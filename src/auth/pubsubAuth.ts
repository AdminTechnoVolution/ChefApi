import { type JWTVerifyGetKey, createRemoteJWKSet, errors, jwtVerify } from "jose";

export type PubSubVerification =
  | { valid: true }
  | { valid: false; reason: "authorization_missing" | "authorization_invalid" | "audience_mismatch" | "issuer_mismatch" | "token_expired" | "email_unverified" | "service_account_mismatch" | "key_fetch_failed" | "invalid_token" | "verification_failed" };

/** Checks that a Pub/Sub push request really comes from Google (an OIDC token in the Authorization header). */
export interface PubSubAuth {
  verify(authorization: string | undefined): Promise<boolean>;
  verifyDetailed?(authorization: string | undefined): Promise<PubSubVerification>;
}

const GOOGLE_CERTS = new URL("https://www.googleapis.com/oauth2/v3/certs");
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export class GooglePubSubAuth implements PubSubAuth {
  /**
   * [audience]: the push endpoint's URL; [serviceAccountEmail]: the account the push subscription signs as, when it should be pinned;
   * [keys]: Google's signing keys, which tests replace with their own.
   */
  constructor(
    private readonly audience: string,
    private readonly serviceAccountEmail?: string,
    private readonly keys: JWTVerifyGetKey = createRemoteJWKSet(GOOGLE_CERTS),
    private readonly now: () => number = Date.now,
  ) {}

  async verify(authorization: string | undefined): Promise<boolean> {
    return (await this.verifyDetailed(authorization)).valid;
  }

  async verifyDetailed(authorization: string | undefined): Promise<PubSubVerification> {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
    if (!match) return { valid: false, reason: authorization ? "authorization_invalid" : "authorization_missing" };
    try {
      const { payload } = await jwtVerify(match[1]!, this.keys, {
        issuer: GOOGLE_ISSUERS,
        audience: this.audience,
        currentDate: new Date(this.now()),
      });
      if (payload.email_verified !== true) return { valid: false, reason: "email_unverified" };
      if (this.serviceAccountEmail !== undefined && payload.email !== this.serviceAccountEmail) {
        return { valid: false, reason: "service_account_mismatch" };
      }
      return { valid: true };
    } catch (error) {
      if (error instanceof errors.JWTExpired) return { valid: false, reason: "token_expired" };
      if (error instanceof errors.JWTClaimValidationFailed) {
        if (error.claim === "aud") return { valid: false, reason: "audience_mismatch" };
        if (error.claim === "iss") return { valid: false, reason: "issuer_mismatch" };
      }
      if (error instanceof errors.JWKSTimeout || !(error instanceof errors.JOSEError)) {
        return { valid: false, reason: "key_fetch_failed" };
      }
      return { valid: false, reason: "invalid_token" };
    }
  }
}
