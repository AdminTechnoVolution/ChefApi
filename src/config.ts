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

  /** Shared secret the app sends in X-Chef-App-Key. Only used with AUTH_MODE=app-key: with accounts every call carries the user's token instead. */
  CHEF_APP_KEY: z.string().min(1).default(DEV_APP_KEY),

  // --- Accounts and plans ---
  /**
   * `app-key`: the original mode. One shared key, no accounts, no plans, no quotas (what the tests and a local run use).
   * `jwt`: every call carries a signed-in user's token; the plan decides what they may use. Production runs this.
   */
  AUTH_MODE: z.enum(["app-key", "jwt"]).default("app-key"),
  /** Signs the short-lived access tokens. At least 32 characters; never the default in production. */
  JWT_SECRET: optionalSecret,
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(60),
  /** Google OAuth client ids whose ID tokens are accepted (the app's web client id), comma separated. */
  GOOGLE_CLIENT_ID: optionalSecret,
  /** The database is called `chef`. Without a URI a local run keeps accounts in memory (never in production). */
  MONGODB_URI: optionalSecret,
  MONGODB_DB: z.string().min(1).default("chef"),
  /**
   * Redis keeps the sessions: refresh tokens (single use, with reuse detection) and the revocation of access tokens, so a logout or a
   * deleted account takes effect at once on every instance. `redis://` or `rediss://` (TLS, as Azure Cache for Redis). Without it a local
   * run keeps them in memory; production refuses to start without it.
   */
  REDIS_URL: optionalSecret,
  /** Every Redis key starts with this, so Chef can share a server. */
  REDIS_KEY_PREFIX: z.string().min(1).max(40).default("chef"),

  // --- Google Play subscriptions ---
  GOOGLE_PLAY_PACKAGE_NAME: z.string().min(1).default("com.ichef.app"),
  /** The Play service account as a file path, or as Base64 (what an App Service setting holds). */
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: optionalSecret,
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64: optionalSecret,
  /** Real-time notifications from Play, delivered by Pub/Sub push with an OIDC token. */
  RTDN_ENABLED: optionalFlag,
  GOOGLE_PUBSUB_PUSH_AUDIENCE: optionalSecret,
  GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL: optionalSecret,

  // --- What each plan may use per month, in AI units (a recipe is 1, a photo 2, a voice note 1, a video 5) ---
  AI_FREE_MONTHLY_UNITS: z.coerce.number().int().min(0).default(5),
  AI_JUNIOR_MONTHLY_UNITS: z.coerce.number().int().min(0).default(150),
  AI_MASTER_MONTHLY_UNITS: z.coerce.number().int().min(0).default(400),

  /** Local development only: everyone is treated as having this plan. Refused in production. */
  DEV_UNLOCK_PLAN: z.preprocess(emptyToUndefined, z.enum(["JUNIOR", "MASTER"]).optional()),
  /** Local development only: accepts `dev:<email>` as a Google ID token. Refused in production. */
  DEV_GOOGLE_AUTH: optionalFlag,

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
  // An explicit switch always takes precedence over the environment default.
  if (config.ENABLE_SWAGGER !== undefined) return config.ENABLE_SWAGGER;
  return config.NODE_ENV !== "production";
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
    // The shared key only guards the original mode. With accounts nobody sends it, so it is not asked for.
    if (config.AUTH_MODE === "app-key" && (config.CHEF_APP_KEY === DEV_APP_KEY || config.CHEF_APP_KEY.length < 24)) {
      problems.push("CHEF_APP_KEY must be a non-default secret of at least 24 characters in production");
    }
    if (!config.OPENROUTER_BASE_URL.startsWith("https://")) {
      problems.push("OPENROUTER_BASE_URL must use https in production");
    }
    if (config.DEV_UNLOCK_PLAN || config.DEV_GOOGLE_AUTH) {
      problems.push("DEV_UNLOCK_PLAN and DEV_GOOGLE_AUTH are for local development only and must be unset in production");
    }
    if (config.AUTH_MODE === "jwt") {
      if (!config.JWT_SECRET || config.JWT_SECRET.length < 32) problems.push("JWT_SECRET must be at least 32 characters in production");
      if (!config.GOOGLE_CLIENT_ID) problems.push("GOOGLE_CLIENT_ID is required when AUTH_MODE=jwt");
      if (!config.MONGODB_URI) problems.push("MONGODB_URI is required when AUTH_MODE=jwt in production");
      if (!config.REDIS_URL) problems.push("REDIS_URL is required when AUTH_MODE=jwt in production (sessions are controlled in Redis)");
    }
    if (problems.length > 0) {
      throw new Error(`Invalid production configuration:\n${problems.map((p) => `  ${p}`).join("\n")}`);
    }
  }

  if (config.AUTH_MODE === "jwt") {
    const problems: string[] = [];
    if (!config.JWT_SECRET || config.JWT_SECRET.length < 32) problems.push("JWT_SECRET: at least 32 characters are required when AUTH_MODE=jwt");
    if (!config.GOOGLE_CLIENT_ID && !config.DEV_GOOGLE_AUTH) problems.push("GOOGLE_CLIENT_ID: required when AUTH_MODE=jwt (or DEV_GOOGLE_AUTH=1 for local development)");
    if (problems.length > 0) throw new Error(`Invalid configuration:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  }

  return config;
}
