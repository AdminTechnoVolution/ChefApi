/**
 * Which access tokens must stop working before their time is up. An access token is checked without asking the database (it is a signed
 * JWT), so ending a session or deleting an account needs a place to say "that one, and everything of this user's up to now".
 * Redis in production (shared by every instance of the API); memory in tests and local runs.
 */
export interface TokenControl {
  /** The user's current epoch (0 until their tokens are first revoked). New access tokens carry it. */
  epochOf(userId: string): Promise<number>;
  /** Revokes every access token issued so far to this user, at once, by moving them to a new epoch. */
  revokeUser(userId: string): Promise<void>;
  /** Revokes one access token (a logout) until it would have expired anyway. */
  revokeAccessToken(tokenId: string, ttlMillis: number): Promise<void>;
  /** Whether a token is revoked: on its own, or because its epoch is older than the user's. */
  isRevoked(token: { userId: string; tokenId: string; epoch: number }): Promise<boolean>;
}

/** Process-local [TokenControl] for tests and a single local instance. It does not survive a restart or span instances. */
export class MemoryTokenControl implements TokenControl {
  private readonly epochs = new Map<string, number>();
  private readonly denied = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  async epochOf(userId: string): Promise<number> {
    return this.epochs.get(userId) ?? 0;
  }

  async revokeUser(userId: string): Promise<void> {
    this.epochs.set(userId, (this.epochs.get(userId) ?? 0) + 1);
  }

  async revokeAccessToken(tokenId: string, ttlMillis: number): Promise<void> {
    this.denied.set(tokenId, this.now() + ttlMillis);
  }

  async isRevoked(token: { userId: string; tokenId: string; epoch: number }): Promise<boolean> {
    const until = this.denied.get(token.tokenId);
    if (until !== undefined) {
      if (until > this.now()) return true;
      this.denied.delete(token.tokenId);
    }
    return token.epoch < (this.epochs.get(token.userId) ?? 0);
  }
}
