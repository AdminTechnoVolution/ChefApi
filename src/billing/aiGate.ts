import type { VerifiedClient } from "../auth/clientVerifier.js";
import type { AccountStores } from "../accounts/stores.js";
import type { Config } from "../config.js";
import { ApiError } from "../errors.js";
import type { EntitlementService } from "./entitlements.js";
import {
  type Feature,
  UNITS_BY_FEATURE,
  lowestPlanFor,
  monthKey,
  monthlyUnits,
  planAllows,
  startOfNextMonthMillis,
} from "./plans.js";

declare module "fastify" {
  interface FastifyRequest {
    /** What this call will cost the user's month, once it has worked. Set by the gate in front of an AI route. */
    charge?: Charge | null;
  }
}

/** What a successful call costs the user's month. Recorded only after the call has worked. */
export interface Charge {
  userId: string;
  monthKey: string;
  units: number;
}

/**
 * Decides whether a signed-in user may use a feature, and how much of their month it spends: the plan must include it, and the month's
 * allowance must have room. It only *checks*; the allowance is spent by [record], once the work has succeeded, so a failed call never
 * costs the user anything.
 */
export class AiGate {
  constructor(
    private readonly entitlements: EntitlementService,
    private readonly usage: AccountStores["usage"],
    private readonly config: Pick<Config, "AI_FREE_MONTHLY_UNITS" | "AI_JUNIOR_MONTHLY_UNITS" | "AI_MASTER_MONTHLY_UNITS">,
    private readonly now: () => number = Date.now,
  ) {}

  /** Throws `plan_required` or `ai_quota_exceeded`; otherwise the charge to [record] afterwards (null when the feature costs nothing). */
  async authorize(client: VerifiedClient | undefined, feature: Feature): Promise<Charge | null> {
    const userId = client?.userId;
    if (!userId) throw new ApiError("unauthorized", "Sign in to use this.");

    const { plan } = await this.entitlements.effectivePlan(userId);
    if (!planAllows(plan, feature)) {
      throw new ApiError("plan_required", "Your plan does not include this.", {
        details: { feature, plan, requiredPlan: lowestPlanFor(feature) },
      });
    }

    const units = UNITS_BY_FEATURE[feature];
    if (units === 0) return null;

    const month = monthKey(this.now());
    const used = await this.usage.get(userId, month);
    const limit = monthlyUnits(plan, this.config);
    if (used + units > limit) {
      throw new ApiError("ai_quota_exceeded", "You have used this month's allowance.", {
        details: { feature, plan, used, limit, resetsAtMillis: startOfNextMonthMillis(this.now()) },
      });
    }
    return { userId, monthKey: month, units };
  }

  async record(charge: Charge): Promise<void> {
    await this.usage.add(charge.userId, charge.monthKey, charge.units);
  }
}
