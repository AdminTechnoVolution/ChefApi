import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { AppleIdTokenVerifier } from "../src/auth/appleIdToken.js";
import { accountsApp } from "./accountsHelpers.js";

const nonce = "a".repeat(64);
const now = Date.UTC(2026, 9, 11);

describe("Apple token verification", () => {
  it("validates signature, issuer, audience, expiry, nonce and verified email", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const verifier = new AppleIdTokenVerifier(["com.merochef.app"], createLocalJWKSet({ keys: [{ ...jwk, kid: "apple-test", alg: "RS256" }] }), () => now);
    async function token(overrides: Record<string, unknown> = {}) {
      return new SignJWT({ sub: "apple-user", email: "private@privaterelay.appleid.com", email_verified: "true", nonce, ...overrides })
        .setProtectedHeader({ alg: "RS256", kid: "apple-test" }).setIssuer("https://appleid.apple.com").setAudience("com.merochef.app")
        .setIssuedAt(now / 1000).setExpirationTime(now / 1000 + 300).sign(privateKey);
    }
    expect(await verifier.verify(await token(), nonce)).toEqual({ appleSub: "apple-user", email: "private@privaterelay.appleid.com" });
    expect(await verifier.verify(await token(), "b".repeat(64))).toBeNull();
    expect(await verifier.verify(await token({ email_verified: false }), nonce)).toBeNull();
    expect(await verifier.verify(await token({ email: undefined, email_verified: undefined }), nonce)).toEqual({ appleSub: "apple-user", email: null });
    expect(await new AppleIdTokenVerifier(["wrong"], createLocalJWKSet({ keys: [{ ...jwk, kid: "apple-test", alg: "RS256" }] }), () => now).verify(await token(), nonce)).toBeNull();
    const expired = new SignJWT({ sub: "apple-user", nonce }).setProtectedHeader({ alg: "RS256", kid: "apple-test" }).setIssuer("https://appleid.apple.com").setAudience("com.merochef.app").setIssuedAt(now / 1000 - 600).setExpirationTime(now / 1000 - 1);
    expect(await verifier.verify(await expired.sign(privateKey), nonce)).toBeNull();
    expect(await verifier.verify("invalid", nonce)).toBeNull();
  });
});

describe("Apple sign-in route", () => {
  it("preserves first-access details, rotates sessions and keeps Apple identities separate", async () => {
    const ctx = await accountsApp();
    let profile = { appleSub: "apple-1", email: "private@privaterelay.appleid.com" as string | null };
    ctx.runtime.appleTokens = { verify: async () => profile };
    const login = (name?: string) => ctx.app.inject({ method: "POST", url: "/v1/auth/apple", payload: { identityToken: "signed-token", nonce, name } });
    try {
      const first = await login("Ana");
      expect(first.statusCode).toBe(200);
      const session = first.json();
      profile = { appleSub: "apple-1", email: null };
      const again = await login();
      expect(again.statusCode).toBe(200);
      expect(again.json().user).toEqual(session.user);
      profile = { appleSub: "apple-2", email: "other@example.com" };
      expect((await login()).json().user.id).not.toBe(session.user.id);
      const refreshed = await ctx.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: session.refreshToken } });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json().refreshToken).not.toBe(session.refreshToken);
      profile = { appleSub: "new-missing-email", email: null };
      expect((await login()).statusCode).toBe(400);
      ctx.runtime.appleTokens = { verify: async () => null };
      expect((await login()).statusCode).toBe(401);
    } finally { await ctx.app.close(); }
  });
  it("rejects matching email across providers in either direction", async () => {
    const ctx = await accountsApp();
    try {
      await ctx.signIn("google@example.com");
      ctx.runtime.appleTokens = { verify: async () => ({ appleSub: "apple-1", email: "GOOGLE@example.com" }) };
      const conflict = await ctx.app.inject({ method: "POST", url: "/v1/auth/apple", payload: { identityToken: "signed-token", nonce } });
      expect(conflict.statusCode).toBe(409);
      ctx.runtime.appleTokens = { verify: async () => ({ appleSub: "apple-2", email: "apple@example.com" }) };
      expect((await ctx.app.inject({ method: "POST", url: "/v1/auth/apple", payload: { identityToken: "signed-token", nonce } })).statusCode).toBe(200);
      ctx.google.profiles.set("google-token", { googleSub: "google-new", email: "APPLE@example.com", name: "Other" });
      expect((await ctx.app.inject({ method: "POST", url: "/v1/auth/google", payload: { idToken: "google-token" } })).statusCode).toBe(409);
    } finally { await ctx.app.close(); }
  });
});
