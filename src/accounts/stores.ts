import type { AllergenId } from "../allergens/catalog.js";
import type { HouseholdStore } from "./householdStores.js";
import type { Plan } from "../billing/plans.js";

/** A person with a Chef account. Google or Apple proves their identity. */
export interface User {
  id: string;
  googleSub?: string;
  appleSub?: string;
  email: string;
  name: string | null;
  createdAtMillis: number;
  /** User choice, independent of subscription access. Missing on older accounts means off. */
  mascotEnabled?: boolean;
  /** Missing on older accounts means no selected allergens. */
  allergens?: AllergenId[];
  /** Previous Chef account ids whose signed App Store account tokens remain valid after an explicit account merge. */
  linkedAccountIds?: string[];
  appleEmail?: string | null;
  appleName?: string | null;
}

export interface GoogleProfile {
  googleSub: string;
  email: string;
  name: string | null;
}

export interface AppleProfile {
  appleSub: string;
  email: string | null;
}

export interface UserStore {
  upsertByApple(profile: AppleProfile, name: string | null, nowMillis: number): Promise<User>;
  /** The user for this Google account, created the first time they sign in; their email and name follow Google's. */
  upsertByGoogle(profile: GoogleProfile, nowMillis: number): Promise<User>;
  findById(id: string): Promise<User | null>;
  setMascotEnabled(id: string, enabled: boolean): Promise<boolean>;
  setAllergens(id: string, allergens: readonly AllergenId[]): Promise<boolean>;
  deleteById(id: string): Promise<void>;
}

export interface AppleAccountLinkStore {
  /**
   * Adds a verified Apple identity to the signed-in account. If it belongs to an Apple-only account, its server-side
   * billing and usage data are merged into the signed-in account. Returns the retired account id, if any.
   */
  linkAppleAccount(primaryUserId: string, profile: AppleProfile, name: string | null, freeMonthlyLimit: number, nowMillis: number): Promise<string | null>;
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

/** What the store (Google Play or the App Store) says about a subscription. */
export type SubscriptionState = "ACTIVE" | "IN_GRACE_PERIOD" | "CANCELED" | "ON_HOLD" | "PAUSED" | "EXPIRED" | "PENDING" | "UNKNOWN";

/** Where a subscription was bought. Records from before the App Store have no `store`: they are Play's. */
export type BillingStore = "play" | "apple";

export interface Entitlement {
  /** What identifies one subscription, whoever it is bound to: the Play purchase token, or `apple:` and the App Store's original transaction id. */
  purchaseToken: string;
  store?: BillingStore;
  userId: string;
  productId: string;
  plan: Exclude<Plan, "FREE">;
  state: SubscriptionState;
  expiresAtMillis: number;
  autoRenewing: boolean;
  updatedAtMillis: number;
  /** App Store only: when Apple signed what this was read from, so that an older note never overwrites a newer one. */
  signedAtMillis?: number;
  /** App Store environment from an Apple-signed transaction; absent on legacy records. */
  appleEnvironment?: "Production" | "Sandbox";
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
  /** Free-plan usage split between the base allowance and earned ad credits. Legacy usage is assigned to the base allowance up to its limit. */
  getFreeUsage(userId: string, monthKey: string, baseLimit: number): Promise<{ baseUnitsUsed: number; adUnitsUsed: number }>;
  /** Atomically records a Free-plan charge in the appropriate allowance buckets and preserves the aggregate usage total. */
  addFreeUsage(userId: string, monthKey: string, units: number, baseUnits: number, adUnits: number, baseLimit: number): Promise<void>;
  deleteForUser(userId: string): Promise<void>;
}

export interface AdRewardReservation {
  userId: string;
  dayKey: string;
  monthKey: string;
  token: string;
  expiresAtMillis: number;
}

/** Daily reservations and completions for AdMob rewarded ads. */
export interface AdRewardStore {
  reserve(reservation: AdRewardReservation, nowMillis: number): Promise<boolean>;
  findReservation(token: string): Promise<AdRewardReservation | null>;
  hasTransaction(transactionId: string): Promise<boolean>;
  activeReservation(userId: string, nowMillis: number): Promise<AdRewardReservation | null>;
  cancel(userId: string, dayKey: string, token: string): Promise<void>;
  /** Atomically consumes a reservation after the authenticated app receives the SDK reward callback. */
  completeFromClient(userId: string, token: string, nowMillis: number): Promise<"awarded" | "duplicate" | "invalid">;
  hasCompletedReservation(token: string): Promise<boolean>;
  /** Atomically consumes one reservation and records the AdMob transaction id. */
  complete(input: AdRewardReservation & { transactionId: string }, nowMillis: number): Promise<"awarded" | "duplicate" | "invalid">;
  daily(userId: string, dayKey: string, nowMillis: number): Promise<{ completed: number; reserved: boolean }>;
  monthlyCredits(userId: string, monthKey: string): Promise<number>;
  deleteForUser(userId: string): Promise<void>;
}

export interface RtdnStore {
  /** True the first time a Pub/Sub message id is seen, false for a redelivery. */
  firstSeen(messageId: string, nowMillis: number): Promise<boolean>;
  /** Takes the message back out, so that when handling it failed Pub/Sub's retry is handled instead of skipped as a duplicate. */
  forget(messageId: string): Promise<void>;
}

export interface AccountStores {
  appleAccountLinks: AppleAccountLinkStore;
  households: HouseholdStore;
  users: UserStore;
  refreshTokens: RefreshTokenStore;
  entitlements: EntitlementStore;
  usage: UsageStore;
  adRewards: AdRewardStore;
  rtdn: RtdnStore;
}
