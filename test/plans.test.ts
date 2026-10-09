import { describe, expect, it } from "vitest";
import {
  FEATURES,
  FEATURES_BY_PLAN,
  PRODUCT_IDS,
  UNITS_BY_FEATURE,
  higherPlan,
  lowestPlanFor,
  monthKey,
  monthlyUnits,
  planAllows,
  planOfProduct,
  startOfNextMonthMillis,
} from "../src/billing/plans.js";

describe("what each plan includes", () => {
  it("is exactly the table the product was designed with", () => {
    expect(FEATURES_BY_PLAN).toEqual({
      FREE: ["recipes", "suggest", "photo", "voice", "video", "assistant"],
      JUNIOR: ["recipes", "suggest", "photo", "voice", "sync"],
      MASTER: ["recipes", "suggest", "photo", "voice", "video", "household", "sync", "assistant"],
    });
  });

  it("gives Chef Junior photo and voice but not video or sharing", () => {
    expect(planAllows("JUNIOR", "photo")).toBe(true);
    expect(planAllows("JUNIOR", "voice")).toBe(true);
    expect(planAllows("JUNIOR", "video")).toBe(false);
    expect(planAllows("JUNIOR", "household")).toBe(false);
  });

  it("gives the mascot to Chef Master only, at one unit a sentence", () => {
    expect(planAllows("MASTER", "assistant")).toBe(true);
    expect(planAllows("JUNIOR", "assistant")).toBe(false);
    expect(planAllows("FREE", "assistant")).toBe(true);
    expect(lowestPlanFor("assistant")).toBe("MASTER");
    expect(UNITS_BY_FEATURE.assistant).toBe(1);
  });

  it("gives Chef Master everything", () => {
    for (const feature of FEATURES) expect(planAllows("MASTER", feature), feature).toBe(true);
  });

  it("gives no plan photo, voice, video or sharing", () => {
    for (const feature of ["household", "sync"] as const) expect(planAllows("FREE", feature), feature).toBe(false);
  });

  it("never takes anything away when going up a plan", () => {
    for (const feature of FEATURES_BY_PLAN.FREE.filter(f => f !== "video" && f !== "assistant")) expect(planAllows("JUNIOR", feature), feature).toBe(true);
    for (const feature of FEATURES_BY_PLAN.JUNIOR) expect(planAllows("MASTER", feature), feature).toBe(true);
  });

  it("says which plan to buy for what is locked", () => {
    expect(lowestPlanFor("recipes")).toBe("FREE");
    expect(lowestPlanFor("photo")).toBe("JUNIOR");
    expect(lowestPlanFor("voice")).toBe("JUNIOR");
    expect(lowestPlanFor("video")).toBe("MASTER");
    expect(lowestPlanFor("household")).toBe("MASTER");
  });
});

describe("the Google Play subscriptions", () => {
  it("are the two products created in Play Console", () => {
    expect(PRODUCT_IDS).toEqual({ JUNIOR: "chef_junior_monthly", MASTER: "chef_master_monthly" });
  });

  it("map to their plans, and nothing else maps", () => {
    expect(planOfProduct("chef_junior_monthly")).toBe("JUNIOR");
    expect(planOfProduct("chef_master_monthly")).toBe("MASTER");
    expect(planOfProduct("chef_gold_monthly")).toBeNull();
    expect(planOfProduct("")).toBeNull();
  });

  it("pick the higher of two plans", () => {
    expect(higherPlan("JUNIOR", "MASTER")).toBe("MASTER");
    expect(higherPlan("MASTER", "JUNIOR")).toBe("MASTER");
    expect(higherPlan("FREE", "JUNIOR")).toBe("JUNIOR");
  });
});

describe("the monthly allowance", () => {
  const config = { AI_FREE_MONTHLY_UNITS: 5, AI_JUNIOR_MONTHLY_UNITS: 150, AI_MASTER_MONTHLY_UNITS: 400 };

  it("is bigger the higher the plan", () => {
    expect(monthlyUnits("FREE", config)).toBe(5);
    expect(monthlyUnits("JUNIOR", config)).toBe(150);
    expect(monthlyUnits("MASTER", config)).toBe(400);
  });

  it("is spent by what each feature costs, and the name suggester costs nothing", () => {
    expect(UNITS_BY_FEATURE).toEqual({ recipes: 1, suggest: 0, photo: 2, voice: 1, video: 5, household: 0, sync: 0, assistant: 1 });
  });

  it("belongs to the calendar month in UTC and starts over on the first", () => {
    expect(monthKey(Date.UTC(2026, 9, 31, 23, 59, 59))).toBe("2026-10");
    expect(monthKey(Date.UTC(2026, 10, 1, 0, 0, 0))).toBe("2026-11");
    expect(startOfNextMonthMillis(Date.UTC(2026, 9, 15))).toBe(Date.UTC(2026, 10, 1));
    expect(startOfNextMonthMillis(Date.UTC(2026, 11, 20))).toBe(Date.UTC(2027, 0, 1));
  });
});
