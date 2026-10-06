import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import type { IngredientScanner } from "./ingredientScanner.js";
import { OpenRouterIngredientScanner } from "./openRouterIngredientScanner.js";

/** Same fail-fast rule as the recipe generator: no key, no start. */
export function createScanner(config: Config, log?: FastifyBaseLogger): IngredientScanner {
  if (!config.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is required.");
  }
  return new OpenRouterIngredientScanner(
    {
      apiKey: config.OPENROUTER_API_KEY,
      baseUrl: config.OPENROUTER_BASE_URL,
      zdr: config.OPENROUTER_ZDR,
      model: config.OPENROUTER_VISION_MODEL,
      maxTokens: config.OPENROUTER_VISION_MAX_TOKENS,
      attemptTimeoutMs: config.OPENROUTER_VISION_TIMEOUT_MS,
    },
    log,
  );
}
