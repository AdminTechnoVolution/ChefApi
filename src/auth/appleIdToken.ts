import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AppleProfile } from "../accounts/stores.js";

export interface AppleTokenVerifier {
  verify(identityToken: string, nonce: string): Promise<AppleProfile | null>;
}

export class AppleIdTokenVerifier implements AppleTokenVerifier {
  constructor(private readonly audiences: readonly string[],
    private readonly keys: JWTVerifyGetKey = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys")),
    private readonly now: () => number = Date.now) {}

  async verify(identityToken: string, nonce: string): Promise<AppleProfile | null> {
    if (!this.audiences.length || !/^[a-f0-9]{64}$/.test(nonce)) return null;
    try {
      const { payload } = await jwtVerify(identityToken, this.keys, {
        issuer: "https://appleid.apple.com", audience: [...this.audiences], algorithms: ["RS256"],
        requiredClaims: ["exp", "iat", "sub", "nonce"], currentDate: new Date(this.now()),
      });
      if (!payload.sub || payload.nonce !== nonce) return null;
      if (payload.email !== undefined && (typeof payload.email !== "string" || ![true, "true"].includes(payload.email_verified as boolean | string))) return null;
      return { appleSub: payload.sub, email: typeof payload.email === "string" ? payload.email : null };
    } catch { return null; }
  }
}
