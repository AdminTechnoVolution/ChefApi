import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import { CachingIngredientSuggester } from "./cachingSuggester.js";
import type { IngredientSuggester } from "./ingredientSuggester.js";
import { OpenRouterIngredientSuggester } from "./openRouterIngredientSuggester.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 2_000;

/** Same fail-fast rule as the other model calls: no key, no start. */
export function createSuggester(config: Config, log?: FastifyBaseLogger): IngredientSuggester {
  if (!config.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is required.");
  }
  return new CachingIngredientSuggester(
    new OpenRouterIngredientSuggester(
      {
        apiKey: config.OPENROUTER_API_KEY,
        baseUrl: config.OPENROUTER_BASE_URL,
        zdr: config.OPENROUTER_ZDR,
        model: config.OPENROUTER_MODEL,
        maxTokens: config.OPENROUTER_SUGGEST_MAX_TOKENS,
        attemptTimeoutMs: config.OPENROUTER_SUGGEST_TIMEOUT_MS,
      },
      log,
    ),
    { ttlMs: CACHE_TTL_MS, maxEntries: CACHE_MAX_ENTRIES },
  );
}
