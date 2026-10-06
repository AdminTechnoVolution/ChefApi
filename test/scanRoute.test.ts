import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../src/errors.js";
import { MAX_SCAN_BODY_BYTES, MAX_SCAN_IMAGE_BASE64_CHARS } from "../src/schema.js";
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
  contractScanResult,
  testConfig,
} from "./helpers.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const SCAN_URL = "/v1/ingredients/scan";

async function scanApp(scanner: StubScanner = StubScanner.returning(), env: Record<string, string> = {}) {
  app = await appWith(StubGenerator.returning(contractRecipe()), testConfig({ RATE_LIMIT_MAX: "100", ...env }), scanner);
  return app;
}

const post = (instance: FastifyInstance, payload: unknown, headers: Record<string, string> = authHeaders) =>
  instance.inject({ method: "POST", url: SCAN_URL, headers, payload: typeof payload === "string" ? payload : JSON.stringify(payload) });

const bytesToBase64 = (head: number[], total = 400) =>
  Buffer.from([...head, ...new Array(Math.max(0, total - head.length)).fill(0x41)]).toString("base64");
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP = [...Buffer.from("RIFF"), 1, 2, 3, 4, ...Buffer.from("WEBP")];

const request = (overrides: Record<string, unknown> = {}) => ({
  image: bytesToBase64(JPEG),
  mimeType: "image/jpeg",
  today: "2026-10-05",
  ...overrides,
});

describe("POST /v1/ingredients/scan: contract", () => {
  it("accepts the shared contract request and returns exactly the shared contract result", async () => {
    const instance = await scanApp();

    const res = await post(instance, contractScanRequest());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(contractScanResult());
    // "Strict, minified JSON": byte-identical to the fixture.
    expect(res.body).toBe(contractFixture("scan-response.example.json"));
  });

  it("hands the photo, media type and date to the scanner, with a deadline and an abort signal", async () => {
    const scanner = StubScanner.returning();
    const instance = await scanApp(scanner);
    const body = request({ today: "2027-01-31" });

    await post(instance, body);

    const call = scanner.calls[0]!;
    expect(call.image).toBe(body.image);
    expect(call.mimeType).toBe("image/jpeg");
    expect(call.today).toBe("2027-01-31");
    expect(call.deadlineAt).toBeGreaterThan(Date.now());
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns an empty list when the photo has no food", async () => {
    const instance = await scanApp(StubScanner.returning([]));

    const res = await post(instance, request());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ingredients: [] });
  });

  it("answers with only the ingredients, not the scanner's bookkeeping", async () => {
    const instance = await scanApp(StubScanner.returning());

    const res = await post(instance, request());

    expect(Object.keys(res.json())).toEqual(["ingredients"]);
  });
});

describe("POST /v1/ingredients/scan: authentication", () => {
  it("rejects a missing or wrong app key without calling the scanner", async () => {
    const scanner = StubScanner.returning();
    const instance = await scanApp(scanner);

    const missing = await post(instance, request(), { "content-type": "application/json" });
    const wrong = await post(instance, request(), { ...authHeaders, "x-chef-app-key": "nope" });

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(scanner.calls).toHaveLength(0);
  });

  it("authenticates before reading a large body, so strangers cannot make the server buffer megabytes", async () => {
    const instance = await scanApp();

    const res = await post(instance, request({ image: bytesToBase64(JPEG, 900_000) }), { "content-type": "application/json" });

    expect(res.statusCode).toBe(401);
  });
});

describe("POST /v1/ingredients/scan: validation", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["missing image", { image: undefined }],
    ["image too short to be a photo", { image: "AAAA" }],
    ["a data: URL instead of plain base64", { image: `data:image/jpeg;base64,${bytesToBase64(JPEG)}` }],
    ["non-base64 characters", { image: `${bytesToBase64(JPEG)}!!!` }],
    ["unsupported media type", { mimeType: "image/gif" }],
    ["missing media type", { mimeType: undefined }],
    ["missing date", { today: undefined }],
    ["a date in the wrong format", { today: "05/10/2026" }],
    ["an empty date", { today: "" }],
    ["an image over the size limit", { image: "A".repeat(MAX_SCAN_IMAGE_BASE64_CHARS + 4) }],
  ];

  it.each(cases)("returns 400 for %s and never calls the scanner", async (_name, overrides) => {
    const scanner = StubScanner.returning();
    const instance = await scanApp(scanner);

    const res = await post(instance, request(overrides));

    expect([400, 413]).toContain(res.statusCode);
    expect(["invalid_request", "payload_too_large"]).toContain(res.json().error.code);
    expect(scanner.calls).toHaveLength(0);
  });

  it("never echoes the submitted image back", async () => {
    const instance = await scanApp();
    const image = bytesToBase64(JPEG, 600);

    const res = await post(instance, request({ image, mimeType: "image/gif" }));

    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(image.slice(0, 40));
  });

  it("returns 400 for malformed JSON", async () => {
    const instance = await scanApp();

    expect((await post(instance, '{"image": "abc", ')).statusCode).toBe(400);
  });
});

describe("POST /v1/ingredients/scan: the image must match its declared type", () => {
  it.each([
    ["JPEG bytes declared as PNG", { image: bytesToBase64(JPEG), mimeType: "image/png" }],
    ["PNG bytes declared as JPEG", { image: bytesToBase64(PNG), mimeType: "image/jpeg" }],
    ["WebP bytes declared as JPEG", { image: bytesToBase64(WEBP), mimeType: "image/jpeg" }],
    ["arbitrary bytes declared as JPEG", { image: bytesToBase64([1, 2, 3, 4]), mimeType: "image/jpeg" }],
    ["text declared as PNG", { image: Buffer.from("<html>not an image</html>".repeat(10)).toString("base64"), mimeType: "image/png" }],
  ])("%s -> 400", async (_name, overrides) => {
    const scanner = StubScanner.returning();
    const instance = await scanApp(scanner);

    const res = await post(instance, request(overrides));

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
    expect(res.json().error.message).toContain("mimeType");
    expect(scanner.calls).toHaveLength(0);
  });

  it.each([
    ["JPEG", JPEG, "image/jpeg"],
    ["PNG", PNG, "image/png"],
    ["WebP", WEBP, "image/webp"],
  ])("accepts a genuine %s", async (_name, head, mimeType) => {
    const instance = await scanApp();

    const res = await post(instance, request({ image: bytesToBase64(head), mimeType }));

    expect(res.statusCode).toBe(200);
  });
});

describe("POST /v1/ingredients/scan: body size", () => {
  it("accepts a photo of about 1 MB, far above the 16 KB every other route allows", async () => {
    const instance = await scanApp();

    const res = await post(instance, request({ image: bytesToBase64(JPEG, 1_000_000) }));

    expect(res.statusCode).toBe(200);
  });

  it("rejects a body over its own limit with 413", async () => {
    const instance = await scanApp();
    const huge = JSON.stringify(request({ image: "A".repeat(MAX_SCAN_BODY_BYTES + 100) }));

    const res = await post(instance, huge);

    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("payload_too_large");
  });

  it("does not loosen the limit for the recipe route", async () => {
    const instance = await scanApp();

    const res = await instance.inject({
      method: "POST",
      url: "/v1/recipes/generate",
      headers: authHeaders,
      payload: JSON.stringify({ ...contractRequest(), systemPrompt: "x".repeat(20_000) }),
    });

    expect(res.statusCode).toBe(413);
  });
});

describe("POST /v1/ingredients/scan: error mapping", () => {
  const mapped: Array<[string, number]> = [
    ["recipe_refused", 422],
    ["rate_limited", 429],
    ["upstream_error", 502],
    ["upstream_timeout", 504],
  ];

  it.each(mapped)("maps %s to HTTP %i with the error envelope", async (code, status) => {
    const instance = await scanApp(StubScanner.failingWith(new ApiError(code as never, "Friendly message.")));

    const res = await post(instance, request());

    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: { code, message: "Friendly message." } });
  });

  it("hides the details of unexpected failures", async () => {
    const instance = await scanApp(StubScanner.failingWith(new Error("db password is hunter2")));

    const res = await post(instance, request());

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("hunter2");
  });
});

describe("POST /v1/ingredients/scan: rate limiting", () => {
  const scanPost = (instance: FastifyInstance, forwardedFor?: string) =>
    instance.inject({
      method: "POST",
      url: SCAN_URL,
      headers: { ...authHeaders, ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}) },
      remoteAddress: "10.0.0.4",
      payload: JSON.stringify(request()),
    });

  it("is stricter than the rest of the API", async () => {
    const instance = await scanApp(StubScanner.returning(), { SCAN_RATE_LIMIT_MAX: "2", RATE_LIMIT_MAX: "100" });

    const statuses = [(await scanPost(instance)).statusCode, (await scanPost(instance)).statusCode, (await scanPost(instance)).statusCode];

    expect(statuses).toEqual([200, 200, 429]);
  });

  it("answers with the standard rate_limited envelope", async () => {
    const instance = await scanApp(StubScanner.returning(), { SCAN_RATE_LIMIT_MAX: "1" });
    await scanPost(instance);

    const res = await scanPost(instance);

    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("rate_limited");
  });

  it("does not use up the recipe route's allowance, nor the other way round", async () => {
    const instance = await scanApp(StubScanner.returning(), { SCAN_RATE_LIMIT_MAX: "1", RATE_LIMIT_MAX: "100" });
    await scanPost(instance);
    expect((await scanPost(instance)).statusCode).toBe(429);

    const recipe = await instance.inject({
      method: "POST",
      url: "/v1/recipes/generate",
      headers: authHeaders,
      payload: JSON.stringify(contractRequest()),
    });

    expect(recipe.statusCode).toBe(200);
  });

  it("counts a client once even when a proxy appends a new source port to X-Forwarded-For every time", async () => {
    const instance = await scanApp(StubScanner.returning(), { SCAN_RATE_LIMIT_MAX: "2", TRUST_PROXY: "1" });

    const statuses: number[] = [];
    for (let port = 50_001; port <= 50_004; port++) statuses.push((await scanPost(instance, `203.0.113.7:${port}`)).statusCode);

    expect(statuses).toEqual([200, 200, 429, 429]);
  });

  it("keeps different clients apart", async () => {
    const instance = await scanApp(StubScanner.returning(), { SCAN_RATE_LIMIT_MAX: "1", TRUST_PROXY: "1" });

    expect((await scanPost(instance, "203.0.113.7:50001")).statusCode).toBe(200);
    expect((await scanPost(instance, "203.0.113.8:50001")).statusCode).toBe(200);
    expect((await scanPost(instance, "203.0.113.7:50002")).statusCode).toBe(429);
  });
});

describe("POST /v1/ingredients/scan: key handling", () => {
  it("requires the same shared key as the other /v1 routes", async () => {
    const instance = await scanApp();

    const res = await post(instance, request(), { "content-type": "application/json", "x-chef-app-key": TEST_APP_KEY });

    expect(res.statusCode).toBe(200);
  });
});
