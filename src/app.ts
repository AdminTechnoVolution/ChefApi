import { randomUUID } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import {
  ERROR_RESPONSES,
  generateOperationDescription,
  registerDocs,
  assistantOperationDescription,
  extractOperationDescription,
  scanOperationDescription,
  scanVideoOperationDescription,
  suggestOperationDescription,
} from "./apiDocs.js";
import type { AccountsRuntime } from "./accounts/runtime.js";
import { registerAuthedAccountRoutes, registerPublicAccountRoutes } from "./accounts/routes.js";
import type { ClientVerifier } from "./auth/clientVerifier.js";
import type { Feature } from "./billing/plans.js";
import { clientKey } from "./clientIp.js";
import type { Config } from "./config.js";
import { ApiError, type ErrorCode, toEnvelope } from "./errors.js";
import type { AssistantUnderstander } from "./assistant/assistantUnderstander.js";
import type { IngredientExtractor } from "./extract/ingredientExtractor.js";
import type { RecipeGenerator } from "./llm/recipeGenerator.js";
import type { IngredientScanner } from "./scan/ingredientScanner.js";
import type { IngredientSuggester } from "./suggest/ingredientSuggester.js";
import { detectImageType } from "./scan/imageType.js";
import {
  AssistantRequestSchema,
  AssistantResultSchema,
  ExtractRequestSchema,
  ExtractResultSchema,
  GenerateRecipeRequestSchema,
  HealthSchema,
  MAX_SCAN_BODY_BYTES,
  MAX_VIDEO_BODY_BYTES,
  RecipeSchema,
  ScanRequestSchema,
  ScanResultSchema,
  ScanVideoRequestSchema,
  ScanVideoResultSchema,
  SuggestRequestSchema,
  SuggestResultSchema,
} from "./schema.js";

export const MAX_BODY_BYTES = 16 * 1024;

export interface AppDependencies {
  config: Config;
  verifier: ClientVerifier;
  /** Accounts, plans and the gates in front of the AI routes. Required with `AUTH_MODE=jwt`; absent in the shared-key mode. */
  accounts?: AccountsRuntime;
  /** A ready generator, or a factory that receives the app's logger (so the generator can log through it). */
  generator: RecipeGenerator | ((log: FastifyBaseLogger) => RecipeGenerator);
  /** Reads receipt/packaging photos and kitchen videos. Same shape as [generator]. */
  scanner: IngredientScanner | ((log: FastifyBaseLogger) => IngredientScanner);
  /** Completes ingredient names while the user types. Same shape as [generator]. */
  suggester: IngredientSuggester | ((log: FastifyBaseLogger) => IngredientSuggester);
  /** Turns dictated text into pantry items. Same shape as [generator]. */
  extractor: IngredientExtractor | ((log: FastifyBaseLogger) => IngredientExtractor);
  /** Works out what the user asked the mascot for. Same shape as [generator]. */
  assistant: AssistantUnderstander | ((log: FastifyBaseLogger) => AssistantUnderstander);
  /** `false` silences logging (tests). Defaults to structured JSON logs at `config.LOG_LEVEL`. */
  logger?: boolean;
  /** Where the JSON log lines go instead of stdout. A test seam: lets a test read what would have been logged. */
  logStream?: { write(line: string): void };
}

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { config, verifier, accounts } = deps;
  if (config.AUTH_MODE === "jwt" && !accounts) throw new Error("AUTH_MODE=jwt needs the accounts runtime");

  const app = Fastify({
    logger:
      deps.logger === false
        ? false
        : {
            level: config.LOG_LEVEL,
            // Never log the shared key; request bodies (pantry contents) are not logged at all.
            redact: { paths: ['req.headers["x-chef-app-key"]', "req.headers.authorization"], censor: "[redacted]" },
            ...(deps.logStream ? { stream: deps.logStream } : {}),
          },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: MAX_BODY_BYTES,
    genReqId: () => randomUUID(),
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const generator = typeof deps.generator === "function" ? deps.generator(app.log) : deps.generator;
  const scanner = typeof deps.scanner === "function" ? deps.scanner(app.log) : deps.scanner;
  const suggester = typeof deps.suggester === "function" ? deps.suggester(app.log) : deps.suggester;
  const extractor = typeof deps.extractor === "function" ? deps.extractor(app.log) : deps.extractor;
  const assistant = typeof deps.assistant === "function" ? deps.assistant(app.log) : deps.assistant;

  // Before the rate limiter on purpose (see registerDocs): the docs UI must not be throttled.
  await registerDocs(app, config);

  // Registered before the routes so it runs first: abusive callers are throttled before auth or parsing work.
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (request) => clientKey(request.ip),
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ApiError) {
      if (error.status >= 500) {
        request.log.error({ code: error.code, err: error.cause ?? error }, "request failed");
      }
      return reply.status(error.status).send(toEnvelope(error.code, error.message, error.details));
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send(toEnvelope("invalid_request", summarizeValidationIssues(error.validation)));
    }

    const status = statusOf(error);
    if (status === 429) {
      return reply.status(429).send(toEnvelope("rate_limited", "Too many requests. Please slow down."));
    }
    if (status === 413) {
      return reply.status(413).send(toEnvelope("payload_too_large", "The request is too large."));
    }
    if (status !== undefined && status >= 400 && status < 500) {
      // e.g. malformed JSON or an unsupported content type.
      return reply.status(400).send(toEnvelope("invalid_request", "The request could not be understood."));
    }

    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send(toEnvelope("internal_error", "Something went wrong. Please try again."));
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send(toEnvelope("not_found", "No such endpoint.")),
  );

  // Liveness probe for the platform; deliberately unauthenticated and unthrottled.
  app.withTypeProvider<ZodTypeProvider>().get(
    "/healthz",
    {
      config: { rateLimit: false },
      schema: { tags: ["meta"], summary: "Liveness probe", response: { 200: HealthSchema.describe("The service is up.") } },
    },
    async () => ({ status: "ok" as const }),
  );

  if (accounts) await registerPublicAccountRoutes(app, accounts, config);

  /** The gate in front of an AI route: the plan must include [feature] and the month must have room. A no-op in the shared-key mode. */
  const gated = (feature: Feature) =>
    accounts
      ? {
          preHandler: async (request: FastifyRequest) => {
            request.charge = await accounts.gate.authorize(request.client, feature);
          },
        }
      : {};

  await app.register(
    async (v1) => {
      // preParsing, not onRequest: the rate limiter's hook is attached at route level and therefore runs AFTER
      // plugin-level onRequest hooks, so authenticating in onRequest would let unauthenticated callers
      // (e.g. someone guessing keys) bypass throttling entirely. preParsing still runs before any body is read.
      v1.addHook("preParsing", async (request: FastifyRequest) => {
        const client = await verifier.verify(request.headers);
        if (!client) {
          throw new ApiError("unauthorized", config.AUTH_MODE === "jwt" ? "Sign in again." : "Missing or invalid app key.");
        }
        request.client = client;
      });

      if (accounts) {
        // The allowance is spent only when the work succeeded: a recipe that failed costs the user nothing.
        v1.addHook("onResponse", async (request, reply) => {
          if (!request.charge || reply.statusCode !== 200) return;
          try {
            await accounts.gate.record(request.charge);
          } catch (error) {
            request.log.error({ err: error }, "could not record AI usage");
          }
        });
        registerAuthedAccountRoutes(v1, accounts, config);
      }

      v1.withTypeProvider<ZodTypeProvider>().post(
        "/recipes/generate",
        {
          ...gated("recipes"),
          schema: {
            tags: ["recipes"],
            summary: "Generate a recipe from pantry ingredients",
            description: generateOperationDescription(config),
            security: [{ appKey: [] }],
            body: GenerateRecipeRequestSchema,
            response: {
              200: RecipeSchema.describe("The recipe, as minified JSON. Every field is always present."),
              ...ERROR_RESPONSES,
            },
          },
        },
        async (request, reply) => {
          const startedAt = performance.now();
          const deadlineAt = Date.now() + config.REQUEST_DEADLINE_MS;

          // Abort upstream work when the budget is spent or the client has gone away; nobody is waiting any more.
          const controller = new AbortController();
          const deadlineTimer = setTimeout(() => controller.abort(), config.REQUEST_DEADLINE_MS);
          reply.raw.once("close", () => {
            if (!reply.raw.writableFinished) controller.abort();
          });

          try {
            const result = await generator.generate({
              clientSystemPrompt: request.body.systemPrompt,
              language: request.body.language,
              region: request.body.region,
              city: request.body.city,
              ingredients: request.body.ingredients,
              dish: request.body.dish,
              diets: request.body.diets,
              deadlineAt,
              signal: controller.signal,
            });

            request.log.info(
              {
                provider: result.provider,
                model: result.model,
                latencyMs: Math.round(performance.now() - startedAt),
                attempts: result.attempts,
                inputTokens: result.usage?.inputTokens,
                outputTokens: result.usage?.outputTokens,
                ingredientCount: request.body.ingredients.length,
                // What was asked for, never what was typed: the dish itself is not logged.
                dishRequested: request.body.dish !== undefined,
                diets: request.body.diets,
                missingCount: result.recipe.missingIngredients.length,
              },
              "recipe generated",
            );
            return result.recipe;
          } finally {
            clearTimeout(deadlineTimer);
          }
        },
      );

      v1.withTypeProvider<ZodTypeProvider>().post(
        "/ingredients/scan",
        {
          ...gated("photo"),
          // The photo makes this body far larger than every other request, so only this route may be big.
          bodyLimit: MAX_SCAN_BODY_BYTES,
          // The expensive call (vision model): a tighter per-client limit than the rest of the API.
          config: { rateLimit: { max: config.SCAN_RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW_MS } },
          schema: {
            tags: ["ingredients"],
            summary: "Read ingredients from a receipt or packaging photo",
            description: scanOperationDescription(config),
            security: [{ appKey: [] }],
            body: ScanRequestSchema,
            response: {
              200: ScanResultSchema.describe("The food items found in the photo. Empty when there are none."),
              ...ERROR_RESPONSES,
            },
          },
        },
        async (request, reply) => {
          const startedAt = performance.now();
          const { image, mimeType, today, language, region } = request.body;

          // The declared type must match the bytes, so the model is never fed something that is not a photo.
          if (detectImageType(image) !== mimeType) {
            throw new ApiError("invalid_request", "Invalid request. image: does not match the declared mimeType");
          }

          const controller = new AbortController();
          const deadlineAt = Date.now() + config.REQUEST_DEADLINE_MS;
          const deadlineTimer = setTimeout(() => controller.abort(), config.REQUEST_DEADLINE_MS);
          reply.raw.once("close", () => {
            if (!reply.raw.writableFinished) controller.abort();
          });

          try {
            const result = await scanner.scan({ image, mimeType, today, language, region, deadlineAt, signal: controller.signal });

            // Counts and sizes only: the photo and what it shows never reach the logs.
            request.log.info(
              {
                model: result.model,
                latencyMs: Math.round(performance.now() - startedAt),
                imageBytes: Math.floor((image.length * 3) / 4),
                itemCount: result.ingredients.length,
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
              },
              "ingredients scanned",
            );
            return { ingredients: result.ingredients };
          } finally {
            clearTimeout(deadlineTimer);
          }
        },
      );

      v1.withTypeProvider<ZodTypeProvider>().post(
        "/ingredients/scan-video",
        {
          ...gated("video"),
          // A handful of frames makes this body far larger than every other request, so only this route and the photo's may be big.
          bodyLimit: MAX_VIDEO_BODY_BYTES,
          // Several images in one vision call: as expensive as it gets, so the same tight per-client limit as the photo scan.
          config: { rateLimit: { max: config.SCAN_RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW_MS } },
          schema: {
            tags: ["ingredients"],
            summary: "Read ingredients from frames of a short kitchen video",
            description: scanVideoOperationDescription(config),
            security: [{ appKey: [] }],
            body: ScanVideoRequestSchema,
            response: {
              200: ScanVideoResultSchema.describe("The food items shown in the video, each listed once. Empty when there are none."),
              ...ERROR_RESPONSES,
            },
          },
        },
        async (request, reply) => {
          const startedAt = performance.now();
          const { frames, today, language, region } = request.body;

          // Every frame must really be an image the model accepts; its type is read from its bytes, never taken on trust.
          const typedFrames = frames.map((image, index) => {
            const mimeType = detectImageType(image);
            if (!mimeType) {
              throw new ApiError("invalid_request", `Invalid request. frames.${index}: is not a JPEG, PNG or WebP image`);
            }
            return { image, mimeType };
          });

          const controller = new AbortController();
          const deadlineAt = Date.now() + config.REQUEST_DEADLINE_MS;
          const deadlineTimer = setTimeout(() => controller.abort(), config.REQUEST_DEADLINE_MS);
          reply.raw.once("close", () => {
            if (!reply.raw.writableFinished) controller.abort();
          });

          try {
            const result = await scanner.scanVideo({
              frames: typedFrames,
              today,
              language,
              region,
              deadlineAt,
              signal: controller.signal,
            });

            // Counts and sizes only: the frames and what they show never reach the logs.
            request.log.info(
              {
                model: result.model,
                latencyMs: Math.round(performance.now() - startedAt),
                frameCount: frames.length,
                frameBytes: frames.reduce((total, frame) => total + Math.floor((frame.length * 3) / 4), 0),
                itemCount: result.ingredients.length,
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
              },
              "video ingredients scanned",
            );
            return { ingredients: result.ingredients };
          } finally {
            clearTimeout(deadlineTimer);
          }
        },
      );

      v1.withTypeProvider<ZodTypeProvider>().post(
        "/ingredients/suggest",
        {
          ...gated("suggest"),
          // Fires while the user types (after a pause): generous, with the cache absorbing repeats.
          config: { rateLimit: { max: config.SUGGEST_RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW_MS } },
          schema: {
            tags: ["ingredients"],
            summary: "Complete an ingredient name as the user types it",
            description: suggestOperationDescription(config),
            security: [{ appKey: [] }],
            body: SuggestRequestSchema,
            response: {
              200: SuggestResultSchema.describe("Foods the text could be, with the details to fill in the form. Empty when it is not a food."),
              ...ERROR_RESPONSES,
            },
          },
        },
        async (request, reply) => {
          const startedAt = performance.now();
          const { query, language, region } = request.body;

          const controller = new AbortController();
          const budgetMs = config.OPENROUTER_SUGGEST_TIMEOUT_MS;
          const deadlineAt = Date.now() + budgetMs;
          const deadlineTimer = setTimeout(() => controller.abort(), budgetMs);
          reply.raw.once("close", () => {
            if (!reply.raw.writableFinished) controller.abort();
          });

          try {
            const result = await suggester.suggest({ query, language, region, deadlineAt, signal: controller.signal });

            // Counts only: what the user types is never logged.
            request.log.info(
              {
                model: result.model,
                latencyMs: Math.round(performance.now() - startedAt),
                itemCount: result.suggestions.length,
                cached: result.cached ?? false,
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
              },
              "ingredients suggested",
            );
            return { suggestions: result.suggestions };
          } finally {
            clearTimeout(deadlineTimer);
          }
        },
      );

      v1.withTypeProvider<ZodTypeProvider>().post(
        "/ingredients/extract",
        {
          ...gated("voice"),
          // One call per dictation, and a model call each time (nothing to cache: nobody says the same sentence twice).
          config: { rateLimit: { max: config.EXTRACT_RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW_MS } },
          schema: {
            tags: ["ingredients"],
            summary: "Turn dictated text into a list of pantry items",
            description: extractOperationDescription(config),
            security: [{ appKey: [] }],
            body: ExtractRequestSchema,
            response: {
              200: ExtractResultSchema.describe("One entry per distinct food the user named, each with the details the form needs. Empty when they named none."),
              ...ERROR_RESPONSES,
            },
          },
        },
        async (request, reply) => {
          const startedAt = performance.now();
          const { transcript, today, language, region } = request.body;

          const controller = new AbortController();
          const budgetMs = config.OPENROUTER_EXTRACT_TIMEOUT_MS;
          const deadlineAt = Date.now() + budgetMs;
          const deadlineTimer = setTimeout(() => controller.abort(), budgetMs);
          reply.raw.once("close", () => {
            if (!reply.raw.writableFinished) controller.abort();
          });

          try {
            const result = await extractor.extract({ transcript, today, language, region, deadlineAt, signal: controller.signal });

            // Sizes and counts only: what the user said (and so what they have at home) never reaches the logs.
            request.log.info(
              {
                model: result.model,
                latencyMs: Math.round(performance.now() - startedAt),
                transcriptChars: transcript.length,
                itemCount: result.ingredients.length,
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
              },
              "ingredients extracted",
            );
            return { ingredients: result.ingredients };
          } finally {
            clearTimeout(deadlineTimer);
          }
        },
      );

      v1.withTypeProvider<ZodTypeProvider>().post(
        "/assistant/understand",
        {
          ...gated("assistant"),
          // One call per sentence spoken to the mascot, and a model call each time.
          config: { rateLimit: { max: config.EXTRACT_RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW_MS } },
          schema: {
            tags: ["assistant"],
            summary: "Work out what the user asked the mascot for",
            description: assistantOperationDescription(config),
            security: [{ appKey: [] }],
            body: AssistantRequestSchema,
            response: {
              200: AssistantResultSchema.describe("What the user wants (`intent`), what the mascot says (`reply`) and the part that goes with the intent."),
              ...ERROR_RESPONSES,
            },
          },
        },
        async (request, reply) => {
          const startedAt = performance.now();
          const { transcript, today, language, region } = request.body;

          const controller = new AbortController();
          const budgetMs = config.OPENROUTER_EXTRACT_TIMEOUT_MS;
          const deadlineAt = Date.now() + budgetMs;
          const deadlineTimer = setTimeout(() => controller.abort(), budgetMs);
          reply.raw.once("close", () => {
            if (!reply.raw.writableFinished) controller.abort();
          });

          try {
            const outcome = await assistant.understand({ transcript, today, language, region, deadlineAt, signal: controller.signal });

            // Sizes, counts and the intent only: what the user said (and so what they have at home) never reaches the logs.
            request.log.info(
              {
                model: outcome.model,
                latencyMs: Math.round(performance.now() - startedAt),
                transcriptChars: transcript.length,
                intent: outcome.result.intent,
                itemCount: outcome.result.ingredients.length,
                inputTokens: outcome.inputTokens,
                outputTokens: outcome.outputTokens,
              },
              "assistant understood",
            );
            return outcome.result;
          } finally {
            clearTimeout(deadlineTimer);
          }
        },
      );
    },
    { prefix: "/v1" },
  );

  return app;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const value = (error as { statusCode?: unknown }).statusCode;
    return typeof value === "number" ? value : undefined;
  }
  return undefined;
}

/** Field paths and rule names only; submitted values are never echoed back. */
function summarizeValidationIssues(issues: ReadonlyArray<{ instancePath?: string; message?: string }>): string {
  const summary = issues
    .slice(0, 3)
    .map((issue) => {
      const path = (issue.instancePath ?? "").replace(/^\//, "").replaceAll("/", ".") || "body";
      return `${path}: ${issue.message ?? "invalid"}`;
    })
    .join("; ");
  return `Invalid request. ${summary}`;
}

export type { ErrorCode };
