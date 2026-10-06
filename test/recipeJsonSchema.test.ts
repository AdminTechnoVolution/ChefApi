import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { buildRecipeJsonSchema, buildScanJsonSchema } from "../src/llm/recipeJsonSchema.js";
import { RecipeOutputSchema, ScanOutputSchema, UNITS } from "../src/schema.js";
import { contractRecipe, contractScanResult } from "./helpers.js";

const schema = buildRecipeJsonSchema();

/** Keywords that strict structured-output decoding (Gemini in particular) can choke on. */
const FORBIDDEN = [
  "$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "default", "format", "pattern",
  // Nullable types are written as `type: [X, "null"]`, the form AntySpendApi's schemas use with these providers.
  "anyOf", "oneOf", "allOf",
];

function walk(node: unknown, visit: (n: Record<string, unknown>, path: string) => void, path = "$"): void {
  if (Array.isArray(node)) return node.forEach((item, i) => walk(item, visit, `${path}[${i}]`));
  if (node === null || typeof node !== "object") return;
  visit(node as Record<string, unknown>, path);
  for (const [key, value] of Object.entries(node)) walk(value, visit, `${path}.${key}`);
}

describe("buildRecipeJsonSchema", () => {
  it("is a valid schema (Ajv strict mode compiles it)", () => {
    expect(() => new Ajv({ strict: true }).compile(schema)).not.toThrow();
  });

  it("accepts the shared contract recipe", () => {
    const validate = new Ajv({ strict: true }).compile(schema);

    expect(validate(contractRecipe())).toBe(true);
  });

  it("rejects a recipe missing any top-level or nested field", () => {
    const validate = new Ajv({ strict: true }).compile(schema);
    const recipe = contractRecipe();

    for (const key of Object.keys(recipe)) {
      const { [key as keyof typeof recipe]: _removed, ...without } = recipe;
      expect(validate(without), `without ${key}`).toBe(false);
    }
    expect(validate({ ...recipe, nutritionalSummary: { calories: 1 } })).toBe(false);
  });

  it("rejects extra properties and wrong types", () => {
    const validate = new Ajv({ strict: true }).compile(schema);

    expect(validate({ ...contractRecipe(), surprise: true })).toBe(false);
    expect(validate({ ...contractRecipe(), prepTimeMinutes: "5" })).toBe(false);
    expect(validate({ ...contractRecipe(), prepTimeMinutes: 5.5 })).toBe(false);
    expect(validate({ ...contractRecipe(), instructions: "do it" })).toBe(false);
  });

  it("is strict-mode friendly: closed objects, everything required, no keywords providers reject", () => {
    walk(schema, (node, path) => {
      for (const keyword of FORBIDDEN) expect(node, `${keyword} at ${path}`).not.toHaveProperty(keyword);

      if (node.type === "object") {
        expect(node.additionalProperties, `additionalProperties at ${path}`).toBe(false);
        expect([...(node.required as string[])].sort(), `required at ${path}`).toEqual(
          Object.keys(node.properties as object).sort(),
        );
      }
    });
  });

  it("stays in lockstep with the Zod schema", () => {
    const shape = Object.keys(RecipeOutputSchema.shape).sort();

    expect(Object.keys(schema.properties as object).sort()).toEqual(shape);
    expect((schema.required as string[]).slice().sort()).toEqual(shape);
  });

  describe("nullable fields", () => {
    const props = schema.properties as Record<string, any>;
    const ingredient = props.ingredientsUsed.items.properties;
    const step = props.instructions.items.properties;

    it("are written as a type list that includes null", () => {
      expect(props.highlight.type).toEqual(["string", "null"]);
      expect(ingredient.quantity.type).toEqual(["number", "null"]);
      expect(step.tip.type).toEqual(["string", "null"]);
    });

    it("keep their enum and add null to it, which strict validators require", () => {
      expect(ingredient.unit.type).toEqual(["string", "null"]);
      expect(ingredient.unit.enum).toEqual([...UNITS, null]);
    });

    it("do not make the non-nullable fields nullable", () => {
      expect(props.title.type).toBe("string");
      expect(props.difficulty.enum).toEqual(["EASY", "MEDIUM", "HARD"]);
      expect(props.difficulty.type).toBe("string");
    });

    it("accept null where allowed and reject it elsewhere", () => {
      const validate = new Ajv({ strict: true }).compile(schema);
      const base = contractRecipe();

      expect(validate({ ...base, highlight: null })).toBe(true);
      expect(validate({ ...base, title: null })).toBe(false);
      expect(validate({ ...base, difficulty: null })).toBe(false);
      expect(validate({ ...base, instructions: [{ ...base.instructions[0], tip: null }] })).toBe(true);
      expect(validate({ ...base, instructions: [{ ...base.instructions[0], title: null }] })).toBe(false);
    });

    it("still reject values outside the enums and missing keys", () => {
      const validate = new Ajv({ strict: true }).compile(schema);
      const base = contractRecipe();

      expect(validate({ ...base, difficulty: "IMPOSSIBLE" })).toBe(false);
      expect(validate({ ...base, ingredientsUsed: [{ name: "x", amount: "1", quantity: 1, unit: "CUPS" }] })).toBe(false);
      expect(validate({ ...base, instructions: [{ title: "a", description: "b", durationMinutes: 1 }] })).toBe(false); // tip missing
    });
  });

  it("is built fresh each time so one caller cannot mutate another's copy", () => {
    expect(buildRecipeJsonSchema()).not.toBe(schema);
    expect(buildRecipeJsonSchema()).toEqual(schema);
  });
});

describe("buildScanJsonSchema", () => {
  const scanSchema = buildScanJsonSchema();

  it("is a valid schema that accepts the shared scan result", () => {
    const validate = new Ajv({ strict: true }).compile(scanSchema);

    expect(validate(contractScanResult())).toBe(true);
    expect(validate({ ingredients: [] })).toBe(true);
  });

  it("rejects incomplete or malformed items", () => {
    const validate = new Ajv({ strict: true }).compile(scanSchema);
    const [first] = contractScanResult().ingredients;
    const { storage: _storage, ...withoutStorage } = first!;

    expect(validate({ ingredients: [withoutStorage] })).toBe(false);
    expect(validate({ ingredients: [{ ...first, unit: "CUPS" }] })).toBe(false);
    expect(validate({ ingredients: [{ ...first, storage: "BASEMENT" }] })).toBe(false);
    expect(validate({ ingredients: [{ ...first, shelfLifeDays: 1.5 }] })).toBe(false);
    expect(validate({ ingredients: [{ ...first, extra: true }] })).toBe(false);
  });

  it("treats expiresOn as the only nullable field", () => {
    const item = (scanSchema.properties as any).ingredients.items.properties;

    expect(item.expiresOn.type).toEqual(["string", "null"]);
    expect(item.name.type).toBe("string");
    expect(item.storage.enum).toEqual(["FRIDGE", "FREEZER", "PANTRY"]);
    expect(item.category.enum).toContain("SEAFOOD");
  });

  it("is strict-mode friendly and in lockstep with the Zod schema", () => {
    walk(scanSchema, (node, path) => {
      for (const keyword of FORBIDDEN) expect(node, `${keyword} at ${path}`).not.toHaveProperty(keyword);
      if (node.type === "object") {
        expect(node.additionalProperties, `additionalProperties at ${path}`).toBe(false);
        expect([...(node.required as string[])].sort(), `required at ${path}`).toEqual(Object.keys(node.properties as object).sort());
      }
    });
    expect(Object.keys((scanSchema.properties as object)).sort()).toEqual(Object.keys(ScanOutputSchema.shape).sort());
  });
});
