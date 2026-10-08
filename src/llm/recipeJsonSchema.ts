import { z } from "zod";
import { AssistantOutputSchema, ExtractOutputSchema, RecipeOutputSchema, ScanOutputSchema, SuggestOutputSchema } from "../schema.js";

type JsonObject = Record<string, unknown>;

/**
 * Keywords removed from the schema sent to providers. Strict structured-output decoding supports only a
 * subset of JSON Schema, and extras make some backends reject the request outright (AntySpendApi hit
 * Gemini's "schema produces a constraint that has too many states for serving" with an over-constrained
 * schema). Zod adds `$schema` and +-2^53 bounds to every `.int()`, none of which carry information we
 * need here: the strict Zod schemas are applied to the result anyway.
 */
const STRIPPED_KEYWORDS = new Set(["$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "default"]);

/**
 * Zod renders `nullable()` as `anyOf: [{type: X}, {type: "null"}]`. The schemas AntySpendApi sends to the same
 * providers use the compact `type: [X, "null"]` form, so collapse to that (adding `null` to any `enum`, which
 * strict validators require for the null to be accepted).
 */
function collapseNullable(node: JsonObject): JsonObject {
  const anyOf = node.anyOf;
  if (!Array.isArray(anyOf) || anyOf.length !== 2) return node;

  const nullBranch = anyOf.find((branch) => (branch as JsonObject)?.type === "null");
  const valueBranch = anyOf.find((branch) => (branch as JsonObject)?.type !== "null") as JsonObject | undefined;
  if (!nullBranch || !valueBranch || typeof valueBranch.type !== "string") return node;

  const { anyOf: _removed, ...rest } = node;
  const collapsed: JsonObject = { ...rest, ...valueBranch, type: [valueBranch.type, "null"] };
  if (Array.isArray(valueBranch.enum)) collapsed.enum = [...valueBranch.enum, null];
  return collapsed;
}

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (node === null || typeof node !== "object") return node;

  const cleaned: JsonObject = {};
  for (const [key, value] of Object.entries(node as JsonObject)) {
    if (STRIPPED_KEYWORDS.has(key)) continue;
    cleaned[key] = sanitize(value);
  }
  return collapseNullable(cleaned);
}

function toStrictJsonSchema(schema: z.ZodType): JsonObject {
  return sanitize(z.toJSONSchema(schema, { io: "output" })) as JsonObject;
}

/**
 * The recipe shape as a strict-mode JSON Schema: every object closed (`additionalProperties: false`) with
 * all properties required, no numeric bounds, no `$schema`, compact nullable types. Derived from the Zod
 * schema so the two can never drift apart.
 */
export function buildRecipeJsonSchema(): JsonObject {
  return toStrictJsonSchema(RecipeOutputSchema);
}

export const RECIPE_JSON_SCHEMA_NAME = "chef_recipe";

/** Same treatment for the receipt/packaging scan result. */
export function buildScanJsonSchema(): JsonObject {
  return toStrictJsonSchema(ScanOutputSchema);
}

export const SCAN_JSON_SCHEMA_NAME = "chef_scan";

/** And for the ingredient suggestions. */
export function buildSuggestJsonSchema(): JsonObject {
  return toStrictJsonSchema(SuggestOutputSchema);
}

export const SUGGEST_JSON_SCHEMA_NAME = "chef_suggest";

/** And for the ingredients read out of dictated text. */
export function buildExtractJsonSchema(): JsonObject {
  return toStrictJsonSchema(ExtractOutputSchema);
}

export const EXTRACT_JSON_SCHEMA_NAME = "chef_extract";

/** And for what the mascot understood from a spoken sentence. */
export function buildAssistantJsonSchema(): JsonObject {
  return toStrictJsonSchema(AssistantOutputSchema);
}

export const ASSISTANT_JSON_SCHEMA_NAME = "chef_assistant";
