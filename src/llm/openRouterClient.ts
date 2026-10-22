import type { FastifyBaseLogger } from "fastify";
import { ApiError } from "../errors.js";

/** What keeps a call alive when the model's shared capacity is busy. Both are off unless given. */
export interface OpenRouterResilience {
  /**
   * Models OpenRouter tries, in order, when the call's own model is rate-limited or down (its `models` routing). The call's own
   * model is left out of the list; with nothing left the request names its model alone, as before.
   */
  fallbackModels?: readonly string[];
  /** Pauses before asking again after a rate limit, an overloaded upstream or a dropped connection; one retry per entry. */
  retryDelaysMs?: readonly number[];
}

export interface OpenRouterClientOptions extends OpenRouterResilience {
  apiKey: string;
  /** e.g. https://openrouter.ai/api/v1 (no trailing path). Overridable for tests and gateways. */
  baseUrl: string;
  /** Route only to Zero-Data-Retention endpoints. Same privacy posture as AntySpendApi. */
  zdr: boolean;
}

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user";
  content: string | ContentPart[];
}

export interface ChatJsonRequest {
  model: string;
  temperature: number;
  maxTokens: number;
  messages: ChatMessage[];
  schemaName: string;
  schema: Record<string, unknown>;
  /** OpenRouter's response-healing plugin (repairs small JSON defects). AntySpendApi leaves it off for images. */
  healing: boolean;
  /** Hard limit for this single call; already clamped to the time left in the request budget. */
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ChatJsonResult {
  /** The model's JSON text, not yet parsed. */
  content: string;
  /** The model that actually answered. */
  model: string;
  inputTokens: number;
  outputTokens: number;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; refusal?: string | null };
    error?: { code?: number | string; message?: string };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  /** OpenRouter can answer HTTP 200 with an error object when the routed provider fails mid-flight. */
  error?: { code?: number | string; message?: string };
}

const MAX_LOGGED_BODY_CHARS = 500;
/** A retry is only worth starting with at least this much of the call's time left after the pause. */
const MIN_RETRY_BUDGET_MS = 3_000;
/** A Retry-After longer than this is not waited for: the user is watching a spinner. */
const MAX_RETRY_AFTER_MS = 10_000;
/** Busy or briefly broken upstream: asking again shortly can work. Timeouts are not here (they already spent the time). */
const TRANSIENT_STATUSES = new Set([429, 502, 503]);

/** A failed attempt, and whether asking again could help. */
class AttemptFailure {
  constructor(
    readonly error: ApiError,
    readonly transient: boolean,
    /** From the Retry-After header, when there was one. */
    readonly retryAfterMs?: number,
  ) {}
}

/**
 * Chat Completions through OpenRouter with a strict JSON-schema response, mirroring how AntySpendApi's
 * `OpenRouterClient` calls it (same endpoint, privacy flags and error mapping), minus axios/Nest.
 * Knows nothing about recipes or scans: callers parse and validate the returned JSON text.
 * Every failure surfaces as an [ApiError] that is safe to show to API clients.
 *
 * When the model's shared capacity is busy (a 429 from Google's pool, say) OpenRouter is told which models to fall back to, and a
 * rate limit, an overloaded upstream or a dropped connection is asked again after a short pause, all within the call's own timeout.
 */
export class OpenRouterClient {
  constructor(
    private readonly options: OpenRouterClientOptions,
    private readonly log?: FastifyBaseLogger,
  ) {}

  async chatJson(request: ChatJsonRequest): Promise<ChatJsonResult> {
    const deadline = Date.now() + request.timeoutMs;
    // One timeout for the whole call, retries included.
    const signal = request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
      : AbortSignal.timeout(request.timeoutMs);
    const delays = this.options.retryDelaysMs ?? [];

    for (let retry = 0; ; retry++) {
      try {
        return await this.attempt(request, signal);
      } catch (failure) {
        if (!(failure instanceof AttemptFailure)) throw failure;
        const pause = failure.transient ? this.pauseBeforeRetry(delays[retry], failure.retryAfterMs, deadline) : undefined;
        if (pause === undefined || signal.aborted) throw failure.error;
        this.log?.warn({ model: request.model, retry: retry + 1, pauseMs: pause, code: failure.error.code }, "openrouter retrying");
        try {
          await sleep(pause, signal);
        } catch (error) {
          throw new ApiError("upstream_timeout", "The request took too long.", { cause: error });
        }
      }
    }
  }

  /** How long to wait before the next try, or undefined when there is no try left or no time for one. */
  private pauseBeforeRetry(delay: number | undefined, retryAfterMs: number | undefined, deadline: number): number | undefined {
    if (delay === undefined) return undefined;
    if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) return undefined;
    // A little jitter so that clients hit by the same limit do not all come back at once.
    const pause = Math.max(delay, retryAfterMs ?? 0) + (delay > 0 ? Math.floor(Math.random() * 250) : 0);
    return deadline - Date.now() - pause >= MIN_RETRY_BUDGET_MS ? pause : undefined;
  }

  /** One request. Failures come out as [AttemptFailure], saying whether a retry could help. */
  private async attempt(request: ChatJsonRequest, signal: AbortSignal): Promise<ChatJsonResult> {
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(this.buildBody(request)),
        signal,
      });
    } catch (error) {
      const mapped = this.networkError(error, signal);
      // A connection that never got an answer (not our own timeout) can be tried again.
      throw new AttemptFailure(mapped, mapped.code === "upstream_error");
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      throw new AttemptFailure(
        this.mapStatus(request.model, response.status, raw),
        TRANSIENT_STATUSES.has(response.status),
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }

    let data: ChatCompletionResponse;
    try {
      data = (await response.json()) as ChatCompletionResponse;
    } catch (error) {
      // Includes a body that was cut off by our own timeout while streaming in.
      throw new AttemptFailure(
        signal.aborted
          ? new ApiError("upstream_timeout", "The request took too long.", { cause: error })
          : new ApiError("upstream_error", "The answer could not be read. Please try again.", { cause: error }),
        false,
      );
    }

    // HTTP 200 carrying an error, either at the top level or on the choice.
    const bodyError = data.error ?? data.choices?.[0]?.error;
    if (bodyError) {
      const status = normalizeStatus(bodyError.code);
      throw new AttemptFailure(
        this.mapStatus(request.model, status, bodyError.message ?? "error in 200 response"),
        TRANSIENT_STATUSES.has(status),
      );
    }
    return this.toResult(request, data);
  }

  private buildBody(request: ChatJsonRequest): Record<string, unknown> {
    const fallbacks = [...new Set(this.options.fallbackModels ?? [])].filter((model) => model !== request.model);
    return {
      // With fallbacks the call's own model leads the list and OpenRouter moves down it when that one is busy or down.
      ...(fallbacks.length > 0 ? { models: [request.model, ...fallbacks] } : { model: request.model }),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: false,
      provider: {
        // Only route to providers that honour every parameter below (notably the strict schema).
        require_parameters: true,
        data_collection: "deny",
        ...(this.options.zdr ? { zdr: true } : {}),
      },
      ...(request.healing ? { plugins: [{ id: "response-healing" }] } : {}),
      messages: request.messages,
      response_format: {
        type: "json_schema",
        json_schema: { name: request.schemaName, strict: true, schema: request.schema },
      },
    };
  }

  private toResult(request: ChatJsonRequest, data: ChatCompletionResponse): ChatJsonResult {
    const choice = data.choices?.[0];
    if (choice?.message?.refusal || choice?.finish_reason === "content_filter") {
      throw new ApiError("recipe_refused", "Chef could not process this request.");
    }
    if (choice?.finish_reason === "length") {
      this.log?.warn({ model: request.model, maxTokens: request.maxTokens }, "answer truncated by max_tokens");
      throw new ApiError("upstream_error", "The answer was cut off before it was finished.");
    }
    if (choice?.finish_reason === "error") {
      throw new ApiError("upstream_error", "Chef is temporarily unavailable.");
    }

    const content = choice?.message?.content;
    if (!content?.trim()) {
      throw new ApiError("upstream_error", "The answer could not be read. Please try again.");
    }

    return {
      content,
      model: data.model ?? request.model,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };
  }

  /**
   * Status mapping from AntySpendApi, adapted to Chef's error envelope. Problems that only an operator
   * can fix (bad key, no credits, rejected schema) are logged loudly and shown to users as a generic outage.
   */
  private mapStatus(model: string, status: number, detail: string): ApiError {
    const logFields = {
      event: "openrouter_request_failed",
      model,
      status,
      providerBody: detail.slice(0, MAX_LOGGED_BODY_CHARS),
    };

    if (status === 429) {
      this.log?.warn(logFields, "openrouter rate limited");
      return new ApiError("rate_limited", "Chef is busy right now. Please try again in a moment.");
    }
    if (status === 408 || status === 504) {
      this.log?.warn(logFields, "openrouter timed out");
      return new ApiError("upstream_timeout", "The request took too long.");
    }
    if (status === 401) {
      this.log?.error(logFields, "openrouter rejected our API key");
    } else if (status === 402) {
      this.log?.error(logFields, "openrouter account has insufficient credits");
    } else if (status >= 500) {
      this.log?.warn(logFields, "openrouter server error");
    } else {
      // 400/403/404/422: schema rejected, moderation, or no endpoint satisfies require_parameters / zdr.
      this.log?.error(logFields, "openrouter rejected the request");
    }
    return new ApiError("upstream_error", "Chef is temporarily unavailable.");
  }

  private networkError(error: unknown, signal: AbortSignal): ApiError {
    const name = (error as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError" || signal.aborted) {
      // Our per-call timeout, the overall deadline, or the client going away: nobody is waiting for more.
      return new ApiError("upstream_timeout", "The request took too long.", { cause: error });
    }
    this.log?.warn(
      { event: "openrouter_unreachable", cause: (error as { cause?: { code?: string } } | null)?.cause?.code ?? null },
      "could not reach openrouter",
    );
    return new ApiError("upstream_error", "Chef could not reach its kitchen. Please try again.", { cause: error });
  }
}

/** Seconds or an HTTP date, as milliseconds from now; undefined when absent or unreadable. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Waits, unless the call is given up on first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeStatus(code: number | string | undefined): number {
  const numeric = typeof code === "string" ? Number.parseInt(code, 10) : code;
  return typeof numeric === "number" && Number.isFinite(numeric) && numeric >= 400 ? numeric : 502;
}

/** Models occasionally wrap JSON in ```json fences even in strict mode. */
function stripCodeFences(content: string): string {
  return content
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

/** Parses the model's JSON text; anything unparseable is an upstream error, never a client error. */
export function parseJsonContent(content: string): unknown {
  try {
    return JSON.parse(stripCodeFences(content));
  } catch (error) {
    throw new ApiError("upstream_error", "The answer could not be read. Please try again.", { cause: error });
  }
}
