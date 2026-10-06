import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import { ConstrainedRecipeGenerator } from "./constrainedRecipeGenerator.js";
import { OpenRouterRecipeModel } from "./openRouterRecipeModel.js";
import type { RecipeGenerator } from "./recipeGenerator.js";

/**
 * Composition root for the LLM side. Fails fast, at startup, when the OpenRouter key is missing
 * (instead of answering the first user request with a 502).
 */
export function createGenerator(config: Config, log?: FastifyBaseLogger): RecipeGenerator {
  if (!config.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is required.");
  }

  const model = new OpenRouterRecipeModel(
    {
      apiKey: config.OPENROUTER_API_KEY,
      model: config.OPENROUTER_MODEL,
      baseUrl: config.OPENROUTER_BASE_URL,
      maxTokens: config.OPENROUTER_MAX_TOKENS,
      temperature: config.OPENROUTER_TEMPERATURE,
      zdr: config.OPENROUTER_ZDR,
    },
    log,
  );
  return new ConstrainedRecipeGenerator(model, { attemptTimeoutMs: config.UPSTREAM_TIMEOUT_MS }, log);
}
