import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { OpenRouterRecipeModel, type OpenRouterModelOptions } from "../src/llm/openRouterRecipeModel.js";
import { buildRecipeJsonSchema } from "../src/llm/recipeJsonSchema.js";
import { buildSystemBlocks } from "../src/llm/prompt.js";
import type { ModelRequest } from "../src/llm/recipeModel.js";
import { completion, recordingLogger, sendJson, startFakeOpenRouter } from "./fakeOpenRouter.js";
import { contractRecipe } from "./helpers.js";

const API_KEY = "sk-or-test-SECRET-KEY-123";

type Fake = Awaited<ReturnType<typeof startFakeOpenRouter>>;
let fake: Fake | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

function model(baseUrl: string, overrides: Partial<OpenRouterModelOptions> = {}, logger?: ReturnType<typeof recordingLogger>) {
  return new OpenRouterRecipeModel(
    {
      apiKey: API_KEY,
      model: "google/gemini-2.5-flash-lite",
      baseUrl,
      maxTokens: 3000,
      temperature: 0.7,
      zdr: true,
      ...overrides,
    },
    logger?.logger,
  );
}

const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  system: buildSystemBlocks("Prefer soon-to-expire items."),
  userMessage: "Create one recipe from this pantry.\n1. Eggs | 6 UNITS | expires tomorrow",
  timeoutMs: 5_000,
  ...overrides,
});

const reply = (content: unknown, overrides: Record<string, unknown> = {}) =>
  startFakeOpenRouter((_req, res) => sendJson(res, 200, completion(content, overrides)));

const rejection = async (promise: Promise<unknown>): Promise<ApiError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected the promise to reject");
};

describe("OpenRouterRecipeModel: request", () => {
  it("posts to /chat/completions with the bearer key", async () => {
    fake = await reply(contractRecipe());

    await model(fake.baseUrl).complete(request());

    const sent = fake.requests[0]!;
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("/api/v1/chat/completions");
    expect(sent.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(sent.headers["content-type"]).toContain("application/json");
  });

  it("tolerates a trailing slash in the base url", async () => {
    fake = await reply(contractRecipe());

    await model(`${fake.baseUrl}/`).complete(request());

    expect(fake.requests[0]!.url).toBe("/api/v1/chat/completions");
  });

  it("mirrors AntySpendApi's call: strict json_schema, privacy flags and response healing", async () => {
    fake = await reply(contractRecipe());

    await model(fake.baseUrl).complete(request());

    const body = fake.requests[0]!.body;
    expect(body.model).toBe("google/gemini-2.5-flash-lite");
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(3000);
    expect(body.provider).toEqual({ require_parameters: true, data_collection: "deny", zdr: true });
    expect(body.plugins).toEqual([{ id: "response-healing" }]);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "chef_recipe", strict: true, schema: buildRecipeJsonSchema() },
    });
  });

  it("uses a non-zero temperature so 'another recipe' differs, and passes the configured value", async () => {
    fake = await reply(contractRecipe());

    await model(fake.baseUrl, { temperature: 1.1 }).complete(request());

    expect(fake.requests[0]!.body.temperature).toBe(1.1);
  });

  it("omits the zdr flag when disabled but keeps the other privacy flags", async () => {
    fake = await reply(contractRecipe());

    await model(fake.baseUrl, { zdr: false }).complete(request());

    expect(fake.requests[0]!.body.provider).toEqual({ require_parameters: true, data_collection: "deny" });
  });

  it("sends the server rules and app guidance as one system message, then the pantry as the user message", async () => {
    fake = await reply(contractRecipe());

    await model(fake.baseUrl).complete(request());

    const [system, user, ...rest] = fake.requests[0]!.body.messages;
    expect(rest).toEqual([]);
    expect(system.role).toBe("system");
    expect(system.content).toContain("Non-negotiable rules");
    expect(system.content).toContain("<app_guidance>\nPrefer soon-to-expire items.\n</app_guidance>");
    expect(user).toEqual({ role: "user", content: expect.stringContaining("Eggs | 6 UNITS") });
  });
});

describe("OpenRouterRecipeModel: successful responses", () => {
  it("returns the validated recipe, token usage and the model that answered", async () => {
    fake = await reply(contractRecipe(), { model: "google/gemini-2.5-flash-lite-001" });

    const result = await model(fake.baseUrl).complete(request());

    expect(result.recipe).toEqual(contractRecipe());
    expect(result.inputTokens).toBe(120);
    expect(result.outputTokens).toBe(80);
    expect(result.model).toBe("google/gemini-2.5-flash-lite-001");
  });

  it("falls back to the requested model name when the response omits it", async () => {
    fake = await reply(contractRecipe(), { model: undefined });

    expect((await model(fake.baseUrl).complete(request())).model).toBe("google/gemini-2.5-flash-lite");
  });

  it.each([
    ["```json fence", (json: string) => `\`\`\`json\n${json}\n\`\`\``],
    ["bare fence", (json: string) => `\`\`\`\n${json}\n\`\`\``],
    ["surrounding whitespace", (json: string) => `\n\n  ${json}  \n`],
  ])("accepts content wrapped in a %s", async (_name, wrap) => {
    fake = await reply(wrap(JSON.stringify(contractRecipe())));

    expect((await model(fake.baseUrl).complete(request())).recipe).toEqual(contractRecipe());
  });

  it("accepts the nullable fields as null (highlight, tip, essentials without an amount)", async () => {
    const recipe = {
      ...contractRecipe(),
      highlight: null,
      ingredientsUsed: [{ name: "Salt", amount: "a pinch", quantity: null, unit: null }],
      instructions: [{ title: "Cook", description: "Cook it.", durationMinutes: 5, tip: null }],
    };
    fake = await reply(recipe);

    const result = await model(fake.baseUrl).complete(request());

    expect(result.recipe.highlight).toBeNull();
    expect(result.recipe.instructions[0]!.tip).toBeNull();
    expect(result.recipe.ingredientsUsed[0]!.quantity).toBeNull();
  });

  it("treats missing usage as zero", async () => {
    fake = await reply(contractRecipe(), { usage: undefined });

    const result = await model(fake.baseUrl).complete(request());

    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });
});

describe("OpenRouterRecipeModel: HTTP failures", () => {
  const cases: Array<[number, string, number]> = [
    [400, "upstream_error", 502],
    [401, "upstream_error", 502], // our key is wrong: an operator problem, never the app user's 401
    [402, "upstream_error", 502], // out of credits: same
    [403, "upstream_error", 502],
    [404, "upstream_error", 502], // e.g. no endpoint satisfies require_parameters / zdr
    [408, "upstream_timeout", 504],
    [429, "rate_limited", 429],
    [500, "upstream_error", 502],
    [502, "upstream_error", 502],
    [503, "upstream_error", 502],
    [504, "upstream_timeout", 504],
  ];

  it.each(cases)("HTTP %i -> %s (%i) without leaking the provider's text", async (status, code, apiStatus) => {
    const secretDetail = "provider-internal-detail-xyz";
    fake = await startFakeOpenRouter((_req, res) => sendJson(res, status, { error: { code: status, message: secretDetail } }));

    const error = await rejection(model(fake.baseUrl).complete(request()));

    expect(error.code).toBe(code);
    expect(error.status).toBe(apiStatus);
    expect(error.message).not.toContain(secretDetail);
  });

  it("copes with a non-JSON error body", async () => {
    fake = await startFakeOpenRouter((_req, res) => {
      res.writeHead(502, { "content-type": "text/html" });
      res.end("<html>Bad gateway</html>");
    });

    expect((await rejection(model(fake.baseUrl).complete(request()))).code).toBe("upstream_error");
  });
});

describe("OpenRouterRecipeModel: errors inside an HTTP 200", () => {
  it.each([
    [{ error: { code: 429, message: "slow down" } }, "rate_limited"],
    [{ error: { code: "429", message: "slow down" } }, "rate_limited"],
    [{ error: { code: 502, message: "provider failed" } }, "upstream_error"],
    [{ error: { code: 408, message: "provider timed out" } }, "upstream_timeout"],
    [{ error: { message: "no code at all" } }, "upstream_error"],
  ])("top-level error %j -> %s", async (body, code) => {
    fake = await startFakeOpenRouter((_req, res) => sendJson(res, 200, body));

    expect((await rejection(model(fake.baseUrl).complete(request()))).code).toBe(code);
  });

  it("an error attached to the choice is also honoured", async () => {
    fake = await startFakeOpenRouter((_req, res) =>
      sendJson(res, 200, { choices: [{ finish_reason: "error", error: { code: 429, message: "x" }, message: { content: null } }] }),
    );

    expect((await rejection(model(fake.baseUrl).complete(request()))).code).toBe("rate_limited");
  });

  it("finish_reason 'error' without details is an upstream error", async () => {
    fake = await startFakeOpenRouter((_req, res) =>
      sendJson(res, 200, { choices: [{ finish_reason: "error", message: { content: "" } }] }),
    );

    expect((await rejection(model(fake.baseUrl).complete(request()))).code).toBe("upstream_error");
  });
});

describe("OpenRouterRecipeModel: unusable model output", () => {
  const upstreamError = async (replyBody: unknown, expectedCode = "upstream_error") => {
    fake = await startFakeOpenRouter((_req, res) => sendJson(res, 200, replyBody));
    expect((await rejection(model(fake.baseUrl).complete(request()))).code).toBe(expectedCode);
  };

  it("truncation (finish_reason length) is reported, not parsed", () =>
    upstreamError(completion('{"title":"Half a rec', { choices: [{ finish_reason: "length", message: { content: '{"title":"Half a rec' } }] })));

  it("content_filter becomes recipe_refused", () =>
    upstreamError(
      completion("", { choices: [{ finish_reason: "content_filter", message: { content: "" } }] }),
      "recipe_refused",
    ));

  it("an explicit refusal becomes recipe_refused", () =>
    upstreamError(
      completion("", { choices: [{ finish_reason: "stop", message: { content: "", refusal: "I can't help with that." } }] }),
      "recipe_refused",
    ));

  it("empty content", () => upstreamError(completion("   ")));
  it("no choices", () => upstreamError({ id: "x", choices: [] }));
  it("content that is not JSON", () => upstreamError(completion("Sure! Here is a lovely recipe for you.")));
  it("truncated JSON", () => upstreamError(completion(JSON.stringify(contractRecipe()).slice(0, 80))));

  it("a missing required field", () => {
    const { nutritionalSummary: _omitted, ...incomplete } = contractRecipe();
    return upstreamError(completion(incomplete));
  });

  it("a wrongly typed field", () => upstreamError(completion({ ...contractRecipe(), prepTimeMinutes: "five" })));
  it("a recipe with no steps", () => upstreamError(completion({ ...contractRecipe(), instructions: [] })));
  it("a step without a title", () =>
    upstreamError(completion({ ...contractRecipe(), instructions: [{ description: "x", durationMinutes: 1, tip: null }] })));
  it("a step with a negative duration", () =>
    upstreamError(completion({ ...contractRecipe(), instructions: [{ title: "a", description: "x", durationMinutes: -1, tip: null }] })));
  it("an unknown difficulty", () => upstreamError(completion({ ...contractRecipe(), difficulty: "IMPOSSIBLE" })));
  it("zero servings", () => upstreamError(completion({ ...contractRecipe(), servings: 0 })));
  it("an ingredient with an unknown unit", () =>
    upstreamError(completion({ ...contractRecipe(), ingredientsUsed: [{ name: "Eggs", amount: "1", quantity: 1, unit: "CUPS" }] })));
  it("no ingredients at all", () => upstreamError(completion({ ...contractRecipe(), ingredientsUsed: [] })));
  it("negative nutrition", () =>
    upstreamError(completion({ ...contractRecipe(), nutritionalSummary: { calories: -5, proteinGrams: 1, carbsGrams: 1, fatGrams: 1 } })));

  it("a 200 whose body is not JSON at all", async () => {
    fake = await startFakeOpenRouter((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("OK");
    });

    expect((await rejection(model(fake.baseUrl).complete(request()))).code).toBe("upstream_error");
  });
});

describe("OpenRouterRecipeModel: time limits and connectivity", () => {
  it("times out when the provider never answers", async () => {
    fake = await startFakeOpenRouter(() => undefined); // accept the request, never reply
    const startedAt = Date.now();

    const error = await rejection(model(fake.baseUrl).complete(request({ timeoutMs: 250 })));

    expect(error.code).toBe("upstream_timeout");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("stops when the caller's signal aborts (deadline or client disconnect)", async () => {
    fake = await startFakeOpenRouter(() => undefined);
    const controller = new AbortController();

    const pending = rejection(model(fake.baseUrl).complete(request({ signal: controller.signal, timeoutMs: 30_000 })));
    setTimeout(() => controller.abort(), 100);

    expect((await pending).code).toBe("upstream_timeout");
  });

  it("is already cancelled if the signal was aborted before the call", async () => {
    fake = await reply(contractRecipe());
    const controller = new AbortController();
    controller.abort();

    expect((await rejection(model(fake.baseUrl).complete(request({ signal: controller.signal })))).code).toBe("upstream_timeout");
    expect(fake.requests).toHaveLength(0);
  });

  it("an unreachable provider is an upstream error, not a timeout", async () => {
    fake = await reply(contractRecipe());
    const baseUrl = fake.baseUrl;
    await fake.close();
    fake = undefined;

    expect((await rejection(model(baseUrl).complete(request()))).code).toBe("upstream_error");
  });

  it("a connection dropped mid-response is an upstream error", async () => {
    fake = await startFakeOpenRouter((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "5000" });
      res.write('{"choices":');
      setTimeout(() => res.destroy(), 20);
    });

    expect((await rejection(model(fake.baseUrl).complete(request()))).code).toBe("upstream_error");
  });
});

describe("OpenRouterRecipeModel: logging", () => {
  it("never writes the API key or the prompt to the logs, even on failures", async () => {
    const logs = recordingLogger();
    const statuses = [401, 402, 429, 500];
    let i = 0;
    fake = await startFakeOpenRouter((_req, res) => sendJson(res, statuses[i++ % statuses.length]!, { error: { message: "nope" } }));
    const m = model(fake.baseUrl, {}, logs);

    for (let n = 0; n < statuses.length; n++) await m.complete(request()).catch(() => undefined);

    expect(logs.entries.length).toBeGreaterThan(0);
    expect(logs.dump()).not.toContain(API_KEY);
    expect(logs.dump()).not.toContain("Eggs");
  });

  it("logs operator-actionable failures at error level and transient ones as warnings", async () => {
    const logs = recordingLogger();
    fake = await startFakeOpenRouter((req, res) => sendJson(res, req.body.max_tokens === 1 ? 429 : 401, { error: { message: "x" } }));

    await model(fake.baseUrl, {}, logs).complete(request()).catch(() => undefined);
    await model(fake.baseUrl, { maxTokens: 1 }, logs).complete(request()).catch(() => undefined);

    expect(logs.entries.map((e) => e.level)).toEqual(["error", "warn"]);
  });

  it("truncates the provider's error body in the logs", async () => {
    const logs = recordingLogger();
    fake = await startFakeOpenRouter((_req, res) => sendJson(res, 400, { error: { message: "y".repeat(5_000) } }));

    await model(fake.baseUrl, {}, logs).complete(request()).catch(() => undefined);

    expect(logs.dump().length).toBeLessThan(1_500);
  });

  it("logs which fields failed validation but not the generated content", async () => {
    const logs = recordingLogger();
    const broken = { ...contractRecipe(), instructions: [], title: "SECRET-RECIPE-TITLE" };
    fake = await reply(broken);

    await model(fake.baseUrl, {}, logs).complete(request()).catch(() => undefined);

    expect(logs.dump()).toContain("instructions");
    expect(logs.dump()).not.toContain("SECRET-RECIPE-TITLE");
  });
});
