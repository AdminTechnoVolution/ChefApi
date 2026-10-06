import type { Language, Suggestion } from "../schema.js";

export interface SuggestInput {
  /** What the user has typed so far. */
  query: string;
  language: Language;
  /** Where the user lives (ISO 3166-1 alpha-2 or UN M.49 code), when the device says. */
  region?: string;
  /** Absolute epoch-ms point after which no upstream attempt may start. */
  deadlineAt: number;
  /** Aborted when the deadline passes or the client disconnects. */
  signal?: AbortSignal;
}

export interface SuggestOutcome {
  suggestions: Suggestion[];
  /** The model that actually answered; for logs only. */
  model?: string;
  inputTokens: number;
  outputTokens: number;
  /** True when the answer came from the cache and no model was called. */
  cached?: boolean;
}

export interface IngredientSuggester {
  /** Rejects with an `ApiError` for every failure; never leaks upstream messages. */
  suggest(input: SuggestInput): Promise<SuggestOutcome>;
}
