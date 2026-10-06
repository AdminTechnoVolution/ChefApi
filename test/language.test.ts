import { describe, expect, it } from "vitest";
import { ESSENTIALS_BY_LANGUAGE } from "../src/llm/essentials.js";
import { findUnlistedIngredients, isEssential } from "../src/llm/ingredientMatcher.js";
import { LANGUAGE_NAMES, buildSystemBlocks } from "../src/llm/prompt.js";
import { buildScanMessages } from "../src/scan/scanPrompt.js";
import { GenerateRecipeRequestSchema, LANGUAGES, ScanRequestSchema } from "../src/schema.js";
import {
  StubGenerator,
  StubScanner,
  appWith,
  authHeaders,
  contractRecipe,
  contractRequest,
  contractScanRequest,
  ingredient,
} from "./helpers.js";

/** Chef speaks English (the default), Spanish, Portuguese, Italian, French and German, in the app and in what the model writes. */
describe("languages: schema", () => {
  it("supports exactly the six app languages", () => {
    expect([...LANGUAGES]).toEqual(["en", "es", "pt", "it", "fr", "de"]);
    expect(Object.keys(LANGUAGE_NAMES).sort()).toEqual([...LANGUAGES].sort());
  });

  it("defaults to English when the app does not say (older app versions)", () => {
    const { language: _drop, ...recipe } = contractRequest();
    const { language: _dropScan, ...scan } = contractScanRequest();

    expect(GenerateRecipeRequestSchema.parse(recipe).language).toBe("en");
    expect(ScanRequestSchema.parse(scan).language).toBe("en");
  });

  it("accepts every supported language on both requests", () => {
    for (const language of LANGUAGES) {
      expect(GenerateRecipeRequestSchema.parse({ ...contractRequest(), language }).language).toBe(language);
      expect(ScanRequestSchema.parse({ ...contractScanRequest(), language }).language).toBe(language);
    }
  });

  it("rejects anything else", () => {
    for (const language of ["xx", "EN", "", "english", "pt-BR", 5, null]) {
      expect(GenerateRecipeRequestSchema.safeParse({ ...contractRequest(), language }).success, String(language)).toBe(false);
      expect(ScanRequestSchema.safeParse({ ...contractScanRequest(), language }).success, String(language)).toBe(false);
    }
  });
});

describe("languages: the routes pass the language on", () => {
  it("recipes are generated in the language the app asked for", async () => {
    for (const language of LANGUAGES) {
      const generator = StubGenerator.returning(contractRecipe());
      const app = await appWith(generator);

      const response = await app.inject({
        method: "POST",
        url: "/v1/recipes/generate",
        headers: authHeaders,
        payload: { ...contractRequest(), language },
      });

      expect(response.statusCode, language).toBe(200);
      expect(generator.calls[0]?.language).toBe(language);
      await app.close();
    }
  });

  it("scans name the items in the language the app asked for", async () => {
    for (const language of LANGUAGES) {
      const scanner = StubScanner.returning();
      const app = await appWith(StubGenerator.returning(contractRecipe()), undefined, scanner);

      const response = await app.inject({
        method: "POST",
        url: "/v1/ingredients/scan",
        headers: authHeaders,
        payload: { ...contractScanRequest(), language },
      });

      expect(response.statusCode, language).toBe(200);
      expect(scanner.calls[0]?.language).toBe(language);
      await app.close();
    }
  });

  it("falls back to English for a request without a language", async () => {
    const generator = StubGenerator.returning(contractRecipe());
    const app = await appWith(generator);
    const { language: _drop, ...payload } = contractRequest();

    await app.inject({ method: "POST", url: "/v1/recipes/generate", headers: authHeaders, payload });

    expect(generator.calls[0]?.language).toBe("en");
    await app.close();
  });

  it("an unsupported language is a 400 and never reaches the model", async () => {
    const generator = StubGenerator.returning(contractRecipe());
    const scanner = StubScanner.returning();
    const app = await appWith(generator, undefined, scanner);

    const recipe = await app.inject({
      method: "POST",
      url: "/v1/recipes/generate",
      headers: authHeaders,
      payload: { ...contractRequest(), language: "klingon" },
    });
    const scan = await app.inject({
      method: "POST",
      url: "/v1/ingredients/scan",
      headers: authHeaders,
      payload: { ...contractScanRequest(), language: "klingon" },
    });

    expect(recipe.statusCode).toBe(400);
    expect(scan.statusCode).toBe(400);
    expect(recipe.json().error.code).toBe("invalid_request");
    expect(generator.calls).toHaveLength(0);
    expect(scanner.calls).toHaveLength(0);
    // the value is never echoed back
    expect(recipe.body).not.toContain("klingon");
    await app.close();
  });
});

describe("languages: what the model is told", () => {
  it("the recipe rules name the language to write in, for every language", () => {
    for (const language of LANGUAGES) {
      const rules = buildSystemBlocks("", language)[0]!.text;

      expect(rules, language).toContain(`in ${LANGUAGE_NAMES[language]}`);
      expect(rules).toContain("Non-negotiable rules");
      expect(rules).toContain("keep pantry ingredient names exactly as listed even if they are in another language");
    }
  });

  it("English is the default", () => {
    expect(buildSystemBlocks("x")[0]!.text).toBe(buildSystemBlocks("x", "en")[0]!.text);
    expect(buildSystemBlocks("x")[0]!.text).toContain("in English");
  });

  it("the languages produce different rules and only the language line differs", () => {
    const english = buildSystemBlocks("", "en")[0]!.text;
    const german = buildSystemBlocks("", "de")[0]!.text;

    expect(german).not.toBe(english);
    expect(german.replaceAll("German", "English")).toBe(english);
  });

  it("the scan rules name the language items are written in", () => {
    for (const language of LANGUAGES) {
      const system = buildScanMessages("AAAA", "image/jpeg", "2026-10-05", language)[0]!;

      expect(system.role).toBe("system");
      expect(String(system.content), language).toContain(`written in ${LANGUAGE_NAMES[language]}`);
    }
  });

  it("scan item names are no longer forced into English", () => {
    const text = String(buildScanMessages("AAAA", "image/jpeg", "2026-10-05", "es")[0]!.content);

    expect(text).not.toContain("in English Title Case");
    expect(text).toContain("Translate names printed in another language");
  });
});

describe("languages: the ingredients-only rule understands every language", () => {
  const pantry = [ingredient({ name: "Leche" }), ingredient({ name: "Eggs" })];

  it("every language's own essentials are recognised", () => {
    for (const [language, words] of Object.entries(ESSENTIALS_BY_LANGUAGE)) {
      expect(words.length, language).toBeGreaterThanOrEqual(8);
      for (const word of words) expect(isEssential(word), `${language}: ${word}`).toBe(true);
    }
  });

  it("recipes written in each language pass when they only add essentials", () => {
    const written = {
      es: ["Sal", "Pimienta negra", "Agua", "Aceite de oliva"],
      pt: ["Sal", "Pimenta-do-reino", "Água", "Azeite"],
      it: ["Sale", "Pepe nero", "Acqua", "Olio d'oliva"],
      fr: ["Sel", "Poivre noir", "Eau", "Huile d'olive"],
      de: ["Salz", "Schwarzer Pfeffer", "Wasser", "Olivenöl"],
      en: ["Salt", "Black pepper", "Water", "Cooking oil"],
    };
    for (const [language, names] of Object.entries(written)) {
      expect(findUnlistedIngredients(names, pantry), language).toEqual([]);
    }
  });

  it("combined essentials are judged part by part in each language", () => {
    for (const entry of ["Sal y pimienta", "Sal e pimenta", "Sale e pepe", "Sel et poivre", "Salz und Pfeffer", "Salt and pepper"]) {
      expect(findUnlistedIngredients([entry], pantry), entry).toEqual([]);
    }
  });

  it("still catches an ingredient the user does not have, in any language", () => {
    expect(findUnlistedIngredients(["Pollo", "Leche"], pantry)).toEqual(["Pollo"]);
    expect(findUnlistedIngredients(["Sal y ajo"], pantry)).toEqual(["Sal y ajo"]);
    expect(findUnlistedIngredients(["Hähnchen"], pantry)).toEqual(["Hähnchen"]);
    expect(findUnlistedIngredients(["Poulet et sel"], pantry)).toEqual(["Poulet et sel"]);
  });

  it("a pantry item named in the user's language is matched as before", () => {
    expect(findUnlistedIngredients(["Leche", "leche entera", "Eggs"], pantry)).toEqual([]);
  });
});
