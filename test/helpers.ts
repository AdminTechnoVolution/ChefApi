import { readFileSync } from "node:fs";
import { buildApp } from "../src/app.js";
import { AppKeyVerifier } from "../src/auth/clientVerifier.js";
import { type Config, loadConfig } from "../src/config.js";
import type { GenerateRecipeInput, GenerationResult, RecipeGenerator } from "../src/llm/recipeGenerator.js";
import type { ExtractInput, ExtractOutcome, IngredientExtractor } from "../src/extract/ingredientExtractor.js";
import type { IngredientScanner, ScanInput, ScanOutcome, ScanVideoInput } from "../src/scan/ingredientScanner.js";
import type { IngredientSuggester, SuggestInput, SuggestOutcome } from "../src/suggest/ingredientSuggester.js";
import type { Diet, ExtractedIngredient, Ingredient, Language, Recipe, ScannedIngredient, Suggestion } from "../src/schema.js";

export const TEST_APP_KEY = "test-app-key-123";

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ NODE_ENV: "test", CHEF_APP_KEY: TEST_APP_KEY, ...overrides });
}

/** Loads an example payload from test/fixtures. */
export function contractFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").trim();
}

export const contractRequest = () => JSON.parse(contractFixture("recipe-request.example.json")) as {
  systemPrompt: string;
  ingredients: Ingredient[];
  language: Language;
  region?: string;
  diets: Diet[];
};
export const contractRecipe = () => JSON.parse(contractFixture("recipe-response.example.json")) as Recipe;
export const contractDishRequest = () =>
  JSON.parse(contractFixture("dish-request.example.json")) as {
    systemPrompt: string;
    ingredients: Ingredient[];
    language: Language;
    region?: string;
    dish: string;
    diets: Diet[];
  };
export const contractDishRecipe = () => JSON.parse(contractFixture("dish-response.example.json")) as Recipe;
export const contractScanRequest = () =>
  JSON.parse(contractFixture("scan-request.example.json")) as {
    image: string;
    mimeType: "image/jpeg";
    today: string;
    language: Language;
    region?: string;
  };
export const contractScanResult = () =>
  JSON.parse(contractFixture("scan-response.example.json")) as { ingredients: ScannedIngredient[] };

export const contractScanVideoRequest = () =>
  JSON.parse(contractFixture("scan-video-request.example.json")) as {
    frames: string[];
    today: string;
    language: Language;
    region?: string;
  };
export const contractScanVideoResult = () =>
  JSON.parse(contractFixture("scan-video-response.example.json")) as { ingredients: ScannedIngredient[] };

export const contractSuggestRequest = () =>
  JSON.parse(contractFixture("suggest-request.example.json")) as { query: string; language: Language; region?: string };
export const contractSuggestResult = () =>
  JSON.parse(contractFixture("suggest-response.example.json")) as { suggestions: Suggestion[] };

export const contractExtractRequest = () =>
  JSON.parse(contractFixture("extract-request.example.json")) as { transcript: string; today: string; language: Language; region?: string };
export const contractExtractResult = () =>
  JSON.parse(contractFixture("extract-response.example.json")) as { ingredients: ExtractedIngredient[] };

export class StubExtractor implements IngredientExtractor {
  readonly calls: ExtractInput[] = [];

  constructor(private readonly behaviour: (input: ExtractInput) => Promise<ExtractOutcome>) {}

  static returning(ingredients: ExtractedIngredient[] = contractExtractResult().ingredients): StubExtractor {
    return new StubExtractor(async () => ({ ingredients, inputTokens: 0, outputTokens: 0, model: "stub/model" }));
  }

  static failingWith(error: unknown): StubExtractor {
    return new StubExtractor(async () => {
      throw error;
    });
  }

  extract(input: ExtractInput): Promise<ExtractOutcome> {
    this.calls.push(input);
    return this.behaviour(input);
  }
}

export class StubSuggester implements IngredientSuggester {
  readonly calls: SuggestInput[] = [];

  constructor(private readonly behaviour: (input: SuggestInput) => Promise<SuggestOutcome>) {}

  static returning(suggestions: Suggestion[] = contractSuggestResult().suggestions): StubSuggester {
    return new StubSuggester(async () => ({ suggestions, inputTokens: 0, outputTokens: 0, model: "stub/model" }));
  }

  static failingWith(error: unknown): StubSuggester {
    return new StubSuggester(async () => {
      throw error;
    });
  }

  suggest(input: SuggestInput): Promise<SuggestOutcome> {
    this.calls.push(input);
    return this.behaviour(input);
  }
}

export class StubGenerator implements RecipeGenerator {
  readonly calls: GenerateRecipeInput[] = [];

  constructor(private readonly behaviour: (input: GenerateRecipeInput) => Promise<GenerationResult>) {}

  static returning(recipe: Recipe): StubGenerator {
    return new StubGenerator(async () => ({ recipe, attempts: 1 }));
  }

  static failingWith(error: unknown): StubGenerator {
    return new StubGenerator(async () => {
      throw error;
    });
  }

  generate(input: GenerateRecipeInput): Promise<GenerationResult> {
    this.calls.push(input);
    return this.behaviour(input);
  }
}

export class StubScanner implements IngredientScanner {
  readonly calls: ScanInput[] = [];
  readonly videoCalls: ScanVideoInput[] = [];

  constructor(
    private readonly behaviour: (input: ScanInput) => Promise<ScanOutcome>,
    private readonly videoBehaviour: (input: ScanVideoInput) => Promise<ScanOutcome> = async () => ({
      ingredients: contractScanVideoResult().ingredients,
      inputTokens: 0,
      outputTokens: 0,
      model: "stub/vision",
    }),
  ) {}

  static returning(
    ingredients: ScannedIngredient[] = contractScanResult().ingredients,
    videoIngredients: ScannedIngredient[] = contractScanVideoResult().ingredients,
  ): StubScanner {
    return new StubScanner(
      async () => ({ ingredients, inputTokens: 0, outputTokens: 0, model: "stub/vision" }),
      async () => ({ ingredients: videoIngredients, inputTokens: 0, outputTokens: 0, model: "stub/vision" }),
    );
  }

  static failingWith(error: unknown): StubScanner {
    const fail = async (): Promise<never> => {
      throw error;
    };
    return new StubScanner(fail, fail);
  }

  scan(input: ScanInput): Promise<ScanOutcome> {
    this.calls.push(input);
    return this.behaviour(input);
  }

  scanVideo(input: ScanVideoInput): Promise<ScanOutcome> {
    this.videoCalls.push(input);
    return this.videoBehaviour(input);
  }
}

export async function appWith(
  generator: RecipeGenerator,
  config: Config = testConfig(),
  scanner: IngredientScanner = StubScanner.returning(),
  suggester: IngredientSuggester = StubSuggester.returning(),
  extractor: IngredientExtractor = StubExtractor.returning(),
) {
  return buildApp({ config, verifier: new AppKeyVerifier(config.CHEF_APP_KEY), generator, scanner, suggester, extractor, logger: false });
}

export const authHeaders = { "x-chef-app-key": TEST_APP_KEY, "content-type": "application/json" };

export function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    name: "Milk",
    quantity: 1,
    unit: "LITERS",
    category: "DAIRY",
    expirationTimestamp: 1_790_000_000_000,
    ...overrides,
  };
}
