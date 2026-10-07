import { decodeJwt, exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { GooglePlayBilling, loadServiceAccount, parsePlaySubscription, stateFromPlay } from "../src/billing/playBilling.js";

const EXPIRY = "2026-11-15T12:00:00.000Z";

const playAnswer = (overrides: Record<string, unknown> = {}) => ({
  kind: "androidpublisher#subscriptionPurchaseV2",
  subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
  lineItems: [{ productId: "chef_junior_monthly", expiryTime: EXPIRY, autoRenewingPlan: { autoRenewEnabled: true } }],
  externalAccountIdentifiers: { obfuscatedExternalAccountId: "abc123" },
  acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
  ...overrides,
});

describe("what Play says a subscription is", () => {
  it("maps every state Play has to ours", () => {
    expect(stateFromPlay("SUBSCRIPTION_STATE_ACTIVE")).toBe("ACTIVE");
    expect(stateFromPlay("SUBSCRIPTION_STATE_IN_GRACE_PERIOD")).toBe("IN_GRACE_PERIOD");
    expect(stateFromPlay("SUBSCRIPTION_STATE_CANCELED")).toBe("CANCELED");
    expect(stateFromPlay("SUBSCRIPTION_STATE_ON_HOLD")).toBe("ON_HOLD");
    expect(stateFromPlay("SUBSCRIPTION_STATE_PAUSED")).toBe("PAUSED");
    expect(stateFromPlay("SUBSCRIPTION_STATE_EXPIRED")).toBe("EXPIRED");
    expect(stateFromPlay("SUBSCRIPTION_STATE_PENDING")).toBe("PENDING");
    expect(stateFromPlay("SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED")).toBe("PENDING");
  });

  it("gives no access for a state it does not know", () => {
    expect(stateFromPlay("SUBSCRIPTION_STATE_SOMETHING_NEW")).toBe("UNKNOWN");
    expect(stateFromPlay(undefined)).toBe("UNKNOWN");
    expect(stateFromPlay(42)).toBe("UNKNOWN");
  });
});

describe("reading Play's answer", () => {
  it("takes the product, the state, the expiry and who it was bought for", () => {
    expect(parsePlaySubscription(playAnswer())).toEqual({
      productId: "chef_junior_monthly",
      state: "ACTIVE",
      expiresAtMillis: Date.parse(EXPIRY),
      autoRenewing: true,
      obfuscatedAccountId: "abc123",
    });
  });

  it("knows a subscription that will not renew", () => {
    const answer = playAnswer({ lineItems: [{ productId: "chef_master_monthly", expiryTime: EXPIRY }] });

    expect(parsePlaySubscription(answer)?.autoRenewing).toBe(false);
  });

  it("goes by the line item that lasts longest when there are several", () => {
    const answer = playAnswer({
      lineItems: [
        { productId: "chef_junior_monthly", expiryTime: "2026-10-20T00:00:00.000Z" },
        { productId: "chef_master_monthly", expiryTime: "2026-12-20T00:00:00.000Z", autoRenewingPlan: {} },
      ],
    });

    expect(parsePlaySubscription(answer)).toMatchObject({ productId: "chef_master_monthly", expiresAtMillis: Date.parse("2026-12-20T00:00:00.000Z") });
  });

  it("has no account when the purchase was not tagged", () => {
    expect(parsePlaySubscription(playAnswer({ externalAccountIdentifiers: {} }))?.obfuscatedAccountId).toBeNull();
    expect(parsePlaySubscription(playAnswer({ externalAccountIdentifiers: undefined }))?.obfuscatedAccountId).toBeNull();
    expect(parsePlaySubscription(playAnswer({ externalAccountIdentifiers: { obfuscatedExternalAccountId: "" } }))?.obfuscatedAccountId).toBeNull();
  });

  it("says nothing usable for an answer that holds nothing usable", () => {
    expect(parsePlaySubscription(null)).toBeNull();
    expect(parsePlaySubscription("nope")).toBeNull();
    expect(parsePlaySubscription({})).toBeNull();
    expect(parsePlaySubscription(playAnswer({ lineItems: [] }))).toBeNull();
    expect(parsePlaySubscription(playAnswer({ lineItems: [{ productId: "x" }] }))).toBeNull();
    expect(parsePlaySubscription(playAnswer({ lineItems: [{ productId: "x", expiryTime: "not a date" }] }))).toBeNull();
  });
});

describe("the service account", () => {
  const json = JSON.stringify({ client_email: "play@project.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n", extra: "ignored" });

  it("is read from Base64, the way an App Service setting holds it", () => {
    expect(loadServiceAccount({ base64: Buffer.from(json).toString("base64") })).toEqual({
      client_email: "play@project.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
    });
  });

  it("is simply absent when none is configured", () => {
    expect(loadServiceAccount({})).toBeUndefined();
  });

  it("is refused when it lacks the key or the email", () => {
    expect(() => loadServiceAccount({ base64: Buffer.from(JSON.stringify({ client_email: "a@b.c" })).toString("base64") })).toThrow(/private_key/);
  });
});

describe("asking Google Play", () => {
  async function client() {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const account = { client_email: "play@project.iam.gserviceaccount.com", private_key: await exportPKCS8(privateKey) };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let tokenRequests = 0;
    const respond = { token: { status: 200, body: { access_token: "play-access-token", expires_in: 3600 } as unknown }, play: { status: 200, body: playAnswer() as unknown } };
    let now = 1_800_000_000_000;
    const http = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      calls.push({ url: target, init });
      const isToken = target === "https://oauth2.googleapis.com/token";
      if (isToken) tokenRequests++;
      const { status, body } = isToken ? respond.token : respond.play;
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const billing = new GooglePlayBilling(account, "com.ichef.app", http, () => now);
    return { billing, calls, respond, publicKey, tokenRequests: () => tokenRequests, advance: (ms: number) => void (now += ms), now: () => now };
  }

  it("asks Play about the purchase token of this app, authenticated as the service account", async () => {
    const t = await client();

    const found = await t.billing.fetch("some token/with+chars");

    expect(found?.productId).toBe("chef_junior_monthly");
    const ask = t.calls.at(-1)!;
    expect(ask.url).toBe(
      "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.ichef.app/purchases/subscriptionsv2/tokens/some%20token%2Fwith%2Bchars",
    );
    expect((ask.init?.headers as Record<string, string>).authorization).toBe("Bearer play-access-token");
  });

  it("proves who it is with a signed assertion for the Play scope", async () => {
    const t = await client();
    await t.billing.fetch("token-1234567890");

    const tokenCall = t.calls.find((call) => call.url === "https://oauth2.googleapis.com/token")!;
    const form = new URLSearchParams(String(tokenCall.init?.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const assertion = form.get("assertion")!;
    const claims = decodeJwt(assertion);
    expect(claims).toMatchObject({ iss: "play@project.iam.gserviceaccount.com", aud: "https://oauth2.googleapis.com/token", scope: "https://www.googleapis.com/auth/androidpublisher" });
    await expect(jwtVerify(assertion, t.publicKey, { algorithms: ["RS256"], currentDate: new Date(t.now()) })).resolves.toBeDefined();
  });

  it("reuses its access token until just before it runs out", async () => {
    const t = await client();

    await t.billing.fetch("token-1234567890");
    await t.billing.fetch("token-1234567890");
    expect(t.tokenRequests()).toBe(1);

    // Still good a minute before its hour is up...
    t.advance(3_500_000);
    await t.billing.fetch("token-1234567890");
    expect(t.tokenRequests()).toBe(1);

    // ...and replaced within that last minute, so a call never goes out with a token about to expire.
    t.advance(45_000);
    await t.billing.fetch("token-1234567890");
    expect(t.tokenRequests()).toBe(2);
  });

  it("says Play does not know a token it answers 400, 404 or 410 for", async () => {
    const t = await client();

    for (const status of [400, 404, 410]) {
      t.respond.play = { status, body: { error: { message: "nope" } } };
      expect(await t.billing.fetch("token-1234567890"), String(status)).toBeNull();
    }
  });

  it("reports an upstream failure, without leaking what Play said", async () => {
    const t = await client();
    t.respond.play = { status: 503, body: { error: { message: "secret internal detail" } } };

    const error = await t.billing.fetch("token-1234567890").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("upstream_error");
    expect((error as ApiError).message).not.toContain("secret");
  });

  it("reports a service account Google refuses, and an access token it never gave", async () => {
    const refused = await client();
    refused.respond.token = { status: 401, body: { error: "invalid_grant" } };
    const empty = await client();
    empty.respond.token = { status: 200, body: {} };

    for (const t of [refused, empty]) {
      const error = await t.billing.fetch("token-1234567890").catch((e: unknown) => e);
      expect((error as ApiError).code).toBe("upstream_error");
    }
  });

  it("reports Play being unreachable as an upstream failure", async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const billing = new GooglePlayBilling({ client_email: "a@b.c", private_key: await exportPKCS8(privateKey) }, "com.ichef.app", down);

    const error = await billing.fetch("token-1234567890").catch((e: unknown) => e);

    expect((error as ApiError).code).toBe("upstream_error");
  });
});
