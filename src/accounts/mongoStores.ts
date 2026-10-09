import { MongoHouseholds, type Household } from "./householdStores.js";
import { randomUUID } from "node:crypto";
import { type Collection, type Db, MongoClient } from "mongodb";
import type {
  AccountStores,
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
    const found = await this.users.findOneAndUpdate(
      { googleSub: profile.googleSub },
      {
        $set: { email: profile.email, name: profile.name },
        $setOnInsert: { id: randomUUID(), googleSub: profile.googleSub, createdAtMillis: nowMillis },
      },
      { upsert: true, returnDocument: "after" },
    );
    if (!found) throw new Error("user upsert returned nothing");
    return withoutMongoId(found);
  }

  async findById(id: string): Promise<User | null> {
    const found = await this.users.findOne({ id });
    return found ? withoutMongoId(found) : null;
  }

  async setMascotEnabled(id: string, enabled: boolean): Promise<boolean> {
    const result = await this.users.updateOne({ id }, { $set: { mascotEnabled: enabled } });
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
  await db.collection(COLLECTIONS.users).createIndexes([
    { key: { googleSub: 1 }, unique: true },
    { key: { id: 1 }, unique: true },
  ]);
  await db.collection(COLLECTIONS.entitlements).createIndexes([
    { key: { purchaseToken: 1 }, unique: true },
    { key: { userId: 1 } },
  ]);
  await db.collection(COLLECTIONS.aiUsage).createIndexes([{ key: { userId: 1, monthKey: 1 }, unique: true }]);
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
