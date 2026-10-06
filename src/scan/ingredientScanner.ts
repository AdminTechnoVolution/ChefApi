import type { Language, ScannedIngredient, SCAN_MIME_TYPES } from "../schema.js";

export interface ScanInput {
  /** Base64 image data, no `data:` prefix. */
  image: string;
  mimeType: (typeof SCAN_MIME_TYPES)[number];
  /** The user's local date, YYYY-MM-DD. */
  today: string;
  /** The language the user reads the app in: item names are written in it. */
  language: Language;
  /** Where the user lives, when the device says: item names use the words people there use. */
  region?: string;
  /** Absolute epoch-ms point after which no upstream attempt may start. */
  deadlineAt: number;
  /** Aborted when the deadline passes or the client disconnects. */
  signal?: AbortSignal;
}

export interface ScanOutcome {
  ingredients: ScannedIngredient[];
  /** The model that actually answered; for logs only. */
  model?: string;
  inputTokens: number;
  outputTokens: number;
}

export interface IngredientScanner {
  /** Rejects with an `ApiError` for every failure; never leaks upstream messages. */
  scan(input: ScanInput): Promise<ScanOutcome>;
}
