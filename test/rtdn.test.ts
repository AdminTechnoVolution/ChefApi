import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/errors.js";
import { type AccountsApp, type SignedIn, PRODUCT_IDS, accountsApp } from "./accountsHelpers.js";

let t: AccountsApp | undefined;
afterEach(async () => {
  await t?.app.close();
  vi.restoreAllMocks();
  t = undefined;
});

const TOKEN = "purchase-token-for-rtdn-1";

/** What Google Pub/Sub pushes: the notification, base64 inside an envelope. */
const envelope = (messageId: string, notification: unknown) => ({
  message: { messageId, data: Buffer.from(typeof notification === "string" ? notification : JSON.stringify(notification)).toString("base64") },
  subscription: "projects/p/subscriptions/play-billing-rtdn-push",
});

const subscriptionNotification = (purchaseToken = TOKEN, packageName = "com.ichef.app") => ({
  version: "1.0",
  packageName,
  eventTimeMillis: "1790000000000",
  subscriptionNotification: { version: "1.0", notificationType: 2, purchaseToken, subscriptionId: PRODUCT_IDS.JUNIOR },
});

const push = (body: unknown, headers: Record<string, string> = {}) =>
  t!.app.inject({
    method: "POST",
    url: "/webhooks/google-play/rtdn",
    headers: { "content-type": "application/json", ...headers },
    payload: JSON.stringify(body),
  });

async function juniorSubscriber(): Promise<SignedIn> {
  const ana = await t!.signIn();
  t!.play.sell(TOKEN, PRODUCT_IDS.JUNIOR, {}, t!.clock.now());
  await t!.app.inject({
    method: "POST",
    url: "/v1/entitlements/verify-purchase",
    headers: ana.headers,
    payload: JSON.stringify({ productId: PRODUCT_IDS.JUNIOR, purchaseToken: TOKEN }),
  });
  return ana;
}

const planOf = async (s: SignedIn) => (await t!.runtime.entitlements.describe(s.userId)).plan;

describe("Google Play's real-time notifications", () => {
  it("logs delivery outcomes and HTTP status without purchase tokens or authorization", async () => {
    t = await accountsApp();
    await juniorSubscriber();
    // Capture request child loggers without enabling noisy test logging.
    vi.spyOn(t.app.log, "child").mockReturnValue(t.app.log);
    const info = vi.spyOn(t.app.log, "info");
    const warn = vi.spyOn(t.app.log, "warn");
    const error = vi.spyOn(t.app.log, "error");
    await push(envelope("log-1", subscriptionNotification()), { authorization: "Bearer secret-oidc" });
    await push(envelope("log-1", subscriptionNotification()));
    await push(envelope("log-2", "invalid-json"));
    t.play.failure = new ApiError("upstream_error", "Play unavailable");
    await push(envelope("log-3", subscriptionNotification()));
    t.pubsub.accept = false;
    await push(envelope("log-4", subscriptionNotification()));
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "rtdn_received" }), expect.any(String));
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "rtdn_processed", notificationType: 2, updated: true }), expect.any(String));
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "rtdn_duplicate" }), expect.any(String));
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "rtdn_ignored", reason: "invalid_notification" }), expect.any(String));
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "rtdn_response", statusCode: 502 }), expect.any(String));
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "rtdn_rejected" }), expect.any(String));
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: "rtdn_failed", retryable: true }), expect.any(String));
    // Fastify's own request logs are serialized/redacted later by Pino;
    // inspect only the structured RTDN events added by this endpoint.
    const logs = JSON.stringify([...info.mock.calls, ...warn.mock.calls, ...error.mock.calls]
      .filter(([fields]) => typeof fields === "object" && fields !== null && "event" in fields));
    expect(logs).not.toContain(TOKEN);
    expect(logs).not.toContain("secret-oidc");
  });

  it("bring a subscription up to date when Play says it ended", async () => {
    t = await accountsApp();
    const ana = await juniorSubscriber();
    expect(await planOf(ana)).toBe("JUNIOR");

    t.play.subscriptions.set(TOKEN, { ...t.play.subscriptions.get(TOKEN)!, state: "EXPIRED" });
    const res = await push(envelope("m-1", subscriptionNotification()));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await planOf(ana)).toBe("FREE");
  });

  it("bring it up to date when Play says it renewed", async () => {
    t = await accountsApp();
    const ana = await juniorSubscriber();
    const renewedUntil = t.clock.now() + 90 * 86_400_000;
    t.play.subscriptions.set(TOKEN, { ...t.play.subscriptions.get(TOKEN)!, expiresAtMillis: renewedUntil });

    await push(envelope("m-2", subscriptionNotification()));

    expect((await t.runtime.entitlements.describe(ana.userId)).expiresAtMillis).toBe(renewedUntil);
  });

  it("are refused when they do not come from Google", async () => {
    t = await accountsApp();
    await juniorSubscriber();
    t.pubsub.accept = false;
    t.play.asked.length = 0;

    const res = await push(envelope("m-3", subscriptionNotification()));

    expect(res.statusCode).toBe(401);
    expect(t.play.asked).toEqual([]);
  });

  it("are handled once, however often Google redelivers them", async () => {
    t = await accountsApp();
    await juniorSubscriber();
    t.play.asked.length = 0;

    const first = await push(envelope("m-4", subscriptionNotification()));
    const second = await push(envelope("m-4", subscriptionNotification()));

    expect(first.json()).toEqual({ ok: true });
    expect(second.json()).toEqual({ ok: true, duplicate: true });
    expect(t.play.asked).toEqual([TOKEN]);
  });

  it("are retried when handling failed, instead of being skipped as a duplicate", async () => {
    t = await accountsApp();
    const ana = await juniorSubscriber();
    t.play.subscriptions.set(TOKEN, { ...t.play.subscriptions.get(TOKEN)!, state: "EXPIRED" });
    t.play.failure = new ApiError("upstream_error", "Google Play could not be reached.");

    const failed = await push(envelope("m-5", subscriptionNotification()));
    expect(failed.statusCode).toBe(502);
    expect(await planOf(ana)).toBe("JUNIOR");

    t.play.failure = null;
    const retried = await push(envelope("m-5", subscriptionNotification()));

    expect(retried.json()).toEqual({ ok: true });
    expect(await planOf(ana)).toBe("FREE");
  });

  it("do not create a subscription for a purchase the app never settled", async () => {
    t = await accountsApp();
    await t.signIn();
    t.play.sell("never-settled-token", PRODUCT_IDS.MASTER, {}, t.clock.now());

    const res = await push(envelope("m-6", subscriptionNotification("never-settled-token")));

    expect(res.statusCode).toBe(200);
    expect(await t.stores.entitlements.findByPurchaseToken("never-settled-token")).toBeNull();
  });

  it("are ignored when they are for another app", async () => {
    t = await accountsApp();
    await juniorSubscriber();
    t.play.asked.length = 0;

    const res = await push(envelope("m-7", subscriptionNotification(TOKEN, "com.someone.else")));

    expect(res.json()).toEqual({ ok: true, ignored: true });
    expect(t.play.asked).toEqual([]);
  });

  it("are acknowledged, not retried, when they are Google's test message or junk", async () => {
    t = await accountsApp();

    const test = await push(envelope("m-8", { version: "1.0", packageName: "com.ichef.app", testNotification: { version: "1.0" } }));
    const junk = await push(envelope("m-9", "this is not json"));
    const empty = await push({ message: { messageId: "m-10" } });

    for (const res of [test, junk, empty]) {
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, ignored: true });
    }
  });

  it("are refused when the envelope is not a Pub/Sub push", async () => {
    t = await accountsApp();

    expect((await push({ nothing: "here" })).statusCode).toBe(400);
  });

  it("are not served at all in production unless Google's push can be verified", async () => {
    t = await accountsApp({
      pubsub: false,
      config: {
        NODE_ENV: "production",
        CHEF_APP_KEY: "k".repeat(32),
        JWT_SECRET: "j".repeat(40),
        MONGODB_URI: "mongodb://localhost:27017",
        REDIS_URL: "redis://localhost:6379",
      },
    });

    const res = await push(envelope("m-11", subscriptionNotification()));

    expect(res.statusCode).toBe(404);
  });
});
