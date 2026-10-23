import { canonicalAllergens, type AllergenId } from "../allergens/catalog.js";
import { MongoHouseholds, type Household } from "./householdStores.js";
import { ApiError } from "../errors.js";
import { randomUUID } from "node:crypto";
import { MongoServerError, type Collection, type Db, MongoClient } from "mongodb";
import type {
  AppleAccountLinkStore,
  AccountStores,
  AdRewardReservation,
  AdRewardStore,
  AppleProfile,
  Entitlement,
  EntitlementStore,
  GoogleProfile,
  RtdnStore,
  UsageStore,
  User,
  UserStore,
} from "./stores.js";

/** The database every Chef collection lives in. */
export const DEFAULT_DB_NAME = "chef";

export const COLLECTIONS = {
  users: "users",
  households: "households",
  entitlements: "entitlements",
  aiUsage: "ai_usage",
  adRewards: "ad_rewards",
  rtdnMessages: "rtdn_messages",
} as const;

const RTDN_KEEP_SECONDS = 30 * 24 * 60 * 60;

/** MongoDB adds `_id` to what it stores; none of it should leak into the domain objects. */
const withoutMongoId = <T extends object>(document: T & { _id?: unknown }): T => {
  const { _id: _ignored, ...rest } = document;
  return rest as T;
};

class MongoUsers implements UserStore {
  constructor(private readonly users: Collection<User>) {}

  async upsertByGoogle(profile: GoogleProfile, nowMillis: number): Promise<User> {
    const existing = await this.users.findOne({ googleSub: profile.googleSub });
    if (!existing && await this.users.findOne({ appleSub: { $type: "string" }, email: profile.email }, { collation: { locale: "en", strength: 2 } })) throw new ApiError("conflict", "Use the original sign-in provider for this email.");
    const found = await this.users.findOneAndUpdate(
      { googleSub: profile.googleSub },
      {
        $set: { email: profile.email, name: profile.name },
        $setOnInsert: { id: randomUUID(), googleSub: profile.googleSub, createdAtMillis: nowMillis },
      },
      { upsert: true, returnDocument: "after" },
    );
    if (!found) throw new Error("user upsert returned nothing");
    return { ...withoutMongoId(found), allergens: found.allergens ?? [] };
  }

  async upsertByApple(profile: AppleProfile, name: string | null, nowMillis: number): Promise<User> {
    const existing = await this.users.findOne({ appleSub: profile.appleSub });
    if (existing) return { ...withoutMongoId(existing), allergens: existing.allergens ?? [] };
    if (!profile.email) throw new ApiError("invalid_request", "Apple did not provide an email for this new account.");
    if (await this.users.findOne({ email: profile.email }, { collation: { locale: "en", strength: 2 } })) throw new ApiError("conflict", "Use the original sign-in provider for this email.");
    const found = await this.users.findOneAndUpdate({ appleSub: profile.appleSub }, {
      $setOnInsert: { id: randomUUID(), appleSub: profile.appleSub, email: profile.email, name, createdAtMillis: nowMillis },
    }, { upsert: true, returnDocument: "after" });
    if (!found) throw new Error("user upsert returned nothing");
    return { ...withoutMongoId(found), allergens: found.allergens ?? [] };
  }

  async findById(id: string): Promise<User | null> {
    const found = await this.users.findOne({ id });
    return found ? { ...withoutMongoId(found), allergens: found.allergens ?? [] } : null;
  }

  async setMascotEnabled(id: string, enabled: boolean): Promise<boolean> {
    const result = await this.users.updateOne({ id }, { $set: { mascotEnabled: enabled } });
    return result.matchedCount === 1;
  }

  async setAllergens(id: string, allergens: readonly AllergenId[]): Promise<boolean> {
    const result = await this.users.updateOne({ id }, { $set: { allergens: canonicalAllergens(allergens) } });
    return result.matchedCount === 1;
  }

  async deleteById(id: string): Promise<void> {
    await this.users.deleteOne({ id });
  }
}

class MongoEntitlements implements EntitlementStore {
  constructor(private readonly entitlements: Collection<Entitlement>) {}

  async upsertByPurchaseToken(entitlement: Entitlement): Promise<void> {
    await this.entitlements.replaceOne({ purchaseToken: entitlement.purchaseToken }, { ...entitlement }, { upsert: true });
  }

  async findByPurchaseToken(purchaseToken: string): Promise<Entitlement | null> {
    const found = await this.entitlements.findOne({ purchaseToken });
    return found ? withoutMongoId(found) : null;
  }

  async listForUser(userId: string): Promise<Entitlement[]> {
    return (await this.entitlements.find({ userId }).toArray()).map((document) => withoutMongoId(document));
  }

  async deleteForUser(userId: string): Promise<void> {
    await this.entitlements.deleteMany({ userId });
  }
}

interface UsageDocument {
  userId: string;
  monthKey: string;
  units: number;
  baseUnits?: number;
  adUnits?: number;
}

class MongoUsage implements UsageStore {
  constructor(private readonly usage: Collection<UsageDocument>) {}

  async get(userId: string, monthKey: string): Promise<number> {
    return (await this.usage.findOne({ userId, monthKey }))?.units ?? 0;
  }

  async add(userId: string, monthKey: string, units: number): Promise<number> {
    const updated = await this.usage.findOneAndUpdate(
      { userId, monthKey },
      { $inc: { units } },
      { upsert: true, returnDocument: "after" },
    );
    return updated?.units ?? units;
  }

  async getFreeUsage(userId: string, monthKey: string, baseLimit: number): Promise<{ baseUnitsUsed: number; adUnitsUsed: number }> {
    const usage = await this.usage.findOne({ userId, monthKey });
    if (!usage) return { baseUnitsUsed: 0, adUnitsUsed: 0 };
    return {
      baseUnitsUsed: usage.baseUnits ?? Math.min(usage.units, baseLimit),
      adUnitsUsed: usage.adUnits ?? 0,
    };
  }

  async addFreeUsage(userId: string, monthKey: string, units: number, baseUnits: number, adUnits: number, baseLimit: number): Promise<void> {
    await this.usage.findOneAndUpdate(
      { userId, monthKey },
      [{
        $set: {
          units: { $add: [{ $ifNull: ["$units", 0] }, units] },
          baseUnits: {
            $add: [
              { $ifNull: ["$baseUnits", { $min: [{ $ifNull: ["$units", 0] }, baseLimit] }] },
              baseUnits,
            ],
          },
          adUnits: { $add: [{ $ifNull: ["$adUnits", 0] }, adUnits] },
        },
      }],
      { upsert: true, returnDocument: "after" },
    );
  }

  async deleteForUser(userId: string): Promise<void> {
    await this.usage.deleteMany({ userId });
  }
}

interface AdRewardDocument {
  userId: string;
  dayKey: string;
  monthKey: string;
  dayStartedAt: Date;
  completed: number;
  transactionIds: string[];
  completedReservationTokens?: string[];
  activeToken?: string;
  activeUntilMillis?: number;
}

class MongoAdRewards implements AdRewardStore {
  constructor(private readonly rewards: Collection<AdRewardDocument>) {}

  async reserve(reservation: AdRewardReservation, nowMillis: number): Promise<boolean> {
    try {
      // Release reservations from a previous UTC day once their 15-minute lease has elapsed. The partial unique user index below
      // makes the update/upsert race safe and keeps the one-active-ad rule account-wide, including across midnight.
      await this.rewards.updateMany(
        { userId: reservation.userId, activeUntilMillis: { $lte: nowMillis } },
        { $unset: { activeToken: "", activeUntilMillis: "" } },
      );
      const result = await this.rewards.updateOne(
        {
          userId: reservation.userId,
          dayKey: reservation.dayKey,
          completed: { $lt: 5 },
          $or: [{ activeToken: { $exists: false } }, { activeUntilMillis: { $lte: nowMillis } }],
        },
        {
          $set: { monthKey: reservation.monthKey, activeToken: reservation.token, activeUntilMillis: reservation.expiresAtMillis },
          $setOnInsert: { completed: 0, transactionIds: [], dayStartedAt: new Date(`${reservation.dayKey}T00:00:00.000Z`) },
        },
        { upsert: true },
      );
      return result.modifiedCount === 1 || result.upsertedCount === 1;
    } catch (error) {
      // Existing daily document with a current reservation or five completions does not match the upsert filter.
      if ((error as { code?: number }).code === 11000) return false;
      throw error;
    }
  }

  async findReservation(token: string): Promise<AdRewardReservation | null> {
    const found = await this.rewards.findOne({ activeToken: token });
    if (!found || found.activeUntilMillis === undefined) return null;
    return { userId: found.userId, dayKey: found.dayKey, monthKey: found.monthKey, token, expiresAtMillis: found.activeUntilMillis };
  }

  async hasTransaction(transactionId: string): Promise<boolean> {
    return (await this.rewards.findOne({ transactionIds: transactionId }, { projection: { _id: 1 } })) !== null;
  }

  async activeReservation(userId: string, nowMillis: number): Promise<AdRewardReservation | null> {
    const found = await this.rewards.findOne({ userId, activeUntilMillis: { $gt: nowMillis } });
    if (!found?.activeToken || found.activeUntilMillis === undefined) return null;
    return { userId: found.userId, dayKey: found.dayKey, monthKey: found.monthKey, token: found.activeToken, expiresAtMillis: found.activeUntilMillis };
  }

  async cancel(userId: string, dayKey: string, token: string): Promise<void> {
    await this.rewards.updateOne({ userId, dayKey, activeToken: token }, { $unset: { activeToken: "", activeUntilMillis: "" } });
  }

  async completeFromClient(userId: string, token: string, nowMillis: number): Promise<"awarded" | "duplicate" | "invalid"> {
    const result = await this.rewards.updateOne(
      { userId, activeToken: token, activeUntilMillis: { $gt: nowMillis }, completed: { $lt: 5 } },
      {
        $inc: { completed: 1 },
        $push: { completedReservationTokens: token, transactionIds: `client:${token}` },
        $unset: { activeToken: "", activeUntilMillis: "" },
      },
    );
    if (result.modifiedCount === 1) return "awarded";
    const duplicate = await this.rewards.findOne({ userId, completedReservationTokens: token }, { projection: { _id: 1 } });
    return duplicate ? "duplicate" : "invalid";
  }

  async hasCompletedReservation(token: string): Promise<boolean> {
    return (await this.rewards.findOne({ completedReservationTokens: token }, { projection: { _id: 1 } })) !== null;
  }

  async complete(input: AdRewardReservation & { transactionId: string }, nowMillis: number): Promise<"awarded" | "duplicate" | "invalid"> {
    const result = await this.rewards.updateOne(
      {
        userId: input.userId, dayKey: input.dayKey, monthKey: input.monthKey,
        activeToken: input.token, activeUntilMillis: { $gt: nowMillis },
        completed: { $lt: 5 }, transactionIds: { $ne: input.transactionId },
      },
      {
        $inc: { completed: 1 },
        $push: { transactionIds: input.transactionId, completedReservationTokens: input.token },
        $unset: { activeToken: "", activeUntilMillis: "" },
      },
    );
    if (result.modifiedCount === 1) return "awarded";
    const duplicate = await this.rewards.findOne({
      userId: input.userId,
      $or: [
        { transactionIds: input.transactionId },
        { completedReservationTokens: input.token },
      ],
    });
    if (duplicate && !duplicate.transactionIds.includes(input.transactionId)) {
      await this.rewards.updateOne(
        { userId: input.userId, completedReservationTokens: input.token, transactionIds: { $ne: input.transactionId } },
        { $push: { transactionIds: input.transactionId } },
      );
    }
    return duplicate ? "duplicate" : "invalid";
  }

  async daily(userId: string, dayKey: string, nowMillis: number): Promise<{ completed: number; reserved: boolean }> {
    const day = await this.rewards.findOne({ userId, dayKey });
    return { completed: day?.completed ?? 0, reserved: !!day?.activeToken && (day.activeUntilMillis ?? 0) > nowMillis };
  }

  async monthlyCredits(userId: string, monthKey: string): Promise<number> {
    const days = await this.rewards.find({ userId, monthKey }).toArray();
    return days.reduce((total, day) => total + day.completed * 5, 0);
  }

  async deleteForUser(userId: string): Promise<void> {
    await this.rewards.deleteMany({ userId });
  }
}

interface RtdnDocument {
  messageId: string;
  seenAt: Date;
}

class MongoRtdn implements RtdnStore {
  constructor(private readonly messages: Collection<RtdnDocument>) {}

  async firstSeen(messageId: string, nowMillis: number): Promise<boolean> {
    // The unique index makes the insert the test: a second delivery of the same message fails it.
    try {
      await this.messages.insertOne({ messageId, seenAt: new Date(nowMillis) });
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return false;
      throw error;
    }
  }

  async forget(messageId: string): Promise<void> {
    await this.messages.deleteOne({ messageId });
  }
}

/** Creates the indexes the stores rely on. Safe to run on every start. */
export async function ensureIndexes(db: Db): Promise<void> {
  await db.collection(COLLECTIONS.households).createIndexes([
    { key: { ownerId: 1 }, unique: true },
    { key: { memberId: 1 }, unique: true, partialFilterExpression: { memberId: { $type: "string" } } },
    { key: { inviteHash: 1 }, unique: true, partialFilterExpression: { inviteHash: { $type: "string" } } },
  ]);
  const users = db.collection(COLLECTIONS.users);
  // Replace only the legacy mandatory Google index; preserve every user document.
  const indexes = await users.listIndexes().toArray().catch((error: { code?: number }) => {
    if (error.code === 26) return [];
    throw error;
  });
  for (const index of indexes) {
    if (index.key.googleSub === 1 && Object.keys(index.key).length === 1 && !index.partialFilterExpression) await users.dropIndex(index.name!);
  }
  await users.createIndexes([
    { key: { googleSub: 1 }, unique: true, partialFilterExpression: { googleSub: { $type: "string" } } },
    { key: { appleSub: 1 }, unique: true, partialFilterExpression: { appleSub: { $type: "string" } } },
    { key: { id: 1 }, unique: true },
  ]);
  await db.collection(COLLECTIONS.entitlements).createIndexes([
    { key: { purchaseToken: 1 }, unique: true },
    { key: { userId: 1 } },
  ]);
  await db.collection(COLLECTIONS.aiUsage).createIndexes([{ key: { userId: 1, monthKey: 1 }, unique: true }]);
  await db.collection(COLLECTIONS.adRewards).createIndexes([
    { key: { userId: 1, dayKey: 1 }, unique: true },
    { key: { userId: 1 }, unique: true, partialFilterExpression: { activeToken: { $type: "string" } } },
    { key: { userId: 1, monthKey: 1 } },
    { key: { dayStartedAt: 1 }, expireAfterSeconds: 62 * 24 * 60 * 60 },
  ]);
  await db.collection(COLLECTIONS.rtdnMessages).createIndexes([
    { key: { messageId: 1 }, unique: true },
    { key: { seenAt: 1 }, expireAfterSeconds: RTDN_KEEP_SECONDS },
  ]);
}

/** What MongoDB holds. Sessions are not here: refresh tokens and revocations live in Redis, where they can expire by themselves. */
export type MongoStores = Omit<AccountStores, "refreshTokens">;

export function createMongoStores(db: Db): MongoStores {
  const users = db.collection<User>(COLLECTIONS.users);
  const households = db.collection<Household>(COLLECTIONS.households);
  const entitlements = db.collection<Entitlement>(COLLECTIONS.entitlements);
  const usage = db.collection<UsageDocument>(COLLECTIONS.aiUsage);
  const rewards = db.collection<AdRewardDocument>(COLLECTIONS.adRewards);
  const appleAccountLinks: AppleAccountLinkStore = {
    async linkAppleAccount(primaryUserId, profile, name, freeMonthlyLimit, nowMillis) {
      const session = db.client.startSession();
      let retiredUserId: string | null = null;
      try {
        await session.withTransaction(async () => {
          const primary = await users.findOne({ id: primaryUserId }, { session });
          if (!primary) throw new ApiError("unauthorized", "Sign in to link an account.");
          if (primary.appleSub && primary.appleSub !== profile.appleSub) throw new ApiError("conflict", "This account already has a different Apple ID linked.");
          const foundAppleAccount = await users.findOne({ appleSub: profile.appleSub }, { session });
          const secondary = foundAppleAccount?.id === primaryUserId ? null : foundAppleAccount;
          if (secondary?.googleSub) throw new ApiError("conflict", "This Apple ID is linked to an account that also uses Google. Sign in to that account to manage it.");
          if (await households.findOne({ $or: [{ ownerId: primaryUserId }, { memberId: primaryUserId }] }, { session }) ||
              secondary && await households.findOne({ $or: [{ ownerId: secondary.id }, { memberId: secondary.id }] }, { session })) {
            throw new ApiError("conflict", "Leave shared households before linking these accounts.");
          }
          if (secondary && await rewards.findOne({ userId: secondary.id, activeUntilMillis: { $gt: nowMillis } }, { session })) {
            throw new ApiError("conflict", "Finish or wait for the active rewarded ad before linking these accounts.");
          }

          if (secondary) {
            await entitlements.updateMany({ userId: secondary.id }, { $set: { userId: primaryUserId } }, { session });
            const oldUsage = await usage.find({ userId: secondary.id }, { session }).toArray();
            for (const source of oldUsage) {
              const target = await usage.findOne({ userId: primaryUserId, monthKey: source.monthKey }, { session });
              const sourceBase = source.baseUnits ?? Math.min(source.units, freeMonthlyLimit);
              const targetBase = target ? target.baseUnits ?? Math.min(target.units, freeMonthlyLimit) : 0;
              await usage.replaceOne(
                { userId: primaryUserId, monthKey: source.monthKey },
                {
                  userId: primaryUserId,
                  monthKey: source.monthKey,
                  units: source.units + (target?.units ?? 0),
                  baseUnits: sourceBase + targetBase,
                  adUnits: (source.adUnits ?? 0) + (target?.adUnits ?? 0),
                },
                { upsert: true, session },
              );
            }
            await usage.deleteMany({ userId: secondary.id }, { session });

            await rewards.updateMany(
              { userId: secondary.id, activeToken: { $type: "string" }, activeUntilMillis: { $lte: nowMillis } },
              { $unset: { activeToken: "", activeUntilMillis: "" } },
              { session },
            );
            const oldRewards = await rewards.find({ userId: secondary.id }, { session }).toArray();
            for (const source of oldRewards) {
              const target = await rewards.findOne({ userId: primaryUserId, dayKey: source.dayKey }, { session });
              const sourceData = withoutMongoId(source);
              const targetData = target ? withoutMongoId(target) : null;
              await rewards.replaceOne(
                { userId: primaryUserId, dayKey: source.dayKey },
                targetData
                  ? {
                      ...targetData,
                      userId: primaryUserId,
                      completed: targetData.completed + sourceData.completed,
                      transactionIds: [...new Set([...targetData.transactionIds, ...sourceData.transactionIds])],
                      completedReservationTokens: [...new Set([...(targetData.completedReservationTokens ?? []), ...(sourceData.completedReservationTokens ?? [])])],
                    }
                  : { ...sourceData, userId: primaryUserId },
                { upsert: true, session },
              );
            }
            await rewards.deleteMany({ userId: secondary.id }, { session });
          }

          const allergens = [...new Set([...(primary.allergens ?? []), ...(secondary?.allergens ?? [])])];
          const linkedAccountIds = secondary
            ? [...new Set([...(primary.linkedAccountIds ?? []), secondary.id])]
            : primary.linkedAccountIds;
          const attached = await users.updateOne(
            { id: primaryUserId, $or: [{ appleSub: { $exists: false } }, { appleSub: profile.appleSub }] },
            {
              $set: {
                appleSub: profile.appleSub,
                allergens,
                appleEmail: profile.email ?? primary.appleEmail ?? secondary?.appleEmail ?? secondary?.email ?? null,
                appleName: name ?? primary.appleName ?? secondary?.appleName ?? secondary?.name ?? null,
                ...(linkedAccountIds ? { linkedAccountIds } : {}),
              },
            },
            { session },
          );
          if (attached.matchedCount !== 1) throw new ApiError("conflict", "This account already has a different Apple ID linked.");
          if (secondary) {
            await users.deleteOne({ id: secondary.id }, { session });
            retiredUserId = secondary.id;
          }
        });
        return retiredUserId;
      } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000) {
          throw new ApiError("conflict", "This Apple ID is already linked to another account.", { cause: error });
        }
        throw error;
      } finally {
        await session.endSession();
      }
    },
  };
  return {
    appleAccountLinks,
    households: new MongoHouseholds(db.collection<Household>(COLLECTIONS.households)),
    users: new MongoUsers(users),
    entitlements: new MongoEntitlements(entitlements),
    usage: new MongoUsage(usage),
    adRewards: new MongoAdRewards(rewards),
    rtdn: new MongoRtdn(db.collection<RtdnDocument>(COLLECTIONS.rtdnMessages)),
  };
}

export interface MongoConnection {
  db: Db;
  close(): Promise<void>;
}

/** Connects to MongoDB and opens the `chef` database (or the one named), with its indexes in place. */
export async function connectMongo(
  uri: string,
  dbName: string = DEFAULT_DB_NAME,
  options: { serverSelectionTimeoutMS?: number } = {},
): Promise<MongoConnection> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: options.serverSelectionTimeoutMS ?? 10_000 });
  try {
    await client.connect();
    const db = client.db(dbName);
    await ensureIndexes(db);
    return { db, close: () => client.close() };
  } catch (error) {
    // Do not leave the driver's sockets and timers running behind a startup that is about to stop.
    await client.close().catch(() => undefined);
    throw error;
  }
}
