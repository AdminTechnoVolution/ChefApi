import type { Collection } from "mongodb";

/** One Master owner and one member. Raw invitation codes are never stored. */
export interface Household {
  ownerId: string;
  memberId?: string;
  inviteHash?: string;
  inviteEmail?: string;
  inviteExpiresAt?: number;
}
export interface HouseholdStore {
  forOwner(ownerId: string): Promise<Household | null>;
  forMember(memberId: string): Promise<Household | null>;
  byInvite(hash: string): Promise<Household | null>;
  invite(ownerId: string, hash: string, email: string, expiresAt: number): Promise<boolean>;
  accept(ownerId: string, hash: string, memberId: string, now: number): Promise<boolean>;
  cancelInvite(ownerId: string): Promise<void>;
  removeMember(ownerId: string, memberId?: string): Promise<void>;
  deleteForUser(userId: string): Promise<void>;
}

export class MemoryHouseholds implements HouseholdStore {
  private readonly rows = new Map<string, Household>();
  async forOwner(id: string) { return this.rows.get(id) ?? null; }
  async forMember(id: string) { return [...this.rows.values()].find(x => x.memberId === id) ?? null; }
  async byInvite(hash: string) { return [...this.rows.values()].find(x => x.inviteHash === hash) ?? null; }
  async invite(ownerId: string, hash: string, email: string, expiresAt: number) {
    if (this.rows.get(ownerId)?.memberId) return false;
    this.rows.set(ownerId, { ownerId, inviteHash: hash, inviteEmail: email, inviteExpiresAt: expiresAt });
    return true;
  }
  async accept(ownerId: string, hash: string, memberId: string, now: number) {
    const row = this.rows.get(ownerId);
    if (!row || row.memberId || row.inviteHash !== hash || (row.inviteExpiresAt ?? 0) <= now ||
        [...this.rows.values()].some(x => x.memberId === memberId)) return false;
    this.rows.set(ownerId, { ownerId, memberId });
    return true;
  }
  async cancelInvite(ownerId: string) {
    const row = this.rows.get(ownerId);
    if (row) this.rows.set(ownerId, { ownerId, ...(row.memberId ? { memberId: row.memberId } : {}) });
  }
  async removeMember(ownerId: string, memberId?: string) {
    const row = this.rows.get(ownerId);
    if (row && (!memberId || row.memberId === memberId)) this.rows.set(ownerId, { ownerId });
  }
  async deleteForUser(id: string) {
    this.rows.delete(id);
    for (const row of this.rows.values()) if (row.memberId === id) this.rows.set(row.ownerId, { ownerId: row.ownerId });
  }
}

export class MongoHouseholds implements HouseholdStore {
  constructor(private readonly rows: Collection<Household>) {}
  async forOwner(ownerId: string) { return this.rows.findOne({ ownerId }); }
  async forMember(memberId: string) { return this.rows.findOne({ memberId }); }
  async byInvite(inviteHash: string) { return this.rows.findOne({ inviteHash }); }
  async invite(ownerId: string, hash: string, email: string, expiresAt: number) {
    try {
      const result = await this.rows.updateOne({ ownerId, memberId: { $exists: false } },
        { $set: { inviteHash: hash, inviteEmail: email, inviteExpiresAt: expiresAt }, $setOnInsert: { ownerId } }, { upsert: true });
      return result.matchedCount > 0 || result.upsertedCount > 0;
    } catch (error) { if ((error as { code?: number }).code === 11000) return false; throw error; }
  }
  async accept(ownerId: string, hash: string, memberId: string, now: number) {
    try {
      const result = await this.rows.updateOne({ ownerId, inviteHash: hash, inviteExpiresAt: { $gt: now }, memberId: { $exists: false } },
        { $set: { memberId }, $unset: { inviteHash: "", inviteEmail: "", inviteExpiresAt: "" } });
      return result.modifiedCount === 1;
    } catch (error) { if ((error as { code?: number }).code === 11000) return false; throw error; }
  }
  async cancelInvite(ownerId: string) {
    await this.rows.updateOne({ ownerId }, { $unset: { inviteHash: "", inviteEmail: "", inviteExpiresAt: "" } });
  }
  async removeMember(ownerId: string, memberId?: string) {
    await this.rows.updateOne({ ownerId, ...(memberId ? { memberId } : {}) }, { $unset: { memberId: "" } });
  }
  async deleteForUser(id: string) {
    await this.rows.deleteOne({ ownerId: id });
    await this.rows.updateMany({ memberId: id }, { $unset: { memberId: "" } });
  }
}
