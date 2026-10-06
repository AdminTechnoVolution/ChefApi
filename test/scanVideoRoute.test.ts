import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../src/errors.js";
import {
  MAX_VIDEO_BODY_BYTES,
  MAX_VIDEO_FRAMES,
  MAX_VIDEO_FRAME_BASE64_CHARS,
  MAX_VIDEO_ITEMS,
} from "../src/schema.js";
import {
  StubGenerator,
  StubScanner,
  TEST_APP_KEY,
  appWith,
  authHeaders,
  contractFixture,
  contractRecipe,
  contractRequest,
  contractScanRequest,
  contractScanVideoRequest,
  contractScanVideoResult,
  testConfig,
} from "./helpers.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const VIDEO_URL = "/v1/ingredients/scan-video";

async function videoApp(scanner: StubScanner = StubScanner.returning(), env: Record<string, string> = {}) {
  app = await appWith(StubGenerator.returning(contractRecipe()), testConfig({ RATE_LIMIT_MAX: "100", ...env }), scanner);
  return app;
}

const post = (instance: FastifyInstance, payload: unknown, headers: Record<string, string> = authHeaders) =>
  instance.inject({ method: "POST", url: VIDEO_URL, headers, payload: typeof payload === "string" ? payload : JSON.stringify(payload) });

const bytesToBase64 = (head: number[], total = 400) =>
  Buffer.from([...head, ...new Array(Math.max(0, total - head.length)).fill(0x41)]).toString("base64");
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP = [...Buffer.from("RIFF"), 1, 2, 3, 4, ...Buffer.from("WEBP")];

const frame = (head: number[] = JPEG, total = 400) => bytesToBase64(head, total);
const request = (overrides: Record<string, unknown> = {}) => ({
  frames: [frame(), frame()],
  today: "2026-10-05",
  ...overrides,
});

describe("POST /v1/ingredients/scan-video: contract", () => {
  it("accepts the shared contract request and returns exactly the shared contract result", async () => {
    const instance = await videoApp();

    const res = await post(instance, contractScanVideoRequest());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(contractScanVideoResult());
    // "Strict, minified JSON": byte-identical to the fixture.
    expect(res.body).toBe(contractFixture("scan-video-response.example.json"));
  });

  it("hands every frame with its detected type, the date, language and region to the scanner, with a deadline and an abort signal", async () => {
    const scanner = StubScanner.returning();
    const instance = await videoApp(scanner);
    const frames = [frame(JPEG), frame(PNG), frame(WEBP)];

    await post(instance, request({ frames, today: "2027-01-31", language: "es", region: "CO" }));

    expect(scanner.videoCalls).toHaveLength(1);
    expect(scanner.calls).toHaveLength(0);
    const call = scanner.videoCalls[0]!;
    expect(call.frames).toEqual([
      { image: frames[0], mimeType: "image/jpeg" },
      { image: frames[1], mimeType: "image/png" },
      { image: frames[2], mimeType: "image/webp" },
    ]);
    expect(call.today).toBe("2027-01-31");
    expect(call.language).toBe("es");
    expect(call.region).toBe("CO");
    expect(call.deadlineAt).toBeGreaterThan(Date.now());
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to English and no region when the app sends neither", async () => {
    const scanner = StubScanner.returning();
    const instance = await videoApp(scanner);

    await post(instance, request());

    expect(scanner.videoCalls[0]?.language).toBe("en");
    expect(scanner.videoCalls[0]?.region).toBeUndefined();
  });

  it("returns an empty list when the video shows no food", async () => {
    const instance = await videoApp(StubScanner.returning([], []));

    const res = await post(instance, request());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ingredients: [] });
  });

  it("answers with only the ingredients, not the scanner's bookkeeping", async () => {
    const instance = await videoApp();

    expect(Object.keys((await post(instance, request())).json())).toEqual(["ingredients"]);
  });

  it("keeps the photo route and the video route apart", async () => {
    const scanner = StubScanner.returning();
    const instance = await videoApp(scanner);

    await instance.inject({ method: "POST", url: "/v1/ingredients/scan", headers: authHeaders, payload: JSON.stringify(contractScanRequest()) });

    expect(scanner.calls).toHaveLength(1);
    expect(scanner.videoCalls).toHaveLength(0);
  });
});

describe("POST /v1/ingredients/scan-video: authentication", () => {
  it("rejects a missing or wrong app key without calling the scanner", async () => {
    const scanner = StubScanner.returning();
    const instance = await videoApp(scanner);

    const missing = await post(instance, request(), { "content-type": "application/json" });
    const wrong = await post(instance, request(), { ...authHeaders, "x-chef-app-key": "nope" });

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(scanner.videoCalls).toHaveLength(0);
  });

  it("authenticates before reading a large body, so strangers cannot make the server buffer megabytes", async () => {
    const instance = await videoApp();

    const res = await post(instance, request({ frames: [frame(JPEG, 900_000), frame(JPEG, 900_000)] }), {
      "content-type": "application/json",
    });

    expect(res.statusCode).toBe(401);
  });
});

describe("POST /v1/ingredients/scan-video: validation", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["missing frames", { frames: undefined }],
    ["no frames at all", { frames: [] }],
    ["frames that is not a list", { frames: frame() }],
    [`more than ${MAX_VIDEO_FRAMES} frames`, { frames: Array.from({ length: MAX_VIDEO_FRAMES + 1 }, () => frame()) }],
    ["a frame too short to be a photo", { frames: [frame(), "AAAA"] }],
    ["a data: URL instead of plain base64", { frames: [`data:image/jpeg;base64,${frame()}`] }],
    ["non-base64 characters", { frames: [`${frame()}!!!`] }],
    ["a frame that is not a string", { frames: [frame(), 42] }],
    ["a frame over the size limit", { frames: [frame(), "A".repeat(MAX_VIDEO_FRAME_BASE64_CHARS + 4)] }],
    ["missing date", { today: undefined }],
    ["a date in the wrong format", { today: "05/10/2026" }],
    ["an empty date", { today: "" }],
    ["an unsupported language", { language: "xx" }],
    ["a malformed region", { region: "colombia" }],
  ];

  it.each(cases)("returns 400 for %s and never calls the scanner", async (_name, overrides) => {
    const scanner = StubScanner.returning();
    const instance = await videoApp(scanner);

    const res = await post(instance, request(overrides));

    expect([400, 413]).toContain(res.statusCode);
    expect(["invalid_request", "payload_too_large"]).toContain(res.json().error.code);
    expect(scanner.videoCalls).toHaveLength(0);
  });

  it("accepts from one frame up to the maximum", async () => {
    const instance = await videoApp();

    for (const count of [1, 4, MAX_VIDEO_FRAMES]) {
      const res = await post(instance, request({ frames: Array.from({ length: count }, () => frame()) }));
      expect(res.statusCode, `${count} frames`).toBe(200);
    }
  });

  it("returns 400 for malformed JSON", async () => {
    const instance = await videoApp();

    expect((await post(instance, '{"frames": ["abc", ')).statusCode).toBe(400);
  });
});

describe("POST /v1/ingredients/scan-video: every frame must really be an image", () => {
  it.each([
    ["plain text", Buffer.from("this is definitely not a photo ".repeat(20)).toString("base64")],
    ["a GIF", bytesToBase64([...Buffer.from("GIF89a")])],
    ["an MP4 video (the video itself must not be sent)", bytesToBase64([0, 0, 0, 0x20, ...Buffer.from("ftypisom")])],
  ])("rejects %s with 400 and names the frame", async (_name, bad) => {
    const scanner = StubScanner.returning();
    const instance = await videoApp(scanner);

    const res = await post(instance, request({ frames: [frame(), frame(PNG), bad] }));

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
    expect(res.json().error.message).toContain("frames.2");
    expect(scanner.videoCalls).toHaveLength(0);
  });

  it("never echoes a submitted frame back", async () => {
    const instance = await videoApp();
    const bad = Buffer.from("SECRET-KITCHEN-FRAME ".repeat(30)).toString("base64");

    const res = await post(instance, request({ frames: [bad] }));

    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(bad.slice(0, 40));
  });
});

describe("POST /v1/ingredients/scan-video: body size", () => {
  it("accepts the largest legitimate upload: every frame at its largest, far above the 16 KB every other route allows", async () => {
    const instance = await videoApp();
    const frames = Array.from({ length: MAX_VIDEO_FRAMES }, () => frame(JPEG, MAX_VIDEO_FRAME_BASE64_CHARS * 0.75 - 4));

    const res = await post(instance, request({ frames }));

    expect(res.statusCode).toBe(200);
  });

  it("rejects a body over its own limit with 413", async () => {
    const instance = await videoApp();
    const huge = JSON.stringify(request({ frames: ["A".repeat(MAX_VIDEO_BODY_BYTES + 100)] }));

    const res = await post(instance, huge);

    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("payload_too_large");
  });

  it("does not loosen the limit for the recipe route", async () => {
    const instance = await videoApp();

    const res = await instance.inject({
      method: "POST",
      url: "/v1/recipes/generate",
      headers: authHeaders,
      payload: JSON.stringify({ ...contractRequest(), systemPrompt: "x".repeat(20_000) }),
    });

    expect(res.statusCode).toBe(413);
  });
});

describe("POST /v1/ingredients/scan-video: results", () => {
  it(`returns up to ${MAX_VIDEO_ITEMS} items, more than a photo does`, async () => {
    const item = contractScanVideoResult().ingredients[0]!;
    const many = Array.from({ length: MAX_VIDEO_ITEMS }, (_, i) => ({ ...item, name: `Item ${i}` }));
    const instance = await videoApp(StubScanner.returning([], many));

    const res = await post(instance, request());

    expect(res.statusCode).toBe(200);
    expect(res.json().ingredients).toHaveLength(MAX_VIDEO_ITEMS);
  });
});

describe("POST /v1/ingredients/scan-video: error mapping", () => {
  const mapped: Array<[string, number]> = [
    ["recipe_refused", 422],
    ["rate_limited", 429],
    ["upstream_error", 502],
    ["upstream_timeout", 504],
  ];

  it.each(mapped)("maps %s to HTTP %i with the error envelope", async (code, status) => {
    const instance = await videoApp(StubScanner.failingWith(new ApiError(code as never, "Friendly message.")));

    const res = await post(instance, request());

    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: { code, message: "Friendly message." } });
  });

  it("hides the details of unexpected failures", async () => {
    const instance = await videoApp(StubScanner.failingWith(new Error("db password is hunter2")));

    const res = await post(instance, request());

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("hunter2");
  });
});

describe("POST /v1/ingredients/scan-video: rate limiting", () => {
  const videoPost = (instance: FastifyInstance, forwardedFor?: string) =>
    instance.inject({
      method: "POST",
      url: VIDEO_URL,
      headers: { ...authHeaders, ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}) },
      remoteAddress: "10.0.0.4",
      payload: JSON.stringify(request()),
    });

  const photoPost = (instance: FastifyInstance) =>
    instance.inject({
      method: "POST",
      url: "/v1/ingredients/scan",
      headers: authHeaders,
      remoteAddress: "10.0.0.4",
      payload: JSON.stringify(contractScanRequest()),
    });

  it("is as strict as the photo scan, and stricter than the rest of the API", async () => {
    const instance = await videoApp(StubScanner.returning(), { SCAN_RATE_LIMIT_MAX: "2", RATE_LIMIT_MAX: "100" });

    const statuses = [(await videoPost(instance)).statusCode, (await videoPost(instance)).statusCode, (await videoPost(instance)).statusCode];

    expect(statuses).toEqual([200, 200, 429]);
  });

  it("answers with the standard rate_limited envelope", async () => {
    const instance = await videoApp(StubScanner.returning(), { SCAN_RATE_LIMIT_MAX: "1" });
    await videoPost(instance);

    const res = await videoPost(instance);

    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("rate_limited");
  });

  it("counts apart from the photo scan and the recipe route", async () => {
    const instance = await videoApp(StubScanner.returning(), { SCAN_RATE_LIMIT_MAX: "1", RATE_LIMIT_MAX: "100" });
    await videoPost(instance);
    expect((await videoPost(instance)).statusCode).toBe(429);

    expect((await photoPost(instance)).statusCode).toBe(200);
    const recipe = await instance.inject({
      method: "POST",
      url: "/v1/recipes/generate",
      headers: authHeaders,
      payload: JSON.stringify(contractRequest()),
    });
    expect(recipe.statusCode).toBe(200);
  });

  it("counts a client once even when a proxy appends a new source port to X-Forwarded-For every time", async () => {
    const instance = await videoApp(StubScanner.returning(), { SCAN_RATE_LIMIT_MAX: "2", TRUST_PROXY: "1" });

    const statuses: number[] = [];
    for (let port = 50_001; port <= 50_004; port++) statuses.push((await videoPost(instance, `203.0.113.7:${port}`)).statusCode);

    expect(statuses).toEqual([200, 200, 429, 429]);
  });

  it("keeps different clients apart", async () => {
    const instance = await videoApp(StubScanner.returning(), { SCAN_RATE_LIMIT_MAX: "1", TRUST_PROXY: "1" });

    expect((await videoPost(instance, "203.0.113.7:50001")).statusCode).toBe(200);
    expect((await videoPost(instance, "203.0.113.8:50001")).statusCode).toBe(200);
    expect((await videoPost(instance, "203.0.113.7:50002")).statusCode).toBe(429);
  });
});

describe("POST /v1/ingredients/scan-video: key handling", () => {
  it("requires the same shared key as the other /v1 routes", async () => {
    const instance = await videoApp();

    const res = await post(instance, request(), { "content-type": "application/json", "x-chef-app-key": TEST_APP_KEY });

    expect(res.statusCode).toBe(200);
  });
});
