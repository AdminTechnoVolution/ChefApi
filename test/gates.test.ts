import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { type AccountsApp, type SignedIn, PRODUCT_IDS, accountsApp, bearer } from "./accountsHelpers.js";
import {
  StubAssistant,
  StubGenerator,
  contractAssistantRequest,
  contractExtractRequest,
  contractRecipe,
  contractRequest,
  contractScanRequest,
  contractScanVideoRequest,
  contractSuggestRequest,
} from "./helpers.js";

let t: AccountsApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

const MONTH = "2026-10";

const call = (session: SignedIn, url: string, payload: unknown) =>
  t!.app.inject({ method: "POST", url, headers: session.headers, payload: JSON.stringify(payload) });

const recipe = (s: SignedIn) => call(s, "/v1/recipes/generate", contractRequest());
const photo = (s: SignedIn) => call(s, "/v1/ingredients/scan", contractScanRequest());
const voice = (s: SignedIn) => call(s, "/v1/ingredients/extract", contractExtractRequest());
const video = (s: SignedIn) => call(s, "/v1/ingredients/scan-video", contractScanVideoRequest());
const assistant = (s: SignedIn) => call(s, "/v1/assistant/understand", contractAssistantRequest());
const suggest = (s: SignedIn) => call(s, "/v1/ingredients/suggest", contractSuggestRequest());

/** Buys a subscription the way the app does: Google Play has it, the server verifies it. */
async function subscribe(session: SignedIn, product: keyof typeof PRODUCT_IDS) {
  const purchaseToken = `purchase-${product}-${session.userId}`;
  t!.play.sell(purchaseToken, PRODUCT_IDS[product], {}, t!.clock.now());
  const res = await call(session, "/v1/entitlements/verify-purchase", { productId: PRODUCT_IDS[product], purchaseToken });
  expect(res.statusCode).toBe(200);
}

const used = (s: SignedIn) => t!.stores.usage.get(s.userId, MONTH);

describe("without a plan", () => {
  it("can write a few recipes, then is told the month's allowance is used up", async () => {
    t = await accountsApp();
    const ana = await t.signIn();

    for (let i = 0; i < 5; i++) expect((await recipe(ana)).statusCode, `recipe ${i + 1}`).toBe(200);
    const sixth = await recipe(ana);

    expect(sixth.statusCode).toBe(403);
    expect(sixth.json()).toEqual({
      error: {
        code: "ai_quota_exceeded",
        message: "You have used this month's allowance.",
        details: { feature: "recipes", plan: "FREE", used: 5, limit: 5, resetsAtMillis: Date.UTC(2026, 10, 1) },
      },
    });
    expect(t.generator.calls).toHaveLength(5);
  });

  it("is not allowed photos, voice or video, and is told which plan has them", async () => {
    t = await accountsApp();
    const ana = await t.signIn();

    const refused = [
      [await photo(ana), "photo", "JUNIOR"],
      [await voice(ana), "voice", "JUNIOR"],
      [await video(ana), "video", "MASTER"],
    ] as const;

    for (const [res, feature, requiredPlan] of refused) {
      expect(res.statusCode, feature).toBe(403);
      expect(res.json().error).toEqual({
        code: "plan_required",
        message: "Your plan does not include this.",
        details: { feature, plan: "FREE", requiredPlan },
      });
    }
  });

  it("keeps the name suggester, which spends nothing", async () => {
    t = await accountsApp();
    const ana = await t.signIn();

    for (let i = 0; i < 8; i++) expect((await suggest(ana)).statusCode).toBe(200);

    expect(await used(ana)).toBe(0);
  });

  it("is sent no further than the gate: nothing is asked of the model", async () => {
    t = await accountsApp();
    const ana = await t.signIn();

    await photo(ana);
    await video(ana);
    await voice(ana);

    expect(await used(ana)).toBe(0);
  });
});

describe("Chef Junior", () => {
  it("has photos and voice, which cost 2 and 1 of the month", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    await subscribe(ana, "JUNIOR");

    expect((await photo(ana)).statusCode).toBe(200);
    expect(await used(ana)).toBe(2);
    expect((await voice(ana)).statusCode).toBe(200);
    expect(await used(ana)).toBe(3);
    expect((await recipe(ana)).statusCode).toBe(200);
    expect(await used(ana)).toBe(4);
  });

  it("does not have video, and is told that Master does", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    await subscribe(ana, "JUNIOR");

    const res = await video(ana);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.details).toEqual({ feature: "video", plan: "JUNIOR", requiredPlan: "MASTER" });
  });

  it("has a far bigger allowance than no plan", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    await subscribe(ana, "JUNIOR");

    for (let i = 0; i < 20; i++) expect((await recipe(ana)).statusCode).toBe(200);
    expect(await used(ana)).toBe(20);
  });

  it("is cut off at its own allowance, saying so", async () => {
    t = await accountsApp({ config: { AI_JUNIOR_MONTHLY_UNITS: "3" } });
    const ana = await t.signIn();
    await subscribe(ana, "JUNIOR");

    expect((await recipe(ana)).statusCode).toBe(200);
    expect((await photo(ana)).statusCode).toBe(200);
    const over = await recipe(ana);

    expect(over.statusCode).toBe(403);
    expect(over.json().error.details).toMatchObject({ plan: "JUNIOR", used: 3, limit: 3 });
  });

  it("will not start a use that would go over, even when some allowance is left", async () => {
    t = await accountsApp({ config: { AI_JUNIOR_MONTHLY_UNITS: "3" } });
    const ana = await t.signIn();
    await subscribe(ana, "JUNIOR");
    await recipe(ana);
    await recipe(ana);

    // 2 of 3 spent; a photo costs 2.
    const res = await photo(ana);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("ai_quota_exceeded");
    expect(await used(ana)).toBe(2);
    expect((await recipe(ana)).statusCode).toBe(200);
  });
});

describe("the mascot", () => {
  it("is for Chef Master only: no plan and Chef Junior are told to buy Master, and nothing is asked of the model", async () => {
    const stub = StubAssistant.returning();
    t = await accountsApp({ assistant: stub });
    const ana = await t.signIn();
    const ben = await t.signIn("ben@example.com", "phone-2");
    await subscribe(ben, "JUNIOR");

    for (const [who, plan] of [[ana, "FREE"], [ben, "JUNIOR"]] as const) {
      const res = await assistant(who);

      expect(res.statusCode, plan).toBe(403);
      expect(res.json().error).toEqual({
        code: "plan_required",
        message: "Your plan does not include this.",
        details: { feature: "assistant", plan, requiredPlan: "MASTER" },
      });
    }
    expect(stub.calls).toHaveLength(0);
    expect(await used(ana)).toBe(0);
  });

  it("costs Chef Master one unit a sentence", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    await subscribe(ana, "MASTER");

    expect((await assistant(ana)).statusCode).toBe(200);
    expect(await used(ana)).toBe(1);
    expect((await assistant(ana)).statusCode).toBe(200);
    expect(await used(ana)).toBe(2);
  });

  it("costs nothing when it could not understand", async () => {
    t = await accountsApp({ assistant: StubAssistant.failingWith(new ApiError("upstream_error", "Chef is temporarily unavailable.")) });
    const ana = await t.signIn();
    await subscribe(ana, "MASTER");

    expect((await assistant(ana)).statusCode).toBe(502);

    expect(await used(ana)).toBe(0);
  });

  it("stops at the month's allowance, like everything else", async () => {
    t = await accountsApp({ config: { AI_MASTER_MONTHLY_UNITS: "2" } });
    const ana = await t.signIn();
    await subscribe(ana, "MASTER");
    await assistant(ana);
    await assistant(ana);

    const over = await assistant(ana);

    expect(over.statusCode).toBe(403);
    expect(over.json().error.code).toBe("ai_quota_exceeded");
  });
});

describe("Chef Master", () => {
  it("has everything, video costing 5 of the month", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    await subscribe(ana, "MASTER");

    expect((await video(ana)).statusCode).toBe(200);
    expect(await used(ana)).toBe(5);
    expect((await photo(ana)).statusCode).toBe(200);
    expect((await voice(ana)).statusCode).toBe(200);
    expect((await recipe(ana)).statusCode).toBe(200);
    expect((await suggest(ana)).statusCode).toBe(200);
    expect((await assistant(ana)).statusCode).toBe(200);
    expect(await used(ana)).toBe(10);
  });
});

describe("what a use costs", () => {
  it("is charged only when the work succeeded", async () => {
    const failing = StubGenerator.failingWith(new ApiError("upstream_error", "Chef is temporarily unavailable."));
    t = await accountsApp({ generator: failing });
    const ana = await t.signIn();

    for (let i = 0; i < 8; i++) expect((await recipe(ana)).statusCode).toBe(502);

    expect(await used(ana)).toBe(0);
    // Eight failures later the user still has all five free recipes.
    expect((await t.runtime.entitlements.describe(ana.userId)).usage.unitsUsed).toBe(0);
  });

  it("is not charged for a request that was refused as invalid", async () => {
    t = await accountsApp();
    const ana = await t.signIn();

    const res = await call(ana, "/v1/recipes/generate", { systemPrompt: "x", ingredients: [{ name: "" }] });

    expect(res.statusCode).toBe(400);
    expect(await used(ana)).toBe(0);
  });

  it("is not charged when the gate said no", async () => {
    t = await accountsApp();
    const ana = await t.signIn();

    await video(ana);

    expect(await used(ana)).toBe(0);
  });

  it("shows up in the plan the app reads", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    await recipe(ana);
    await recipe(ana);

    const me = await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: ana.plain });

    expect(me.json().usage).toEqual({ unitsUsed: 2, unitsLimit: 5, resetsAtMillis: Date.UTC(2026, 10, 1) });
  });

  it("belongs to each person on their own", async () => {
    t = await accountsApp();
    const ana = await t.signIn("ana@example.com");
    const beto = await t.signIn("beto@example.com");
    for (let i = 0; i < 5; i++) await recipe(ana);

    expect((await recipe(ana)).statusCode).toBe(403);
    expect((await recipe(beto)).statusCode).toBe(200);
    expect(await used(beto)).toBe(1);
  });

  it("starts over on the first of the next month", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    for (let i = 0; i < 5; i++) await recipe(ana);
    expect((await recipe(ana)).statusCode).toBe(403);

    t.clock.advance(20 * 86_400_000);
    const renewed = await t.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ refreshToken: ana.refreshToken }),
    });
    const later = { ...ana, headers: bearer(renewed.json().accessToken), plain: { authorization: `Bearer ${renewed.json().accessToken}` } };

    expect((await recipe(later)).statusCode).toBe(200);
    expect(await t.stores.usage.get(ana.userId, "2026-11")).toBe(1);
  });
});

describe("a plan changing under the user", () => {
  it("opens the locked features as soon as the purchase is verified", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    expect((await photo(ana)).statusCode).toBe(403);

    await subscribe(ana, "JUNIOR");

    expect((await photo(ana)).statusCode).toBe(200);
  });

  it("closes them again when the subscription runs out", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    await subscribe(ana, "MASTER");
    expect((await video(ana)).statusCode).toBe(200);

    t.clock.advance(31 * 86_400_000);
    const renewed = await t.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ refreshToken: ana.refreshToken }),
    });
    const later = { ...ana, headers: bearer(renewed.json().accessToken) } as SignedIn;

    expect((await video(later)).statusCode).toBe(403);
    expect((await photo(later)).statusCode).toBe(403);
    expect((await recipe(later)).statusCode).toBe(200);
  });

  it("follows Google Play when it says the subscription is on hold", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    await subscribe(ana, "JUNIOR");
    expect((await photo(ana)).statusCode).toBe(200);
    const token = `purchase-JUNIOR-${ana.userId}`;

    t.play.subscriptions.set(token, { ...t.play.subscriptions.get(token)!, state: "ON_HOLD" });
    await t.runtime.entitlements.refreshFromPlay(token);

    expect((await photo(ana)).statusCode).toBe(403);
  });
});

describe("local development", () => {
  it("can unlock a plan for everybody, and says so", async () => {
    t = await accountsApp({ config: { DEV_UNLOCK_PLAN: "MASTER" } });
    const ana = await t.signIn();

    expect((await video(ana)).statusCode).toBe(200);
    const me = await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: ana.plain });
    expect(me.json()).toMatchObject({ plan: "MASTER", source: "dev", active: true });
  });
});

describe("the routes behind the gate", () => {
  it("still answer what they always did when allowed", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    await subscribe(ana, "MASTER");

    const res = await recipe(ana);

    expect(res.json()).toEqual(contractRecipe());
    expect(t.generator.calls[0]?.ingredients).toEqual(contractRequest().ingredients);
  });
});
