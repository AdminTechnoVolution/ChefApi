import { type RedisClientType, createClient } from "redis";
import type { RefreshTokenRecord, RefreshTokenStore } from "./stores.js";
import type { TokenControl } from "./tokenControl.js";

export const DEFAULT_REDIS_PREFIX = "chef";

/** Every Redis key Chef writes, under one prefix so it can share a server with anything else. */
export class RedisKeys {
  constructor(private readonly prefix: string = DEFAULT_REDIS_PREFIX) {}
  refreshToken = (tokenHash: string) => `${this.prefix}:rt:${tokenHash}`;
  refreshTokensOf = (userId: string) => `${this.prefix}:rt:user:${userId}`;
  usedRefreshToken = (tokenHash: string) => `${this.prefix}:rt:used:${tokenHash}`;
  epoch = (userId: string) => `${this.prefix}:epoch:${userId}`;
  deniedAccessToken = (tokenId: string) => `${this.prefix}:deny:${tokenId}`;
  all = () => `${this.prefix}:*`;
}

export type RedisClient = RedisClientType;

export interface RedisConnection {
  client: RedisClient;
  close(): Promise<void>;
}

/**
 * Connects to Redis (`redis://` or `rediss://` for TLS, as Azure Cache for Redis uses).
 *
 * Starting up, an unreachable server **fails the start** after a few tries: by default the client retries for ever, and an API that hangs
 * without a word is much harder to diagnose than one that stops and says why. Once connected it does keep retrying, so a restart of Redis
 * is survived.
 */
export async function connectRedis(url: string, options: { connectTimeoutMs?: number; startupAttempts?: number } = {}): Promise<RedisConnection> {
  const connectTimeout = options.connectTimeoutMs ?? 10_000;
  const startupAttempts = options.startupAttempts ?? 3;
  let started = false;
  const client = createClient({
    url,
    socket: {
      connectTimeout,
      reconnectStrategy: (retries, cause) => (started ? Math.min(retries * 200, 5_000) : retries >= startupAttempts - 1 ? cause : 500),
    },
  }) as RedisClient;
  // An unhandled 'error' event would kill the process; the failing command already reports it to its caller.
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (error) {
    client.destroy();
    throw error;
  }
  started = true;
  return { client, close: async () => void (await client.quit()) };
}

/**
 * Refresh tokens in Redis. Each is one key that Redis deletes by itself when it expires, taken out atomically (GETDEL) when used, so a
 * token works once even if two requests race. A used token leaves a marker until its original expiry, which is how reuse is spotted.
 */
export class RedisRefreshTokens implements RefreshTokenStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly keys: RedisKeys = new RedisKeys(),
    private readonly now: () => number = Date.now,
  ) {}

  async save(record: RefreshTokenRecord): Promise<void> {
    const ttl = Math.max(1, record.expiresAtMillis - this.now());
    const value = JSON.stringify({ userId: record.userId, expiresAtMillis: record.expiresAtMillis, deviceId: record.deviceId });
    await this.redis
      .multi()
      .set(this.keys.refreshToken(record.tokenHash), value, { PX: ttl })
      .sAdd(this.keys.refreshTokensOf(record.userId), record.tokenHash)
      // The user's index lives as long as their longest token ("GT": only ever extend it).
      .pExpire(this.keys.refreshTokensOf(record.userId), ttl, "GT")
      .exec();
  }

  async consume(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const raw = await this.redis.getDel(this.keys.refreshToken(tokenHash));
    if (raw === null) return null;
    const stored = JSON.parse(raw) as { userId: string; expiresAtMillis: number; deviceId: string | null };
    const remaining = Math.max(1, stored.expiresAtMillis - this.now());
    await this.redis
      .multi()
      .set(this.keys.usedRefreshToken(tokenHash), stored.userId, { PX: remaining })
      .sRem(this.keys.refreshTokensOf(stored.userId), tokenHash)
      .exec();
    return { tokenHash, userId: stored.userId, expiresAtMillis: stored.expiresAtMillis, deviceId: stored.deviceId };
  }

  async usedBy(tokenHash: string): Promise<string | null> {
    return this.redis.get(this.keys.usedRefreshToken(tokenHash));
  }

  async revoke(tokenHash: string): Promise<void> {
    const raw = await this.redis.getDel(this.keys.refreshToken(tokenHash));
    if (raw === null) return;
    const { userId } = JSON.parse(raw) as { userId: string };
    await this.redis.sRem(this.keys.refreshTokensOf(userId), tokenHash);
  }

  async revokeAllForUser(userId: string): Promise<void> {
    const index = this.keys.refreshTokensOf(userId);
    const hashes = await this.redis.sMembers(index);
    const multi = this.redis.multi();
    for (const hash of hashes) multi.unlink(this.keys.refreshToken(hash));
    multi.unlink(index);
    await multi.exec();
  }
}

/** Access-token revocation in Redis: one counter per user (their epoch) and one short-lived key per revoked token. */
export class RedisTokenControl implements TokenControl {
  constructor(
    private readonly redis: RedisClient,
    /** How long a user's epoch is kept: longer than any access token lives, so no revoked token outlasts its marker. */
    private readonly epochTtlMillis: number,
    private readonly keys: RedisKeys = new RedisKeys(),
  ) {}

  async epochOf(userId: string): Promise<number> {
    return Number((await this.redis.get(this.keys.epoch(userId))) ?? 0);
  }

  async revokeUser(userId: string): Promise<void> {
    const key = this.keys.epoch(userId);
    await this.redis.multi().incr(key).pExpire(key, this.epochTtlMillis).exec();
  }

  async revokeAccessToken(tokenId: string, ttlMillis: number): Promise<void> {
    await this.redis.set(this.keys.deniedAccessToken(tokenId), "1", { PX: Math.max(1, ttlMillis) });
  }

  async isRevoked(token: { userId: string; tokenId: string; epoch: number }): Promise<boolean> {
    // One round trip for both questions.
    const [epoch, denied] = await this.redis.mGet([this.keys.epoch(token.userId), this.keys.deniedAccessToken(token.tokenId)]);
    return denied !== null || token.epoch < Number(epoch ?? 0);
  }
}
