import http, { type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyBaseLogger } from "fastify";

export interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: any;
}

export type Handler = (request: CapturedRequest, response: ServerResponse) => void | Promise<void>;

/** A real HTTP server standing in for OpenRouter, so the client's headers, timeouts and abort handling are exercised for real. */
export async function startFakeOpenRouter(handler: Handler) {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        /* keep the raw string */
      }
      const captured: CapturedRequest = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(captured);
      await handler(captured, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

/** A well-formed OpenRouter chat completion whose message content is [content]. */
export function completion(content: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: "gen-test",
    model: "google/gemini-2.5-flash-lite",
    provider: "Google",
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) },
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 80 },
    ...overrides,
  };
}

/** Logger that records everything so tests can assert what was (and was not) written to the logs. */
export function recordingLogger() {
  const entries: Array<{ level: string; args: unknown[] }> = [];
  const record = (level: string) => (...args: unknown[]) => {
    entries.push({ level, args });
  };
  const logger = {
    trace: record("trace"),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
    child: () => logger,
    level: "trace",
    silent: () => undefined,
  } as unknown as FastifyBaseLogger;
  return { logger, entries, dump: () => JSON.stringify(entries) };
}
