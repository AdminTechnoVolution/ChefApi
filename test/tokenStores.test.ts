import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryRefreshTokens } from "../src/accounts/memoryStores.js";
import { DEFAULT_REDIS_PREFIX, RedisKeys, RedisRefreshTokens, RedisTokenControl, connectRedis } from "../src/accounts/redisTokens.js";
import type { RefreshTokenStore } from "../src/accounts/stores.js";
import { MemoryTokenControl, type TokenControl } from "../src/accounts/tokenControl.js";

/**
 * The sessions' storage asked the same of both implementations: memory (tests, a local run) and Redis (production). The Redis run needs a
 * server: set REDIS_URL_TEST. It uses keys of its own under a throwaway prefix and removes only those, never anything else on the server.
 */
const NOW = 1_800_000_000_000;

function refreshTokenBehaviour(name: string, make: () => Promise<{ store: RefreshTokenStore; now: { value: number } }>) {
  describe(`refresh tokens: ${name}`, () => {
    let store: RefreshTokenStore;
    let now: { value: number };
    beforeAll(async () => {
      ({ store, now } = await make());
    });

    const record = (tokenHash: string, userId: string, overrides: Partial<{ expiresAtMillis: number; deviceId: string | null }> = {}) => ({
      tokenHash,
      userId,
      expiresAtMillis: NOW + 60_000,
      deviceId: "phone" as string | null,
      ...overrides,
    });

    it("lets a token be used once", async () => {
      await store.save(record("hash-once", "user-1"));

      const first = await store.consume("hash-once");
      const second = await store.consume("hash-once");

      expect(first).toEqual({ tokenHash: "hash-once", userId: "user-1", expiresAtMillis: NOW + 60_000, deviceId: "phone" });
      expect(second).toBeNull();
    });

    it("keeps a missing device as nothing", async () => {
      await store.save(record("hash-nodevice", "user-1", { deviceId: null }));

      expect((await store.consume("hash-nodevice"))?.deviceId).toBeNull();
    });

    it("lets only one of two simultaneous uses win", async () => {
      await store.save(record("hash-race", "user-1"));

      const results = await Promise.all(Array.from({ length: 8 }, () => store.consume("hash-race")));

      expect(results.filter((result) => result !== null)).toHaveLength(1);
    });

    it("remembers who a used token belonged to, and knows nothing of one never issued", async () => {
      await store.save(record("hash-used", "user-7"));
      expect(await store.usedBy("hash-used")).toBeNull();

      await store.consume("hash-used");

      expect(await store.usedBy("hash-used")).toBe("user-7");
      expect(await store.usedBy("hash-never")).toBeNull();
    });

    it("forgets a used token once it would have expired", async () => {
      await store.save(record("hash-forgotten", "user-8", { expiresAtMillis: now.value + 2_000 }));
      await store.consume("hash-forgotten");
      expect(await store.usedBy("hash-forgotten")).toBe("user-8");

      now.value += 2_500;
      await new Promise((resolve) => setTimeout(resolve, 2_600));

      expect(await store.usedBy("hash-forgotten")).toBeNull();
    });

    it("revokes one token without remembering it as used, so a replay is just an unknown token", async () => {
      await store.save(record("hash-out", "user-5"));
      await store.save(record("hash-kept", "user-5"));

      await store.revoke("hash-out");

      expect(await store.consume("hash-out")).toBeNull();
      expect(await store.usedBy("hash-out")).toBeNull();
      expect((await store.consume("hash-kept"))?.userId).toBe("user-5");
      await store.revoke("hash-never-issued");
    });

    it("revokes every token of one user and only theirs", async () => {
      await store.save(record("hash-a", "user-2"));
      await store.save(record("hash-b", "user-2"));
      await store.save(record("hash-c", "user-3"));

      await store.revokeAllForUser("user-2");

      expect(await store.consume("hash-a")).toBeNull();
      expect(await store.consume("hash-b")).toBeNull();
      expect((await store.consume("hash-c"))?.userId).toBe("user-3");
    });

    it("does not keep a used token on the user's list, so revoking later does not trip over it", async () => {
      await store.save(record("hash-d", "user-4"));
      await store.save(record("hash-e", "user-4"));
      await store.consume("hash-d");

      await store.revokeAllForUser("user-4");

      expect(await store.consume("hash-e")).toBeNull();
    });
  });
}

function tokenControlBehaviour(name: string, make: () => Promise<TokenControl>) {
  describe(`token control: ${name}`, () => {
    let control: TokenControl;
    beforeAll(async () => {
      control = await make();
    });

    it("starts every user at epoch 0 and counts up each time their tokens are revoked", async () => {
      expect(await control.epochOf("u-1")).toBe(0);

      await control.revokeUser("u-1");
      expect(await control.epochOf("u-1")).toBe(1);
      await control.revokeUser("u-1");
      expect(await control.epochOf("u-1")).toBe(2);
      expect(await control.epochOf("u-2")).toBe(0);
    });

    it("revokes the tokens of an older epoch and not those of the current one", async () => {
      await control.revokeUser("u-3");

      expect(await control.isRevoked({ userId: "u-3", tokenId: "t-old", epoch: 0 })).toBe(true);
      expect(await control.isRevoked({ userId: "u-3", tokenId: "t-new", epoch: 1 })).toBe(false);
      expect(await control.isRevoked({ userId: "u-4", tokenId: "t-other", epoch: 0 })).toBe(false);
    });

    it("revokes one token on its own", async () => {
      await control.revokeAccessToken("t-denied", 5_000);

      expect(await control.isRevoked({ userId: "u-5", tokenId: "t-denied", epoch: 0 })).toBe(true);
      expect(await control.isRevoked({ userId: "u-5", tokenId: "t-fine", epoch: 0 })).toBe(false);
    });
  });
}

const holder = { value: NOW };
refreshTokenBehaviour("memory", async () => {
  holder.value = Date.now();
  return { store: new MemoryRefreshTokens(() => holder.value), now: holder };
});
tokenControlBehaviour("memory", async () => new MemoryTokenControl());

describe("the memory token control forgets a revoked token when its time is up", () => {
  it("lets it go after its ttl", async () => {
    let now = NOW;
    const control = new MemoryTokenControl(() => now);
    await control.revokeAccessToken("t-1", 1_000);

    expect(await control.isRevoked({ userId: "u", tokenId: "t-1", epoch: 0 })).toBe(true);
    now += 1_001;
    expect(await control.isRevoked({ userId: "u", tokenId: "t-1", epoch: 0 })).toBe(false);
  });
});

const redisUrl = process.env.REDIS_URL_TEST;

if (redisUrl) {
  describe("Redis", () => {
    const prefix = `chef_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const keys = new RedisKeys(prefix);
    let connection: Awaited<ReturnType<typeof connectRedis>>;

    beforeAll(async () => {
      connection = await connectRedis(redisUrl);
    });

    afterAll(async () => {
      // Only this test's own keys go: never FLUSH, never anything under another prefix.
      for await (const batch of connection.client.scanIterator({ MATCH: keys.all(), COUNT: 200 })) {
        const found = Array.isArray(batch) ? batch : [batch];
        if (found.length > 0) await connection.client.unlink(found);
      }
      await connection.close();
    });

    it("writes everything under its prefix, never under a bare name", () => {
      expect(DEFAULT_REDIS_PREFIX).toBe("chef");
      expect(keys.refreshToken("h")).toBe(`${prefix}:rt:h`);
      expect(keys.all()).toBe(`${prefix}:*`);
    });

    it("makes a refresh token expire by itself, and its used marker with it", async () => {
      const store = new RedisRefreshTokens(connection.client, keys);
      await store.save({ tokenHash: "hash-ttl", userId: "user-ttl", expiresAtMillis: Date.now() + 1_500, deviceId: null });
      expect(await connection.client.pTTL(keys.refreshToken("hash-ttl"))).toBeGreaterThan(0);

      await new Promise((resolve) => setTimeout(resolve, 1_700));

      expect(await store.consume("hash-ttl")).toBeNull();
    });

    it("never stores the token's value, only a hash and the owner", async () => {
      const store = new RedisRefreshTokens(connection.client, keys);
      await store.save({ tokenHash: "hash-shape", userId: "user-shape", expiresAtMillis: Date.now() + 60_000, deviceId: "phone" });

      const raw = JSON.parse((await connection.client.get(keys.refreshToken("hash-shape")))!);

      expect(Object.keys(raw).sort()).toEqual(["deviceId", "expiresAtMillis", "userId"]);
    });

    it("expires a revoked access token's marker, and the epoch lives longer than any token", async () => {
      const control = new RedisTokenControl(connection.client, 120_000, keys);
      await control.revokeAccessToken("t-ttl", 60_000);
      await control.revokeUser("u-ttl");

      expect(await connection.client.pTTL(keys.deniedAccessToken("t-ttl"))).toBeGreaterThan(0);
      expect(await connection.client.pTTL(keys.epoch("u-ttl"))).toBeGreaterThan(60_000);
    });

    refreshTokenBehaviour("Redis", async () => ({
      store: new RedisRefreshTokens(connection.client, keys, () => Date.now()),
      // The Redis clock is the real one: this lets the test move "now" in step with it.
      now: new Proxy({ value: 0 }, { get: () => Date.now(), set: () => true }) as { value: number },
    }));
    tokenControlBehaviour("Redis", async () => new RedisTokenControl(connection.client, 3_600_000, keys));
  });
}
