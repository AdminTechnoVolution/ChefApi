import { canonicalAllergens, type AllergenId } from "../allergens/catalog.js";
import { MongoHouseholds, type Household } from "./householdStores.js";
import { ApiError } from "../errors.js";
import { randomUUID } from "node:crypto";
import { type Collection, type Db, MongoClient } from "mongodb";
import type {
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

  async complete(input: AdRewardReservation & { transactionId: string }, nowMillis: number): Promise<"awarded" | "duplicate" | "invalid"> {
    const result = await this.rewards.updateOne(
      {
        userId: input.userId, dayKey: input.dayKey, monthKey: input.monthKey,
        activeToken: input.token, activeUntilMillis: { $gt: nowMillis },
        completed: { $lt: 5 }, transactionIds: { $ne: input.transactionId },
      },
      { $inc: { completed: 1 }, $push: { transactionIds: input.transactionId }, $unset: { activeToken: "", activeUntilMillis: "" } },
    );
    if (result.modifiedCount === 1) return "awarded";
    const duplicate = await this.rewards.findOne({ userId: input.userId, dayKey: input.dayKey, transactionIds: input.transactionId });
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
  return {
    households: new MongoHouseholds(db.collection<Household>(COLLECTIONS.households)),
    users: new MongoUsers(db.collection<User>(COLLECTIONS.users)),
    entitlements: new MongoEntitlements(db.collection<Entitlement>(COLLECTIONS.entitlements)),
    usage: new MongoUsage(db.collection<UsageDocument>(COLLECTIONS.aiUsage)),
    adRewards: new MongoAdRewards(db.collection<AdRewardDocument>(COLLECTIONS.adRewards)),
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
