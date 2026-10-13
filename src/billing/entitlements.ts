import { createHash } from "node:crypto";
import type { AccountStores, BillingStore, Entitlement } from "../accounts/stores.js";
import { entitlementIsActive } from "../accounts/stores.js";
import type { Config } from "../config.js";
import { ApiError } from "../errors.js";
import {
  FEATURES_BY_PLAN,
  type Feature,
  type Plan,
  higherPlan,
  monthKey,
  monthlyUnits,
  planOfProduct,
  startOfNextMonthMillis,
} from "./plans.js";
import type { AppStoreBillingVerifier, AppleNotification, AppleSubscription } from "./appStoreBilling.js";
import type { PlayBillingVerifier } from "./playBilling.js";

export type EntitlementSource = "play" | "apple" | "dev" | "none" | "household";

/** What the app is told about the signed-in user's plan. */
export interface EntitlementView {
  plan: Plan;
  /** A subscription gives access now. False for a person with no plan, whatever they used to have. */
  active: boolean;
  source: EntitlementSource;
  productId: string | null;
  expiresAtMillis: number | null;
  autoRenewing: boolean;
  /** What this plan includes, so the app shows padlocks from the same table the server enforces. */
  features: Feature[];
  usage: { unitsUsed: number; unitsLimit: number; resetsAtMillis: number };
  /** The account id to give the store when buying (Google Play's obfuscated account id; for the App Store, as a UUID, its account token), which ties the purchase to this account. */
  billingAccountId: string;
}

/** What Google Play is told the buyer is. A hash of the user id: random already, never an email. */
export const billingAccountIdFor = (userId: string): string => createHash("sha256").update(userId).digest("hex").slice(0, 32);

/** The same id as the UUID the App Store takes as `appAccountToken`: 32 hex digits are 128 bits. Lower case, as Apple signs it back. */
export const appAccountTokenFor = (userId: string): string => {
  const hex = billingAccountIdFor(userId);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Apple's subscriptions share the table of Play's purchase tokens, so their key says whose they are. */
const appleKey = (originalTransactionId: string): string => `apple:${originalTransactionId}`;

const storeOf = (entitlement: Entitlement): BillingStore => entitlement.store ?? "play";

export interface EffectivePlan {
  plan: Plan;
  source: EntitlementSource;
  entitlement: Entitlement | null;
}

/** Works out and records what each user has bought. */
export class EntitlementService {
  constructor(
    private readonly stores: AccountStores,
    private readonly playBilling: PlayBillingVerifier | null,
    private readonly config: Pick<
      Config,
      "DEV_UNLOCK_PLAN" | "AI_FREE_MONTHLY_UNITS" | "AI_JUNIOR_MONTHLY_UNITS" | "AI_MASTER_MONTHLY_UNITS"
    >,
    private readonly now: () => number = Date.now,
    private readonly appStore: AppStoreBillingVerifier | null = null,
    private readonly warn: (message: string) => void = () => {},
  ) {}

  /** The plan this user can use right now: the best of their active subscriptions, or free. */
  async effectivePlan(userId: string): Promise<EffectivePlan> {
    const own = await this.ownPlan(userId);
    if (own.plan === "MASTER") return own;
    const household = await this.stores.households.forMember(userId);
    if (household && await this.stores.users.findById(household.ownerId)) {
      const owner = await this.ownPlan(household.ownerId);
      if (owner.plan === "MASTER") return { ...owner, source: "household" };
    }
    return own;
  }

  /** Direct subscriptions only: a shared member can never sponsor another account. */
  async ownPlan(userId: string): Promise<EffectivePlan> {
    if (this.config.DEV_UNLOCK_PLAN) return { plan: this.config.DEV_UNLOCK_PLAN, source: "dev", entitlement: null };

    const now = this.now();
    let best: Entitlement | null = null;
    let refreshFailure: ApiError | null = null;
    for (let entitlement of await this.stores.entitlements.listForUser(userId)) {
      // A missed/delayed notification must not turn a renewed subscription into FREE.
      // Check the store before enforcing an old expiry, including on feature gates.
      if (this.canAskStore(entitlement) && !entitlementIsActive(entitlement, now) &&
          ((entitlement.expiresAtMillis <= now && entitlement.updatedAtMillis < entitlement.expiresAtMillis) ||
           now - entitlement.updatedAtMillis >= 60_000)) {
        try {
          await this.refreshFromStore(entitlement);
        } catch (error) {
          // Keep checking: another subscription may still give valid access. Never hide database failures.
          if (!(error instanceof ApiError) || error.code !== "upstream_error") throw error;
          refreshFailure ??= error;
        }
        entitlement = await this.stores.entitlements.findByPurchaseToken(entitlement.purchaseToken) ?? entitlement;
      }
      if (!entitlementIsActive(entitlement, now)) continue;
      if (!best || higherPlan(entitlement.plan, best.plan) !== best.plan) best = entitlement;
    }
    if (refreshFailure) {
      // Without a current entitlement we cannot confirm renewal; preserve the upstream error rather than grant expired access.
      if (!best) throw refreshFailure;
      this.warn("Store refresh failed for an inactive subscription; using another active subscription.");
    }
    return best ? { plan: best.plan, source: storeOf(best), entitlement: best } : { plan: "FREE", source: "none", entitlement: null };
  }

  async describe(userId: string): Promise<EntitlementView> {
    const { plan, source, entitlement } = await this.effectivePlan(userId);
    const now = this.now();
    return {
      plan,
      active: plan !== "FREE",
      source,
      productId: source === "household" ? null : entitlement?.productId ?? null,
      expiresAtMillis: entitlement?.expiresAtMillis ?? null,
      autoRenewing: source === "household" ? false : entitlement?.autoRenewing ?? false,
      features: FEATURES_BY_PLAN[plan].filter(feature => source !== "household" || feature !== "household"),
      usage: {
        unitsUsed: await this.stores.usage.get(userId, monthKey(now)),
        unitsLimit: monthlyUnits(plan, this.config),
        resetsAtMillis: startOfNextMonthMillis(now),
      },
      billingAccountId: billingAccountIdFor(userId),
    };
  }

  /** The app has just bought (or restored) a subscription: check it with Google Play and bind it to this account. */
  async verifyPurchase(userId: string, productId: string, purchaseToken: string): Promise<EntitlementView> {
    const plan = planOfProduct(productId);
    if (!plan || plan === "FREE") throw new ApiError("invalid_request", "That is not one of Chef's subscriptions.");
    if (!this.playBilling) throw new ApiError("upstream_error", "Purchases cannot be verified right now.");

    const known = await this.stores.entitlements.findByPurchaseToken(purchaseToken);
    if (known && known.userId !== userId) throw new ApiError("conflict", "This purchase belongs to another account.");

    const play = await this.playBilling.fetch(purchaseToken);
    if (!play) throw new ApiError("invalid_request", "Google Play does not know this purchase.");
    if (play.productId !== productId) throw new ApiError("invalid_request", "The purchase is for a different subscription.");
    // The app tells Play who is buying. A purchase made for another account cannot be claimed by this one.
    if (play.obfuscatedAccountId !== null && play.obfuscatedAccountId !== billingAccountIdFor(userId)) {
      throw new ApiError("conflict", "This purchase belongs to another account.");
    }

    await this.stores.entitlements.upsertByPurchaseToken({
      purchaseToken,
      userId,
      productId,
      plan,
      state: play.state,
      expiresAtMillis: play.expiresAtMillis,
      autoRenewing: play.autoRenewing,
      updatedAtMillis: this.now(),
    });
    return this.describe(userId);
  }

  private canAskStore(entitlement: Entitlement): boolean {
    return storeOf(entitlement) === "apple" ? this.appStore?.canRefresh === true : this.playBilling !== null;
  }

  private async refreshFromStore(entitlement: Entitlement): Promise<void> {
    if (storeOf(entitlement) === "play") await this.refreshFromPlay(entitlement.purchaseToken);
    else await this.refreshFromAppStore(entitlement.purchaseToken);
  }

  /** The app has just bought (or restored) a subscription from the App Store: check what Apple signed and bind it to this account. */
  async verifyAppleTransaction(userId: string, signedTransaction: string): Promise<EntitlementView> {
    if (!this.appStore) throw new ApiError("upstream_error", "Purchases cannot be verified right now.");
    const apple = await this.appStore.verify(signedTransaction);
    if (!apple) throw new ApiError("invalid_request", "The App Store does not know this purchase.");
    const plan = planOfProduct(apple.productId);
    if (!plan || plan === "FREE") throw new ApiError("invalid_request", "That is not one of Chef's subscriptions.");

    const purchaseToken = appleKey(apple.originalTransactionId);
    const known = await this.stores.entitlements.findByPurchaseToken(purchaseToken);
    if (known && known.userId !== userId) throw new ApiError("conflict", "This purchase belongs to another account.");
    // The app tells StoreKit who is buying. A purchase made for another account cannot be claimed by this one.
    if (apple.appAccountToken !== null && apple.appAccountToken !== appAccountTokenFor(userId)) {
      throw new ApiError("conflict", "This purchase belongs to another account.");
    }
    // Something Apple signed before what we already hold (an old copy, sent again) says nothing new.
    if (known?.signedAtMillis !== undefined && apple.signedAtMillis < known.signedAtMillis) return this.describe(userId);

    await this.stores.entitlements.upsertByPurchaseToken({
      purchaseToken,
      store: "apple",
      userId,
      productId: apple.productId,
      plan,
      state: apple.state,
      expiresAtMillis: apple.expiresAtMillis,
      autoRenewing: apple.autoRenewing,
      updatedAtMillis: this.now(),
      signedAtMillis: apple.signedAtMillis,
      ...(apple.environment ? { appleEnvironment: apple.environment } : {}),
    });
    return this.describe(userId);
  }

  /** The App Store says a subscription changed. Ours is brought in step; one we have never seen is ignored. Returns whether anything was updated. */
  async applyAppleNotification(notification: AppleNotification): Promise<boolean> {
    const apple = notification.subscription;
    if (!apple) return false;
    return this.applyApple(appleKey(apple.originalTransactionId), apple);
  }

  /** Asks Apple (when an App Store Server API key is set) for the truth about a subscription we hold. Returns whether anything was updated. */
  async refreshFromAppStore(purchaseToken: string): Promise<boolean> {
    const known = await this.stores.entitlements.findByPurchaseToken(purchaseToken);
    if (!known || !this.appStore?.canRefresh || !purchaseToken.startsWith("apple:")) return false;
    const apple = await this.appStore.refresh(purchaseToken.slice("apple:".length), known.appleEnvironment);
    return apple ? this.applyApple(purchaseToken, apple) : false;
  }

  private async applyApple(purchaseToken: string, apple: AppleSubscription): Promise<boolean> {
    const known = await this.stores.entitlements.findByPurchaseToken(purchaseToken);
    if (!known) return false;
    if (known.signedAtMillis !== undefined && apple.signedAtMillis < known.signedAtMillis) return false;
    const plan = planOfProduct(apple.productId) ?? known.plan;
    await this.stores.entitlements.upsertByPurchaseToken({
      ...known,
      store: "apple",
      productId: apple.productId,
      plan: plan === "FREE" ? known.plan : plan,
      state: apple.state,
      expiresAtMillis: apple.expiresAtMillis,
      autoRenewing: apple.autoRenewing,
      updatedAtMillis: this.now(),
      signedAtMillis: apple.signedAtMillis,
      ...(apple.environment ? { appleEnvironment: apple.environment } : {}),
    });
    return true;
  }

  /**
   * Google Play says a subscription changed (renewed, cancelled, ran out). Ask Play for the truth and keep ours in step. A token we have
   * never seen is ignored: the app's own verification will create it, and Play's note must not create entitlements for nobody.
   * Returns whether anything was updated.
   */
  async refreshFromPlay(purchaseToken: string): Promise<boolean> {
    const known = await this.stores.entitlements.findByPurchaseToken(purchaseToken);
    if (!known || !this.playBilling) return false;
    const play = await this.playBilling.fetch(purchaseToken);
    if (!play) return false;
    const plan = planOfProduct(play.productId) ?? known.plan;
    await this.stores.entitlements.upsertByPurchaseToken({
      ...known,
      productId: play.productId,
      plan: plan === "FREE" ? known.plan : plan,
      state: play.state,
      expiresAtMillis: play.expiresAtMillis,
      autoRenewing: play.autoRenewing,
      updatedAtMillis: this.now(),
    });
    return true;
  }
}
