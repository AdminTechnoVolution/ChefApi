import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { RefreshTokenStore } from "../accounts/stores.js";
import type { TokenControl } from "../accounts/tokenControl.js";

export const ACCESS_ISSUER = "chef-api";
export const ACCESS_AUDIENCE = "chef-app";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Seconds the access token stays valid. */
  expiresInSeconds: number;
}

/** What a valid access token says. */
export interface AccessClaims {
  userId: string;
  /** Identifies this one token, so it can be revoked on its own. */
  tokenId: string;
  expiresAtMillis: number;
}

export interface TokenServiceOptions {
  /** At least 32 characters; signs the access tokens. */
  secret: string;
  accessTtlSeconds: number;
  refreshTtlMillis: number;
}

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * The session a signed-in app carries: a short-lived access token (a signed JWT) and a long-lived, single-use refresh token (random,
 * stored only as a hash) that swaps itself for a new pair.
 *
 * Both are under control, and the control lives in Redis so that every instance of the API sees it at once:
 * - A refresh token works once. Presenting one that was already used means a copy leaked, so every session of that user is ended.
 * - Logging out revokes that device's access token immediately; deleting the account (or a leak) revokes all of a user's, by moving
 *   them to a new epoch, without waiting for the tokens to run out.
 */
export class TokenService {
  private readonly key: Uint8Array;

  constructor(
    private readonly options: TokenServiceOptions,
    private readonly refreshTokens: RefreshTokenStore,
    private readonly control: TokenControl,
    private readonly now: () => number = Date.now,
  ) {
    this.key = new TextEncoder().encode(options.secret);
  }

  /** A new session for [userId]. */
  async issue(userId: string, deviceId: string | null = null): Promise<TokenPair> {
    const issuedAt = Math.floor(this.now() / 1000);
    const accessToken = await new SignJWT({ typ: "access", epoch: await this.control.epochOf(userId) })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setJti(randomUUID())
      .setIssuer(ACCESS_ISSUER)
      .setAudience(ACCESS_AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + this.options.accessTtlSeconds)
      .sign(this.key);

    const refreshToken = randomBytes(48).toString("base64url");
    await this.refreshTokens.save({
      tokenHash: hashToken(refreshToken),
      userId,
      expiresAtMillis: this.now() + this.options.refreshTtlMillis,
      deviceId,
    });
    return { accessToken, refreshToken, expiresInSeconds: this.options.accessTtlSeconds };
  }

  /** What an access token says, or null when it is not ours, is the wrong kind, has expired or has been revoked. */
  async verifyAccess(token: string): Promise<AccessClaims | null> {
    let claims: AccessClaims;
    let epoch: number;
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ["HS256"],
        issuer: ACCESS_ISSUER,
        audience: ACCESS_AUDIENCE,
        currentDate: new Date(this.now()),
      });
      if (payload.typ !== "access" || typeof payload.sub !== "string" || payload.sub.length === 0) return null;
      if (typeof payload.jti !== "string" || typeof payload.epoch !== "number" || typeof payload.exp !== "number") return null;
      claims = { userId: payload.sub, tokenId: payload.jti, expiresAtMillis: payload.exp * 1000 };
      epoch = payload.epoch;
    } catch {
      return null;
    }
    return (await this.control.isRevoked({ userId: claims.userId, tokenId: claims.tokenId, epoch })) ? null : claims;
  }

  /** Trades a refresh token for a new session, once. Null when it is unknown, was already used, or has expired. */
  async refresh(refreshToken: string): Promise<(TokenPair & { userId: string }) | null> {
    const hash = hashToken(refreshToken);
    const record = await this.refreshTokens.consume(hash);
    if (!record) {
      // A token that was used and comes back is a leaked copy (or a stolen one): end every session of its owner.
      const owner = await this.refreshTokens.usedBy(hash);
      if (owner) await this.revokeAll(owner);
      return null;
    }
    if (record.expiresAtMillis <= this.now()) return null;
    return { ...(await this.issue(record.userId, record.deviceId)), userId: record.userId };
  }

  /** Ends one device's session: its refresh token, and the access token it is using right now. The user's other devices stay signed in. */
  async logout(refreshToken: string, access?: AccessClaims): Promise<void> {
    await this.refreshTokens.revoke(hashToken(refreshToken));
    if (access) await this.control.revokeAccessToken(access.tokenId, Math.max(1_000, access.expiresAtMillis - this.now()));
  }

  /** Ends every session of a user at once: their refresh tokens, and every access token issued so far. */
  async revokeAll(userId: string): Promise<void> {
    await this.refreshTokens.revokeAllForUser(userId);
    await this.control.revokeUser(userId);
  }
}
