import type { SystemBlock } from "./prompt.js";
import type { Recipe } from "../schema.js";

export interface ModelRequest {
  /** Server rules first, then the app's guidance as lower-priority context. */
  system: SystemBlock[];
  userMessage: string;
  /** Hard limit for this single call; already clamped to the time left in the request budget. */
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ModelResponse {
  /** Already validated against the strict recipe schema. */
  recipe: Recipe;
  inputTokens: number;
  outputTokens: number;
  /** The model that actually served the call, when the provider reports it. */
  model?: string;
}

/**
 * One LLM call that returns one schema-valid recipe. Implementations only know how to talk to a
 * provider; the retry policy and the ingredients-only rule live in {@link ConstrainedRecipeGenerator}.
 * Every failure must surface as an `ApiError` (never a raw SDK/HTTP error).
 */
export interface RecipeModel {
  readonly provider: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
