import type { Ingredient, Language, Recipe } from "../schema.js";

export interface GenerateRecipeInput {
  /** From the app's PromptBuilder. Untrusted: it may only add guidance, never override server rules. */
  clientSystemPrompt: string;
  ingredients: Ingredient[];
  /** The language the user reads the app in: every text written for them is in it. */
  language: Language;
  /** Where the user lives (ISO 3166-1 alpha-2 or UN M.49 code), when the device says: the recipe is tailored to it. */
  region?: string;
  /** Absolute epoch-ms point after which no further upstream attempt may start. */
  deadlineAt: number;
  /** Aborted when the deadline passes or the client disconnects. */
  signal?: AbortSignal;
}

export interface GenerationResult {
  recipe: Recipe;
  /** Number of model calls it took (2 means the first answer broke the ingredients-only rule). */
  attempts: number;
  /** Which backend served it (always `openrouter` today); for logs only. */
  provider?: string;
  /** The model that actually answered, when the provider reports it; for logs only. */
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface RecipeGenerator {
  /** Rejects with an `ApiError` for every failure; never leaks upstream messages. */
  generate(input: GenerateRecipeInput): Promise<GenerationResult>;
}
