import { randomUUID } from "node:crypto";
import type {
  AccountStores,
  Entitlement,
  EntitlementStore,
  GoogleProfile,
  RefreshTokenRecord,
  RefreshTokenStore,
  RtdnStore,
  UsageStore,
  User,
  UserStore,
} from "./stores.js";

class MemoryUsers implements UserStore {
  private readonly byId = new Map<string, User>();

  async upsertByGoogle(profile: GoogleProfile, nowMillis: number): Promise<User> {
    const existing = [...this.byId.values()].find((user) => user.googleSub === profile.googleSub);
    const user: User = existing
      ? { ...existing, email: profile.email, name: profile.name }
      : { id: randomUUID(), googleSub: profile.googleSub, email: profile.email, name: profile.name, createdAtMillis: nowMillis };
    this.byId.set(user.id, user);
    return user;
  }

  async findById(id: string): Promise<User | null> {
    return this.byId.get(id) ?? null;
  }

  async deleteById(id: string): Promise<void> {
    this.byId.delete(id);
  }
}

export class MemoryRefreshTokens implements RefreshTokenStore {
  private readonly byHash = new Map<string, RefreshTokenRecord>();
  private readonly used = new Map<string, { userId: string; untilMillis: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async save(record: RefreshTokenRecord): Promise<void> {
    this.byHash.set(record.tokenHash, record);
  }

  async consume(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const record = this.byHash.get(tokenHash) ?? null;
    this.byHash.delete(tokenHash);
    if (record) this.used.set(tokenHash, { userId: record.userId, untilMillis: record.expiresAtMillis });
    return record;
  }

  async usedBy(tokenHash: string): Promise<string | null> {
    const found = this.used.get(tokenHash);
    if (!found) return null;
    if (found.untilMillis <= this.now()) {
      this.used.delete(tokenHash);
      return null;
    }
    return found.userId;
  }

  async revoke(tokenHash: string): Promise<void> {
    this.byHash.delete(tokenHash);
  }

  async revokeAllForUser(userId: string): Promise<void> {
    for (const [hash, record] of this.byHash) if (record.userId === userId) this.byHash.delete(hash);
  }
}

class MemoryEntitlements implements EntitlementStore {
  private readonly byToken = new Map<string, Entitlement>();

  async upsertByPurchaseToken(entitlement: Entitlement): Promise<void> {
    this.byToken.set(entitlement.purchaseToken, { ...entitlement });
  }

  async findByPurchaseToken(purchaseToken: string): Promise<Entitlement | null> {
    const found = this.byToken.get(purchaseToken);
    return found ? { ...found } : null;
  }

  async listForUser(userId: string): Promise<Entitlement[]> {
    return [...this.byToken.values()].filter((entitlement) => entitlement.userId === userId).map((entitlement) => ({ ...entitlement }));
  }

  async deleteForUser(userId: string): Promise<void> {
    for (const [token, entitlement] of this.byToken) if (entitlement.userId === userId) this.byToken.delete(token);
  }
}

class MemoryUsage implements UsageStore {
  private readonly units = new Map<string, number>();
  private key = (userId: string, monthKey: string) => `${userId}|${monthKey}`;

  async get(userId: string, monthKey: string): Promise<number> {
    return this.units.get(this.key(userId, monthKey)) ?? 0;
  }

  async add(userId: string, monthKey: string, units: number): Promise<number> {
    const total = (this.units.get(this.key(userId, monthKey)) ?? 0) + units;
    this.units.set(this.key(userId, monthKey), total);
    return total;
  }

  async deleteForUser(userId: string): Promise<void> {
    for (const key of this.units.keys()) if (key.startsWith(`${userId}|`)) this.units.delete(key);
  }
}

class MemoryRtdn implements RtdnStore {
  private readonly seen = new Set<string>();

  async firstSeen(messageId: string): Promise<boolean> {
    if (this.seen.has(messageId)) return false;
    this.seen.add(messageId);
    return true;
  }

  async forget(messageId: string): Promise<void> {
    this.seen.delete(messageId);
  }
}

/** Everything in memory: what the tests and a local run without a database use. Gone when the process ends. */
export function createMemoryStores(now: () => number = Date.now): AccountStores {
  return {
    users: new MemoryUsers(),
    refreshTokens: new MemoryRefreshTokens(now),
    entitlements: new MemoryEntitlements(),
    usage: new MemoryUsage(),
    rtdn: new MemoryRtdn(),
  };
}
