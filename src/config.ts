import { z } from "zod";

export const DEV_APP_KEY = "dev-local-key";

const booleanFlag = z
  .enum(["1", "0", "true", "false"])
  .transform((value) => value === "1" || value === "true");

/** `.env` files commonly contain `KEY=` for unset values; treat an empty string as "not set". */
const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);
const optionalSecret = z.preprocess(emptyToUndefined, z.string().min(1).optional());
const optionalFlag = z.preprocess(emptyToUndefined, booleanFlag.optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),

  /** Shared secret the app sends in X-Chef-App-Key. App Check is the planned replacement. */
  CHEF_APP_KEY: z.string().min(1).default(DEV_APP_KEY),

  // --- OpenRouter (same variable names as AntySpendApi) ---
  OPENROUTER_API_KEY: optionalSecret,
  /** Any OpenRouter model id with structured-output support, including Claude ones (e.g. anthropic/claude-sonnet-5.5). */
  OPENROUTER_MODEL: z.string().min(1).default("google/gemini-2.5-flash-lite"),
  OPENROUTER_BASE_URL: z.url({ protocol: /^https?$/ }).default("https://openrouter.ai/api/v1"),
  /** Generous: some models spend part of this budget on reasoning before the JSON. Billed only for tokens used. */
  OPENROUTER_MAX_TOKENS: z.coerce.number().int().min(300).max(16_000).default(3_000),
  /** Vision model for receipt/packaging scans (AntySpendApi's receipt model). Must accept images and structured outputs. */
  OPENROUTER_VISION_MODEL: z.string().min(1).default("google/gemini-2.5-flash"),
  OPENROUTER_VISION_MAX_TOKENS: z.coerce.number().int().min(300).max(8_000).default(2_000),
  /** Per scan call. Photos are slower than text. */
  /** Autocomplete answers are short: a small budget keeps them fast and cheap. */
  OPENROUTER_SUGGEST_MAX_TOKENS: z.coerce.number().int().min(300).max(4_000).default(900),
  /** Per suggestion call. The user is waiting on a text field, so this is far shorter than a recipe. */
  OPENROUTER_SUGGEST_TIMEOUT_MS: z.coerce.number().int().min(2_000).max(30_000).default(10_000),
  OPENROUTER_VISION_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(80_000).default(30_000),
  /** A spoken list of up to 20 items with details: more room than a suggestion, far less than a recipe. */
  OPENROUTER_EXTRACT_MAX_TOKENS: z.coerce.number().int().min(300).max(8_000).default(2_000),
  /** Per extraction call; the user is watching a spinner after finishing speaking. */
  OPENROUTER_EXTRACT_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(60_000).default(20_000),
  /** Not 0 like AntySpendApi's extraction calls: "get another recipe" must not return the same recipe again. */
  OPENROUTER_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),
  /** Route only to Zero-Data-Retention endpoints (AntySpendApi's setting). Turn off if the model has none. */
  OPENROUTER_ZDR: booleanFlag.default(true),

  /** Must be true behind a reverse proxy so rate limits apply per client, not per proxy. */
  TRUST_PROXY: booleanFlag.default(false),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),
  /** Scans are the expensive call (vision model, large body), so they get a tighter per-client limit. */
  SCAN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(6),
  /** Suggestions fire as the user types (after a pause), so this limit is generous: the cache absorbs repeats. */
  SUGGEST_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(40),
  /** One call per dictation (a person speaks, then reviews), so this sits between a recipe and a scan. */
  EXTRACT_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),

  /** Overall budget for one request. Must stay below the Android client's 90 s call timeout. */
  REQUEST_DEADLINE_MS: z.coerce.number().int().min(5_000).max(85_000).default(75_000),
  /** Per model call. A constraint-violation retry is a second call inside the same deadline. */
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(80_000).default(40_000),

  /**
   * Swagger UI at /docs plus the OpenAPI document at /docs-json and /openapi.json (same URLs as AntySpendApi).
   * Unset means on outside production and off in production; set it explicitly to override either way.
   */
  ENABLE_SWAGGER: optionalFlag,

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Config = z.infer<typeof EnvSchema>;

/** Whether the API documentation endpoints are served. */
export function swaggerEnabled(config: Pick<Config, "ENABLE_SWAGGER" | "NODE_ENV">): boolean {
  return config.ENABLE_SWAGGER ?? config.NODE_ENV !== "production";
}

/** Parses and validates the environment, failing fast with a readable message on misconfiguration. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${problems}`);
  }

  const config = parsed.data;

  if (config.NODE_ENV === "production") {
    const problems: string[] = [];
    if (config.CHEF_APP_KEY === DEV_APP_KEY || config.CHEF_APP_KEY.length < 24) {
      problems.push("CHEF_APP_KEY must be a non-default secret of at least 24 characters in production");
    }
    if (!config.OPENROUTER_BASE_URL.startsWith("https://")) {
      problems.push("OPENROUTER_BASE_URL must use https in production");
    }
    if (problems.length > 0) {
      throw new Error(`Invalid production configuration:\n${problems.map((p) => `  ${p}`).join("\n")}`);
    }
  }

  return config;
}
