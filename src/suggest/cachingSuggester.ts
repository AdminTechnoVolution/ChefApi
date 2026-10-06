import type { IngredientSuggester, SuggestInput, SuggestOutcome } from "./ingredientSuggester.js";

export interface CacheOptions {
  ttlMs: number;
  maxEntries: number;
  /** Clock seam for tests. */
  now?: () => number;
}

/**
 * Remembers answers, because people type the same foods all day ("tom" -> tomatoes) and the model's answer for the same
 * text, language and country is the same. Only successes are kept. In memory and per process: after a restart it
 * simply refills.
 */
export class CachingIngredientSuggester implements IngredientSuggester {
  private readonly entries = new Map<string, { expiresAt: number; outcome: SuggestOutcome }>();

  constructor(
    private readonly inner: IngredientSuggester,
    private readonly options: CacheOptions,
  ) {}

  async suggest(input: SuggestInput): Promise<SuggestOutcome> {
    const now = this.options.now ?? Date.now;
    const key = [input.language, input.region ?? "", input.query.normalize("NFKC").trim().toLowerCase()].join("|");

    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now()) {
      // Refresh recency: the Map keeps insertion order, so the oldest entry is always the first one.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return { ...hit.outcome, inputTokens: 0, outputTokens: 0, cached: true };
    }
    if (hit) this.entries.delete(key);

    const outcome = await this.inner.suggest(input);
    this.entries.set(key, { expiresAt: now() + this.options.ttlMs, outcome });
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return { ...outcome, cached: false };
  }
}
