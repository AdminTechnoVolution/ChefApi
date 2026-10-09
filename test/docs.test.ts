import SwaggerParser from "@apidevtools/swagger-parser";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  GenerateRecipeRequestSchema,
  MAX_VIDEO_FRAMES,
  MAX_VIDEO_SECONDS,
  RecipeSchema,
  ScanResultSchema,
  ScanVideoResultSchema,
} from "../src/schema.js";
import { registerDocs } from "../src/apiDocs.js";
import {
  StubGenerator,
  TEST_APP_KEY,
  appWith,
  contractRecipe,
  contractRequest,
  contractScanResult,
  contractScanVideoResult,
  contractAssistantAdd,
  contractExtractResult,
  contractSuggestResult,
  testConfig,
} from "./helpers.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const PRODUCTION = { NODE_ENV: "production", CHEF_APP_KEY: "a-long-production-secret-key-123456" };

async function docsApp(env: Record<string, string> = {}) {
  app = await appWith(StubGenerator.returning(contractRecipe()), testConfig(env));
  return app;
}

const get = (instance: FastifyInstance, url: string) => instance.inject({ method: "GET", url });

async function openApi(env: Record<string, string> = {}): Promise<any> {
  const res = await get(await docsApp(env), "/openapi.json");
  expect(res.statusCode).toBe(200);
  return res.json();
}

const generateOperation = (doc: any) => doc.paths["/v1/recipes/generate"].post;
const scanOperation = (doc: any) => doc.paths["/v1/ingredients/scan"].post;
const scanVideoOperation = (doc: any) => doc.paths["/v1/ingredients/scan-video"].post;
const suggestOperation = (doc: any) => doc.paths["/v1/ingredients/suggest"].post;
const extractOperation = (doc: any) => doc.paths["/v1/ingredients/extract"].post;
const assistantOperation = (doc: any) => doc.paths["/v1/assistant/understand"].post;

describe("docs endpoints", () => {
  it("serve Swagger UI at /docs and the OpenAPI document at /docs-json and /openapi.json", async () => {
    const instance = await docsApp();

    const ui = await get(instance, "/docs/");
    const viaDocsJson = await get(instance, "/docs-json");
    const viaOpenApiJson = await get(instance, "/openapi.json");

    expect(ui.statusCode).toBe(200);
    expect(ui.headers["content-type"]).toContain("text/html");
    expect(ui.body.toLowerCase()).toContain("swagger");
    expect(viaDocsJson.statusCode).toBe(200);
    expect(viaDocsJson.json()).toEqual(viaOpenApiJson.json());
  });

  it("show the Chef icon as the browser-tab favicon instead of Swagger's", async () => {
    const instance = await docsApp();

    const page = await get(instance, "/docs/");
    expect(page.body).toMatch(/<link rel="icon"[^>]*favicon\.png/);
    expect(page.body).not.toContain("favicon-32x32.png");

    const favicon = await get(instance, "/docs/static/theme/favicon.png");
    expect(favicon.statusCode).toBe(200);
    expect(favicon.headers["content-type"]).toBe("image/png");
    expect(favicon.rawPayload.subarray(0, 4).toString("hex")).toBe("89504e47");
  });

  it("show the Chef icon next to the name in Swagger UI's top bar", async () => {
    const initializer = await get(await docsApp(), "/docs/static/swagger-initializer.js");

    const logo = /data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/.exec(initializer.body)?.[1];
    expect(logo).toBeDefined();
    const svg = Buffer.from(logo!, "base64").toString("utf8");
    expect(svg).toContain("data:image/png;base64,");
    expect(svg).toContain(">Chef</text>");
  });

  it("/docs (no trailing slash) works too", async () => {
    expect((await get(await docsApp(), "/docs")).statusCode).toBe(200);
  });

  it("need no app key", async () => {
    const instance = await docsApp();

    expect((await get(instance, "/openapi.json")).statusCode).toBe(200);
    expect((await get(instance, "/docs/")).statusCode).toBe(200);
  });

  it("are on by default outside production", async () => {
    expect((await get(await docsApp({ NODE_ENV: "development" }), "/docs/")).statusCode).toBe(200);
  });

  it("are off by default in production, with the normal not_found envelope", async () => {
    const instance = await docsApp(PRODUCTION);

    for (const url of ["/docs", "/docs/", "/docs-json", "/openapi.json", "/docs/json", "/docs/static/index.html"]) {
      const res = await get(instance, url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error.code, url).toBe("not_found");
    }
  });

  it("do not even load the swagger plugins when disabled", async () => {
    const instance = await docsApp(PRODUCTION);

    expect(instance.hasPlugin("@fastify/swagger")).toBe(false);
    expect(instance.hasPlugin("@fastify/swagger-ui")).toBe(false);
  });

  it("can be forced on in production with ENABLE_SWAGGER=1", async () => {
    expect((await get(await docsApp({ ...PRODUCTION, ENABLE_SWAGGER: "1" }), "/docs/")).statusCode).toBe(200);
  });

  it("can be forced off outside production with ENABLE_SWAGGER=0", async () => {
    const instance = await docsApp({ ENABLE_SWAGGER: "0" });

    expect((await get(instance, "/docs/")).statusCode).toBe(404);
    expect((await get(instance, "/openapi.json")).statusCode).toBe(404);
  });

  it("are never throttled, so loading the UI cannot trip the rate limit", async () => {
    const instance = await docsApp({ RATE_LIMIT_MAX: "1" });

    const statuses: number[] = [];
    for (const url of ["/docs/", "/docs/", "/docs-json", "/openapi.json", "/docs/json", "/docs/"]) {
      statuses.push((await get(instance, url)).statusCode);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
  });

  it("do not weaken the rate limit on the real endpoint", async () => {
    const instance = await docsApp({ RATE_LIMIT_MAX: "2" });
    const post = () =>
      instance.inject({
        method: "POST",
        url: "/v1/recipes/generate",
        headers: { "x-chef-app-key": TEST_APP_KEY, "content-type": "application/json" },
        payload: contractRequest(),
      });

    await get(instance, "/docs/");
    const statuses = [(await post()).statusCode, (await post()).statusCode, (await post()).statusCode];

    expect(statuses).toEqual([200, 200, 429]);
  });
});

describe("startup message", () => {
  async function startupLog(env: Record<string, string>): Promise<string> {
    const lines: string[] = [];
    const instance = Fastify({ logger: { level: "info", stream: { write: (line: string) => void lines.push(line) } } });
    await registerDocs(instance, testConfig(env));
    await instance.close();
    return lines.join("\n");
  }

  it("says the docs are on and where", async () => {
    const log = await startupLog({});

    expect(log).toContain("API docs are on");
    expect(log).toContain("/docs");
    expect(log).toContain("/openapi.json");
  });

  it("explains why the docs are off in production and how to turn them on", async () => {
    const log = await startupLog(PRODUCTION);

    expect(log).toContain("API docs are off by default when NODE_ENV=production");
    expect(log).toContain("ENABLE_SWAGGER=1");
  });

  it("says so when they were switched off explicitly", async () => {
    const log = await startupLog({ ENABLE_SWAGGER: "0" });

    expect(log).toContain("API docs are off (ENABLE_SWAGGER is disabled)");
    expect(log).not.toContain("API docs are on");
  });
});

describe("the OpenAPI document", () => {
  it("is a valid OpenAPI document (what Swagger UI needs to render it)", async () => {
    const doc = await openApi();

    await expect(SwaggerParser.validate(structuredClone(doc))).resolves.toBeDefined();
  });

  it("describes the API and the app-key security scheme", async () => {
    const doc = await openApi();

    expect(doc.info.title).toBe("Chef API");
    expect(doc.info.description).toContain("X-Chef-App-Key");
    expect(doc.components.securitySchemes.appKey).toMatchObject({ type: "apiKey", in: "header", name: "X-Chef-App-Key" });
    expect(generateOperation(doc).security).toEqual([{ appKey: [] }]);
  });

  it("documents the generate and scan endpoints and the health probe", async () => {
    const doc = await openApi();

    expect(Object.keys(doc.paths).sort()).toEqual([
      "/healthz",
      "/v1/assistant/understand",
      "/v1/ingredients/extract",
      "/v1/ingredients/scan",
      "/v1/ingredients/scan-video",
      "/v1/ingredients/suggest",
      "/v1/recipes/generate",
    ]);
    expect(generateOperation(doc).tags).toEqual(["recipes"]);
    expect(scanOperation(doc).tags).toEqual(["ingredients"]);
    expect(scanVideoOperation(doc).tags).toEqual(["ingredients"]);
    expect(suggestOperation(doc).tags).toEqual(["ingredients"]);
    expect(doc.paths["/healthz"].get.tags).toEqual(["meta"]);
  });

  it("does not list the documentation routes themselves", async () => {
    const doc = await openApi();

    for (const path of Object.keys(doc.paths)) expect(path).not.toMatch(/docs|openapi/);
  });

  it("documents every status code the API can return, each with its own explanation", async () => {
    const responses = generateOperation(await openApi()).responses;

    expect(Object.keys(responses).sort()).toEqual(["200", "400", "401", "403", "413", "422", "429", "500", "502", "504"]);
    const descriptions = Object.values<any>(responses).map((r) => r.description as string);
    expect(new Set(descriptions).size).toBe(descriptions.length);
    expect(descriptions.filter((d) => /default response/i.test(d))).toEqual([]);
    for (const code of ["400", "401", "403", "413", "422", "429", "500", "502", "504"]) {
      expect(responses[code].content["application/json"].schema.properties.error.properties).toHaveProperty("code");
    }
  });

  it("names the error codes in the response descriptions", async () => {
    const responses = generateOperation(await openApi()).responses;

    const expected: Record<string, string> = {
      "400": "invalid_request", "401": "unauthorized", "403": "plan_required", "413": "payload_too_large", "422": "recipe_constraint_violation",
      "429": "rate_limited", "500": "internal_error", "502": "upstream_error", "504": "upstream_timeout",
    };
    for (const [status, code] of Object.entries(expected)) expect(responses[status].description).toContain(code);
  });

  it("documents every request field", async () => {
    const schema = generateOperation(await openApi()).requestBody.content["application/json"].schema;

    expect(Object.keys(schema.properties).sort()).toEqual(["diets", "dish", "ingredients", "language", "region", "systemPrompt"]);
    for (const [name, property] of Object.entries<any>(schema.properties)) expect(property.description, name).toBeTruthy();
    const ingredient = schema.properties.ingredients.items;
    expect(Object.keys(ingredient.properties).sort()).toEqual(["category", "expirationTimestamp", "name", "quantity", "unit"]);
    for (const [name, property] of Object.entries<any>(ingredient.properties)) expect(property.description, name).toBeTruthy();
  });

  it("documents every response field", async () => {
    const schema = generateOperation(await openApi()).responses["200"].content["application/json"].schema;

    expect(schema.required.length).toBe(12);
    expect(schema.required).toContain("missingIngredients");
    for (const [name, property] of Object.entries<any>(schema.properties)) expect(property.description, name).toBeTruthy();
    for (const [name, property] of Object.entries<any>(schema.properties.nutritionalSummary.properties)) {
      expect(property.description, name).toBeTruthy();
    }
  });

  it("lists the allowed enum values for unit and category", async () => {
    const ingredient = generateOperation(await openApi()).requestBody.content["application/json"].schema.properties.ingredients.items;

    expect(ingredient.properties.unit.enum).toEqual(["GRAMS", "KILOGRAMS", "MILLILITERS", "LITERS", "UNITS"]);
    expect(ingredient.properties.category.enum).toEqual([
      "DAIRY", "MEAT_POULTRY", "VEGETABLES", "FRUITS", "PANTRY_STAPLES", "BAKERY", "SEAFOOD", "OTHER",
    ]);
  });

  describe("error examples", () => {
    const exampleOf = (doc: any, status: string) =>
      generateOperation(doc).responses[status].content["application/json"].schema.example;

    it("every error response has a realistic example whose code is the one its description names", async () => {
      const doc = await openApi();

      for (const status of ["400", "401", "403", "413", "422", "429", "500", "502", "504"]) {
        const example = exampleOf(doc, status);
        expect(example.error.code, status).toMatch(/^[a-z_]+$/);
        expect(example.error.message, status).not.toBe("string");
        expect(generateOperation(doc).responses[status].description, status).toContain(example.error.code);
      }
    });

    it("the 401, 413, 429 and 400 examples are exactly what the API really returns", async () => {
      const instance = await docsApp({ RATE_LIMIT_MAX: "100" });
      const doc = (await get(instance, "/openapi.json")).json();
      const post = (headers: Record<string, string>, payload: unknown) =>
        instance.inject({ method: "POST", url: "/v1/recipes/generate", headers: { "content-type": "application/json", ...headers }, payload: JSON.stringify(payload) });
      const authed = { "x-chef-app-key": TEST_APP_KEY };

      expect((await post({}, contractRequest())).json()).toEqual(exampleOf(doc, "401"));
      expect((await post(authed, { systemPrompt: "x".repeat(20_000), ingredients: [] })).json()).toEqual(exampleOf(doc, "413"));

      const invalid = (await post(authed, { systemPrompt: "x", ingredients: [] })).json();
      expect(invalid).toEqual(exampleOf(doc, "400"));
    });

    it("the 429 example is exactly what the rate limiter returns", async () => {
      const instance = await docsApp({ RATE_LIMIT_MAX: "1" });
      const doc = (await get(instance, "/openapi.json")).json();
      const post = () =>
        instance.inject({
          method: "POST",
          url: "/v1/recipes/generate",
          headers: { "x-chef-app-key": TEST_APP_KEY, "content-type": "application/json" },
          payload: contractRequest(),
        });

      await post();
      const limited = await post();

      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toEqual(exampleOf(doc, "429"));
    });
  });

  describe("examples", () => {
    it("the request example is accepted by the real request schema", async () => {
      const example = generateOperation(await openApi()).requestBody.content["application/json"].schema.example;

      expect(() => GenerateRecipeRequestSchema.parse(example)).not.toThrow();
    });

    it("the request example uses exactly the shared contract ingredients (no drift)", async () => {
      const example = generateOperation(await openApi()).requestBody.content["application/json"].schema.example;

      expect(example.ingredients).toEqual(contractRequest().ingredients);
    });

    it("the response example is exactly the shared contract recipe (no drift)", async () => {
      const example = generateOperation(await openApi()).responses["200"].content["application/json"].schema.example;

      expect(example).toEqual(contractRecipe());
      expect(() => RecipeSchema.parse(example)).not.toThrow();
    });
  });

  describe("scan endpoint", () => {
    it("documents the secured operation with every status the API can return", async () => {
      const op = scanOperation(await openApi());

      expect(op.security).toEqual([{ appKey: [] }]);
      expect(op.summary).toMatch(/receipt or packaging/i);
      expect(Object.keys(op.responses).sort()).toEqual(["200", "400", "401", "403", "413", "422", "429", "500", "502", "504"]);
    });

    it("documents every request and response field", async () => {
      const op = scanOperation(await openApi());
      const request = op.requestBody.content["application/json"].schema;
      const item = op.responses["200"].content["application/json"].schema.properties.ingredients.items;

      expect(Object.keys(request.properties).sort()).toEqual(["image", "language", "mimeType", "region", "today"]);
      for (const [name, property] of Object.entries<any>(request.properties)) expect(property.description, name).toBeTruthy();
      expect(Object.keys(item.properties).sort()).toEqual(
        ["category", "emoji", "expiresOn", "name", "quantity", "shelfLifeDays", "storage", "unit"],
      );
      for (const [name, property] of Object.entries<any>(item.properties)) expect(property.description, name).toBeTruthy();
      expect(item.properties.storage.enum).toEqual(["FRIDGE", "FREEZER", "PANTRY"]);
    });

    it("the response example is exactly the shared contract scan result (no drift)", async () => {
      const example = scanOperation(await openApi()).responses["200"].content["application/json"].schema.example;

      expect(example).toEqual(contractScanResult());
      expect(() => ScanResultSchema.parse(example)).not.toThrow();
    });

    it("the description states the limits and the cost warning", async () => {
      const description = scanOperation(await openApi({ SCAN_RATE_LIMIT_MAX: "4", RATE_LIMIT_WINDOW_MS: "120000" })).description as string;

      expect(description).toContain("4 scans per 120 s");
      expect(description).toMatch(/costs money/i);
      expect(description).toMatch(/1 MB/);
    });
  });

  describe("scan-video endpoint", () => {
    it("documents the secured operation with every status the API can return", async () => {
      const op = scanVideoOperation(await openApi());

      expect(op.security).toEqual([{ appKey: [] }]);
      expect(op.summary).toMatch(/kitchen video/i);
      expect(Object.keys(op.responses).sort()).toEqual(["200", "400", "401", "403", "413", "422", "429", "500", "502", "504"]);
    });

    it("documents every request and response field", async () => {
      const op = scanVideoOperation(await openApi());
      const request = op.requestBody.content["application/json"].schema;
      const item = op.responses["200"].content["application/json"].schema.properties.ingredients.items;

      expect(Object.keys(request.properties).sort()).toEqual(["frames", "language", "region", "today"]);
      for (const [name, property] of Object.entries<any>(request.properties)) expect(property.description, name).toBeTruthy();
      expect(request.properties.frames.minItems).toBe(1);
      expect(request.properties.frames.maxItems).toBe(MAX_VIDEO_FRAMES);
      for (const [name, property] of Object.entries<any>(item.properties)) expect(property.description, name).toBeTruthy();
    });

    it("the response example is exactly the shared contract video result (no drift)", async () => {
      const example = scanVideoOperation(await openApi()).responses["200"].content["application/json"].schema.example;

      expect(example).toEqual(contractScanVideoResult());
      expect(() => ScanVideoResultSchema.parse(example)).not.toThrow();
    });

    it("the description states that the video is not uploaded, the limits and the cost warning", async () => {
      const description = scanVideoOperation(await openApi({ SCAN_RATE_LIMIT_MAX: "4", RATE_LIMIT_WINDOW_MS: "120000" })).description as string;

      expect(description).toMatch(/video itself is never uploaded/i);
      expect(description).toContain(`${MAX_VIDEO_SECONDS} seconds`);
      expect(description).toContain("4 video scans per 120 s");
      expect(description).toMatch(/costs money/i);
    });
  });

  it("the operation description reflects the configured limits", async () => {
    const description = generateOperation(
      await openApi({ RATE_LIMIT_MAX: "7", RATE_LIMIT_WINDOW_MS: "30000", REQUEST_DEADLINE_MS: "60000" }),
    ).description as string;

    expect(description).toContain("7 requests per 30 s");
    expect(description).toContain("up to 60 s");
    expect(description).toMatch(/costs money/i);
  });

  it("never contains the app key or any secret", async () => {
    const res = await get(await docsApp({ OPENROUTER_API_KEY: "sk-or-SHOULD-NOT-APPEAR" }), "/openapi.json");

    expect(res.body).not.toContain(TEST_APP_KEY);
    expect(res.body).not.toContain("dev-local-key");
    expect(res.body).not.toContain("sk-or-SHOULD-NOT-APPEAR");
  });
});

describe("the suggest endpoint in the OpenAPI document", () => {
  it("is documented as a secured operation with every status the API can return", async () => {
    const op = suggestOperation(await openApi());

    expect(op.security).toEqual([{ appKey: [] }]);
    expect(op.summary).toMatch(/complete an ingredient name/i);
    expect(op.description).toMatch(/nothing about foods is stored in the app/i);
    expect(Object.keys(op.responses).sort()).toEqual(["200", "400", "401", "403", "413", "422", "429", "500", "502", "504"]);
  });

  it("documents every request and response field", async () => {
    const op = suggestOperation(await openApi());
    const request = op.requestBody.content["application/json"].schema;
    const item = op.responses["200"].content["application/json"].schema.properties.suggestions.items;

    expect(Object.keys(request.properties).sort()).toEqual(["language", "query", "region"]);
    for (const [name, property] of Object.entries<any>(request.properties)) expect(property.description, name).toBeTruthy();
    expect(Object.keys(item.properties).sort()).toEqual(["category", "emoji", "name", "shelfLifeDays", "storage", "tip", "unit"]);
    for (const [name, property] of Object.entries<any>(item.properties)) expect(property.description, name).toBeTruthy();
    expect(item.properties.storage.enum).toEqual(["FRIDGE", "FREEZER", "PANTRY"]);
  });

  it("the response example is exactly the shared contract suggest result (no drift)", async () => {
    const example = suggestOperation(await openApi()).responses["200"].content["application/json"].schema.example;

    expect(example).toEqual(contractSuggestResult());
  });
});

describe("the extract endpoint in the OpenAPI document", () => {
  it("is documented as a secured operation with every status the API can return", async () => {
    const op = extractOperation(await openApi());

    expect(op.security).toEqual([{ appKey: [] }]);
    expect(op.summary).toMatch(/dictated text/i);
    expect(op.description).toMatch(/no audio ever reaches this api/i);
    expect(Object.keys(op.responses).sort()).toEqual(["200", "400", "401", "403", "413", "422", "429", "500", "502", "504"]);
  });

  it("documents every request and response field", async () => {
    const op = extractOperation(await openApi());
    const request = op.requestBody.content["application/json"].schema;
    const item = op.responses["200"].content["application/json"].schema.properties.ingredients.items;

    expect(Object.keys(request.properties).sort()).toEqual(["language", "region", "today", "transcript"]);
    for (const [name, property] of Object.entries<any>(request.properties)) expect(property.description, name).toBeTruthy();
    expect(Object.keys(item.properties).sort()).toEqual(["category", "emoji", "expiresOn", "heard", "name", "quantity", "shelfLifeDays", "storage", "unit"]);
    for (const [name, property] of Object.entries<any>(item.properties)) expect(property.description, name).toBeTruthy();
  });

  it("the response example is exactly the shared contract extract result (no drift)", async () => {
    const example = extractOperation(await openApi()).responses["200"].content["application/json"].schema.example;

    expect(example).toEqual(contractExtractResult());
  });
});

describe("the assistant endpoint in the OpenAPI document", () => {
  it("is documented as a secured operation with every status the API can return", async () => {
    const op = assistantOperation(await openApi());

    expect(op.tags).toEqual(["assistant"]);
    expect(op.security).toEqual([{ appKey: [] }]);
    expect(op.description).toMatch(/no audio ever reaches this api/i);
    expect(op.description).toMatch(/chef master/i);
    expect(Object.keys(op.responses).sort()).toEqual(["200", "400", "401", "403", "413", "422", "429", "500", "502", "504"]);
  });

  it("documents every request and response field", async () => {
    const op = assistantOperation(await openApi());
    const request = op.requestBody.content["application/json"].schema;
    const response = op.responses["200"].content["application/json"].schema;

    expect(Object.keys(request.properties).sort()).toEqual(["language", "region", "today", "transcript"]);
    for (const [name, property] of Object.entries<any>(request.properties)) expect(property.description, name).toBeTruthy();
    expect(Object.keys(response.properties).sort()).toEqual(["ingredients", "intent", "pantryQuery", "recipe", "reminder", "reply"]);
    for (const [name, property] of Object.entries<any>(response.properties)) expect(property.description, name).toBeTruthy();
    expect(response.properties.intent.enum).toEqual(["add_ingredients", "make_recipe", "query_pantry", "create_reminder", "unknown"]);
  });

  it("the response example is exactly the shared contract answer (no drift)", async () => {
    const example = assistantOperation(await openApi()).responses["200"].content["application/json"].schema.example;

    expect(example).toEqual(contractAssistantAdd());
  });
});

describe("the OpenAPI document: dishes and diets", () => {
  it("lists every diet the app can ask for, in the request", async () => {
    const schema = generateOperation(await openApi()).requestBody.content["application/json"].schema;

    expect(schema.properties.diets.items.enum).toEqual([
      "VEGETARIAN", "VEGAN", "PESCATARIAN", "GLUTEN_FREE", "DAIRY_FREE", "EGG_FREE", "NUT_FREE", "LOW_CARB", "KETO", "HALAL", "KOSHER",
    ]);
    expect(schema.properties.dish.maxLength).toBe(80);
  });

  it("explains the dish, the diets and the shopping list in the description", async () => {
    const description: string = generateOperation(await openApi()).description;

    for (const phrase of ["`dish`", "`missingIngredients`", "`diets`", "`VEGAN`"]) expect(description, phrase).toContain(phrase);
  });

  it("describes the shopping list entries", async () => {
    const schema = generateOperation(await openApi()).responses["200"].content["application/json"].schema;

    expect(Object.keys(schema.properties.missingIngredients.items.properties).sort()).toEqual(["amount", "name"]);
    for (const [name, property] of Object.entries<any>(schema.properties.missingIngredients.items.properties)) {
      expect(property.description, name).toBeTruthy();
    }
  });
});
