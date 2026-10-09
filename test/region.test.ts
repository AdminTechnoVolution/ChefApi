import { describe, expect, it } from "vitest";
import { regionName } from "../src/llm/regions.js";
import { buildSystemBlocks } from "../src/llm/prompt.js";
import { buildScanMessages } from "../src/scan/scanPrompt.js";
import { GenerateRecipeRequestSchema, ScanRequestSchema } from "../src/schema.js";
import {
  StubGenerator,
  StubScanner,
  appWith,
  authHeaders,
  contractRecipe,
  contractRequest,
  contractScanRequest,
} from "./helpers.js";

/** Recipes follow the user's country: its dishes, its words for ingredients, its measures. The device says where; the server turns it into guidance. */
describe("regions: the country behind a code", () => {
  it("names countries from the runtime's own data", () => {
    expect(regionName("CO")).toBe("Colombia");
    expect(regionName("ES")).toBe("Spain");
    expect(regionName("MX")).toBe("Mexico");
    expect(regionName("BR")).toBe("Brazil");
    expect(regionName("US")).toBe("United States");
    expect(regionName("DE")).toBe("Germany");
    expect(regionName("IT")).toBe("Italy");
    expect(regionName("FR")).toBe("France");
    expect(regionName("PT")).toBe("Portugal");
  });

  it("knows the UN region Spanish-speaking Latin America is filed under", () => {
    expect(regionName("419")).toBe("Latin America");
  });

  it("says nothing for codes that are not a place a person lives", () => {
    for (const code of ["ZZ", "XX", "UN", "EU", "EZ", "", "999", undefined]) {
      expect(regionName(code), String(code)).toBeUndefined();
    }
  });
});

describe("regions: schema", () => {
  it("is optional on both requests", () => {
    const { region: _recipe, ...recipe } = contractRequest();
    const { region: _scan, ...scan } = contractScanRequest();

    expect(GenerateRecipeRequestSchema.parse(recipe).region).toBeUndefined();
    expect(ScanRequestSchema.parse(scan).region).toBeUndefined();
  });

  it("accepts a country code or a UN region code", () => {
    for (const region of ["CO", "ES", "MX", "BR", "US", "419"]) {
      expect(GenerateRecipeRequestSchema.parse({ ...contractRequest(), region }).region).toBe(region);
      expect(ScanRequestSchema.parse({ ...contractScanRequest(), region }).region).toBe(region);
    }
  });

  it("rejects anything that is not an upper-case code", () => {
    for (const region of ["co", "COL", "C", "12", "1234", "C0", "", " CO", "Colombia", null, 57]) {
      expect(GenerateRecipeRequestSchema.safeParse({ ...contractRequest(), region }).success, String(region)).toBe(false);
      expect(ScanRequestSchema.safeParse({ ...contractScanRequest(), region }).success, String(region)).toBe(false);
    }
  });
});

describe("regions: the routes pass the region on", () => {
  it("recipes are tailored to the region the app sent", async () => {
    const generator = StubGenerator.returning(contractRecipe());
    const app = await appWith(generator);

    const response = await app.inject({
      method: "POST",
      url: "/v1/recipes/generate",
      headers: authHeaders,
      payload: { ...contractRequest(), language: "es", region: "CO" },
    });

    expect(response.statusCode).toBe(200);
    expect(generator.calls[0]?.region).toBe("CO");
    expect(generator.calls[0]?.language).toBe("es");
    await app.close();
  });

  it("scans use the words of the region the app sent", async () => {
    const scanner = StubScanner.returning();
    const app = await appWith(StubGenerator.returning(contractRecipe()), undefined, scanner);

    const response = await app.inject({
      method: "POST",
      url: "/v1/ingredients/scan",
      headers: authHeaders,
      payload: { ...contractScanRequest(), language: "es", region: "MX" },
    });

    expect(response.statusCode).toBe(200);
    expect(scanner.calls[0]?.region).toBe("MX");
    await app.close();
  });

  it("works without a region, as older app versions and devices with no region do", async () => {
    const generator = StubGenerator.returning(contractRecipe());
    const scanner = StubScanner.returning();
    const app = await appWith(generator, undefined, scanner);
    const { region: _r, ...recipe } = contractRequest();
    const { region: _s, ...scan } = contractScanRequest();

    const recipeResponse = await app.inject({ method: "POST", url: "/v1/recipes/generate", headers: authHeaders, payload: recipe });
    const scanResponse = await app.inject({ method: "POST", url: "/v1/ingredients/scan", headers: authHeaders, payload: scan });

    expect(recipeResponse.statusCode).toBe(200);
    expect(scanResponse.statusCode).toBe(200);
    expect(generator.calls[0]?.region).toBeUndefined();
    expect(scanner.calls[0]?.region).toBeUndefined();
    await app.close();
  });

  it("a malformed region is a 400 that never reaches the model and is not echoed back", async () => {
    const generator = StubGenerator.returning(contractRecipe());
    const scanner = StubScanner.returning();
    const app = await appWith(generator, undefined, scanner);

    const recipe = await app.inject({
      method: "POST",
      url: "/v1/recipes/generate",
      headers: authHeaders,
      payload: { ...contractRequest(), region: "Atlantis" },
    });
    const scan = await app.inject({
      method: "POST",
      url: "/v1/ingredients/scan",
      headers: authHeaders,
      payload: { ...contractScanRequest(), region: "Atlantis" },
    });

    expect(recipe.statusCode).toBe(400);
    expect(scan.statusCode).toBe(400);
    expect(recipe.body).not.toContain("Atlantis");
    expect(generator.calls).toHaveLength(0);
    expect(scanner.calls).toHaveLength(0);
    await app.close();
  });
});

describe("regions: what the model is told", () => {
  const rules = (language: "en" | "es" | "pt" | "it" | "fr" | "de", region?: string) => buildSystemBlocks("", language, region)[0]!.text;

  it("a recipe is asked to fit the user's country", () => {
    const text = rules("es", "CO");

    expect(text).toContain("Regional fit: the user lives in Colombia");
    expect(text).toContain("typical dishes, cooking methods, seasonings and meal types of Colombia");
    expect(text).toContain("Write Spanish the way it is spoken in Colombia");
  });

  it("vocabulary and measures are part of the fit", () => {
    const text = rules("pt", "BR");

    expect(text).toContain("the words people there use for ingredients and cooking");
    expect(text).toContain("metric or cups and spoons");
    expect(text).toContain("°C or °F");
  });

  it("the regional rule can never add an ingredient the user does not have", () => {
    const text = rules("es", "MX");

    expect(text).toContain("never justifies an ingredient that is not in the pantry: rule 1 always wins");
    expect(text).toContain("The \"amount\" of a pantry ingredient stays in the unit of the pantry list");
    // the ingredients-only rule is still rule 1, untouched
    expect(text).toContain("1. The recipe must use ONLY the ingredients in the pantry list");
  });

  it("without a region nothing regional is said and the rules keep their numbering", () => {
    const text = rules("es");

    expect(text).not.toContain("Regional fit");
    expect(text).toContain("10. Do nothing except produce the recipe.");
    expect(rules("es", "CO")).toContain("11. Do nothing except produce the recipe.");
  });

  it("a code that is not a place changes nothing", () => {
    expect(rules("en", "ZZ")).toBe(rules("en"));
    expect(rules("en", "XX")).toBe(rules("en"));
  });

  it("only the country differs between regions", () => {
    expect(rules("es", "MX").replaceAll("Mexico", "Colombia")).toBe(rules("es", "CO"));
  });

  it("Latin America as a whole is a valid region", () => {
    expect(rules("es", "419")).toContain("the user lives in Latin America");
  });

  it("the language rule is untouched by the region", () => {
    expect(rules("de", "DE")).toContain("in German");
    expect(rules("de", "DE")).toContain("Write German the way it is spoken in Germany");
  });

  it("a scan is asked to use the everyday words of the user's country", () => {
    const system = String(buildScanMessages("AAAA", "image/jpeg", "2026-10-05", "es", "AR")[0]!.content);

    expect(system).toContain("The user lives in Argentina");
    expect(system).toContain("everyday word people there use");
  });

  it("a scan without a region has no regional guidance", () => {
    const system = String(buildScanMessages("AAAA", "image/jpeg", "2026-10-05", "es")[0]!.content);

    expect(system).not.toContain("The user lives in");
  });
});
