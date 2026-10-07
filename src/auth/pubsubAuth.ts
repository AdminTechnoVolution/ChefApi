import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from "jose";

/** Checks that a Pub/Sub push request really comes from Google (an OIDC token in the Authorization header). */
export interface PubSubAuth {
  verify(authorization: string | undefined): Promise<boolean>;
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
    const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
    if (!match) return false;
    try {
      const { payload } = await jwtVerify(match[1]!, this.keys, {
        issuer: GOOGLE_ISSUERS,
        audience: this.audience,
        currentDate: new Date(this.now()),
      });
      if (payload.email_verified !== true) return false;
      return this.serviceAccountEmail === undefined || payload.email === this.serviceAccountEmail;
    } catch {
      return false;
    }
  }
}
