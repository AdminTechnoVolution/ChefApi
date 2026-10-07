import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from "jose";
import type { GoogleProfile } from "../accounts/stores.js";

/** Proves who is signing in. The real one asks Google; tests and local development use a stand-in. */
export interface IdTokenVerifier {
  /** The Google account behind an ID token, or null when the token is not valid for this app. */
  verify(idToken: string): Promise<GoogleProfile | null>;
}

const GOOGLE_CERTS = new URL("https://www.googleapis.com/oauth2/v3/certs");
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/** Checks a Google ID token's signature against Google's published keys, and that it was issued to this app. */
export class GoogleIdTokenVerifier implements IdTokenVerifier {
  /** [clientIds]: the OAuth client ids this app accepts tokens for. [keys]: Google's signing keys; tests pass their own. */
  constructor(
    private readonly clientIds: readonly string[],
    private readonly keys: JWTVerifyGetKey = createRemoteJWKSet(GOOGLE_CERTS),
    private readonly now: () => number = Date.now,
  ) {}

  async verify(idToken: string): Promise<GoogleProfile | null> {
    try {
      const { payload } = await jwtVerify(idToken, this.keys, {
        issuer: GOOGLE_ISSUERS,
        audience: [...this.clientIds],
        currentDate: new Date(this.now()),
      });
      if (typeof payload.sub !== "string" || typeof payload.email !== "string" || payload.email_verified !== true) return null;
      return { googleSub: payload.sub, email: payload.email, name: typeof payload.name === "string" ? payload.name : null };
    } catch {
      return null;
    }
  }
}

/**
 * Local development only: `dev:someone@example.com` signs in as that person, with no Google at all. Switched on by DEV_GOOGLE_AUTH, which the
 * configuration refuses in production.
 */
export class DevIdTokenVerifier implements IdTokenVerifier {
  async verify(idToken: string): Promise<GoogleProfile | null> {
    const match = /^dev:([^\s@]+@[^\s@]+)$/.exec(idToken);
    if (!match) return null;
    const email = match[1]!;
    return { googleSub: `dev-${email}`, email, name: email.split("@")[0] ?? null };
  }
}
