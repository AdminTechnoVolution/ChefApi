import type { FastifyBaseLogger } from "fastify";
import { ApiError } from "../errors.js";

export interface OpenRouterClientOptions {
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

/**
 * Chat Completions through OpenRouter with a strict JSON-schema response, mirroring how AntySpendApi's
 * `OpenRouterClient` calls it (same endpoint, privacy flags and error mapping), minus axios/Nest.
 * Knows nothing about recipes or scans: callers parse and validate the returned JSON text.
 * Every failure surfaces as an [ApiError] that is safe to show to API clients.
 */
export class OpenRouterClient {
  constructor(
    private readonly options: OpenRouterClientOptions,
    private readonly log?: FastifyBaseLogger,
  ) {}

  async chatJson(request: ChatJsonRequest): Promise<ChatJsonResult> {
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const signal = request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
      : AbortSignal.timeout(request.timeoutMs);

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
      throw this.networkError(error, signal);
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      throw this.mapStatus(request.model, response.status, raw);
    }

    let data: ChatCompletionResponse;
    try {
      data = (await response.json()) as ChatCompletionResponse;
    } catch (error) {
      // Includes a body that was cut off by our own timeout while streaming in.
      throw signal.aborted
        ? new ApiError("upstream_timeout", "The request took too long.", { cause: error })
        : new ApiError("upstream_error", "The answer could not be read. Please try again.", { cause: error });
    }

    return this.toResult(request, data);
  }

  private buildBody(request: ChatJsonRequest): Record<string, unknown> {
    return {
      model: request.model,
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
    // HTTP 200 carrying an error, either at the top level or on the choice.
    const bodyError = data.error ?? data.choices?.[0]?.error;
    if (bodyError) {
      throw this.mapStatus(request.model, normalizeStatus(bodyError.code), bodyError.message ?? "error in 200 response");
    }

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
