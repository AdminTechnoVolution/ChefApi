import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { errorResponse } from "../schema.js";
import { CONFLICT_RESPONSE, ERROR_RESPONSES } from "../apiDocs.js";
import type { AccountsRuntime } from "./runtime.js";
import { monthlyUnits } from "../billing/plans.js";
import type { Config } from "../config.js";

const PersonSchema = z.object({ email: z.string(), name: z.string().nullable() });
const StatusSchema = z.object({
  role: z.enum(["none", "owner", "member"]), active: z.boolean(), canInvite: z.boolean(),
  owner: PersonSchema.nullable(), member: PersonSchema.nullable(),
  invitation: z.object({ email: z.string(), expiresAtMillis: z.number() }).nullable(),
  unitsPerPerson: z.number(),
});
const InviteSchema = z.object({ email: z.email().max(254).transform(x => x.trim().toLowerCase()) }).strict();
const AcceptSchema = z.object({ code: z.string().trim().transform(x => x.toUpperCase()).pipe(z.string().regex(/^[A-F0-9]{16}$/)) }).strict();
const hash = (code: string) => createHash("sha256").update(code).digest("hex");

export function registerHouseholdRoutes(v1: FastifyInstance, accounts: AccountsRuntime, config: Config): void {
  const route = v1.withTypeProvider<ZodTypeProvider>();
  const errors = { 400: ERROR_RESPONSES[400], 401: ERROR_RESPONSES[401], 403: ERROR_RESPONSES[403], 404: errorResponse("Invitation not found", { code: "not_found", message: "The invitation is invalid or expired." }), 409: CONFLICT_RESPONSE };
  const security = [{ bearer: [] }];
  const user = async (id: string | undefined) => {
    const found = id && await accounts.stores.users.findById(id);
    if (!found) throw new ApiError("unauthorized", "Sign in to use this.");
    return found;
  };
  const requireOwnerMaster = async (id: string) => {
    if ((await accounts.entitlements.ownPlan(id)).plan !== "MASTER") {
      throw new ApiError("plan_required", "An active Master subscription is required to share.", { details: { feature: "household", requiredPlan: "MASTER" } });
    }
    if (await accounts.stores.households.forMember(id)) throw new ApiError("conflict", "Leave your shared plan before creating a group.");
  };
  const status = async (id: string) => {
    const direct = await accounts.entitlements.ownPlan(id);
    const membership = await accounts.stores.households.forMember(id);
    const group = membership ?? await accounts.stores.households.forOwner(id);
    const role = membership ? "member" as const : group || direct.plan === "MASTER" ? "owner" as const : "none" as const;
    const ownerId = membership?.ownerId ?? id;
    const owner = role !== "none" ? await accounts.stores.users.findById(ownerId) : null;
    const member = group?.memberId ? await accounts.stores.users.findById(group.memberId) : null;
    const active = !!owner && (await accounts.entitlements.ownPlan(ownerId)).plan === "MASTER";
    return {
      role, active, canInvite: role === "owner" && active && !member,
      owner: owner ? { email: owner.email, name: owner.name } : null,
      member: member ? { email: member.email, name: member.name } : null,
      invitation: group?.inviteEmail && (group.inviteExpiresAt ?? 0) > accounts.now()
        ? { email: group.inviteEmail, expiresAtMillis: group.inviteExpiresAt! } : null,
      unitsPerPerson: monthlyUnits("MASTER", config),
    };
  };
  route.get("/household", { schema: { tags: ["account"], summary: "Shared Master status", security, response: { 200: StatusSchema, ...errors } } },
    async request => status((await user(request.client?.userId)).id));

  route.post("/household/invite", { config: { rateLimit: { max: 5, timeWindow: 60_000 } }, schema: {
    tags: ["account"], summary: "Invite one account to share Master", security, body: InviteSchema,
    response: { 200: z.object({ code: z.string(), expiresAtMillis: z.number(), household: StatusSchema }), ...errors },
  } }, async request => {
    const owner = await user(request.client?.userId);
    await requireOwnerMaster(owner.id);
    if (owner.email.toLowerCase() === request.body.email) throw new ApiError("invalid_request", "Invite a different account.");
    const code = randomBytes(8).toString("hex").toUpperCase();
    const expiresAtMillis = accounts.now() + 48 * 60 * 60 * 1000;
    if (!await accounts.stores.households.invite(owner.id, hash(code), request.body.email, expiresAtMillis)) throw new ApiError("conflict", "The shared place is already occupied.");
    return { code, expiresAtMillis, household: await status(owner.id) };
  });
  route.post("/household/accept", { config: { rateLimit: { max: 5, timeWindow: 60_000 } }, schema: {
    tags: ["account"], summary: "Accept an email-bound invitation", security, body: AcceptSchema,
    response: { 200: StatusSchema, ...errors },
  } }, async request => {
    const recipient = await user(request.client?.userId);
    const group = await accounts.stores.households.byInvite(hash(request.body.code));
    if (!group || (group.inviteExpiresAt ?? 0) <= accounts.now()) throw new ApiError("not_found", "The invitation is invalid or expired.");
    if (group.ownerId === recipient.id || group.inviteEmail !== recipient.email.toLowerCase()) throw new ApiError("invalid_request", "Sign in with the Google email named in the invitation.");
    if (await accounts.stores.households.forMember(recipient.id) || await accounts.stores.households.forOwner(recipient.id)) throw new ApiError("conflict", "Leave your existing group first.");
    if ((await accounts.entitlements.ownPlan(recipient.id)).plan !== "FREE") throw new ApiError("conflict", "This account already has its own paid plan.");
    await requireOwnerMaster(group.ownerId);
    if (!await accounts.stores.users.findById(group.ownerId)) throw new ApiError("not_found", "The owner account is no longer available.");
    if (!await accounts.stores.households.accept(group.ownerId, hash(request.body.code), recipient.id, accounts.now())) throw new ApiError("conflict", "The invitation is no longer available.");
    return status(recipient.id);
  });
  route.delete("/household/invitation", { schema: { tags: ["account"], summary: "Cancel the pending invitation", security, response: { 200: StatusSchema, ...errors } } }, async request => {
    const owner = await user(request.client?.userId);
    await accounts.stores.households.cancelInvite(owner.id);
    return status(owner.id);
  });
  route.delete("/household/member", { schema: { tags: ["account"], summary: "Remove the invited member", security, response: { 200: StatusSchema, ...errors } } }, async request => {
    const owner = await user(request.client?.userId);
    await accounts.stores.households.removeMember(owner.id);
    return status(owner.id);
  });
  route.post("/household/leave", { schema: { tags: ["account"], summary: "Leave or dissolve the shared group", security, response: { 200: StatusSchema, ...errors } } }, async request => {
    const person = await user(request.client?.userId);
    await accounts.stores.households.deleteForUser(person.id);
    return status(person.id);
  });
}
