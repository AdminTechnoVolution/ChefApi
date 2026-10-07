import { createHash } from "node:crypto";
import type { AccountStores, Entitlement } from "../accounts/stores.js";
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
import type { PlayBillingVerifier } from "./playBilling.js";

export type EntitlementSource = "play" | "dev" | "none";

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
  /** The account id to give Google Play when buying, which ties the purchase to this account. */
  billingAccountId: string;
}

/** What Google Play is told the buyer is. A hash of the user id: random already, never an email. */
export const billingAccountIdFor = (userId: string): string => createHash("sha256").update(userId).digest("hex").slice(0, 32);

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
  ) {}

  /** The plan this user can use right now: the best of their active subscriptions, or free. */
  async effectivePlan(userId: string): Promise<EffectivePlan> {
    if (this.config.DEV_UNLOCK_PLAN) return { plan: this.config.DEV_UNLOCK_PLAN, source: "dev", entitlement: null };

    const now = this.now();
    let best: Entitlement | null = null;
    for (const entitlement of await this.stores.entitlements.listForUser(userId)) {
      if (!entitlementIsActive(entitlement, now)) continue;
      if (!best || higherPlan(entitlement.plan, best.plan) !== best.plan) best = entitlement;
    }
    return best ? { plan: best.plan, source: "play", entitlement: best } : { plan: "FREE", source: "none", entitlement: null };
  }

  async describe(userId: string): Promise<EntitlementView> {
    const { plan, source, entitlement } = await this.effectivePlan(userId);
    const now = this.now();
    return {
      plan,
      active: plan !== "FREE",
      source,
      productId: entitlement?.productId ?? null,
      expiresAtMillis: entitlement?.expiresAtMillis ?? null,
      autoRenewing: entitlement?.autoRenewing ?? false,
      features: [...FEATURES_BY_PLAN[plan]],
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
