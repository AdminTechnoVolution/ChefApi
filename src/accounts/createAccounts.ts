import { DevIdTokenVerifier, GoogleIdTokenVerifier } from "../auth/googleIdToken.js";
import { GooglePubSubAuth } from "../auth/pubsubAuth.js";
import { GooglePlayBilling, loadServiceAccount } from "../billing/playBilling.js";
import type { Config } from "../config.js";
import { MemoryRefreshTokens, createMemoryStores } from "./memoryStores.js";
import { connectionFailure } from "./connectionFailure.js";
import { connectMongo, createMongoStores } from "./mongoStores.js";
import { RedisKeys, RedisRefreshTokens, RedisTokenControl, connectRedis } from "./redisTokens.js";
import { MemoryTokenControl } from "./tokenControl.js";
import { type AccountsRuntime, createAccountsRuntime } from "./runtime.js";
import type { TokenControl } from "./tokenControl.js";

/** The little of a logger this needs, so it can run before the app (and its logger) exists. */
export interface StartupLog {
  info(fields: object, message: string): void;
  warn(message: string): void;
}

export interface AccountsHandle {
  runtime: AccountsRuntime;
  close(): Promise<void>;
}

/**
 * Builds the real accounts runtime from the environment: MongoDB (the `chef` database) for storage, Google for sign-in, Google Play for
 * purchases. Returns undefined in the shared-key mode, where there are no accounts.
 */
export async function createAccountsFromConfig(
  config: Config,
  log: StartupLog,
  /** How long to wait for each server before giving up; the defaults are for a real start, a test shortens them. */
  options: { connectTimeoutMs?: number } = {},
): Promise<AccountsHandle | undefined> {
  if (config.AUTH_MODE !== "jwt") return undefined;

  const closers: Array<() => Promise<void>> = [];
  let stores = createMemoryStores();
  if (config.MONGODB_URI) {
    const production = config.NODE_ENV === "production";
    let connection: Awaited<ReturnType<typeof connectMongo>>;
    try {
      connection = await connectMongo(config.MONGODB_URI, config.MONGODB_DB, { serverSelectionTimeoutMS: options.connectTimeoutMs });
    } catch (error) {
      throw connectionFailure("MongoDB", config.MONGODB_URI, error, { production, detail: `database "${config.MONGODB_DB}"` });
    }
    stores = { ...stores, ...createMongoStores(connection.db) };
    closers.push(connection.close);
    log.info({ database: config.MONGODB_DB }, "accounts are stored in MongoDB");
  } else {
    // loadConfig refuses this in production.
    log.warn("MONGODB_URI is not set: accounts live in memory and are lost on restart (local development only)");
  }

  // Sessions: refresh tokens and the revocation of access tokens.
  let tokenControl: TokenControl = new MemoryTokenControl();
  if (config.REDIS_URL) {
    let redis: Awaited<ReturnType<typeof connectRedis>>;
    try {
      redis = await connectRedis(config.REDIS_URL, { connectTimeoutMs: options.connectTimeoutMs });
    } catch (error) {
      // MongoDB is already open: close it, or the process would not end.
      await Promise.all(closers.map((close) => close().catch(() => undefined)));
      throw connectionFailure("Redis", config.REDIS_URL, error, { production: config.NODE_ENV === "production" });
    }
    const keys = new RedisKeys(config.REDIS_KEY_PREFIX);
    stores = { ...stores, refreshTokens: new RedisRefreshTokens(redis.client, keys) };
    tokenControl = new RedisTokenControl(redis.client, Math.max(2 * config.JWT_ACCESS_TTL_SECONDS, 3600) * 1000, keys);
    closers.push(redis.close);
    log.info({ prefix: config.REDIS_KEY_PREFIX }, "sessions are controlled in Redis");
  } else {
    // loadConfig refuses this in production.
    log.warn("REDIS_URL is not set: sessions live in memory and are lost on restart (local development only)");
    stores = { ...stores, refreshTokens: new MemoryRefreshTokens() };
  }

  const serviceAccount = loadServiceAccount({
    path: config.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON,
    base64: config.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64,
  });
  if (!serviceAccount) log.warn("No Google Play service account is set: subscriptions cannot be verified");

  const idTokens = config.DEV_GOOGLE_AUTH
    ? new DevIdTokenVerifier()
    : new GoogleIdTokenVerifier((config.GOOGLE_CLIENT_ID ?? "").split(",").map((id) => id.trim()).filter(Boolean));
  if (config.DEV_GOOGLE_AUTH) log.warn("DEV_GOOGLE_AUTH is on: anyone can sign in as dev:<email> (local development only)");

  const pubsub =
    config.RTDN_ENABLED && config.GOOGLE_PUBSUB_PUSH_AUDIENCE
      ? new GooglePubSubAuth(config.GOOGLE_PUBSUB_PUSH_AUDIENCE, config.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL)
      : null;

  return {
    runtime: createAccountsRuntime({
      config,
      stores,
      tokenControl,
      idTokens,
      playBilling: serviceAccount ? new GooglePlayBilling(serviceAccount, config.GOOGLE_PLAY_PACKAGE_NAME) : null,
      pubsub,
    }),
    close: async () => {
      for (const close of closers) await close();
    },
  };
}
