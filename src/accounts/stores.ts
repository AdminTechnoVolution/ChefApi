import type { Plan } from "../billing/plans.js";

/** A person with a Chef account. Google proves who they are; nothing else about them is kept. */
export interface User {
  id: string;
  googleSub: string;
  email: string;
  name: string | null;
  createdAtMillis: number;
  /** User choice, independent of subscription access. Missing on older accounts means off. */
  mascotEnabled?: boolean;
}

export interface GoogleProfile {
  googleSub: string;
  email: string;
  name: string | null;
}

export interface UserStore {
  /** The user for this Google account, created the first time they sign in; their email and name follow Google's. */
  upsertByGoogle(profile: GoogleProfile, nowMillis: number): Promise<User>;
  findById(id: string): Promise<User | null>;
  setMascotEnabled(id: string, enabled: boolean): Promise<boolean>;
  deleteById(id: string): Promise<void>;
}

export interface RefreshTokenRecord {
  /** SHA-256 of the token: the token itself is never stored. */
  tokenHash: string;
  userId: string;
  expiresAtMillis: number;
  deviceId: string | null;
}

export interface RefreshTokenStore {
  save(record: RefreshTokenRecord): Promise<void>;
  /** Takes the token out and returns it, atomically: a refresh token works once, then it is gone (and remembered as used). */
  consume(tokenHash: string): Promise<RefreshTokenRecord | null>;
  /**
   * Whose token this was, when it has already been used (remembered until it would have expired). A used token showing up again
   * means someone kept a copy: the caller ends every session of that user.
   */
  usedBy(tokenHash: string): Promise<string | null>;
  /** Deletes one token without remembering it as used: what logging out does. A token gone this way coming back is just unknown. */
  revoke(tokenHash: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<void>;
}

/** What Google Play says about a subscription. */
export type SubscriptionState = "ACTIVE" | "IN_GRACE_PERIOD" | "CANCELED" | "ON_HOLD" | "PAUSED" | "EXPIRED" | "PENDING" | "UNKNOWN";

export interface Entitlement {
  /** The Play purchase token: what identifies one subscription, whoever it is bound to. */
  purchaseToken: string;
  userId: string;
  productId: string;
  plan: Exclude<Plan, "FREE">;
  state: SubscriptionState;
  expiresAtMillis: number;
  autoRenewing: boolean;
  updatedAtMillis: number;
}

/** Whether the subscription gives access now. A cancelled one still does until it runs out; one on hold or paused does not. */
export function entitlementIsActive(entitlement: Entitlement, nowMillis: number): boolean {
  const entitled = entitlement.state === "ACTIVE" || entitlement.state === "IN_GRACE_PERIOD" || entitlement.state === "CANCELED";
  return entitled && entitlement.expiresAtMillis > nowMillis;
}

export interface EntitlementStore {
  upsertByPurchaseToken(entitlement: Entitlement): Promise<void>;
  findByPurchaseToken(purchaseToken: string): Promise<Entitlement | null>;
  listForUser(userId: string): Promise<Entitlement[]>;
  deleteForUser(userId: string): Promise<void>;
}

export interface UsageStore {
  /** Units of the monthly allowance spent so far. */
  get(userId: string, monthKey: string): Promise<number>;
  /** Spends [units] and returns the total for the month. */
  add(userId: string, monthKey: string, units: number): Promise<number>;
  deleteForUser(userId: string): Promise<void>;
}

export interface RtdnStore {
  /** True the first time a Pub/Sub message id is seen, false for a redelivery. */
  firstSeen(messageId: string, nowMillis: number): Promise<boolean>;
  /** Takes the message back out, so that when handling it failed Pub/Sub's retry is handled instead of skipped as a duplicate. */
  forget(messageId: string): Promise<void>;
}

export interface AccountStores {
  users: UserStore;
  refreshTokens: RefreshTokenStore;
  entitlements: EntitlementStore;
  usage: UsageStore;
  rtdn: RtdnStore;
}
