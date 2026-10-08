import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import type { AssistantUnderstander } from "./assistantUnderstander.js";
import { OpenRouterAssistantUnderstander } from "./openRouterAssistantUnderstander.js";

/** Same fail-fast rule as the other model calls: no key, no start. */
export function createAssistant(config: Config, log?: FastifyBaseLogger): AssistantUnderstander {
  if (!config.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is required.");
  }
  return new OpenRouterAssistantUnderstander(
    {
      apiKey: config.OPENROUTER_API_KEY,
      baseUrl: config.OPENROUTER_BASE_URL,
      zdr: config.OPENROUTER_ZDR,
      model: config.OPENROUTER_MODEL,
      // The same budget as dictation: a short spoken sentence in, a short JSON out.
      maxTokens: config.OPENROUTER_EXTRACT_MAX_TOKENS,
      attemptTimeoutMs: config.OPENROUTER_EXTRACT_TIMEOUT_MS,
    },
    log,
  );
}
