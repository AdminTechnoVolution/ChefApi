import type { FastifyBaseLogger } from "fastify";
import { firstEmoji } from "../emoji.js";
import { ApiError } from "../errors.js";
import { OpenRouterClient, parseJsonContent } from "../llm/openRouterClient.js";
import { SUGGEST_JSON_SCHEMA_NAME, buildSuggestJsonSchema } from "../llm/recipeJsonSchema.js";
import { MAX_SUGGESTIONS, SuggestionSchema, type Suggestion } from "../schema.js";
import type { IngredientSuggester, SuggestInput, SuggestOutcome } from "./ingredientSuggester.js";
import { buildSuggestMessages } from "./suggestPrompt.js";

export interface OpenRouterSuggesterOptions {
  apiKey: string;
  baseUrl: string;
  zdr: boolean;
  model: string;
  maxTokens: number;
  /** Per model call. */
  attemptTimeoutMs: number;
  /** Clock seam for tests. */
  now?: () => number;
}

/** Completes the name a person is typing, with the details to fill in the form, through OpenRouter. */
export class OpenRouterIngredientSuggester implements IngredientSuggester {
  private readonly client: OpenRouterClient;
  private readonly jsonSchema = buildSuggestJsonSchema();

  constructor(
    private readonly options: OpenRouterSuggesterOptions,
    private readonly log?: FastifyBaseLogger,
  ) {
    this.client = new OpenRouterClient({ apiKey: options.apiKey, baseUrl: options.baseUrl, zdr: options.zdr }, log);
  }

  async suggest(input: SuggestInput): Promise<SuggestOutcome> {
    const now = this.options.now ?? Date.now;
    const remaining = input.deadlineAt - now();
    if (remaining <= 0) throw new ApiError("upstream_timeout", "The request took too long.");

    const result = await this.client.chatJson({
      model: this.options.model,
      // The same typing must give the same answer: deterministic, and therefore cacheable.
      temperature: 0,
      maxTokens: this.options.maxTokens,
      messages: buildSuggestMessages(input.query, input.language, input.region),
      schemaName: SUGGEST_JSON_SCHEMA_NAME,
      schema: this.jsonSchema,
      healing: true,
      timeoutMs: Math.min(this.options.attemptTimeoutMs, remaining),
      signal: input.signal,
    });

    const parsed = parseJsonContent(result.content);
    const raw = (parsed as { suggestions?: unknown } | null)?.suggestions;
    if (!Array.isArray(raw)) {
      throw new ApiError("upstream_error", "The suggestions could not be read. Please try again.");
    }

    return {
      suggestions: normalizeSuggestions(raw, this.log),
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  }
}

/** Keeps the good entries and drops the rest, so one odd suggestion never costs the user the others. */
export function normalizeSuggestions(raw: unknown[], log?: FastifyBaseLogger): Suggestion[] {
  const seen = new Set<string>();
  const kept: Suggestion[] = [];
  let dropped = 0;

  for (const entry of raw) {
    if (kept.length >= MAX_SUGGESTIONS) break;
    const item = entry as Record<string, unknown> | null;
    const candidate = {
      name: typeof item?.name === "string" ? item.name.replace(/\s+/g, " ").trim() : "",
      emoji: firstEmoji(item?.emoji),
      category: item?.category,
      unit: item?.unit,
      storage: item?.storage,
      shelfLifeDays:
        typeof item?.shelfLifeDays === "number" && Number.isFinite(item.shelfLifeDays)
          ? Math.min(3650, Math.max(1, Math.round(item.shelfLifeDays)))
          : undefined,
      tip: typeof item?.tip === "string" ? item.tip.replace(/\s+/g, " ").trim().slice(0, 200) : "",
    };

    const checked = SuggestionSchema.safeParse(candidate);
    const key = candidate.name.toLowerCase();
    if (!checked.success || seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    kept.push(checked.data);
  }

  if (dropped > 0) log?.info({ dropped, kept: kept.length }, "suggestions dropped during normalization");
  return kept;
}
