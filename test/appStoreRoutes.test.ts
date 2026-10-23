import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/errors.js";
import { appAccountTokenFor } from "../src/billing/entitlements.js";
import { type AccountsApp, type SignedIn, PRODUCT_IDS, accountsApp } from "./accountsHelpers.js";

let t: AccountsApp | undefined;
afterEach(async () => {
  await t?.app.close();
  vi.restoreAllMocks();
  t = undefined;
});

const DAY = 86_400_000;
/** The app sends StoreKit's signed transaction; these tests only need it to be long enough and different each time. */
const signed = (name: string) => `signed-transaction-${name}`.padEnd(120, ".");
const ORIGINAL = "2000000001";
const KEY = `apple:${ORIGINAL}`;
/** What Apple posts to the webhook is long too. */
const note = (name: string) => name.padEnd(120, ".");
const announce = (name: string, type: string, subscription: Parameters<AccountsApp["appStore"]["announce"]>[2], uuid?: string) =>
  t!.appStore.announce(note(name), type, subscription, uuid);
const push = (name: string) =>
  t!.app.inject({ method: "POST", url: "/webhooks/apple/app-store", headers: { "content-type": "application/json" }, payload: JSON.stringify({ signedPayload: note(name) }) });

const verify = (who: SignedIn, signedTransaction: string) =>
  t!.app.inject({ method: "POST", url: "/v1/entitlements/verify-apple-purchase", headers: who.headers, payload: JSON.stringify({ signedTransaction }) });

const planOf = async (who: SignedIn) => (await t!.runtime.entitlements.describe(who.userId)).plan;

describe("the account token", () => {
  it("is the billing account id written as a UUID, so StoreKit can carry it", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    const me = await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: ana.plain });
    const id = me.json().billingAccountId as string;

    expect(appAccountTokenFor(ana.userId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(appAccountTokenFor(ana.userId).replaceAll("-", "")).toBe(id);
  });
});

describe("settling an App Store purchase", () => {
  it("becomes Chef Junior once Apple's transaction is verified", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.appStore.sell(signed("junior"), ORIGINAL, PRODUCT_IDS.JUNIOR, { appAccountToken: appAccountTokenFor(ana.userId) });

    const res = await verify(ana, signed("junior"));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      plan: "JUNIOR",
      active: true,
      source: "apple",
      productId: "chef_junior_monthly",
      autoRenewing: true,
      features: ["recipes", "suggest", "photo", "voice", "sync"],
      usage: { unitsLimit: 150 },
    });
    const later = await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: ana.plain });
    expect(later.json()).toMatchObject({ plan: "JUNIOR", source: "apple" });
  });

  it("keeps Apple's subscription apart from a Play purchase token that looks the same", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.appStore.sell(signed("junior"), ORIGINAL, PRODUCT_IDS.JUNIOR);
    await verify(ana, signed("junior"));

    const [entitlement] = await t.stores.entitlements.listForUser(ana.userId);

    expect(entitlement).toMatchObject({ purchaseToken: KEY, store: "apple", productId: PRODUCT_IDS.JUNIOR });
  });

  it("becomes Chef Master, with video and the household", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.appStore.sell(signed("master"), ORIGINAL, PRODUCT_IDS.MASTER);

    const res = await verify(ana, signed("master"));

    expect(res.json().plan).toBe("MASTER");
    expect(res.json().features).toEqual(["recipes", "suggest", "photo", "voice", "video", "household", "sync", "assistant"]);
  });

  it("follows an upgrade, which is the same subscription in a new product", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.appStore.sell(signed("junior"), ORIGINAL, PRODUCT_IDS.JUNIOR, {}, t.clock.now());
    await verify(ana, signed("junior"));
    // Within the life of the access token.
    t.clock.advance(5 * 60_000);
    t.appStore.sell(signed("master"), ORIGINAL, PRODUCT_IDS.MASTER, {}, t.clock.now());

    const res = await verify(ana, signed("master"));

    expect(res.json().plan).toBe("MASTER");
    expect(await t.stores.entitlements.listForUser(ana.userId)).toHaveLength(1);
  });

  it("is the higher plan when someone holds a Play subscription and an App Store one", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.play.sell("play-junior", PRODUCT_IDS.JUNIOR);
    await t.app.inject({
      method: "POST",
      url: "/v1/entitlements/verify-purchase",
      headers: ana.headers,
      payload: JSON.stringify({ productId: PRODUCT_IDS.JUNIOR, purchaseToken: "play-junior" }),
    });
    t.appStore.sell(signed("master"), ORIGINAL, PRODUCT_IDS.MASTER);

    const res = await verify(ana, signed("master"));

    expect(res.json()).toMatchObject({ plan: "MASTER", source: "apple" });
  });

  it("refuses what Apple does not know", async () => {
    t = await accountsApp();
    const ana = await t.signIn();

    const res = await verify(ana, signed("never-sold"));

    expect(res.statusCode).toBe(400);
    expect(await planOf(ana)).toBe("FREE");
  });

  it("refuses a product that is not one of Chef's", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.appStore.sell(signed("gold"), ORIGINAL, "chef_gold_monthly");

    const res = await verify(ana, signed("gold"));

    expect(res.statusCode).toBe(400);
    expect(await t.stores.entitlements.listForUser(ana.userId)).toEqual([]);
  });

  it("refuses a purchase made for another account", async () => {
    t = await accountsApp();
    const ana = await t.signIn("ana@example.com");
    const ben = await t.signIn("ben@example.com");
    t.appStore.sell(signed("junior"), ORIGINAL, PRODUCT_IDS.JUNIOR, { appAccountToken: appAccountTokenFor(ana.userId) });

    const res = await verify(ben, signed("junior"));

    expect(res.statusCode).toBe(409);
    expect(await planOf(ben)).toBe("FREE");
    expect((await verify(ana, signed("junior"))).statusCode).toBe(200);
  });

  it("refuses a subscription that already belongs to another account, even when it was not tagged", async () => {
    t = await accountsApp();
    const ana = await t.signIn("ana@example.com");
    const ben = await t.signIn("ben@example.com");
    t.appStore.sell(signed("junior"), ORIGINAL, PRODUCT_IDS.JUNIOR);
    await verify(ana, signed("junior"));

    const res = await verify(ben, signed("junior"));

    expect(res.statusCode).toBe(409);
    expect(await planOf(ana)).toBe("JUNIOR");
    expect(await planOf(ben)).toBe("FREE");
  });

  it("links an Apple-only account into the signed-in Google account and carries over its data", async () => {
    t = await accountsApp();
    const google = await t.signIn("google@example.com");
    const apple = await t.stores.users.upsertByApple(
      { appleSub: "apple-sub-1", email: "relay@privaterelay.appleid.com" },
      "Apple Person",
      t.clock.now(),
    );
    const oldSession = await t.runtime.tokens.issue(apple.id);
    await t.stores.users.setAllergens(google.userId, ["peanuts"]);
    await t.stores.users.setAllergens(apple.id, ["milk"]);
    await t.stores.usage.add(google.userId, "2026-10", 2);
    await t.stores.usage.add(apple.id, "2026-10", 3);
    const reward = {
      userId: apple.id,
      dayKey: "2026-10-23",
      monthKey: "2026-10",
      token: "apple-account-reward",
      expiresAtMillis: t.clock.now() + 60_000,
    };
    expect(await t.stores.adRewards.reserve(reward, t.clock.now())).toBe(true);
    expect(await t.stores.adRewards.completeFromClient(apple.id, reward.token, t.clock.now())).toBe("awarded");
    await t.stores.entitlements.upsertByPurchaseToken({
      purchaseToken: KEY,
      store: "apple",
      userId: apple.id,
      productId: PRODUCT_IDS.JUNIOR,
      plan: "JUNIOR",
      state: "ACTIVE",
      expiresAtMillis: t.clock.now() + DAY,
      autoRenewing: true,
      updatedAtMillis: t.clock.now(),
      signedAtMillis: t.clock.now(),
    });
    t.appStore.sell(signed("linked-apple-purchase"), ORIGINAL, PRODUCT_IDS.JUNIOR, {
      appAccountToken: appAccountTokenFor(apple.id),
    });
    t.apple.profiles.set("apple-identity-token", { appleSub: "apple-sub-1", email: "relay@privaterelay.appleid.com" });

    const linked = await t.app.inject({
      method: "POST",
      url: "/v1/auth/link/apple",
      headers: google.headers,
      payload: JSON.stringify({ identityToken: "apple-identity-token", nonce: "a".repeat(64), name: "Apple Name" }),
    });

    expect(linked.statusCode).toBe(200);
    const identities = await t.app.inject({ method: "GET", url: "/v1/account/identities", headers: google.plain });
    expect(identities.statusCode).toBe(200);
    expect(identities.json()).toEqual({ apple: { email: "relay@privaterelay.appleid.com", name: "Apple Name" } });
    expect(await t.stores.users.findById(apple.id)).toBeNull();
    expect(await t.runtime.tokens.verifyAccess(oldSession.accessToken)).toBeNull();
    expect(await t.stores.users.findById(google.userId)).toMatchObject({
      appleSub: "apple-sub-1",
      appleEmail: "relay@privaterelay.appleid.com",
      appleName: "Apple Name",
      allergens: ["peanuts", "milk"],
    });
    expect(await t.stores.entitlements.findByPurchaseToken(KEY)).toMatchObject({ userId: google.userId, store: "apple" });
    expect(await t.stores.usage.get(google.userId, "2026-10")).toBe(5);
    expect(await t.stores.adRewards.monthlyCredits(google.userId, "2026-10")).toBe(5);
    expect((await verify(google, signed("linked-apple-purchase"))).statusCode).toBe(200);
  });

  it("reports an unlinked Apple identity explicitly", async () => {
    t = await accountsApp();
    const google = await t.signIn();

    const identities = await t.app.inject({ method: "GET", url: "/v1/account/identities", headers: google.plain });

    expect(identities.statusCode).toBe(200);
    expect(identities.json()).toEqual({ apple: null });
  });

  it("does not merge an Apple account that also has a Google identity", async () => {
    t = await accountsApp();
    const google = await t.signIn("google@example.com");
    const other = await t.signIn("other@example.com");
    const apple = await t.stores.users.upsertByApple(
      { appleSub: "apple-sub-2", email: "relay@privaterelay.appleid.com" },
      null,
      t.clock.now(),
    );
    await t.stores.appleAccountLinks.linkAppleAccount(
      other.userId,
      { appleSub: "apple-sub-2", email: "relay@privaterelay.appleid.com" },
      null,
      10,
      t.clock.now(),
    );
    t.apple.profiles.set("apple-identity-token-2", { appleSub: "apple-sub-2", email: "relay@privaterelay.appleid.com" });
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/auth/link/apple",
      headers: google.headers,
      payload: JSON.stringify({ identityToken: "apple-identity-token-2", nonce: "b".repeat(64) }),
    });

    expect(res.statusCode).toBe(409);
    expect(await t.stores.users.findById(apple.id)).toBeNull();
    expect(await t.stores.users.findById(other.userId)).not.toBeNull();
  });

  it("ignores a copy that Apple signed before what is already held", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    const now = t.clock.now();
    t.appStore.sell(signed("old"), ORIGINAL, PRODUCT_IDS.JUNIOR, { expiresAtMillis: now + 5 * DAY, signedAtMillis: now - 25 * DAY });
    t.appStore.sell(signed("new"), ORIGINAL, PRODUCT_IDS.JUNIOR, { expiresAtMillis: now + 35 * DAY, signedAtMillis: now });
    await verify(ana, signed("new"));

    const res = await verify(ana, signed("old"));

    expect(res.statusCode).toBe(200);
    expect(res.json().expiresAtMillis).toBe(now + 35 * DAY);
  });

  it("does not bring back a refunded subscription from an old copy", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    const now = t.clock.now();
    t.appStore.sell(signed("old"), ORIGINAL, PRODUCT_IDS.JUNIOR, { signedAtMillis: now - DAY });
    await verify(ana, signed("old"));
    const refunded = t.appStore.sell(signed("refund"), ORIGINAL, PRODUCT_IDS.JUNIOR, { state: "EXPIRED", signedAtMillis: now });
    announce("note-refund", "REFUND", refunded);
    await push("note-refund");
    expect(await planOf(ana)).toBe("FREE");

    await verify(ana, signed("old"));

    expect(await planOf(ana)).toBe("FREE");
  });

  it("is a gateway error, not a refusal, when Apple cannot be reached", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.appStore.sell(signed("junior"), ORIGINAL, PRODUCT_IDS.JUNIOR);
    t.appStore.failure = new ApiError("upstream_error", "The App Store could not be reached.");

    const res = await verify(ana, signed("junior"));

    expect(res.statusCode).toBe(502);
    expect(await planOf(ana)).toBe("FREE");
  });

  it("cannot be settled where purchases cannot be checked", async () => {
    t = await accountsApp({ appStore: false });
    const ana = await t.signIn();

    expect((await verify(ana, signed("junior"))).statusCode).toBe(502);
  });

  it("needs a signed-in user and a transaction", async () => {
    t = await accountsApp();
    const ana = await t.signIn();

    const anonymous = await t.app.inject({ method: "POST", url: "/v1/entitlements/verify-apple-purchase", headers: { "content-type": "application/json" }, payload: JSON.stringify({ signedTransaction: signed("x") }) });
    const empty = await t.app.inject({ method: "POST", url: "/v1/entitlements/verify-apple-purchase", headers: ana.headers, payload: JSON.stringify({}) });

    expect(anonymous.statusCode).toBe(401);
    expect(empty.statusCode).toBe(400);
  });

  it("is lost with the account", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.appStore.sell(signed("junior"), ORIGINAL, PRODUCT_IDS.JUNIOR);
    await verify(ana, signed("junior"));

    await t.app.inject({ method: "DELETE", url: "/v1/account", headers: ana.plain });

    expect(await t.stores.entitlements.findByPurchaseToken(KEY)).toBeNull();
  });
});

describe("an old subscription alongside a restored purchase", () => {
  it.each([false, true])("does not let a legacy refresh failure hide a current sandbox purchase (reverse order: %s)", async (reverse) => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.appStore.canRefresh = true;
    await t.stores.entitlements.upsertByPurchaseToken({
      purchaseToken: "apple:legacy-original", store: "apple", userId: ana.userId,
      productId: PRODUCT_IDS.MASTER, plan: "MASTER", state: "EXPIRED",
      expiresAtMillis: t.clock.now() - DAY, updatedAtMillis: t.clock.now() - 2 * DAY,
      autoRenewing: false,
    });
    if (reverse) {
      const list = t.stores.entitlements.listForUser.bind(t.stores.entitlements);
      vi.spyOn(t.stores.entitlements, "listForUser").mockImplementation(async userId => (await list(userId)).reverse());
    }
    vi.spyOn(t.appStore, "refresh").mockRejectedValue(new ApiError("upstream_error", "Apple rejected the legacy refresh."));
    t.appStore.sell(signed("restored-sandbox"), ORIGINAL, PRODUCT_IDS.JUNIOR, { environment: "Sandbox" }, t.clock.now());
    const restored = await verify(ana, signed("restored-sandbox"));
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ plan: "JUNIOR", active: true });
    const me = await t.app.inject({ method: "GET", url: "/v1/entitlements/me", headers: ana.plain });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ plan: "JUNIOR", active: true });
    t.clock.advance(31 * DAY);
    await expect(t.runtime.entitlements.describe(ana.userId)).rejects.toMatchObject({ code: "upstream_error" });
  });
});

describe("a subscription that runs out", () => {
  it("falls back to free", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.appStore.sell(signed("junior"), ORIGINAL, PRODUCT_IDS.JUNIOR, {}, t.clock.now());
    await verify(ana, signed("junior"));

    t.clock.advance(31 * DAY);

    expect(await planOf(ana)).toBe("FREE");
  });

  it("is checked with Apple first when Apple can be asked, so a missed notification does not cost the plan", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.appStore.canRefresh = true;
    t.appStore.sell(signed("junior"), ORIGINAL, PRODUCT_IDS.JUNIOR, {}, t.clock.now());
    await verify(ana, signed("junior"));
    t.clock.advance(31 * DAY);
    // It renewed, and we were never told.
    t.appStore.current.set(ORIGINAL, {
      ...t.appStore.current.get(ORIGINAL)!,
      expiresAtMillis: t.clock.now() + 29 * DAY,
      signedAtMillis: t.clock.now(),
    });

    expect(await planOf(ana)).toBe("JUNIOR");
  });

  it("keeps the signed sandbox environment for refreshes after expiry", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.appStore.canRefresh = true;
    t.appStore.sell(signed("sandbox"), ORIGINAL, PRODUCT_IDS.JUNIOR, { environment: "Sandbox" }, t.clock.now());
    await verify(ana, signed("sandbox"));
    expect(await t.stores.entitlements.findByPurchaseToken(KEY)).toMatchObject({ appleEnvironment: "Sandbox" });
    t.clock.advance(31 * DAY);
    const refresh = vi.spyOn(t.appStore, "refresh");
    await planOf(ana);
    expect(refresh).toHaveBeenCalledWith(ORIGINAL, "Sandbox");
  });

  it("is not asked about when Apple cannot be asked", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    t.appStore.sell(signed("junior"), ORIGINAL, PRODUCT_IDS.JUNIOR, {}, t.clock.now());
    await verify(ana, signed("junior"));
    t.clock.advance(31 * DAY);
    t.appStore.asked.length = 0;

    expect(await planOf(ana)).toBe("FREE");
    expect(t.appStore.asked).toEqual([]);
  });
});

describe("the App Store's notifications", () => {
  async function junior(): Promise<SignedIn> {
    const ana = await t!.signIn();
    t!.appStore.sell(signed("junior"), ORIGINAL, PRODUCT_IDS.JUNIOR, {}, t!.clock.now());
    await verify(ana, signed("junior"));
    return ana;
  }

  it("bring a renewal in", async () => {
    t = await accountsApp();
    const ana = await junior();
    t.clock.advance(29 * DAY);
    const renewed = { ...t.appStore.current.get(ORIGINAL)!, expiresAtMillis: t.clock.now() + 30 * DAY, signedAtMillis: t.clock.now() };
    announce("note-renew", "DID_RENEW", renewed);

    const res = await push("note-renew");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect((await t.runtime.entitlements.describe(ana.userId)).expiresAtMillis).toBe(renewed.expiresAtMillis);
  });

  it("take the plan away on a refund", async () => {
    t = await accountsApp();
    const ana = await junior();
    t.clock.advance(DAY);
    announce("note-refund", "REFUND", { ...t.appStore.current.get(ORIGINAL)!, state: "EXPIRED", signedAtMillis: t.clock.now() });

    await push("note-refund");

    expect(await planOf(ana)).toBe("FREE");
  });

  it("follow an upgrade to the plan it names", async () => {
    t = await accountsApp();
    const ana = await junior();
    t.clock.advance(DAY);
    announce("note-upgrade", "DID_CHANGE_RENEWAL_PREF", { ...t.appStore.current.get(ORIGINAL)!, productId: PRODUCT_IDS.MASTER, signedAtMillis: t.clock.now() });

    await push("note-upgrade");

    expect(await planOf(ana)).toBe("MASTER");
  });

  it("do not let an older note undo a newer one", async () => {
    t = await accountsApp();
    const ana = await junior();
    t.clock.advance(DAY);
    const later = t.clock.now();
    announce("note-new", "EXPIRED", { ...t.appStore.current.get(ORIGINAL)!, state: "EXPIRED", signedAtMillis: later });
    announce("note-old", "DID_RENEW", { ...t.appStore.current.get(ORIGINAL)!, expiresAtMillis: later + 30 * DAY, signedAtMillis: later - DAY });
    await push("note-new");

    await push("note-old");

    expect(await planOf(ana)).toBe("FREE");
  });

  it("are handled once, however often Apple redelivers them", async () => {
    t = await accountsApp();
    await junior();
    announce("note-renew", "DID_RENEW", { ...t.appStore.current.get(ORIGINAL)!, signedAtMillis: t.clock.now() + 1 }, "same-uuid");

    expect((await push("note-renew")).json()).toEqual({ ok: true });
    expect((await push("note-renew")).json()).toEqual({ ok: true, duplicate: true });
  });

  it("ignore a subscription nobody has bought through the app", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    announce("note-stranger", "SUBSCRIBED", {
      originalTransactionId: "2999999999",
      productId: PRODUCT_IDS.MASTER,
      state: "ACTIVE",
      expiresAtMillis: t.clock.now() + 30 * DAY,
      autoRenewing: true,
      appAccountToken: appAccountTokenFor(ana.userId),
      signedAtMillis: t.clock.now(),
    });

    expect((await push("note-stranger")).statusCode).toBe(200);
    expect(await planOf(ana)).toBe("FREE");
    expect(await t.stores.entitlements.listForUser(ana.userId)).toEqual([]);
  });

  it("answer Apple's test and ignore notes with no subscription", async () => {
    t = await accountsApp();
    announce("note-test", "TEST", null);
    announce("note-empty", "PRICE_INCREASE", null);

    expect((await push("note-test")).json()).toEqual({ ok: true, test: true });
    expect((await push("note-empty")).json()).toEqual({ ok: true, ignored: true });
  });

  it("are refused when Apple did not sign them", async () => {
    t = await accountsApp();
    await junior();

    const res = await push("forged-note");

    expect(res.statusCode).toBe(401);
  });

  it("are tried again when handling failed, not skipped as a duplicate", async () => {
    t = await accountsApp();
    const ana = await junior();
    t.clock.advance(29 * DAY);
    const renewed = { ...t.appStore.current.get(ORIGINAL)!, expiresAtMillis: t.clock.now() + 30 * DAY, signedAtMillis: t.clock.now() };
    announce("note-renew", "DID_RENEW", renewed, "retry-uuid");
    const upsert = vi.spyOn(t.stores.entitlements, "upsertByPurchaseToken").mockRejectedValueOnce(new Error("database down"));

    const failed = await push("note-renew");
    expect(failed.statusCode).toBeGreaterThanOrEqual(500);
    upsert.mockRestore();
    const retried = await push("note-renew");

    expect(retried.json()).toEqual({ ok: true });
    expect((await t.runtime.entitlements.describe(ana.userId)).expiresAtMillis).toBe(renewed.expiresAtMillis);
  });

  it("are not served where purchases cannot be checked", async () => {
    t = await accountsApp({ appStore: false });

    const res = await push("note-anything");

    expect(res.statusCode).toBe(404);
  });
});
