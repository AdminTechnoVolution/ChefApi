import { afterEach, describe, expect, it } from "vitest";
import { billingAccountIdFor } from "../src/billing/entitlements.js";
import { type AccountsApp, PRODUCT_IDS, accountsApp, bearer } from "./accountsHelpers.js";
import { authHeaders } from "./helpers.js";

let t: AccountsApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

const json = { "content-type": "application/json" };

const post = (url: string, payload: unknown, headers: Record<string, string> = json) =>
  t!.app.inject({ method: "POST", url, headers, payload: JSON.stringify(payload) });

describe("signing in with Google", () => {
  it("creates the account the first time and returns a session", async () => {
    t = await accountsApp();
    t.google.profiles.set("good", { googleSub: "sub-1", email: "ana@example.com", name: "Ana" });

    const res = await post("/v1/auth/google", { idToken: "good-token-xxxxxxxx".replace("good-token-xxxxxxxx", "good") + "padding" });

    expect(res.statusCode).toBe(401);
  });

  it("returns the user, an access token and a refresh token", async () => {
    t = await accountsApp();

    const session = await t.signIn("ana@example.com");

    const me = await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: session.headers });
    expect(me.statusCode).toBe(200);
    expect(session.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.refreshToken.length).toBeGreaterThan(40);
  });

  it("describes the user in the response", async () => {
    t = await accountsApp();
    t.google.profiles.set("token-ana-1234", { googleSub: "sub-ana", email: "ana@example.com", name: "Ana" });

    const res = await post("/v1/auth/google", { idToken: "token-ana-1234", deviceId: "pixel" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ expiresInSeconds: 900, user: { email: "ana@example.com", name: "Ana" } });
    expect(Object.keys(res.json()).sort()).toEqual(["accessToken", "expiresInSeconds", "refreshToken", "user"]);
  });

  it("is the same account every time the same Google account signs in, on any device", async () => {
    t = await accountsApp();

    const phone = await t.signIn("ana@example.com", "phone");
    const tablet = await t.signIn("ana@example.com", "tablet");
    const other = await t.signIn("beto@example.com");

    expect(tablet.userId).toBe(phone.userId);
    expect(other.userId).not.toBe(phone.userId);
  });

  it("refuses a token Google does not vouch for, without saying why", async () => {
    t = await accountsApp();

    const res = await post("/v1/auth/google", { idToken: "something-forged" });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: "unauthorized", message: "Google sign-in could not be verified." } });
  });

  it("refuses a request that is not a sign-in", async () => {
    t = await accountsApp();

    expect((await post("/v1/auth/google", {})).statusCode).toBe(400);
    expect((await post("/v1/auth/google", { idToken: "short" })).statusCode).toBe(400);
    expect((await post("/v1/auth/google", { idToken: "x".repeat(5000) })).statusCode).toBe(400);
  });

  it("is limited much harder than the rest of the API", async () => {
    t = await accountsApp();

    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await post("/v1/auth/google", { idToken: "something-forged" })).statusCode);

    expect(codes.slice(0, 10).every((code) => code === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
});

describe("keeping the session going", () => {
  it("renews with the refresh token, and the old one stops working", async () => {
    t = await accountsApp();
    const session = await t.signIn();

    const renewed = await post("/v1/auth/refresh", { refreshToken: session.refreshToken });

    expect(renewed.statusCode).toBe(200);
    expect(renewed.json().refreshToken).not.toBe(session.refreshToken);
    const next = bearer(renewed.json().accessToken);
    expect((await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: next })).statusCode).toBe(200);
    expect((await post("/v1/auth/refresh", { refreshToken: session.refreshToken })).statusCode).toBe(401);
  });

  it("takes the whole session down when a refresh token that was already used comes back", async () => {
    t = await accountsApp();
    const phone = await t.signIn("ana@example.com", "phone");
    const tablet = await t.signIn("ana@example.com", "tablet");
    const renewed = await post("/v1/auth/refresh", { refreshToken: phone.refreshToken });
    const next = bearer(renewed.json().accessToken);

    // Someone who kept a copy of the old token tries it: the real owner and every other device are signed out.
    expect((await post("/v1/auth/refresh", { refreshToken: phone.refreshToken })).statusCode).toBe(401);

    expect((await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: next })).statusCode).toBe(401);
    expect((await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: tablet.plain })).statusCode).toBe(401);
    expect((await post("/v1/auth/refresh", { refreshToken: tablet.refreshToken })).statusCode).toBe(401);
    // Signing in again with Google starts a clean session.
    const again = await t.signIn("ana@example.com", "phone");
    expect((await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: again.plain })).statusCode).toBe(200);
  });

  it("refuses a refresh token that was never issued", async () => {
    t = await accountsApp();

    const res = await post("/v1/auth/refresh", { refreshToken: "x".repeat(60) });

    expect(res.statusCode).toBe(401);
  });

  it("refuses an expired session", async () => {
    t = await accountsApp();
    const session = await t.signIn();

    t.clock.advance(61 * 86_400_000);

    expect((await post("/v1/auth/refresh", { refreshToken: session.refreshToken })).statusCode).toBe(401);
  });

  it("lets the access token run out and the refresh token bring a new one", async () => {
    t = await accountsApp();
    const session = await t.signIn();

    t.clock.advance(16 * 60_000);
    const stale = await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: session.headers });
    const renewed = await post("/v1/auth/refresh", { refreshToken: session.refreshToken });
    const fresh = await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: bearer(renewed.json().accessToken) });

    expect(stale.statusCode).toBe(401);
    expect(fresh.statusCode).toBe(200);
  });

  it("ends only this device's session on logout", async () => {
    t = await accountsApp();
    const phone = await t.signIn("ana@example.com", "phone");
    const tablet = await t.signIn("ana@example.com", "tablet");

    const out = await post("/v1/auth/logout", { refreshToken: phone.refreshToken }, phone.headers);

    expect(out.statusCode).toBe(200);
    expect((await post("/v1/auth/refresh", { refreshToken: phone.refreshToken })).statusCode).toBe(401);
    expect((await post("/v1/auth/refresh", { refreshToken: tablet.refreshToken })).statusCode).toBe(200);
  });

  it("cuts this device's access token at once on logout, not when it would have expired", async () => {
    t = await accountsApp();
    const phone = await t.signIn("ana@example.com", "phone");
    const tablet = await t.signIn("ana@example.com", "tablet");
    expect((await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: phone.plain })).statusCode).toBe(200);

    await post("/v1/auth/logout", { refreshToken: phone.refreshToken }, phone.headers);

    expect((await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: phone.plain })).statusCode).toBe(401);
    expect((await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: tablet.plain })).statusCode).toBe(200);
  });
});

describe("what needs a signed-in user", () => {
  it("is refused without one, with the shared app key, or with a bad token", async () => {
    t = await accountsApp();

    for (const headers of [json, { ...authHeaders }, bearer("garbage")]) {
      const res = await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("unauthorized");
    }
  });

  it("is refused for the AI routes too, however the request is made", async () => {
    t = await accountsApp();

    const res = await post("/v1/recipes/generate", { systemPrompt: "x", ingredients: [] }, authHeaders);

    expect(res.statusCode).toBe(401);
    expect(t.generator.calls).toHaveLength(0);
  });
});

describe("deleting the account", () => {
  it("removes the user, their subscriptions and their usage, and signs every device out", async () => {
    t = await accountsApp();
    const phone = await t.signIn("ana@example.com", "phone");
    const tablet = await t.signIn("ana@example.com", "tablet");
    t.play.sell("purchase-token-1", PRODUCT_IDS.JUNIOR);
    await post("/v1/entitlements/verify-purchase", { productId: PRODUCT_IDS.JUNIOR, purchaseToken: "purchase-token-1" }, phone.headers);
    await t.stores.usage.add(phone.userId, "2026-10", 4);

    const res = await t.app.inject({ method: "DELETE", url: "/v1/account", headers: phone.plain });

    expect(res.statusCode).toBe(200);
    expect(await t.stores.users.findById(phone.userId)).toBeNull();
    expect(await t.stores.entitlements.listForUser(phone.userId)).toEqual([]);
    expect(await t.stores.usage.get(phone.userId, "2026-10")).toBe(0);
    // Both access tokens are still within their time, and neither works any more.
    expect((await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: phone.headers })).statusCode).toBe(401);
    expect((await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: tablet.headers })).statusCode).toBe(401);
    expect((await post("/v1/auth/refresh", { refreshToken: tablet.refreshToken })).statusCode).toBe(401);
  });

  it("leaves other people alone", async () => {
    t = await accountsApp();
    const ana = await t.signIn("ana@example.com");
    const beto = await t.signIn("beto@example.com");

    await t.app.inject({ method: "DELETE", url: "/v1/account", headers: ana.plain });

    expect((await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: beto.headers })).statusCode).toBe(200);
  });

  it("lets the same Google account start over as a new user", async () => {
    t = await accountsApp();
    const before = await t.signIn("ana@example.com");
    await t.app.inject({ method: "DELETE", url: "/v1/account", headers: before.plain });

    const after = await t.signIn("ana@example.com");

    expect(after.userId).not.toBe(before.userId);
  });

  it("needs a signed-in user", async () => {
    t = await accountsApp();

    expect((await t.app.inject({ method: "DELETE", url: "/v1/account", headers: {} })).statusCode).toBe(401);
  });
});

describe("the plan", () => {
  it("is free, with its allowance, for someone who has bought nothing", async () => {
    t = await accountsApp();
    const ana = await t.signIn();

    const res = await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: ana.headers });

    expect(res.json()).toEqual({
      plan: "FREE",
      active: false,
      source: "none",
      productId: null,
      expiresAtMillis: null,
      autoRenewing: false,
      features: ["recipes", "suggest", "photo", "voice", "video", "assistant"],
      usage: { unitsUsed: 0, unitsLimit: 5, resetsAtMillis: Date.UTC(2026, 10, 1) },
      billingAccountId: billingAccountIdFor(ana.userId),
    });
  });

  it("gives Google Play an account id that is neither the user id nor the email", async () => {
    t = await accountsApp();
    const ana = await t.signIn("ana@example.com");

    const { billingAccountId } = (await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: ana.headers })).json();

    expect(billingAccountId).toMatch(/^[0-9a-f]{32}$/);
    expect(billingAccountId).not.toBe(ana.userId);
    expect(billingAccountId).not.toContain("ana");
  });

  it("becomes Chef Junior once the purchase is verified", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.play.sell("purchase-token-1", PRODUCT_IDS.JUNIOR);

    const res = await post("/v1/entitlements/verify-purchase", { productId: PRODUCT_IDS.JUNIOR, purchaseToken: "purchase-token-1" }, ana.headers);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      plan: "JUNIOR",
      active: true,
      source: "play",
      productId: "chef_junior_monthly",
      autoRenewing: true,
      features: ["recipes", "suggest", "photo", "voice", "sync"],
      usage: { unitsLimit: 150 },
    });
    const later = await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: ana.headers });
    expect(later.json().plan).toBe("JUNIOR");
  });

  it("becomes Chef Master, with video and the household", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.play.sell("purchase-token-2", PRODUCT_IDS.MASTER);

    const res = await post("/v1/entitlements/verify-purchase", { productId: PRODUCT_IDS.MASTER, purchaseToken: "purchase-token-2" }, ana.headers);

    expect(res.json().plan).toBe("MASTER");
    expect(res.json().features).toEqual(["recipes", "suggest", "photo", "voice", "video", "household", "sync", "assistant"]);
    expect(res.json().usage.unitsLimit).toBe(400);
  });

  it("is the higher plan when someone holds both", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.play.sell("junior-token-1", PRODUCT_IDS.JUNIOR);
    t.play.sell("master-token-1", PRODUCT_IDS.MASTER);
    await post("/v1/entitlements/verify-purchase", { productId: PRODUCT_IDS.MASTER, purchaseToken: "master-token-1" }, ana.headers);

    const res = await post("/v1/entitlements/verify-purchase", { productId: PRODUCT_IDS.JUNIOR, purchaseToken: "junior-token-1" }, ana.headers);

    expect(res.json().plan).toBe("MASTER");
  });

  it("falls back to free when the subscription runs out", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.play.sell("purchase-token-1", PRODUCT_IDS.JUNIOR);
    await post("/v1/entitlements/verify-purchase", { productId: PRODUCT_IDS.JUNIOR, purchaseToken: "purchase-token-1" }, ana.headers);

    t.clock.advance(31 * 86_400_000);
    const renewed = await post("/v1/auth/refresh", { refreshToken: ana.refreshToken });
    const me = await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: bearer(renewed.json().accessToken) });

    expect(me.json().plan).toBe("FREE");
    expect(me.json().active).toBe(false);
  });
});

describe("settling a purchase", () => {
  const verify = (headers: Record<string, string>, productId: string, purchaseToken: string) =>
    post("/v1/entitlements/verify-purchase", { productId, purchaseToken }, headers);

  it("refuses a product that is not one of Chef's", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.play.sell("purchase-token-1", "chef_gold_monthly");

    const res = await verify(ana.headers, "chef_gold_monthly", "purchase-token-1");

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
    expect(t.play.asked).toEqual([]);
  });

  it("refuses a purchase Google Play does not know", async () => {
    t = await accountsApp();
    const ana = await t.signIn();

    const res = await verify(ana.headers, PRODUCT_IDS.JUNIOR, "never-bought-token");

    expect(res.statusCode).toBe(400);
    expect((await t.runtime.entitlements.describe(ana.userId)).plan).toBe("FREE");
  });

  it("refuses a purchase of another subscription than the one claimed", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.play.sell("purchase-token-1", PRODUCT_IDS.JUNIOR);

    const res = await verify(ana.headers, PRODUCT_IDS.MASTER, "purchase-token-1");

    expect(res.statusCode).toBe(400);
    expect((await t.runtime.entitlements.describe(ana.userId)).plan).toBe("FREE");
  });

  it("gives nothing for a subscription that is on hold or has expired", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.play.sell("on-hold-token", PRODUCT_IDS.MASTER, { state: "ON_HOLD" });
    t.play.sell("expired-token", PRODUCT_IDS.MASTER, { state: "EXPIRED", expiresAtMillis: 1 });

    expect((await verify(ana.headers, PRODUCT_IDS.MASTER, "on-hold-token")).json().plan).toBe("FREE");
    expect((await verify(ana.headers, PRODUCT_IDS.MASTER, "expired-token")).json().plan).toBe("FREE");
  });

  it("counts a grace period and a cancelled-but-paid subscription as active", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.play.sell("grace-token", PRODUCT_IDS.JUNIOR, { state: "IN_GRACE_PERIOD" });

    expect((await verify(ana.headers, PRODUCT_IDS.JUNIOR, "grace-token")).json().plan).toBe("JUNIOR");
    t.play.sell("canceled-token", PRODUCT_IDS.MASTER, { state: "CANCELED", autoRenewing: false });
    const res = await verify(ana.headers, PRODUCT_IDS.MASTER, "canceled-token");
    expect(res.json()).toMatchObject({ plan: "MASTER", autoRenewing: false });
  });

  it("refuses a purchase that belongs to another account, however it got here", async () => {
    t = await accountsApp();
    const ana = await t.signIn("ana@example.com");
    const beto = await t.signIn("beto@example.com");
    t.play.sell("anas-token", PRODUCT_IDS.JUNIOR, { obfuscatedAccountId: billingAccountIdFor(ana.userId) });

    const stolen = await verify(beto.headers, PRODUCT_IDS.JUNIOR, "anas-token");
    const own = await verify(ana.headers, PRODUCT_IDS.JUNIOR, "anas-token");

    expect(stolen.statusCode).toBe(409);
    expect(stolen.json().error.code).toBe("conflict");
    expect(own.json().plan).toBe("JUNIOR");
    expect((await t.runtime.entitlements.describe(beto.userId)).plan).toBe("FREE");
  });

  it("refuses a token already settled by someone else, even when Play did not tag it", async () => {
    t = await accountsApp();
    const ana = await t.signIn("ana@example.com");
    const beto = await t.signIn("beto@example.com");
    t.play.sell("shared-token", PRODUCT_IDS.JUNIOR);
    await verify(ana.headers, PRODUCT_IDS.JUNIOR, "shared-token");

    const res = await verify(beto.headers, PRODUCT_IDS.JUNIOR, "shared-token");

    expect(res.statusCode).toBe(409);
    expect((await t.runtime.entitlements.describe(beto.userId)).plan).toBe("FREE");
  });

  it("can be repeated: restoring a purchase just says the same thing", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.play.sell("purchase-token-1", PRODUCT_IDS.JUNIOR);

    await verify(ana.headers, PRODUCT_IDS.JUNIOR, "purchase-token-1");
    const again = await verify(ana.headers, PRODUCT_IDS.JUNIOR, "purchase-token-1");

    expect(again.json().plan).toBe("JUNIOR");
    expect(await t.stores.entitlements.listForUser(ana.userId)).toHaveLength(1);
  });

  it("says so, without leaking why, when Google Play cannot be reached", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    const { ApiError } = await import("../src/errors.js");
    t.play.failure = new ApiError("upstream_error", "Google Play could not be reached.");

    const res = await verify(ana.headers, PRODUCT_IDS.JUNIOR, "purchase-token-1");

    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("upstream_error");
  });

  it("does not trust the amount of time the app claims: expiry comes from Google Play", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.play.sell("purchase-token-1", PRODUCT_IDS.JUNIOR, { expiresAtMillis: t.clock.now() + 5 * 86_400_000 });

    const res = await verify(ana.headers, PRODUCT_IDS.JUNIOR, "purchase-token-1");

    expect(res.json().expiresAtMillis).toBe(t.clock.now() + 5 * 86_400_000);
  });
});
