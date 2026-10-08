import type { Config } from "../config.js";

/** What a person pays for. `FREE` is no subscription at all. */
export const PLANS = ["FREE", "JUNIOR", "MASTER"] as const;
export type Plan = (typeof PLANS)[number];

/** Everything the plan decides. Each is one capability the app can offer or lock. */
export const FEATURES = ["recipes", "suggest", "photo", "voice", "video", "household", "sync", "assistant"] as const;
export type Feature = (typeof FEATURES)[number];

/** The Google Play subscriptions, as created in Play Console. */
export const PRODUCT_IDS = {
  JUNIOR: "chef_junior_monthly",
  MASTER: "chef_master_monthly",
} as const;

/**
 * THE one table of what each plan includes. Routes, the entitlement the app reads, and the tests all go through it, so the
 * app's padlocks and the server's refusals cannot disagree. Recipes are in FREE too, but only up to a small monthly quota.
 */
export const FEATURES_BY_PLAN: Record<Plan, readonly Feature[]> = {
  FREE: ["recipes", "suggest"],
  JUNIOR: ["recipes", "suggest", "photo", "voice", "sync"],
  MASTER: ["recipes", "suggest", "photo", "voice", "video", "household", "sync", "assistant"],
};

/** How much of the monthly allowance one use of each feature spends. The name suggester spends none: it fires as the user types. */
export const UNITS_BY_FEATURE: Record<Feature, number> = {
  recipes: 1,
  suggest: 0,
  photo: 2,
  voice: 1,
  video: 5,
  household: 0,
  sync: 0,
  // The mascot: one spoken sentence understood. The recipe it then asks for is a "recipes" use of its own.
  assistant: 1,
};

export function planAllows(plan: Plan, feature: Feature): boolean {
  return FEATURES_BY_PLAN[plan].includes(feature);
}

/** The cheapest plan that includes [feature], to tell the user what to buy. */
export function lowestPlanFor(feature: Feature): Plan {
  return PLANS.find((plan) => planAllows(plan, feature)) ?? "MASTER";
}

export function planOfProduct(productId: string): Plan | null {
  if (productId === PRODUCT_IDS.JUNIOR) return "JUNIOR";
  if (productId === PRODUCT_IDS.MASTER) return "MASTER";
  return null;
}

/** The higher of two plans. */
export function higherPlan(a: Plan, b: Plan): Plan {
  return PLANS.indexOf(a) >= PLANS.indexOf(b) ? a : b;
}

/** The monthly allowance of a plan, in AI units. */
export function monthlyUnits(plan: Plan, config: Pick<Config, "AI_FREE_MONTHLY_UNITS" | "AI_JUNIOR_MONTHLY_UNITS" | "AI_MASTER_MONTHLY_UNITS">): number {
  switch (plan) {
    case "FREE":
      return config.AI_FREE_MONTHLY_UNITS;
    case "JUNIOR":
      return config.AI_JUNIOR_MONTHLY_UNITS;
    case "MASTER":
      return config.AI_MASTER_MONTHLY_UNITS;
  }
}

/** "2026-10": the calendar month (UTC) an allowance belongs to. */
export function monthKey(nowMillis: number): string {
  return new Date(nowMillis).toISOString().slice(0, 7);
}

/** When the allowance starts over: midnight UTC on the first of next month. */
export function startOfNextMonthMillis(nowMillis: number): number {
  const now = new Date(nowMillis);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}
