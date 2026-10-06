import type { FastifyBaseLogger } from "fastify";
import { firstEmoji } from "../emoji.js";
import { ApiError } from "../errors.js";
import { OpenRouterClient, parseJsonContent } from "../llm/openRouterClient.js";
import { SCAN_JSON_SCHEMA_NAME, buildScanJsonSchema } from "../llm/recipeJsonSchema.js";
import { MAX_NAME_LENGTH, MAX_QUANTITY, MAX_SCAN_ITEMS, ScannedIngredientSchema, type ScannedIngredient } from "../schema.js";
import type { IngredientScanner, ScanInput, ScanOutcome } from "./ingredientScanner.js";
import { buildScanMessages } from "./scanPrompt.js";

export interface OpenRouterScannerOptions {
  apiKey: string;
  baseUrl: string;
  zdr: boolean;
  /** A vision-capable model (AntySpendApi's receipt scanning uses google/gemini-2.5-flash). */
  model: string;
  maxTokens: number;
  /** Per model call. */
  attemptTimeoutMs: number;
  /** Clock seam for tests. */
  now?: () => number;
}

/** Reads a receipt or packaging photo through OpenRouter, mirroring AntySpendApi's `chatCompletionJsonWithImage`. */
export class OpenRouterIngredientScanner implements IngredientScanner {
  private readonly client: OpenRouterClient;
  private readonly jsonSchema = buildScanJsonSchema();

  constructor(
    private readonly options: OpenRouterScannerOptions,
    private readonly log?: FastifyBaseLogger,
  ) {
    this.client = new OpenRouterClient({ apiKey: options.apiKey, baseUrl: options.baseUrl, zdr: options.zdr }, log);
  }

  async scan(input: ScanInput): Promise<ScanOutcome> {
    const now = this.options.now ?? Date.now;
    const remaining = input.deadlineAt - now();
    if (remaining <= 0) throw new ApiError("upstream_timeout", "The request took too long.");

    const result = await this.client.chatJson({
      model: this.options.model,
      // Extraction wants determinism (unlike recipes, where variety is the point).
      temperature: 0,
      maxTokens: this.options.maxTokens,
      messages: buildScanMessages(input.image, input.mimeType, input.today, input.language, input.region),
      schemaName: SCAN_JSON_SCHEMA_NAME,
      schema: this.jsonSchema,
      // AntySpendApi runs its image path without response healing.
      healing: false,
      timeoutMs: Math.min(this.options.attemptTimeoutMs, remaining),
      signal: input.signal,
    });

    const parsed = parseJsonContent(result.content);
    const rawItems = (parsed as { ingredients?: unknown } | null)?.ingredients;
    if (!Array.isArray(rawItems)) {
      throw new ApiError("upstream_error", "The photo could not be read. Please try again.");
    }

    return {
      ingredients: normalizeScanned(rawItems, input.today, this.log),
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  }
}

/**
 * Cleans what the model returned, item by item, so one bad entry never costs the user the rest of the scan:
 * invalid items are dropped, numbers clamped, dates validated and duplicates merged.
 */
export function normalizeScanned(rawItems: unknown[], today: string, log?: FastifyBaseLogger): ScannedIngredient[] {
  const seen = new Set<string>();
  const kept: ScannedIngredient[] = [];
  let dropped = 0;

  for (const raw of rawItems) {
    if (kept.length >= MAX_SCAN_ITEMS) {
      dropped++;
      continue;
    }
    const item = raw as Record<string, unknown> | null;
    const candidate = scannedCandidate(item, today);
    const name = candidate.name;

    const checked = ScannedIngredientSchema.safeParse(candidate);
    const key = name.toLowerCase();
    if (!checked.success || seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    kept.push(checked.data);
  }

  if (dropped > 0) log?.info({ dropped, kept: kept.length }, "scan items dropped during normalization");
  return kept;
}

/**
 * One model item reduced to the scan shape: name tidied, quantity and shelf life clamped, date checked. Not yet validated
 * against the schema (the caller does that), so dictation can add its own fields on top.
 */
export function scannedCandidate(item: Record<string, unknown> | null, today: string) {
  const name = typeof item?.name === "string" ? item.name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH) : "";
  const quantity = typeof item?.quantity === "number" && item.quantity > 0 ? Math.min(item.quantity, MAX_QUANTITY) : 1;
  const shelfLife =
    typeof item?.shelfLifeDays === "number" && Number.isFinite(item.shelfLifeDays)
      ? Math.min(3650, Math.max(1, Math.round(item.shelfLifeDays)))
      : 7;

  return {
    name,
    emoji: firstEmoji(item?.emoji),
    quantity,
    unit: item?.unit,
    category: item?.category,
    storage: item?.storage,
    expiresOn: validFutureDate(item?.expiresOn, today),
    shelfLifeDays: shelfLife,
  };
}

/** A real calendar date in YYYY-MM-DD that is not before [today]; otherwise null. */
export function validFutureDate(value: unknown, today: string): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return value >= today ? value : null;
}
