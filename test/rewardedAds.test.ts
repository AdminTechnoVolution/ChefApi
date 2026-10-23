import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMemoryStores } from "../src/accounts/memoryStores.js";
import { EntitlementService } from "../src/billing/entitlements.js";
import { AdMobSSVVerifier, RewardedAdService } from "../src/billing/rewardedAds.js";

const config = {
  AI_FREE_MONTHLY_UNITS: 5, AI_JUNIOR_MONTHLY_UNITS: 150, AI_MASTER_MONTHLY_UNITS: 400,
  DEV_UNLOCK_PLAN: undefined,
  NODE_ENV: "test" as const,
  ADMOB_REWARDED_ANDROID_UNIT_ID: "ca-app-pub-5985509149921822/1065793284",
  ADMOB_REWARDED_IOS_UNIT_ID: "ca-app-pub-5985509149921822/7234695947",
};

function setup(initialNow = Date.UTC(2026, 9, 22, 12)) {
  let now = initialNow;
  const stores = createMemoryStores(() => now);
  const entitlements = new EntitlementService(stores, null, config, () => now);
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const keys = JSON.stringify({ keys: [{ keyId: 77, pem: pair.publicKey.export({ type: "spki", format: "pem" }) }] });
  const verifier = new AdMobSSVVerifier(async () => new Response(keys, { status: 200 }), () => now);
  const rewards = new RewardedAdService(stores.adRewards, entitlements, verifier, config, () => now);
  return { rewards, stores, entitlements, setNow: (value: number) => { now = value; }, privateKey: pair.privateKey };
}

function callback(token: string, transactionId: string, privateKey: KeyObject, unit = "1065793284") {
  const signed = `ad_network=5450213213286189855&ad_unit=${unit}&custom_data=${encodeURIComponent(token)}&reward_amount=5&reward_item=credits&timestamp=1792670400000&transaction_id=${transactionId}`;
  const signature = sign("sha256", Buffer.from(signed), privateKey).toString("base64url");
  return `/webhooks/admob/rewarded?ad_network=5450213213286189855&ad_unit=${unit}&custom_data=${encodeURIComponent(token)}&key_id=77&reward_amount=5&reward_item=credits&signature=${signature}&timestamp=1792670400000&transaction_id=${transactionId}`;
}

describe("AdMob rewarded ads", () => {
  it("adds five monthly credits only after a valid signed callback", async () => {
    const t = setup();
    const reservation = await t.rewards.reserve("ana");
    expect((await t.rewards.status("ana")).availableToday).toBe(0);
    expect(await t.rewards.handleCallback(callback(reservation.token, "txn-1", t.privateKey))).toBe("awarded");
    expect((await t.rewards.status("ana")).monthlyCredits).toBe(5);
    expect((await t.rewards.status("ana")).availableToday).toBe(4);
  });

  it("rejects bad signatures without consuming the reservation", async () => {
    const t = setup();
    const reservation = await t.rewards.reserve("ana");
    const forged = callback(reservation.token, "txn-1", t.privateKey).replace("reward_amount=5", "reward_amount=50");
    await expect(t.rewards.handleCallback(forged)).rejects.toMatchObject({ code: "unauthorized" });
    expect((await t.rewards.status("ana")).reservationActive).toBe(true);
    expect((await t.rewards.status("ana")).monthlyCredits).toBe(0);
  });

  it("does not award a repeated AdMob transaction twice", async () => {
    const t = setup();
    const reservation = await t.rewards.reserve("ana");
    const signed = callback(reservation.token, "txn-1", t.privateKey);
    expect(await t.rewards.handleCallback(signed)).toBe("awarded");
    expect(await t.rewards.handleCallback(signed)).toBe("duplicate");
    expect((await t.rewards.status("ana")).monthlyCredits).toBe(5);
  });

  it("enforces one active reservation and a maximum of five completed ads each UTC day", async () => {
    const t = setup();
    for (let index = 0; index < 5; index++) {
      const reservation = await t.rewards.reserve("ana");
      await expect(t.rewards.reserve("ana")).rejects.toMatchObject({ code: "conflict" });
      await t.rewards.handleCallback(callback(reservation.token, `txn-${index}`, t.privateKey));
    }
    expect((await t.rewards.status("ana")).availableToday).toBe(0);
    await expect(t.rewards.reserve("ana")).rejects.toMatchObject({ code: "conflict" });
  });

  it("keeps the one-active-ad limit across UTC midnight", async () => {
    const t = setup(Date.UTC(2026, 9, 22, 23, 59));
    await t.rewards.reserve("ana");
    t.setNow(Date.UTC(2026, 9, 23, 0, 1));
    expect((await t.rewards.status("ana")).reservationActive).toBe(true);
    expect((await t.rewards.status("ana")).availableToday).toBe(0);
    expect((await t.entitlements.describe("ana")).adRewards).toMatchObject({ reservationActive: true, availableToday: 0 });
    await expect(t.rewards.reserve("ana")).rejects.toMatchObject({ code: "conflict" });
  });

  it("expires unfinished reservations after fifteen minutes and accepts cancellation", async () => {
    const t = setup();
    const first = await t.rewards.reserve("ana");
    t.setNow(Date.UTC(2026, 9, 22, 12, 16));
    expect((await t.rewards.status("ana")).availableToday).toBe(5);
    const second = await t.rewards.reserve("ana");
    expect(await t.rewards.cancel("ana", second.token)).toMatchObject({ reservationActive: false, availableToday: 5 });
    await expect(t.rewards.handleCallback(callback(first.token, "late", t.privateKey))).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("expires earned credits at the next monthly allowance", async () => {
    const t = setup();
    const reservation = await t.rewards.reserve("ana");
    await t.rewards.handleCallback(callback(reservation.token, "txn-1", t.privateKey));
    t.setNow(Date.UTC(2026, 10, 1));
    expect((await t.rewards.status("ana")).monthlyCredits).toBe(0);
  });

  it("rejects callbacks for an unconfigured ad unit", async () => {
    const t = setup();
    const reservation = await t.rewards.reserve("ana");
    await expect(t.rewards.handleCallback(callback(reservation.token, "txn-1", t.privateKey, "not-our-ad")))
      .rejects.toMatchObject({ code: "invalid_request" });
  });

  it("does not offer or reserve rewarded ads for an active paid plan", async () => {
    const t = setup();
    await t.stores.entitlements.upsertByPurchaseToken({
      purchaseToken: "paid-purchase", userId: "ana", productId: "chef_junior", plan: "JUNIOR", state: "ACTIVE",
      expiresAtMillis: Date.UTC(2026, 9, 23), autoRenewing: true, updatedAtMillis: Date.UTC(2026, 9, 22),
    });
    expect((await t.rewards.status("ana")).eligible).toBe(false);
    await expect(t.rewards.reserve("ana")).rejects.toMatchObject({ code: "plan_required" });
  });
});
