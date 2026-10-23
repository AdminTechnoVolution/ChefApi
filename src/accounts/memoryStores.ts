import { canonicalAllergens, type AllergenId } from "../allergens/catalog.js";
import { MemoryHouseholds } from "./householdStores.js";
import { ApiError } from "../errors.js";
import { randomUUID } from "node:crypto";
import type {
  AccountStores,
  AdRewardReservation,
  AdRewardStore,
  AppleProfile,
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
    if (!existing && [...this.byId.values()].some(user => user.appleSub && user.email.toLowerCase() === profile.email.toLowerCase())) throw new ApiError("conflict", "Use the original sign-in provider for this email.");
    const user: User = existing
      ? { ...existing, email: profile.email, name: profile.name }
      : { id: randomUUID(), googleSub: profile.googleSub, email: profile.email, name: profile.name, createdAtMillis: nowMillis };
    this.byId.set(user.id, user);
    return { ...user, allergens: [...(user.allergens ?? [])] };
  }

  async upsertByApple(profile: AppleProfile, name: string | null, nowMillis: number): Promise<User> {
    const existing = [...this.byId.values()].find(user => user.appleSub === profile.appleSub);
    if (existing) return { ...existing, allergens: [...(existing.allergens ?? [])] };
    if (!profile.email) throw new ApiError("invalid_request", "Apple did not provide an email for this new account.");
    if ([...this.byId.values()].some(user => user.email.toLowerCase() === profile.email!.toLowerCase())) throw new ApiError("conflict", "Use the original sign-in provider for this email.");
    const user: User = { id: randomUUID(), appleSub: profile.appleSub, email: profile.email, name, createdAtMillis: nowMillis };
    this.byId.set(user.id, user);
    return { ...user, allergens: [...(user.allergens ?? [])] };
  }

  async findById(id: string): Promise<User | null> {
    const user = this.byId.get(id);
    return user ? { ...user, allergens: [...(user.allergens ?? [])] } : null;
  }

  async setMascotEnabled(id: string, enabled: boolean): Promise<boolean> {
    const user = this.byId.get(id);
    if (!user) return false;
    this.byId.set(id, { ...user, mascotEnabled: enabled });
    return true;
  }

  async setAllergens(id: string, allergens: readonly AllergenId[]): Promise<boolean> {
    const user = this.byId.get(id);
    if (!user) return false;
    this.byId.set(id, { ...user, allergens: canonicalAllergens(allergens) });
    return true;
  }

  async deleteById(id: string): Promise<void> {
    this.byId.delete(id);
  }

  async findByAppleSub(appleSub: string): Promise<User | null> {
    const user = [...this.byId.values()].find((candidate) => candidate.appleSub === appleSub);
    return user ? { ...user, allergens: [...(user.allergens ?? [])] } : null;
  }

  async linkAppleIdentity(primaryUserId: string, appleSub: string): Promise<string | null> {
    const primary = this.byId.get(primaryUserId);
    if (!primary) throw new ApiError("unauthorized", "Sign in to link an account.");
    if (primary.appleSub && primary.appleSub !== appleSub) throw new ApiError("conflict", "This account already has a different Apple ID linked.");
    const secondary = [...this.byId.values()].find((candidate) => candidate.appleSub === appleSub);
    if (secondary?.id === primaryUserId) return null;
    if (secondary?.googleSub) throw new ApiError("conflict", "This Apple ID is linked to an account that also uses Google. Sign in to that account to manage it.");
    const allergens = [...new Set([...(primary.allergens ?? []), ...(secondary?.allergens ?? [])])];
    this.byId.set(primaryUserId, {
      ...primary,
      appleSub,
      allergens,
      ...(secondary ? { linkedAccountIds: [...new Set([...(primary.linkedAccountIds ?? []), secondary.id])] } : {}),
    });
    if (secondary) this.byId.delete(secondary.id);
    return secondary?.id ?? null;
  }

  async updateAppleProfile(userId: string, email: string | null, name: string | null): Promise<void> {
    const user = this.byId.get(userId);
    if (!user) throw new ApiError("unauthorized", "Sign in to link an account.");
    this.byId.set(userId, { ...user, appleEmail: email, appleName: name });
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

  async moveToUser(sourceUserId: string, targetUserId: string): Promise<void> {
    for (const [token, entitlement] of this.byToken) {
      if (entitlement.userId === sourceUserId) this.byToken.set(token, { ...entitlement, userId: targetUserId });
    }
  }
}

class MemoryUsage implements UsageStore {
  private readonly units = new Map<string, { total: number; baseUnits?: number; adUnits?: number }>();
  private key = (userId: string, monthKey: string) => `${userId}|${monthKey}`;

  async get(userId: string, monthKey: string): Promise<number> {
    return this.units.get(this.key(userId, monthKey))?.total ?? 0;
  }

  async add(userId: string, monthKey: string, units: number): Promise<number> {
    const key = this.key(userId, monthKey);
    const entry = this.units.get(key) ?? { total: 0 };
    entry.total += units;
    this.units.set(key, entry);
    return entry.total;
  }

  async getFreeUsage(userId: string, monthKey: string, baseLimit: number): Promise<{ baseUnitsUsed: number; adUnitsUsed: number }> {
    const entry = this.units.get(this.key(userId, monthKey));
    if (!entry) return { baseUnitsUsed: 0, adUnitsUsed: 0 };
    return {
      baseUnitsUsed: entry.baseUnits ?? Math.min(entry.total, baseLimit),
      adUnitsUsed: entry.adUnits ?? 0,
    };
  }

  async addFreeUsage(userId: string, monthKey: string, units: number, baseUnits: number, adUnits: number, baseLimit: number): Promise<void> {
    const key = this.key(userId, monthKey);
    const entry = this.units.get(key) ?? { total: 0 };
    entry.baseUnits = (entry.baseUnits ?? Math.min(entry.total, baseLimit)) + baseUnits;
    entry.adUnits = (entry.adUnits ?? 0) + adUnits;
    entry.total += units;
    this.units.set(key, entry);
  }

  async deleteForUser(userId: string): Promise<void> {
    for (const key of this.units.keys()) if (key.startsWith(`${userId}|`)) this.units.delete(key);
  }

  async mergeUser(sourceUserId: string, targetUserId: string, baseLimit: number): Promise<void> {
    for (const [key, source] of [...this.units]) {
      if (!key.startsWith(`${sourceUserId}|`)) continue;
      const monthKey = key.slice(sourceUserId.length + 1);
      const targetKey = this.key(targetUserId, monthKey);
      const target = this.units.get(targetKey);
      const sourceBase = source.baseUnits ?? Math.min(source.total, baseLimit);
      const targetBase = target ? target.baseUnits ?? Math.min(target.total, baseLimit) : 0;
      this.units.set(targetKey, {
        total: (target?.total ?? 0) + source.total,
        baseUnits: targetBase + sourceBase,
        adUnits: (target?.adUnits ?? 0) + (source.adUnits ?? 0),
      });
      this.units.delete(key);
    }
  }
}

class MemoryAdRewards implements AdRewardStore {
  private readonly days = new Map<string, {
    monthKey: string;
    reservation?: AdRewardReservation;
    completed: string[];
    completedReservations: string[];
  }>();
  private key = (userId: string, dayKey: string) => `${userId}|${dayKey}`;

  async reserve(reservation: AdRewardReservation, nowMillis: number): Promise<boolean> {
    if (await this.activeReservation(reservation.userId, nowMillis)) return false;
    const key = this.key(reservation.userId, reservation.dayKey);
    const day = this.days.get(key) ?? { monthKey: reservation.monthKey, completed: [], completedReservations: [] };
    if (day.completed.length >= 5 || (day.reservation && day.reservation.expiresAtMillis > nowMillis)) return false;
    day.reservation = reservation;
    this.days.set(key, day);
    return true;
  }

  async findReservation(token: string): Promise<AdRewardReservation | null> {
    for (const day of this.days.values()) if (day.reservation?.token === token) return { ...day.reservation };
    return null;
  }

  async hasTransaction(transactionId: string): Promise<boolean> {
    return [...this.days.values()].some(day => day.completed.includes(transactionId));
  }

  async activeReservation(userId: string, nowMillis: number): Promise<AdRewardReservation | null> {
    for (const day of this.days.values()) {
      const reservation = day.reservation;
      if (reservation?.userId === userId && reservation.expiresAtMillis > nowMillis) return { ...reservation };
    }
    return null;
  }

  async cancel(userId: string, dayKey: string, token: string): Promise<void> {
    const day = this.days.get(this.key(userId, dayKey));
    if (day?.reservation?.token === token) delete day.reservation;
  }

  async completeFromClient(userId: string, token: string, nowMillis: number): Promise<"awarded" | "duplicate" | "invalid"> {
    const day = [...this.days.values()].find(item =>
      item.reservation?.userId === userId && item.reservation.token === token,
    );
    if (!day) {
      const prefix = `${userId}|`;
      return [...this.days.entries()].some(([key, item]) => key.startsWith(prefix) && item.completedReservations.includes(token))
        ? "duplicate"
        : "invalid";
    }
    if (day.reservation!.expiresAtMillis <= nowMillis || day.completed.length >= 5) return "invalid";
    day.completedReservations.push(token);
    day.completed.push(`client:${token}`);
    delete day.reservation;
    return "awarded";
  }

  async hasCompletedReservation(token: string): Promise<boolean> {
    return [...this.days.values()].some(day => day.completedReservations.includes(token));
  }

  async complete(input: AdRewardReservation & { transactionId: string }, nowMillis: number): Promise<"awarded" | "duplicate" | "invalid"> {
    const day = this.days.get(this.key(input.userId, input.dayKey));
    if (day?.completed.includes(input.transactionId)) return "duplicate";
    if (day?.completedReservations.includes(input.token)) {
      day.completed.push(input.transactionId);
      return "duplicate";
    }
    if (!day || day.reservation?.token !== input.token || day.reservation.expiresAtMillis <= nowMillis || day.completed.length >= 5) return "invalid";
    day.completed.push(input.transactionId);
    day.completedReservations.push(input.token);
    delete day.reservation;
    return "awarded";
  }

  async daily(userId: string, dayKey: string, nowMillis: number): Promise<{ completed: number; reserved: boolean }> {
    const day = this.days.get(this.key(userId, dayKey));
    return { completed: day?.completed.length ?? 0, reserved: !!day?.reservation && day.reservation.expiresAtMillis > nowMillis };
  }

  async monthlyCredits(userId: string, monthKey: string): Promise<number> {
    let credits = 0;
    for (const [key, day] of this.days) {
      if (key.startsWith(`${userId}|`) && day.monthKey === monthKey) credits += day.completed.length * 5;
    }
    return credits;
  }

  async deleteForUser(userId: string): Promise<void> {
    for (const key of this.days.keys()) if (key.startsWith(`${userId}|`)) this.days.delete(key);
  }

  async hasActiveReservation(userId: string, nowMillis: number): Promise<boolean> {
    return [...this.days].some(([key, day]) =>
      key.startsWith(`${userId}|`) && day.reservation !== undefined && day.reservation.expiresAtMillis > nowMillis,
    );
  }

  async mergeUser(sourceUserId: string, targetUserId: string): Promise<void> {
    for (const [key, source] of [...this.days]) {
      if (!key.startsWith(`${sourceUserId}|`)) continue;
      const dayKey = key.slice(sourceUserId.length + 1);
      const targetKey = this.key(targetUserId, dayKey);
      const target = this.days.get(targetKey);
      this.days.set(targetKey, target ? {
        monthKey: target.monthKey,
        completed: [...new Set([...target.completed, ...source.completed])],
        completedReservations: [...new Set([...target.completedReservations, ...source.completedReservations])],
        ...(target.reservation ? { reservation: target.reservation } : {}),
      } : source);
      this.days.delete(key);
    }
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
  const users = new MemoryUsers();
  const households = new MemoryHouseholds();
  const refreshTokens = new MemoryRefreshTokens(now);
  const entitlements = new MemoryEntitlements();
  const usage = new MemoryUsage();
  const adRewards = new MemoryAdRewards();
  return {
    appleAccountLinks: {
      async linkAppleAccount(primaryUserId, profile, name, freeMonthlyLimit, nowMillis) {
        const primary = await users.findById(primaryUserId);
        if (!primary) throw new ApiError("unauthorized", "Sign in to link an account.");
        const secondary = await users.findByAppleSub(profile.appleSub);
        if (secondary?.id === primaryUserId) return null;
        if (secondary?.googleSub) throw new ApiError("conflict", "This Apple ID is linked to an account that also uses Google. Sign in to that account to manage it.");
        if (await households.forOwner(primaryUserId) || await households.forMember(primaryUserId) ||
            secondary && (await households.forOwner(secondary.id) || await households.forMember(secondary.id))) {
          throw new ApiError("conflict", "Leave shared households before linking these accounts.");
        }
        if (secondary && await adRewards.hasActiveReservation(secondary.id, nowMillis)) {
          throw new ApiError("conflict", "Finish or wait for the active rewarded ad before linking these accounts.");
        }
        if (secondary) {
          await entitlements.moveToUser(secondary.id, primaryUserId);
          await usage.mergeUser(secondary.id, primaryUserId, freeMonthlyLimit);
          await adRewards.mergeUser(secondary.id, primaryUserId);
        }
        const retiredUserId = await users.linkAppleIdentity(primaryUserId, profile.appleSub);
        const linked = await users.findById(primaryUserId);
        if (!linked) throw new ApiError("internal_error", "Linked account could not be loaded.");
        const mergedAccount = secondary?.id !== primaryUserId ? secondary : null;
        const previous = mergedAccount ?? linked;
        const appleEmail = profile.email ?? previous.appleEmail ?? mergedAccount?.email ?? null;
        const appleName = name ?? previous.appleName ?? mergedAccount?.name ?? null;
        await users.updateAppleProfile(primaryUserId, appleEmail, appleName);
        return retiredUserId;
      },
    },
    users,
    households,
    refreshTokens,
    entitlements,
    usage,
    adRewards,
    rtdn: new MemoryRtdn(),
  };
}
