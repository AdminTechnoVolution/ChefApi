import { type JWTPayload, SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { createMemoryStores } from "../src/accounts/memoryStores.js";
import { MemoryTokenControl } from "../src/accounts/tokenControl.js";
import { DevIdTokenVerifier, GoogleIdTokenVerifier } from "../src/auth/googleIdToken.js";
import { JwtVerifier } from "../src/auth/jwtVerifier.js";
import { GooglePubSubAuth } from "../src/auth/pubsubAuth.js";
import { ACCESS_AUDIENCE, ACCESS_ISSUER, TokenService, hashToken } from "../src/auth/tokenService.js";
import { Clock, JWT_SECRET } from "./accountsHelpers.js";

const service = (overrides: { accessTtlSeconds?: number; refreshTtlMillis?: number; secret?: string } = {}) => {
  const clock = new Clock();
  const stores = createMemoryStores(clock.now);
  const control = new MemoryTokenControl(clock.now);
  const tokens = new TokenService(
    {
      secret: overrides.secret ?? JWT_SECRET,
      accessTtlSeconds: overrides.accessTtlSeconds ?? 900,
      refreshTtlMillis: overrides.refreshTtlMillis ?? 60 * 86_400_000,
    },
    stores.refreshTokens,
    control,
    clock.now,
  );
  return { tokens, stores, clock, control };
};

describe("the access token", () => {
  it("tells whose it is", async () => {
    const { tokens } = service();
    const pair = await tokens.issue("user-1");

    expect((await tokens.verifyAccess(pair.accessToken))?.userId).toBe("user-1");
    expect(pair.expiresInSeconds).toBe(900);
  });

  it("stops working when its time is up, and not before", async () => {
    const { tokens, clock } = service({ accessTtlSeconds: 900 });
    const { accessToken } = await tokens.issue("user-1");

    clock.advance(899_000);
    expect((await tokens.verifyAccess(accessToken))?.userId).toBe("user-1");
    clock.advance(2_000);
    expect(await tokens.verifyAccess(accessToken)).toBeNull();
  });

  it("is refused when it was signed with another secret, altered, or is not a token at all", async () => {
    const { tokens } = service();
    const other = service({ secret: "another-secret-that-is-also-32-characters-long" });
    const foreign = await other.tokens.issue("user-1");
    const { accessToken } = await tokens.issue("user-1");

    expect(await tokens.verifyAccess(foreign.accessToken)).toBeNull();
    expect(await tokens.verifyAccess(accessToken.slice(0, -3) + "abc")).toBeNull();
    expect(await tokens.verifyAccess("not-a-token")).toBeNull();
    expect(await tokens.verifyAccess("")).toBeNull();
  });

  it("is refused when it is not an access token of Chef's, even if our secret signed it", async () => {
    const { tokens, clock } = service();
    const key = new TextEncoder().encode(JWT_SECRET);
    const forge = (claims: JWTPayload, issuer = ACCESS_ISSUER, audience = ACCESS_AUDIENCE) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("user-1")
        .setIssuer(issuer)
        .setAudience(audience)
        .setExpirationTime(Math.floor(clock.now() / 1000) + 600)
        .sign(key);

    expect((await tokens.verifyAccess(await forge({ typ: "access", epoch: 0, jti: "t-1" })))?.userId).toBe("user-1");
    // Missing what a token of ours always carries: its id and its epoch.
    expect(await tokens.verifyAccess(await forge({ typ: "access" }))).toBeNull();
    expect(await tokens.verifyAccess(await forge({ typ: "access", epoch: 0 }))).toBeNull();
    expect(await tokens.verifyAccess(await forge({ typ: "refresh", epoch: 0, jti: "t-1" }))).toBeNull();
    expect(await tokens.verifyAccess(await forge({}))).toBeNull();
    expect(await tokens.verifyAccess(await forge({ typ: "access", epoch: 0, jti: "t-1" }, "someone-else"))).toBeNull();
    expect(await tokens.verifyAccess(await forge({ typ: "access", epoch: 0, jti: "t-1" }, ACCESS_ISSUER, "another-app"))).toBeNull();
  });

  it("is refused when it is unsigned (alg none)", async () => {
    const { tokens } = service();
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ sub: "user-1", typ: "access", iss: ACCESS_ISSUER, aud: ACCESS_AUDIENCE, exp: 9_999_999_999 })).toString("base64url");

    expect(await tokens.verifyAccess(`${header}.${body}.`)).toBeNull();
  });
});

describe("the refresh token", () => {
  it("is stored only as a hash", async () => {
    const { tokens, stores } = service();
    const { refreshToken } = await tokens.issue("user-1", "phone");

    expect(await stores.refreshTokens.consume(refreshToken)).toBeNull();
    const record = await stores.refreshTokens.consume(hashToken(refreshToken));
    expect(record?.userId).toBe("user-1");
    expect(record?.deviceId).toBe("phone");
  });

  it("trades itself for a new session, once", async () => {
    const { tokens } = service();
    const first = await tokens.issue("user-1", "phone");

    const second = await tokens.refresh(first.refreshToken);

    expect(second?.userId).toBe("user-1");
    expect(second?.refreshToken).not.toBe(first.refreshToken);
    expect((await tokens.verifyAccess(second!.accessToken))?.userId).toBe("user-1");
    expect(await tokens.refresh(first.refreshToken)).toBeNull();
  });

  it("keeps the device it was issued to", async () => {
    const { tokens, stores } = service();
    const first = await tokens.issue("user-1", "phone");

    const second = await tokens.refresh(first.refreshToken);

    expect((await stores.refreshTokens.consume(hashToken(second!.refreshToken)))?.deviceId).toBe("phone");
  });

  it("stops working when its time is up", async () => {
    const { tokens, clock } = service({ refreshTtlMillis: 60 * 86_400_000 });
    const { refreshToken } = await tokens.issue("user-1");

    clock.advance(61 * 86_400_000);

    expect(await tokens.refresh(refreshToken)).toBeNull();
  });

  it("is refused when it never existed", async () => {
    expect(await service().tokens.refresh("x".repeat(64))).toBeNull();
  });

  it("ends one device's session without touching the others", async () => {
    const { tokens } = service();
    const phone = await tokens.issue("user-1", "phone");
    const tablet = await tokens.issue("user-1", "tablet");

    await tokens.logout(phone.refreshToken);

    expect(await tokens.refresh(phone.refreshToken)).toBeNull();
    expect((await tokens.refresh(tablet.refreshToken))?.userId).toBe("user-1");
  });

  it("ends every session of a user", async () => {
    const { tokens } = service();
    const phone = await tokens.issue("user-1");
    const tablet = await tokens.issue("user-1");
    const someoneElse = await tokens.issue("user-2");

    await tokens.revokeAll("user-1");

    expect(await tokens.refresh(phone.refreshToken)).toBeNull();
    expect(await tokens.refresh(tablet.refreshToken)).toBeNull();
    expect((await tokens.refresh(someoneElse.refreshToken))?.userId).toBe("user-2");
  });
});

describe("revoking sessions", () => {
  it("makes one access token stop working at once, and only that one", async () => {
    const { tokens } = service();
    const phone = await tokens.issue("user-1", "phone");
    const tablet = await tokens.issue("user-1", "tablet");
    const claims = (await tokens.verifyAccess(phone.accessToken))!;

    await tokens.logout(phone.refreshToken, claims);

    expect(await tokens.verifyAccess(phone.accessToken)).toBeNull();
    expect((await tokens.verifyAccess(tablet.accessToken))?.userId).toBe("user-1");
  });

  it("makes every access token of one user stop working at once, and nobody else's", async () => {
    const { tokens } = service();
    const first = await tokens.issue("user-1");
    const second = await tokens.issue("user-1");
    const other = await tokens.issue("user-2");

    await tokens.revokeAll("user-1");

    expect(await tokens.verifyAccess(first.accessToken)).toBeNull();
    expect(await tokens.verifyAccess(second.accessToken)).toBeNull();
    expect((await tokens.verifyAccess(other.accessToken))?.userId).toBe("user-2");
  });

  it("does not hold back tokens issued after the revocation, not even in the same instant", async () => {
    const { tokens } = service();
    await tokens.issue("user-1");

    await tokens.revokeAll("user-1");
    const after = await tokens.issue("user-1");

    expect((await tokens.verifyAccess(after.accessToken))?.userId).toBe("user-1");
  });

  it("forgets a revoked token once it would have expired anyway", async () => {
    const { tokens, clock, control } = service({ accessTtlSeconds: 900 });
    const pair = await tokens.issue("user-1");
    const claims = (await tokens.verifyAccess(pair.accessToken))!;
    await tokens.logout(pair.refreshToken, claims);

    clock.advance(901_000);

    expect(await control.isRevoked({ userId: "user-1", tokenId: claims.tokenId, epoch: 0 })).toBe(false);
    expect(await tokens.verifyAccess(pair.accessToken)).toBeNull();
  });

  it("treats a refresh token that comes back after being used as a leak, and ends every session of its owner", async () => {
    const { tokens } = service();
    const phone = await tokens.issue("user-1", "phone");
    const tablet = await tokens.issue("user-1", "tablet");
    const renewed = (await tokens.refresh(phone.refreshToken))!;

    // Someone who kept a copy of the old refresh token tries it.
    expect(await tokens.refresh(phone.refreshToken)).toBeNull();

    expect(await tokens.verifyAccess(renewed.accessToken)).toBeNull();
    expect(await tokens.verifyAccess(tablet.accessToken)).toBeNull();
    expect(await tokens.refresh(renewed.refreshToken)).toBeNull();
    expect(await tokens.refresh(tablet.refreshToken)).toBeNull();
  });

  it("does not take the owner's sessions down for a token nobody ever issued", async () => {
    const { tokens } = service();
    const phone = await tokens.issue("user-1");

    expect(await tokens.refresh("z".repeat(64))).toBeNull();

    expect((await tokens.verifyAccess(phone.accessToken))?.userId).toBe("user-1");
  });

  it("ends a session for good by logging out, without taking the user's other devices down with it", async () => {
    const { tokens } = service();
    const phone = await tokens.issue("user-1", "phone");
    const tablet = await tokens.issue("user-1", "tablet");

    await tokens.logout(phone.refreshToken);

    expect(await tokens.refresh(phone.refreshToken)).toBeNull();
    expect((await tokens.verifyAccess(tablet.accessToken))?.userId).toBe("user-1");
    expect((await tokens.refresh(tablet.refreshToken))?.userId).toBe("user-1");
  });
});

describe("JwtVerifier", () => {
  const verifierWithUser = async () => {
    const { tokens, stores } = service();
    const user = await stores.users.upsertByGoogle({ googleSub: "s", email: "a@example.com", name: null }, 0);
    return { verifier: new JwtVerifier(tokens), tokens, stores, user };
  };

  it("knows the user behind a bearer token", async () => {
    const { verifier, tokens, user } = await verifierWithUser();
    const { accessToken } = await tokens.issue(user.id);

    const client = await verifier.verify({ authorization: `Bearer ${accessToken}` });
    expect(client).toMatchObject({ clientId: user.id, userId: user.id });
    expect(client?.access?.tokenId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await verifier.verify({ authorization: `bearer ${accessToken}` })).toMatchObject({ userId: user.id });
  });

  it("refuses a missing header, another scheme, and a bad token", async () => {
    const { verifier, tokens, user } = await verifierWithUser();
    const { accessToken } = await tokens.issue(user.id);

    expect(await verifier.verify({})).toBeNull();
    expect(await verifier.verify({ authorization: `Basic ${accessToken}` })).toBeNull();
    expect(await verifier.verify({ authorization: accessToken })).toBeNull();
    expect(await verifier.verify({ authorization: "Bearer nope" })).toBeNull();
    expect(await verifier.verify({ "x-chef-app-key": "some-key" })).toBeNull();
  });

  it("refuses a valid token once every session of its user has been revoked", async () => {
    const { verifier, tokens, user } = await verifierWithUser();
    const { accessToken } = await tokens.issue(user.id);

    await tokens.revokeAll(user.id);

    expect(await verifier.verify({ authorization: `Bearer ${accessToken}` })).toBeNull();
  });
});

// --- Google's side, with keys of our own ------------------------------------------------------------

async function googleSigner() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const clock = new Clock();
  const sign = (claims: JWTPayload, options: { issuer?: string; audience?: string; expiresInSeconds?: number; key?: CryptoKey } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(options.issuer ?? "https://accounts.google.com")
      .setAudience(options.audience ?? "chef-client")
      .setIssuedAt(Math.floor(clock.now() / 1000))
      .setExpirationTime(Math.floor(clock.now() / 1000) + (options.expiresInSeconds ?? 600))
      .sign(options.key ?? privateKey);
  return { keys, sign, clock };
}

describe("GoogleIdTokenVerifier", () => {
  const profile = { sub: "google-123", email: "ana@example.com", email_verified: true, name: "Ana" };

  it("accepts a token Google issued to this app and reads who it is", async () => {
    const { keys, sign, clock } = await googleSigner();
    const verifier = new GoogleIdTokenVerifier(["chef-client"], keys, clock.now);

    expect(await verifier.verify(await sign(profile))).toEqual({ googleSub: "google-123", email: "ana@example.com", name: "Ana" });
  });

  it("accepts either spelling of Google's issuer, and any of the client ids", async () => {
    const { keys, sign, clock } = await googleSigner();
    const verifier = new GoogleIdTokenVerifier(["other-client", "chef-client"], keys, clock.now);

    expect(await verifier.verify(await sign(profile, { issuer: "accounts.google.com" }))).not.toBeNull();
    expect(await verifier.verify(await sign(profile, { audience: "other-client" }))).not.toBeNull();
  });

  it("works without a name", async () => {
    const { keys, sign, clock } = await googleSigner();

    expect((await new GoogleIdTokenVerifier(["chef-client"], keys, clock.now).verify(await sign({ ...profile, name: undefined })))?.name).toBeNull();
  });

  it("refuses a token issued to another app, by someone else, or already expired", async () => {
    const { keys, sign, clock } = await googleSigner();
    const verifier = new GoogleIdTokenVerifier(["chef-client"], keys, clock.now);

    expect(await verifier.verify(await sign(profile, { audience: "someone-elses-app" }))).toBeNull();
    expect(await verifier.verify(await sign(profile, { issuer: "https://evil.example.com" }))).toBeNull();
    const expired = await sign(profile, { expiresInSeconds: 60 });
    clock.advance(120_000);
    expect(await verifier.verify(expired)).toBeNull();
  });

  it("refuses an email Google has not verified, and a token without one", async () => {
    const { keys, sign, clock } = await googleSigner();
    const verifier = new GoogleIdTokenVerifier(["chef-client"], keys, clock.now);

    expect(await verifier.verify(await sign({ ...profile, email_verified: false }))).toBeNull();
    expect(await verifier.verify(await sign({ sub: "google-123", email_verified: true }))).toBeNull();
  });

  it("refuses a token signed with a key Google does not publish", async () => {
    const { keys, sign, clock } = await googleSigner();
    const stranger = await generateKeyPair("RS256");
    const verifier = new GoogleIdTokenVerifier(["chef-client"], keys, clock.now);

    expect(await verifier.verify(await sign(profile, { key: stranger.privateKey }))).toBeNull();
    expect(await verifier.verify("garbage")).toBeNull();
  });
});

describe("DevIdTokenVerifier", () => {
  it("signs in as the email after dev:, and nothing else", async () => {
    const verifier = new DevIdTokenVerifier();

    expect(await verifier.verify("dev:ana@example.com")).toEqual({ googleSub: "dev-ana@example.com", email: "ana@example.com", name: "ana" });
    expect(await verifier.verify("ana@example.com")).toBeNull();
    expect(await verifier.verify("dev:not-an-email")).toBeNull();
    expect(await verifier.verify("dev: a@b.c")).toBeNull();
  });
});

describe("GooglePubSubAuth", () => {
  const push = { email: "push@project.iam.gserviceaccount.com", email_verified: true };

  it("accepts Google's token for this endpoint, from the pinned account", async () => {
    const { keys, sign, clock } = await googleSigner();
    const auth = new GooglePubSubAuth("https://api.example.com/webhooks/google-play/rtdn", push.email, keys, clock.now);

    const token = await sign(push, { audience: "https://api.example.com/webhooks/google-play/rtdn" });

    expect(await auth.verify(`Bearer ${token}`)).toBe(true);
  });

  it("refuses another audience, another account, an unverified account, a missing header and a forged token", async () => {
    const { keys, sign, clock } = await googleSigner();
    const audience = "https://api.example.com/webhooks/google-play/rtdn";
    const auth = new GooglePubSubAuth(audience, push.email, keys, clock.now);

    expect(await auth.verify(`Bearer ${await sign(push, { audience: "https://elsewhere.example.com" })}`)).toBe(false);
    expect(await auth.verify(`Bearer ${await sign({ ...push, email: "evil@project.iam.gserviceaccount.com" }, { audience })}`)).toBe(false);
    expect(await auth.verify(`Bearer ${await sign({ ...push, email_verified: false }, { audience })}`)).toBe(false);
    expect(await auth.verify(undefined)).toBe(false);
    expect(await auth.verify("Bearer forged")).toBe(false);
    const stranger = await generateKeyPair("RS256");
    expect(await auth.verify(`Bearer ${await sign(push, { audience, key: stranger.privateKey })}`)).toBe(false);
  });

  it("does not pin the account when none is configured", async () => {
    const { keys, sign, clock } = await googleSigner();
    const audience = "https://api.example.com/webhooks/google-play/rtdn";
    const auth = new GooglePubSubAuth(audience, undefined, keys, clock.now);

    expect(await auth.verify(`Bearer ${await sign({ ...push, email: "anyone@project.iam.gserviceaccount.com" }, { audience })}`)).toBe(true);
  });
});
