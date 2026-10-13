import { X509Certificate } from "node:crypto";
import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import {
  APPLE_ROOT_CA_G3,
  AppStoreBilling,
  AppStoreServerApi,
  AppleJwsVerifier,
  appleSubscription,
  hasCertificateExtension,
  loadAppStoreKey,
} from "../src/billing/appStoreBilling.js";
import { type TestPki, testPki } from "./applePki.js";

const BUNDLE = "com.merochef.app";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const TOKEN = "3f2a9c1e-5b7d-4a60-8f1e-2c3b4d5a6978";

/** Apple's WWDR G6 intermediate certificate, as Apple publishes it. */
const APPLE_WWDR_G6 = `-----BEGIN CERTIFICATE-----
MIIDFjCCApygAwIBAgIUIsGhRwp0c2nvU4YSycafPTjzbNcwCgYIKoZIzj0EAwMw
ZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBD
ZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkG
A1UEBhMCVVMwHhcNMjEwMzE3MjAzNzEwWhcNMzYwMzE5MDAwMDAwWjB1MUQwQgYD
VQQDDDtBcHBsZSBXb3JsZHdpZGUgRGV2ZWxvcGVyIFJlbGF0aW9ucyBDZXJ0aWZp
Y2F0aW9uIEF1dGhvcml0eTELMAkGA1UECwwCRzYxEzARBgNVBAoMCkFwcGxlIElu
Yy4xCzAJBgNVBAYTAlVTMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEbsQKC94PrlWm
ZXnXgtxzdVJL8T0SGYngDRGpngn3N6PT8JMEb7FDi4bBmPhCnZ3/sq6PF/cGcKXW
sL5vOteRhyJ45x3ASP7cOB+aao90fcpxSv/EZFbniAbNgZGhIhpIo4H6MIH3MBIG
A1UdEwEB/wQIMAYBAf8CAQAwHwYDVR0jBBgwFoAUu7DeoVgziJqkipnevr3rr9rL
JKswRgYIKwYBBQUHAQEEOjA4MDYGCCsGAQUFBzABhipodHRwOi8vb2NzcC5hcHBs
ZS5jb20vb2NzcDAzLWFwcGxlcm9vdGNhZzMwNwYDVR0fBDAwLjAsoCqgKIYmaHR0
cDovL2NybC5hcHBsZS5jb20vYXBwbGVyb290Y2FnMy5jcmwwHQYDVR0OBBYEFD8v
lCNR01DJmig97bB85c+lkGKZMA4GA1UdDwEB/wQEAwIBBjAQBgoqhkiG92NkBgIB
BAIFADAKBggqhkjOPQQDAwNoADBlAjBAXhSq5IyKogMCPtw490BaB677CaEGJXuf
QB/EqZGd6CSjiCtOnuMTbXVXmxxcxfkCMQDTSPxarZXvNrkxU3TkUMI33yzvFVVR
T4wxWJC994OsdcZ4+RGNsYDyR5gmdr0nDGg=
-----END CERTIFICATE-----`;

const transaction = (overrides: Record<string, unknown> = {}) => ({
  transactionId: "2000000099",
  originalTransactionId: "2000000001",
  bundleId: BUNDLE,
  productId: "chef_junior_monthly",
  type: "Auto-Renewable Subscription",
  purchaseDate: NOW,
  expiresDate: NOW + 30 * DAY,
  appAccountToken: TOKEN,
  environment: "Sandbox",
  signedDate: NOW,
  ...overrides,
});

describe("Apple's root certificate", () => {
  it("is the one Apple publishes", () => {
    expect(new X509Certificate(APPLE_ROOT_CA_G3).fingerprint256).toBe(
      "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79",
    );
  });

  it("signs Apple's intermediate, which carries the marker the verifier looks for", () => {
    const intermediate = new X509Certificate(APPLE_WWDR_G6);
    expect(intermediate.verify(new X509Certificate(APPLE_ROOT_CA_G3).publicKey)).toBe(true);
    expect(hasCertificateExtension(intermediate.raw, "1.2.840.113635.100.6.2.1")).toBe(true);
    expect(hasCertificateExtension(intermediate.raw, "1.2.840.113635.100.6.11.1")).toBe(false);
  });
});

describe("what Apple signed", () => {
  it("is accepted when the chain leads to the root we trust", async () => {
    const pki = testPki();
    const verifier = new AppleJwsVerifier([pki.rootPem], () => NOW);

    expect(await verifier.verify(await pki.sign(transaction()))).toMatchObject({ productId: "chef_junior_monthly" });
  });

  it("is refused when the root is not the one we trust, whatever the header claims", async () => {
    const pki = testPki();
    const real = new AppleJwsVerifier([APPLE_ROOT_CA_G3], () => NOW);

    expect(await real.verify(await pki.sign(transaction()))).toBeNull();
  });

  it("is refused when the payload was changed after signing", async () => {
    const pki = testPki();
    const verifier = new AppleJwsVerifier([pki.rootPem], () => NOW);
    const [header, , signature] = (await pki.sign(transaction())).split(".");
    const forged = Buffer.from(JSON.stringify(transaction({ productId: "chef_master_monthly" }))).toString("base64url");

    expect(await verifier.verify(`${header}.${forged}.${signature}`)).toBeNull();
  });

  it("is refused when the leaf is not the key that signed it", async () => {
    const mine = testPki();
    const other = testPki();
    const verifier = new AppleJwsVerifier([mine.rootPem, other.rootPem], () => NOW);
    // Signed by one key, announcing another leaf (from a chain we trust) as its own.
    const jws = await mine.sign(transaction(), { chain: other.chain });

    expect(await verifier.verify(jws)).toBeNull();
  });

  it("is refused when the leaf lacks Apple's marker, as any developer certificate does", async () => {
    const pki = testPki({ marker: false });
    const verifier = new AppleJwsVerifier([pki.rootPem], () => NOW);

    expect(await verifier.verify(await pki.sign(transaction()))).toBeNull();
  });

  it("is refused when a certificate names the right issuer but was not signed by it", async () => {
    for (const forged of ["leaf", "intermediate"] as const) {
      const pki = testPki({ forged });
      const verifier = new AppleJwsVerifier([pki.rootPem], () => NOW);

      expect(await verifier.verify(await pki.sign(transaction()))).toBeNull();
    }
  });

  it("is refused when the chain is cut short or put out of order", async () => {
    const pki = testPki();
    const verifier = new AppleJwsVerifier([pki.rootPem], () => NOW);
    const [leaf, intermediate, root] = pki.chain as [Buffer, Buffer, Buffer];

    expect(await verifier.verify(await pki.sign(transaction(), { chain: [leaf, root] }))).toBeNull();
    expect(await verifier.verify(await pki.sign(transaction(), { chain: [leaf] }))).toBeNull();
    expect(await verifier.verify(await pki.sign(transaction(), { chain: [intermediate, leaf, root] }))).toBeNull();
  });

  it("is refused when it names no algorithm Apple uses or carries no chain", async () => {
    const pki = testPki();
    const verifier = new AppleJwsVerifier([pki.rootPem], () => NOW);

    expect(await verifier.verify(await pki.sign(transaction(), { header: { x5c: undefined } }))).toBeNull();
    expect(await verifier.verify("not.a.jws")).toBeNull();
    expect(await verifier.verify("")).toBeNull();
  });

  it("must have been signed while the certificates were valid, not today", async () => {
    const pki = testPki({ notBefore: new Date(NOW - 400 * DAY), notAfter: new Date(NOW - 30 * DAY) });
    const verifier = new AppleJwsVerifier([pki.rootPem], () => NOW);

    // Signed last month with a leaf that has since run out: still Apple's word.
    expect(await verifier.verify(await pki.sign(transaction({ signedDate: NOW - 60 * DAY })))).not.toBeNull();
    // Signed after the leaf ran out: no.
    expect(await verifier.verify(await pki.sign(transaction({ signedDate: NOW })))).toBeNull();
    // Signed before the leaf existed: no.
    expect(await verifier.verify(await pki.sign(transaction({ signedDate: NOW - 500 * DAY })))).toBeNull();
  });
});

describe("what a transaction says about a subscription", () => {
  const read = (t: Record<string, unknown>, renewal: Record<string, unknown> | null = null, status: number | null = null, at = NOW) =>
    appleSubscription(t, renewal, status, at);

  it("takes the product, the dates and the account it was bought for", () => {
    expect(read(transaction())).toEqual({
      originalTransactionId: "2000000001",
      productId: "chef_junior_monthly",
      state: "ACTIVE",
      expiresAtMillis: NOW + 30 * DAY,
      autoRenewing: true,
      appAccountToken: TOKEN,
      signedAtMillis: NOW,
    });
  });

  it("has no account when the purchase was not tagged, and reads it in lower case", () => {
    expect(read(transaction({ appAccountToken: undefined }))?.appAccountToken).toBeNull();
    expect(read(transaction({ appAccountToken: TOKEN.toUpperCase() }))?.appAccountToken).toBe(TOKEN);
  });

  it("is over when the period is, and when it was refunded", () => {
    expect(read(transaction({ expiresDate: NOW - 1 }))?.state).toBe("EXPIRED");
    expect(read(transaction({ revocationDate: NOW - DAY }))?.state).toBe("EXPIRED");
  });

  it("follows the status Apple gives, when it gives one", () => {
    expect(read(transaction(), null, 1)?.state).toBe("ACTIVE");
    expect(read(transaction(), null, 2)?.state).toBe("EXPIRED");
    expect(read(transaction(), null, 3)?.state).toBe("ON_HOLD");
    expect(read(transaction(), null, 5)?.state).toBe("EXPIRED");
    expect(read(transaction(), null, 9)?.state).toBe("UNKNOWN");
  });

  it("keeps access through the grace period, to the day it ends", () => {
    const lapsed = transaction({ expiresDate: NOW - DAY });
    const subscription = read(lapsed, { autoRenewStatus: 1, gracePeriodExpiresDate: NOW + 5 * DAY }, 4);

    expect(subscription).toMatchObject({ state: "IN_GRACE_PERIOD", expiresAtMillis: NOW + 5 * DAY, autoRenewing: true });
  });

  it("knows a subscription that was cancelled but has not run out", () => {
    expect(read(transaction(), { autoRenewStatus: 0 }, 1)).toMatchObject({ state: "CANCELED", autoRenewing: false });
    expect(read(transaction(), { autoRenewStatus: 1 }, 1)).toMatchObject({ state: "ACTIVE", autoRenewing: true });
  });

  it("is nothing without what identifies it", () => {
    expect(read(transaction({ originalTransactionId: undefined }))).toBeNull();
    expect(read(transaction({ productId: "" }))).toBeNull();
    expect(read(transaction({ expiresDate: "tomorrow" }))).toBeNull();
  });
});

describe("the App Store as the API uses it", () => {
  const billing = (pki = testPki(), api: AppStoreServerApi | null = null) =>
    ({ pki, billing: new AppStoreBilling(BUNDLE, new AppleJwsVerifier([pki.rootPem], () => NOW), api, () => NOW) });

  it("reads a purchase from the signature alone when it has no API key", async () => {
    const { pki, billing: store } = billing();

    expect(store.canRefresh).toBe(false);
    expect(await store.verify(await pki.sign(transaction()))).toMatchObject({ originalTransactionId: "2000000001", state: "ACTIVE" });
    expect(await store.refresh("2000000001")).toBeNull();
  });

  it("refuses another app's transaction, another kind of product, and anything not signed by Apple", async () => {
    const { pki, billing: store } = billing();
    const other = testPki();

    expect(await store.verify(await pki.sign(transaction({ bundleId: "com.example.other" })))).toBeNull();
    expect(await store.verify(await pki.sign(transaction({ type: "Consumable" })))).toBeNull();
    expect(await store.verify(await other.sign(transaction()))).toBeNull();
  });

  it("reads Apple's server notifications", async () => {
    const { pki, billing: store } = billing();
    const signedTransactionInfo = await pki.sign(transaction({ expiresDate: NOW - DAY }));
    const signedRenewalInfo = await pki.sign({ autoRenewStatus: 1, gracePeriodExpiresDate: NOW + 4 * DAY });
    const payload = await pki.sign({
      notificationType: "DID_FAIL_TO_RENEW",
      subtype: "GRACE_PERIOD",
      notificationUUID: "9f6f1d1c-1111-4222-8333-444455556666",
      signedDate: NOW,
      data: { bundleId: BUNDLE, environment: "Sandbox", status: 4, signedTransactionInfo, signedRenewalInfo },
    });

    expect(await store.notification(payload)).toEqual({
      uuid: "9f6f1d1c-1111-4222-8333-444455556666",
      type: "DID_FAIL_TO_RENEW",
      subscription: expect.objectContaining({ state: "IN_GRACE_PERIOD", expiresAtMillis: NOW + 4 * DAY }),
    });
  });

  it("answers a test notification, and ignores one about another app", async () => {
    const { pki, billing: store } = billing();
    const signedTransactionInfo = await pki.sign(transaction());

    expect(await store.notification(await pki.sign({ notificationType: "TEST", notificationUUID: "t-1", signedDate: NOW }))).toEqual({ uuid: "t-1", type: "TEST", subscription: null });
    const foreign = await pki.sign({ notificationType: "DID_RENEW", notificationUUID: "t-2", signedDate: NOW, data: { bundleId: "com.example.other", signedTransactionInfo } });
    expect(await store.notification(foreign)).toEqual({ uuid: "t-2", type: "DID_RENEW", subscription: null });
  });

  it("refuses a notification that Apple did not sign", async () => {
    const { billing: store } = billing();
    const forger = testPki();

    expect(await store.notification(await forger.sign({ notificationType: "REFUND", notificationUUID: "x", signedDate: NOW }))).toBeNull();
    expect(await store.notification("garbage")).toBeNull();
  });

  it("brings in a refund as the end of access", async () => {
    const { pki, billing: store } = billing();
    const signedTransactionInfo = await pki.sign(transaction({ revocationDate: NOW, revocationReason: 0 }));
    const payload = await pki.sign({ notificationType: "REFUND", notificationUUID: "r-1", signedDate: NOW, data: { bundleId: BUNDLE, signedTransactionInfo } });

    expect((await store.notification(payload))?.subscription?.state).toBe("EXPIRED");
  });
});

describe("the App Store Server API", () => {
  const answer = async (pki: ReturnType<typeof testPki>, entry: Record<string, unknown> = {}) => ({
    environment: "Sandbox",
    bundleId: BUNDLE,
    data: [
      {
        subscriptionGroupIdentifier: "21000000",
        lastTransactions: [
          {
            originalTransactionId: "2000000001",
            status: 1,
            signedTransactionInfo: await pki.sign(transaction({ productId: "chef_master_monthly", expiresDate: NOW + 60 * DAY, signedDate: NOW + DAY })),
            signedRenewalInfo: await pki.sign({ autoRenewStatus: 0 }),
            ...entry,
          },
        ],
      },
    ],
  });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  async function setup(respond: (pki: TestPki) => (url: string, init: RequestInit) => Response | Promise<Response>) {
    const pki = testPki();
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const key = { keyId: "KEY1234567", issuerId: "69a6de70-aaaa-47e3-bbbb-cccccccccccc", privateKey: await exportPKCS8(privateKey) };
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const handler = respond(pki);
    const http = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return handler(url, init);
    }) as unknown as typeof fetch;
    const api = new AppStoreServerApi(key, BUNDLE, http, () => NOW);
    const billing = new AppStoreBilling(BUNDLE, new AppleJwsVerifier([pki.rootPem], () => NOW + 2 * DAY), api, () => NOW + 2 * DAY);
    return { pki, calls, billing, api, publicKey };
  }

  it("is asked, and its answer wins over the transaction the app sent", async () => {
    const t = await setup((pki) => async () => json(await answer(pki)));

    const subscription = await t.billing.verify(await t.pki.sign(transaction()));

    // The app sent a Junior month; Apple says it was upgraded to Master and will not renew.
    expect(subscription).toMatchObject({ productId: "chef_master_monthly", state: "CANCELED", autoRenewing: false, expiresAtMillis: NOW + 60 * DAY });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.url).toBe("https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/2000000001");
  });

  it("signs its requests as Apple asks", async () => {
    const t = await setup((pki) => async () => json(await answer(pki)));
    await t.api.subscriptionStatus("2000000001");
    await t.api.subscriptionStatus("2000000001");

    const token = t.calls[0]!.headers.authorization!.replace("Bearer ", "");
    const { payload, protectedHeader } = await jwtVerify(token, t.publicKey, { audience: "appstoreconnect-v1", currentDate: new Date(NOW) });

    expect(protectedHeader).toMatchObject({ alg: "ES256", kid: "KEY1234567", typ: "JWT" });
    expect(payload).toMatchObject({ iss: "69a6de70-aaaa-47e3-bbbb-cccccccccccc", aud: "appstoreconnect-v1", bid: BUNDLE });
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(3600);
    // One token serves both calls.
    expect(t.calls[1]!.headers.authorization).toBe(t.calls[0]!.headers.authorization);
  });

  it("tries the sandbox server when the production one does not know the subscription", async () => {
    const t = await setup((pki) => async (url) => (url.includes("sandbox") ? json(await answer(pki)) : json({ errorCode: 4040010 }, 404)));

    expect(await t.billing.refresh("2000000001")).toMatchObject({ productId: "chef_master_monthly" });
    expect(t.calls.map((call) => new URL(call.url).host)).toEqual(["api.storekit.itunes.apple.com", "api.storekit-sandbox.itunes.apple.com"]);
  });

  it("does not know a subscription neither server knows", async () => {
    const t = await setup(() => async () => json({ errorCode: 4040010 }, 404));

    expect(await t.billing.refresh("2000000001")).toBeNull();
    expect(await t.billing.verify(await t.pki.sign(transaction()))).toBeNull();
  });

  it("does not take a status for a different subscription", async () => {
    const t = await setup((pki) => async () => json(await answer(pki, { originalTransactionId: "2999999999" })));

    expect(await t.billing.refresh("2000000001")).toBeNull();
  });

  it("is an upstream error when Apple cannot be reached or refuses the key", async () => {
    const down = await setup(() => async () => json({}, 503));
    const unauthorised = await setup(() => async () => json({ errorCode: 4010001 }, 401));
    const offline = await setup(() => () => Promise.reject(new TypeError("fetch failed")));

    for (const t of [down, unauthorised, offline]) {
      await expect(t.billing.refresh("2000000001")).rejects.toMatchObject({ code: "upstream_error" });
      await expect(t.billing.refresh("2000000001")).rejects.toBeInstanceOf(ApiError);
    }
  });

  it("keeps the purchase Apple signed when its server cannot be asked, and says why", async () => {
    for (const respond of [() => json({ errorCode: 4010001 }, 401), () => json({}, 503), () => Promise.reject(new TypeError("fetch failed"))]) {
      const warnings: string[] = [];
      const pki = testPki();
      const { privateKey } = await generateKeyPair("ES256", { extractable: true });
      const key = { keyId: "KEY1234567", issuerId: "69a6de70-aaaa-47e3-bbbb-cccccccccccc", privateKey: await exportPKCS8(privateKey) };
      const api = new AppStoreServerApi(key, BUNDLE, (async () => respond()) as unknown as typeof fetch, () => NOW);
      const billing = new AppStoreBilling(BUNDLE, new AppleJwsVerifier([pki.rootPem], () => NOW + 2 * DAY), api, () => NOW + 2 * DAY, (message) => warnings.push(message));

      const subscription = await billing.verify(await pki.sign(transaction()));

      expect(subscription).toMatchObject({ originalTransactionId: "2000000001", productId: "chef_junior_monthly" });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("2000000001");
    }
  });

  it("still refuses what Apple did not sign, whatever its server says", async () => {
    const t = await setup(() => async () => json({}, 503));
    expect(await t.billing.verify(await testPki().sign(transaction()))).toBeNull();
  });

  it("refuses an answer Apple did not sign", async () => {
    const t = await setup(() => async () => json(await answer(testPki())));

    expect(await t.billing.refresh("2000000001")).toBeNull();
  });
});

describe("the App Store Server API key", () => {
  it("is read from Base64 or from a file, and is absent when nothing is set", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    const base64 = Buffer.from(pem).toString("base64");

    expect(loadAppStoreKey({})).toBeUndefined();
    expect(loadAppStoreKey({ keyId: "K", issuerId: "I", base64 })).toEqual({ keyId: "K", issuerId: "I", privateKey: pem });
  });

  it("is refused when only part of it is set", () => {
    expect(() => loadAppStoreKey({ keyId: "K" })).toThrow(/together/);
    expect(() => loadAppStoreKey({ base64: Buffer.from("x").toString("base64") })).toThrow(/together/);
  });
});
