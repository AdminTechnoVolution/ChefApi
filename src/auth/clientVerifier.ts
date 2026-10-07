import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

declare module "fastify" {
  interface FastifyRequest {
    /** Who is calling, set once the request has passed authentication. */
    client?: VerifiedClient;
  }
}

export interface VerifiedClient {
  /** Stable identifier usable as a rate-limit key. */
  clientId: string;
  /** Who is signed in. Only present when accounts are on (`AUTH_MODE=jwt`); the shared-key mode has no users. */
  userId?: string;
  /** The access token this call came with, so a logout can revoke exactly it. */
  access?: { tokenId: string; expiresAtMillis: number };
}

/**
 * Decides whether a request comes from the genuine Chef app. Routes depend only on this interface,
 * so swapping the MVP shared key for Firebase App Check (Phase 9) needs no route changes.
 */
export interface ClientVerifier {
  verify(headers: IncomingHttpHeaders): Promise<VerifiedClient | null>;
}

export const APP_KEY_HEADER = "x-chef-app-key";

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();

/**
 * Shared-secret check. The key ships inside the APK, so this is a speed bump against casual abuse,
 * not real authentication. Both sides are hashed to equal length so the constant-time compare is valid.
 */
export class AppKeyVerifier implements ClientVerifier {
  private readonly expected: Buffer;

  constructor(appKey: string) {
    this.expected = sha256(appKey);
  }

  async verify(headers: IncomingHttpHeaders): Promise<VerifiedClient | null> {
    const provided = headers[APP_KEY_HEADER];
    if (typeof provided !== "string" || provided.length === 0) return null;
    return timingSafeEqual(sha256(provided), this.expected) ? { clientId: "shared-app-key" } : null;
  }
}
