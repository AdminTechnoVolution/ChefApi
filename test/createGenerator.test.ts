import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AppKeyVerifier } from "../src/auth/clientVerifier.js";
import { createGenerator } from "../src/llm/createGenerator.js";
import { createScanner } from "../src/scan/createScanner.js";
import { completion, sendJson, startFakeOpenRouter } from "./fakeOpenRouter.js";
import { StubAssistant, StubExtractor, StubScanner, StubSuggester, TEST_APP_KEY, authHeaders, contractRecipe, contractRequest, testConfig } from "./helpers.js";

let fake: Awaited<ReturnType<typeof startFakeOpenRouter>> | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe("createScanner", () => {
  it("fails fast at startup without an OpenRouter key", () => {
    expect(() => createScanner(testConfig())).toThrow(/OPENROUTER_API_KEY is required/);
  });

  it("builds when the key is present", () => {
    expect(() => createScanner(testConfig({ OPENROUTER_API_KEY: "sk-or-x" }))).not.toThrow();
  });
});

describe("createGenerator", () => {
  it("fails fast at startup without an OpenRouter key", () => {
    expect(() => createGenerator(testConfig())).toThrow(/OPENROUTER_API_KEY is required/);
    expect(() => createGenerator(testConfig({ OPENROUTER_API_KEY: "" }))).toThrow(/OPENROUTER_API_KEY/);
  });

  it("builds the OpenRouter pipeline when a key is present", () => {
    expect(() => createGenerator(testConfig({ OPENROUTER_API_KEY: "sk-or-x" }))).not.toThrow();
  });

});

describe("full request through the HTTP API into a (fake) OpenRouter", () => {
  async function appAgainst(baseUrl: string, extra: Record<string, string> = {}) {
    const config = testConfig({ OPENROUTER_API_KEY: "sk-or-e2e", OPENROUTER_BASE_URL: baseUrl, ...extra });
    return buildApp({
      config,
      verifier: new AppKeyVerifier(TEST_APP_KEY),
      generator: (log) => createGenerator(config, log),
      scanner: StubScanner.returning(),
      suggester: StubSuggester.returning(),
      extractor: StubExtractor.returning(),
      assistant: StubAssistant.returning(),
      logger: false,
    });
  }

  const post = (app: Awaited<ReturnType<typeof appAgainst>>) =>
    app.inject({ method: "POST", url: "/v1/recipes/generate", headers: authHeaders, payload: contractRequest() });

  it("returns one clean emoji for the dish, whatever the model wrote around it", async () => {
    fake = await startFakeOpenRouter((_req, res) => sendJson(res, 200, completion({ ...contractRecipe(), emoji: "🍳🍳 delicious" })));
    const app = await appAgainst(fake.baseUrl);

    const res = await post(app);

    expect(res.statusCode).toBe(200);
    expect(res.json().emoji).toBe("🍳");
  });

  it("a recipe whose emoji is missing or not an emoji still comes back, with an empty one", async () => {
    fake = await startFakeOpenRouter((_req, res) => sendJson(res, 200, completion({ ...contractRecipe(), emoji: "tasty" })));
    const app = await appAgainst(fake.baseUrl);

    const res = await post(app);

    expect(res.statusCode).toBe(200);
    expect(res.json().emoji).toBe("");
  });

  it("asks the model for the dish's emoji", async () => {
    fake = await startFakeOpenRouter((_req, res) => sendJson(res, 200, completion(contractRecipe())));
    const app = await appAgainst(fake.baseUrl);

    await post(app);

    expect(String(fake.requests[0]!.body.messages[0].content)).toContain('"emoji" is exactly one emoji that pictures the dish');
  });

  it("returns the recipe the model produced, as minified contract JSON", async () => {
    fake = await startFakeOpenRouter((_req, res) => sendJson(res, 200, completion(contractRecipe())));
    const app = await appAgainst(fake.baseUrl);

    const res = await post(app);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(contractRecipe());
    expect(res.body).not.toMatch(/\n|: /); // minified
    await app.close();
  });

  it("sends the app's pantry and rules to OpenRouter, never the app key", async () => {
    fake = await startFakeOpenRouter((_req, res) => sendJson(res, 200, completion(contractRecipe())));
    const app = await appAgainst(fake.baseUrl);

    await post(app);

    const upstream = fake.requests[0]!;
    expect(upstream.headers.authorization).toBe("Bearer sk-or-e2e");
    expect(JSON.stringify(upstream.body)).not.toContain(TEST_APP_KEY);
    const [system, user] = upstream.body.messages;
    expect(system.content).toContain("Non-negotiable rules");
    expect(user.content).toContain("Tomatoes");
    await app.close();
  });

  it("retries once when the model uses an unlisted ingredient, then succeeds", async () => {
    const violating = {
      ...contractRecipe(),
      ingredientsUsed: [{ name: "Eggs", amount: "2", quantity: 2, unit: "UNITS" }, { name: "Chicken", amount: "300 g", quantity: 300, unit: "GRAMS" }],
    };
    let call = 0;
    fake = await startFakeOpenRouter((_req, res) =>
      sendJson(res, 200, completion(call++ === 0 ? violating : contractRecipe())),
    );
    const app = await appAgainst(fake.baseUrl);

    const res = await post(app);

    expect(res.statusCode).toBe(200);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.body.messages[1].content).toContain("not in the pantry: Chicken");
    await app.close();
  });

  it("answers 422 and never returns a recipe that keeps breaking the ingredients-only rule", async () => {
    const violating = {
      ...contractRecipe(),
      ingredientsUsed: [{ name: "Chicken", amount: "300 g", quantity: 300, unit: "GRAMS" }],
    };
    fake = await startFakeOpenRouter((_req, res) => sendJson(res, 200, completion(violating)));
    const app = await appAgainst(fake.baseUrl);

    const res = await post(app);

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("recipe_constraint_violation");
    await app.close();
  });

  it("maps an OpenRouter outage to 502 with the safe envelope", async () => {
    fake = await startFakeOpenRouter((_req, res) => sendJson(res, 402, { error: { message: "Insufficient credits" } }));
    const app = await appAgainst(fake.baseUrl);

    const res = await post(app);

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: { code: "upstream_error", message: "Chef is temporarily unavailable." } });
    expect(res.body).not.toContain("credits");
    await app.close();
  });

  it("maps an OpenRouter rate limit to 429", async () => {
    fake = await startFakeOpenRouter((_req, res) => sendJson(res, 429, { error: { message: "slow down" } }));
    const app = await appAgainst(fake.baseUrl);

    expect((await post(app)).statusCode).toBe(429);
    await app.close();
  });

  it("answers 504 when OpenRouter is slower than the upstream timeout", async () => {
    fake = await startFakeOpenRouter(() => undefined);
    const app = await appAgainst(fake.baseUrl, { UPSTREAM_TIMEOUT_MS: "5000", REQUEST_DEADLINE_MS: "5000" });

    const res = await post(app);

    expect(res.statusCode).toBe(504);
    expect(res.json().error.code).toBe("upstream_timeout");
    await app.close();
  }, 15_000);
});
