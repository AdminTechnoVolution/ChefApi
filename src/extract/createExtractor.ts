import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import type { IngredientExtractor } from "./ingredientExtractor.js";
import { OpenRouterIngredientExtractor } from "./openRouterIngredientExtractor.js";

/** Same fail-fast rule as the other model calls: no key, no start. */
export function createExtractor(config: Config, log?: FastifyBaseLogger): IngredientExtractor {
  if (!config.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is required.");
  }
  return new OpenRouterIngredientExtractor(
    {
      apiKey: config.OPENROUTER_API_KEY,
      baseUrl: config.OPENROUTER_BASE_URL,
      zdr: config.OPENROUTER_ZDR,
      model: config.OPENROUTER_MODEL,
      maxTokens: config.OPENROUTER_EXTRACT_MAX_TOKENS,
      attemptTimeoutMs: config.OPENROUTER_EXTRACT_TIMEOUT_MS,
    },
    log,
  );
}
