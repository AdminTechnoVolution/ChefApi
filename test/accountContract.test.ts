import { afterEach, describe, expect, it } from "vitest";
import {
  EntitlementSchema,
  GoogleSignInRequestSchema,
  RefreshRequestSchema,
  SessionSchema,
  TokensSchema,
  VerifyPurchaseRequestSchema,
} from "../src/accountSchema.js";
import { FEATURES, FEATURES_BY_PLAN, PLANS, PRODUCT_IDS, UNITS_BY_FEATURE, lowestPlanFor } from "../src/billing/plans.js";
import { ErrorEnvelopeSchema } from "../src/schema.js";
import { type AccountsApp, PRODUCT_IDS as PRODUCTS, accountsApp } from "./accountsHelpers.js";
import { contractFixture, contractRequest, contractScanVideoRequest } from "./helpers.js";

/**
 * The account half of the contract the Android app is tested against. The same files live in `ChefAndroid/contract`; whichever side changes
 * a shape or a plan has to change them, and the other side's tests fail until it agrees.
 */

const json = (name: string) => JSON.parse(contractFixture(name)) as unknown;

/** The shape of a JSON value: its keys, and for every leaf the kind of value. Two responses with different tokens still have the same shape. */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])];
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, shapeOf(v)]),
    );
  }
  return value === null ? "null" : typeof value;
}

let t: AccountsApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

describe("the plan table the app is built against", () => {
  const table = json("plans.example.json") as {
    plans: string[];
    products: Record<string, string>;
    features: Record<string, { minimumPlan: string; units: number }>;
  };

  it("lists the plans in the order they go up", () => {
    expect(table.plans).toEqual([...PLANS]);
  });

  it("names the two subscriptions Google Play sells", () => {
    expect(table.products).toEqual({ ...PRODUCT_IDS });
  });

  it("has every feature, the cheapest plan that includes it, and what one use of it costs", () => {
    expect(Object.keys(table.features).sort()).toEqual([...FEATURES].sort());
    for (const feature of FEATURES) {
      expect(table.features[feature], feature).toEqual({ minimumPlan: lowestPlanFor(feature), units: UNITS_BY_FEATURE[feature] });
    }
  });

  it("is consistent with what each plan includes: a plan has a feature exactly when it is at least the feature's minimum", () => {
    for (const plan of PLANS) {
      const expected = FEATURES.filter((f) => (plan === "FREE" && table.features[f]!.units > 0) || PLANS.indexOf(plan) >= PLANS.indexOf(table.features[f]!.minimumPlan as (typeof PLANS)[number]));
      expect([...FEATURES_BY_PLAN[plan]].sort(), plan).toEqual([...expected].sort());
    }
  });
});

describe("account request examples", () => {
  it("are accepted by the API", () => {
    expect(GoogleSignInRequestSchema.strict().safeParse(json("auth-google-request.example.json")).success).toBe(true);
    expect(RefreshRequestSchema.strict().safeParse(json("refresh-request.example.json")).success).toBe(true);
    expect(VerifyPurchaseRequestSchema.strict().safeParse(json("verify-purchase-request.example.json")).success).toBe(true);
  });
});

describe("account response examples", () => {
  it("are exactly what the API's schemas describe, nothing more", () => {
    expect(SessionSchema.strict().safeParse(json("session-response.example.json")).success).toBe(true);
    expect(TokensSchema.strict().safeParse(json("refresh-response.example.json")).success).toBe(true);
    expect(EntitlementSchema.strict().safeParse(json("entitlement-response.example.json")).success).toBe(true);
    expect(ErrorEnvelopeSchema.safeParse(json("error-plan-required.example.json")).success).toBe(true);
    expect(ErrorEnvelopeSchema.safeParse(json("error-quota-exceeded.example.json")).success).toBe(true);
  });

  it("are stored minified, like every other response example", () => {
    for (const name of [
      "session-response.example.json",
      "refresh-response.example.json",
      "entitlement-response.example.json",
      "error-plan-required.example.json",
      "error-quota-exceeded.example.json",
    ]) {
      expect(contractFixture(name), name).toBe(JSON.stringify(JSON.parse(contractFixture(name))));
    }
  });

  it("have the shape of what the running API really answers", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.play.sell("purchase-token-1234567890", PRODUCTS.JUNIOR, {}, t.clock.now());

    const signedIn = await t.app.inject({
      method: "POST",
      url: "/v1/auth/google",
      headers: { "content-type": "application/json" },
      payload: contractFixture("auth-google-request.example.json").replace(/"idToken":"[^"]*"/, '"idToken":"token-ana@example.com"'),
    });
    const refreshed = await t.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ refreshToken: ana.refreshToken }),
    });
    const bought = await t.app.inject({
      method: "POST",
      url: "/v1/entitlements/verify-purchase",
      headers: ana.headers,
      payload: JSON.stringify({ productId: PRODUCTS.JUNIOR, purchaseToken: "purchase-token-1234567890" }),
    });

    expect(shapeOf(signedIn.json())).toEqual(shapeOf(json("session-response.example.json")));
    expect(shapeOf(refreshed.json())).toEqual(shapeOf(json("refresh-response.example.json")));
    expect(shapeOf(bought.json())).toEqual(shapeOf(json("entitlement-response.example.json")));
  });

  it("include the two refusals the app turns into the plans sheet, word for word", async () => {
    t = await accountsApp();
    const ana = await t.signIn();

    const junior = await t.signIn("junior@example.com", "junior-phone");
    t.play.sell("junior-trial-test", PRODUCTS.JUNIOR, {}, t.clock.now());
    await t.app.inject({ method: "POST", url: "/v1/entitlements/verify-purchase", headers: junior.headers,
      payload: JSON.stringify({ productId: PRODUCTS.JUNIOR, purchaseToken: "junior-trial-test" }) });

    const video = await t.app.inject({
      method: "POST",
      url: "/v1/ingredients/scan-video",
      headers: junior.headers,
      payload: JSON.stringify(contractScanVideoRequest()),
    });
    expect(video.statusCode).toBe(403);
    expect(video.body).toBe(contractFixture("error-plan-required.example.json"));

    for (let i = 0; i < 5; i++) {
      await t.app.inject({ method: "POST", url: "/v1/recipes/generate", headers: ana.headers, payload: JSON.stringify(contractRequest()) });
    }
    const sixth = await t.app.inject({
      method: "POST",
      url: "/v1/recipes/generate",
      headers: ana.headers,
      payload: JSON.stringify(contractRequest()),
    });
    expect(sixth.statusCode).toBe(403);
    expect(sixth.body).toBe(contractFixture("error-quota-exceeded.example.json"));
  });
});
