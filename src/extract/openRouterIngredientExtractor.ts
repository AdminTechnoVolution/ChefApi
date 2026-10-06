import type { FastifyBaseLogger } from "fastify";
import { ApiError } from "../errors.js";
import { OpenRouterClient, parseJsonContent } from "../llm/openRouterClient.js";
import { EXTRACT_JSON_SCHEMA_NAME, buildExtractJsonSchema } from "../llm/recipeJsonSchema.js";
import { scannedCandidate } from "../scan/openRouterIngredientScanner.js";
import { ExtractedIngredientSchema, MAX_HEARD_LENGTH, MAX_SCAN_ITEMS, type ExtractedIngredient } from "../schema.js";
import { buildExtractMessages } from "./extractPrompt.js";
import type { ExtractInput, ExtractOutcome, IngredientExtractor } from "./ingredientExtractor.js";

export interface OpenRouterExtractorOptions {
  apiKey: string;
  baseUrl: string;
  zdr: boolean;
  /** A text model with structured-output support (the same one as recipes and suggestions). */
  model: string;
  maxTokens: number;
  /** Per model call. */
  attemptTimeoutMs: number;
  /** Clock seam for tests. */
  now?: () => number;
}

/** Turns dictated text into pantry items through OpenRouter, with a strict JSON schema. */
export class OpenRouterIngredientExtractor implements IngredientExtractor {
  private readonly client: OpenRouterClient;
  private readonly jsonSchema = buildExtractJsonSchema();

  constructor(
    private readonly options: OpenRouterExtractorOptions,
    private readonly log?: FastifyBaseLogger,
  ) {
    this.client = new OpenRouterClient({ apiKey: options.apiKey, baseUrl: options.baseUrl, zdr: options.zdr }, log);
  }

  async extract(input: ExtractInput): Promise<ExtractOutcome> {
    const now = this.options.now ?? Date.now;
    const remaining = input.deadlineAt - now();
    if (remaining <= 0) throw new ApiError("upstream_timeout", "The request took too long.");

    const result = await this.client.chatJson({
      model: this.options.model,
      // Extraction wants determinism: the same words give the same list.
      temperature: 0,
      maxTokens: this.options.maxTokens,
      messages: buildExtractMessages(input.transcript, input.today, input.language, input.region),
      schemaName: EXTRACT_JSON_SCHEMA_NAME,
      schema: this.jsonSchema,
      healing: true,
      timeoutMs: Math.min(this.options.attemptTimeoutMs, remaining),
      signal: input.signal,
    });

    const parsed = parseJsonContent(result.content);
    const rawItems = (parsed as { ingredients?: unknown } | null)?.ingredients;
    if (!Array.isArray(rawItems)) {
      throw new ApiError("upstream_error", "What you said could not be understood. Please try again.");
    }

    return {
      ingredients: normalizeExtracted(rawItems, input.today, this.log),
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  }
}

/**
 * Cleans what the model returned, item by item, so one bad entry never costs the user the rest of the list: invalid
 * items are dropped, numbers clamped, dates validated and duplicates merged. The scan rules apply, plus `heard`.
 */
export function normalizeExtracted(rawItems: unknown[], today: string, log?: FastifyBaseLogger): ExtractedIngredient[] {
  const seen = new Set<string>();
  const kept: ExtractedIngredient[] = [];
  let dropped = 0;

  for (const raw of rawItems) {
    if (kept.length >= MAX_SCAN_ITEMS) {
      dropped++;
      continue;
    }
    const item = raw as Record<string, unknown> | null;
    const candidate = {
      ...scannedCandidate(item, today),
      heard: typeof item?.heard === "string" ? item.heard.replace(/\s+/g, " ").trim().slice(0, MAX_HEARD_LENGTH) : "",
    };

    const checked = ExtractedIngredientSchema.safeParse(candidate);
    const key = candidate.name.toLowerCase();
    if (!checked.success || seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    kept.push(checked.data);
  }

  if (dropped > 0) log?.info({ dropped, kept: kept.length }, "dictated items dropped during normalization");
  return kept;
}
