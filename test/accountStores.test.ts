import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStores } from "../src/accounts/memoryStores.js";
import { COLLECTIONS, DEFAULT_DB_NAME, connectMongo, createMongoStores } from "../src/accounts/mongoStores.js";
import { type AccountStores, type Entitlement, entitlementIsActive } from "../src/accounts/stores.js";

/** What both the memory stores and the MongoDB stores provide. Sessions are tested apart (tokenStores.test.ts): they live in Redis. */
type DataStores = Omit<AccountStores, "refreshTokens">;

/**
 * The same behaviour is asked of both implementations of the account stores: the in-memory one the other tests use, and the MongoDB
 * one production runs. The MongoDB run is optional, since it needs a server: set MONGODB_URI_TEST to one, or MONGO_MEMORY=1 to start a
 * throwaway one (mongodb-memory-server). Either way it uses its own disposable database, never `chef`.
 */
const NOW = 1_800_000_000_000;

const entitlement = (overrides: Partial<Entitlement> = {}): Entitlement => ({
  purchaseToken: "token-1",
  userId: "user-1",
  productId: "chef_junior_monthly",
  plan: "JUNIOR",
  state: "ACTIVE",
  expiresAtMillis: NOW + 30 * 86_400_000,
  autoRenewing: true,
  updatedAtMillis: NOW,
  ...overrides,
});

function behaviour(name: string, makeStores: () => Promise<DataStores>) {
  describe(`account stores: ${name}`, () => {
    let stores: DataStores;
    beforeAll(async () => {
      stores = await makeStores();
    });

    it("creates a user the first time a Google account signs in, and finds the same one after", async () => {
      const first = await stores.users.upsertByGoogle({ googleSub: "sub-a", email: "a@example.com", name: "Ana" }, NOW);
      const again = await stores.users.upsertByGoogle({ googleSub: "sub-a", email: "a@example.com", name: "Ana" }, NOW + 1000);

      expect(again.id).toBe(first.id);
      expect(again.createdAtMillis).toBe(NOW);
      expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("follows the email and name Google reports now", async () => {
      const first = await stores.users.upsertByGoogle({ googleSub: "sub-b", email: "old@example.com", name: null }, NOW);

      const changed = await stores.users.upsertByGoogle({ googleSub: "sub-b", email: "new@example.com", name: "Beto" }, NOW + 5);

      expect(changed.id).toBe(first.id);
      expect(changed.email).toBe("new@example.com");
      expect(changed.name).toBe("Beto");
      expect((await stores.users.findById(first.id))?.email).toBe("new@example.com");
    });

    it("gives different Google accounts different users, and none of them leaks storage internals", async () => {
      const one = await stores.users.upsertByGoogle({ googleSub: "sub-c", email: "c@example.com", name: null }, NOW);
      const two = await stores.users.upsertByGoogle({ googleSub: "sub-d", email: "d@example.com", name: null }, NOW);

      expect(one.id).not.toBe(two.id);
      expect(Object.keys(one).sort()).toEqual(["createdAtMillis", "email", "googleSub", "id", "name"]);
    });

    it("deletes a user", async () => {
      const user = await stores.users.upsertByGoogle({ googleSub: "sub-e", email: "e@example.com", name: null }, NOW);

      await stores.users.deleteById(user.id);

      expect(await stores.users.findById(user.id)).toBeNull();
      expect(await stores.users.findById("nobody")).toBeNull();
    });

    it("keeps one entitlement per purchase token and replaces it when Play says something new", async () => {
      await stores.entitlements.upsertByPurchaseToken(entitlement({ purchaseToken: "tok-a", userId: "u-a" }));
      await stores.entitlements.upsertByPurchaseToken(entitlement({ purchaseToken: "tok-a", userId: "u-a", state: "EXPIRED" }));

      const list = await stores.entitlements.listForUser("u-a");

      expect(list).toHaveLength(1);
      expect(list[0]?.state).toBe("EXPIRED");
      expect((await stores.entitlements.findByPurchaseToken("tok-a"))?.userId).toBe("u-a");
      expect(await stores.entitlements.findByPurchaseToken("unknown")).toBeNull();
    });

    it("lists the subscriptions of one user and deletes only theirs", async () => {
      await stores.entitlements.upsertByPurchaseToken(entitlement({ purchaseToken: "tok-b1", userId: "u-b" }));
      await stores.entitlements.upsertByPurchaseToken(entitlement({ purchaseToken: "tok-b2", userId: "u-b", productId: "chef_master_monthly", plan: "MASTER" }));
      await stores.entitlements.upsertByPurchaseToken(entitlement({ purchaseToken: "tok-c1", userId: "u-c" }));

      expect((await stores.entitlements.listForUser("u-b")).map((e) => e.plan).sort()).toEqual(["JUNIOR", "MASTER"]);
      await stores.entitlements.deleteForUser("u-b");

      expect(await stores.entitlements.listForUser("u-b")).toEqual([]);
      expect(await stores.entitlements.listForUser("u-c")).toHaveLength(1);
    });

    it("adds up the month's usage per user and per month", async () => {
      expect(await stores.usage.get("u-use", "2026-10")).toBe(0);

      expect(await stores.usage.add("u-use", "2026-10", 2)).toBe(2);
      expect(await stores.usage.add("u-use", "2026-10", 1)).toBe(3);
      await stores.usage.add("u-use", "2026-11", 5);
      await stores.usage.add("u-other", "2026-10", 9);

      expect(await stores.usage.get("u-use", "2026-10")).toBe(3);
      expect(await stores.usage.get("u-use", "2026-11")).toBe(5);
      await stores.usage.deleteForUser("u-use");
      expect(await stores.usage.get("u-use", "2026-10")).toBe(0);
      expect(await stores.usage.get("u-other", "2026-10")).toBe(9);
    });

    it("does not lose usage when two calls are counted at once", async () => {
      await Promise.all(Array.from({ length: 20 }, () => stores.usage.add("u-race", "2026-10", 1)));

      expect(await stores.usage.get("u-race", "2026-10")).toBe(20);
    });

    it("accepts only one concurrent use of an invitation and only one group per member", async () => {
      await stores.households.invite("owner-race", "hash-race", "guest@example.com", NOW + 1000);
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => stores.households.accept("owner-race", "hash-race", `guest-${i}`, NOW)));
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = (await stores.households.forOwner("owner-race"))!.memberId!;
      expect(await stores.households.byInvite("hash-race")).toBeNull();
      expect(await stores.households.invite("owner-race", "replacement", "new@example.com", NOW + 1000)).toBe(false);
      await stores.households.invite("another-owner", "another-hash", "guest@example.com", NOW + 1000);
      expect(await stores.households.accept("another-owner", "another-hash", winner, NOW)).toBe(false);
      await stores.households.deleteForUser(winner);
      expect((await stores.households.forOwner("owner-race"))?.memberId).toBeUndefined();
      expect(await stores.households.accept("another-owner", "another-hash", winner, NOW)).toBe(true);
    });

    it("cancels and expires invitations without disturbing a member", async () => {
      await stores.households.invite("cancel-owner", "cancel-hash", "guest@example.com", NOW + 1000);
      await stores.households.cancelInvite("cancel-owner");
      expect(await stores.households.accept("cancel-owner", "cancel-hash", "cancel-guest", NOW)).toBe(false);
      await stores.households.invite("cancel-owner", "expired-hash", "guest@example.com", NOW);
      expect(await stores.households.accept("cancel-owner", "expired-hash", "cancel-guest", NOW)).toBe(false);
      await stores.households.invite("cancel-owner", "fresh-hash", "guest@example.com", NOW + 1000);
      expect(await stores.households.accept("cancel-owner", "fresh-hash", "cancel-guest", NOW)).toBe(true);
      await stores.households.cancelInvite("cancel-owner");
      await stores.households.removeMember("cancel-owner", "wrong-guest");
      expect((await stores.households.forOwner("cancel-owner"))?.memberId).toBe("cancel-guest");
    });

    it("sees a Pub/Sub message once, however often it is redelivered", async () => {
      expect(await stores.rtdn.firstSeen("msg-1", NOW)).toBe(true);
      expect(await stores.rtdn.firstSeen("msg-1", NOW + 1)).toBe(false);
      expect(await stores.rtdn.firstSeen("msg-2", NOW)).toBe(true);
    });

    it("handles a redelivered message again when handling it failed the first time", async () => {
      expect(await stores.rtdn.firstSeen("msg-3", NOW)).toBe(true);

      await stores.rtdn.forget("msg-3");

      expect(await stores.rtdn.firstSeen("msg-3", NOW + 1)).toBe(true);
    });
  });
}

describe("entitlementIsActive", () => {
  it("is active while the subscription is active, in grace, or cancelled but not yet run out", () => {
    for (const state of ["ACTIVE", "IN_GRACE_PERIOD", "CANCELED"] as const) {
      expect(entitlementIsActive(entitlement({ state }), NOW), state).toBe(true);
    }
  });

  it("is not active when it is on hold, paused, expired, pending or unknown", () => {
    for (const state of ["ON_HOLD", "PAUSED", "EXPIRED", "PENDING", "UNKNOWN"] as const) {
      expect(entitlementIsActive(entitlement({ state }), NOW), state).toBe(false);
    }
  });

  it("is not active once its date has passed, whatever Play last said", () => {
    expect(entitlementIsActive(entitlement({ state: "ACTIVE", expiresAtMillis: NOW - 1 }), NOW)).toBe(false);
    expect(entitlementIsActive(entitlement({ state: "ACTIVE", expiresAtMillis: NOW }), NOW)).toBe(false);
  });
});

behaviour("memory", async () => createMemoryStores());

const mongoUri = process.env.MONGODB_URI_TEST;
const mongoMemory = process.env.MONGO_MEMORY === "1";

if (mongoUri || mongoMemory) {
  describe("account stores: MongoDB", () => {
    let stop: (() => Promise<void>) | undefined;
    const dbName = `chef_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let connection: Awaited<ReturnType<typeof connectMongo>>;

    beforeAll(async () => {
      let uri = mongoUri;
      if (!uri) {
        const { MongoMemoryServer } = await import("mongodb-memory-server");
        const server = await MongoMemoryServer.create();
        uri = server.getUri();
        stop = async () => void (await server.stop());
      }
      connection = await connectMongo(uri, dbName);
    }, 300_000);

    afterAll(async () => {
      // Only the disposable database goes: never `chef`, never anything else on the server.
      await connection?.db.dropDatabase();
      await connection?.close();
      await stop?.();
    });

    it("is named chef unless told otherwise, and keeps its collections apart", () => {
      expect(DEFAULT_DB_NAME).toBe("chef");
      expect(Object.values(COLLECTIONS).sort()).toEqual(["ai_usage", "entitlements", "households", "rtdn_messages", "users"]);
    });

    it("creates the unique and expiry indexes", async () => {
      const indexes = async (name: string) => (await connection.db.collection(name).indexes()).map((index) => index.name);

      expect(await indexes(COLLECTIONS.users)).toEqual(expect.arrayContaining(["googleSub_1", "id_1"]));
      expect(await indexes(COLLECTIONS.entitlements)).toContain("purchaseToken_1");
      expect(await indexes(COLLECTIONS.households)).toEqual(expect.arrayContaining(["ownerId_1", "memberId_1", "inviteHash_1"]));
      expect(await indexes(COLLECTIONS.aiUsage)).toContain("userId_1_monthKey_1");
      const ttl = (await connection.db.collection(COLLECTIONS.rtdnMessages).indexes()).find((index) => index.name === "seenAt_1");
      expect(ttl?.expireAfterSeconds).toBe(30 * 24 * 60 * 60);
    });

    it("refuses two users for one Google account, even when two sign-ins race", async () => {
      const stores = createMongoStores(connection.db);

      const users = await Promise.all(
        Array.from({ length: 5 }, () => stores.users.upsertByGoogle({ googleSub: "sub-race", email: "r@example.com", name: null }, NOW)),
      );

      expect(new Set(users.map((user) => user.id)).size).toBe(1);
      expect(await connection.db.collection(COLLECTIONS.users).countDocuments({ googleSub: "sub-race" })).toBe(1);
    });

    behaviour("MongoDB", async () => createMongoStores(connection.db));
  });
}
