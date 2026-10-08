import type { AssistantResult, Language } from "../schema.js";

export interface AssistantInput {
  /** What the user said to the mascot, as written by the phone's speech recognizer. */
  transcript: string;
  /** The user's local date, YYYY-MM-DD: spoken dates ("on Friday") are worked out from it. */
  today: string;
  /** The language the user reads the app in: names and the reply are written in it. */
  language: Language;
  /** Where the user lives, when the device says: names use the words people there use. */
  region?: string;
  /** Absolute epoch-ms point after which no upstream attempt may start. */
  deadlineAt: number;
  /** Aborted when the deadline passes or the client disconnects. */
  signal?: AbortSignal;
}

export interface AssistantOutcome {
  result: AssistantResult;
  /** The model that actually answered; for logs only. */
  model?: string;
  inputTokens: number;
  outputTokens: number;
}

/** Works out what a person asking the mascot for something wants done. */
export interface AssistantUnderstander {
  /** Rejects with an `ApiError` for every failure; never leaks upstream messages. */
  understand(input: AssistantInput): Promise<AssistantOutcome>;
}
