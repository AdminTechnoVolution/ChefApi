import type { IncomingHttpHeaders } from "node:http";
import type { ClientVerifier, VerifiedClient } from "./clientVerifier.js";
import type { TokenService } from "./tokenService.js";

/**
 * Authenticates a call by the signed-in user's access token (`Authorization: Bearer ...`). The client is the user. A token that was
 * revoked (a logout, a deleted account, a leaked refresh token) is refused at once: the token service asks the token control.
 */
export class JwtVerifier implements ClientVerifier {
  constructor(private readonly tokens: TokenService) {}

  async verify(headers: IncomingHttpHeaders): Promise<VerifiedClient | null> {
    const header = headers.authorization;
    if (typeof header !== "string") return null;
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) return null;
    const claims = await this.tokens.verifyAccess(match[1]!);
    if (!claims) return null;
    return { clientId: claims.userId, userId: claims.userId, access: { tokenId: claims.tokenId, expiresAtMillis: claims.expiresAtMillis } };
  }
}
