import { afterEach, describe, expect, it } from "vitest";
import { accountsApp, type AccountsApp, type SignedIn } from "./accountsHelpers.js";
import { PRODUCT_IDS, monthKey } from "../src/billing/plans.js";
let t: AccountsApp;
afterEach(async () => { await t?.app.close(); });
const call = (user: SignedIn, method: "GET" | "POST" | "DELETE", path: string, payload?: unknown) => t.app.inject({
  method, url: `/v1/${path}`, headers: payload ? user.headers : user.plain, ...(payload ? { payload } : {}),
});
async function setup() {
  t = await accountsApp();
  const owner = await t.signIn("owner@example.com");
  const guest = await t.signIn("guest@example.com", "guest-phone");
  t.play.sell("master-purchase", PRODUCT_IDS.MASTER);
  expect((await call(owner, "POST", "entitlements/verify-purchase", { productId: PRODUCT_IDS.MASTER, purchaseToken: "master-purchase" })).statusCode).toBe(200);
  return { owner, guest };
}
const invite = async (owner: SignedIn, email = "guest@example.com") => {
  const result = await call(owner, "POST", "household/invite", { email });
  expect(result.statusCode).toBe(200);
  return result.json().code as string;
};
describe("shared Master", () => {
  it("invites and accepts one account with independent quotas and no subscription ownership", async () => {
    const { owner, guest } = await setup();
    const code = await invite(owner);
    expect(code).toMatch(/^[A-F0-9]{16}$/);
    expect((await call(guest, "POST", "household/accept", { code })).json()).toMatchObject({ role: "member", active: true, owner: { email: "owner@example.com" }, unitsPerPerson: 400 });
    const entitlement = (await call(guest, "GET", "entitlements/me")).json();
    expect(entitlement).toMatchObject({ plan: "MASTER", source: "household", productId: null, autoRenewing: false, usage: { unitsLimit: 400 } });
    expect(entitlement.features).toContain("assistant");
    expect(entitlement.features).not.toContain("household");
    const charge = await t.runtime.gate.authorize({ userId: guest.userId, clientId: guest.userId }, "recipes");
    await t.runtime.gate.record(charge!);
    expect((await call(guest, "GET", "entitlements/me")).json().usage.unitsUsed).toBe(1);
    expect((await call(owner, "GET", "entitlements/me")).json().usage.unitsUsed).toBe(0);
    expect((await call(guest, "POST", "household/invite", { email: "third@example.com" })).statusCode).toBe(403);
  });
  it("binds a single-use invitation to the recipient email and invalidates old codes", async () => {
    const { owner, guest } = await setup();
    const other = await t.signIn("other@example.com", "other-phone");
    const old = await invite(owner);
    expect((await call(other, "POST", "household/accept", { code: old })).statusCode).toBe(400);
    const code = await invite(owner);
    expect((await call(guest, "POST", "household/accept", { code: old })).statusCode).toBe(404);
    expect((await call(guest, "POST", "household/accept", { code: code.toLowerCase() })).statusCode).toBe(200);
    expect((await call(guest, "POST", "household/accept", { code })).statusCode).toBe(404);
    expect((await call(owner, "POST", "household/invite", { email: "other@example.com" })).statusCode).toBe(409);
  });
  it("suspends shared access on expiry and restores it on renewal without erasing the group", async () => {
    const { owner, guest } = await setup();
    await call(guest, "POST", "household/accept", { code: await invite(owner) });
    t.play.sell("master-purchase", PRODUCT_IDS.MASTER, { state: "EXPIRED" });
    await t.runtime.entitlements.refreshFromPlay("master-purchase");
    expect((await call(guest, "GET", "entitlements/me")).json().plan).toBe("FREE");
    expect((await call(guest, "GET", "household")).json()).toMatchObject({ role: "member", active: false });
    t.play.sell("master-purchase", PRODUCT_IDS.MASTER);
    await t.runtime.entitlements.refreshFromPlay("master-purchase");
    expect((await call(guest, "GET", "entitlements/me")).json().plan).toBe("MASTER");
  });
  it("supports owner removal and guest leaving without resetting usage", async () => {
    const { owner, guest } = await setup();
    await call(guest, "POST", "household/accept", { code: await invite(owner) });
    await t.stores.usage.add(guest.userId, monthKey(t.runtime.now()), 20);
    await call(owner, "DELETE", "household/member");
    expect((await call(guest, "GET", "entitlements/me")).json().plan).toBe("FREE");
    await call(guest, "POST", "household/accept", { code: await invite(owner) });
    expect((await call(guest, "GET", "entitlements/me")).json().usage.unitsUsed).toBe(20);
    await call(guest, "POST", "household/leave");
    expect((await call(guest, "GET", "household")).json().role).toBe("none");
    expect((await call(owner, "GET", "household")).json().member).toBeNull();
  });
  it("expires codes, rejects self invites and requires active direct Master", async () => {
    const { owner, guest } = await setup();
    expect((await call(guest, "POST", "household/invite", { email: "other@example.com" })).statusCode).toBe(403);
    expect((await call(owner, "POST", "household/invite", { email: "owner@example.com" })).statusCode).toBe(400);
    const code = await invite(owner);
    const group = await t.stores.households.forOwner(owner.userId);
    await t.stores.households.invite(owner.userId, group!.inviteHash!, "guest@example.com", t.runtime.now() - 1);
    expect((await call(guest, "POST", "household/accept", { code })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "GET", url: "/v1/household" })).statusCode).toBe(401);
  });
  it("rejects overlapping paid subscriptions and only lets the owner cancel or remove", async () => {
    const { owner, guest } = await setup();
    const code = await invite(owner);
    t.play.sell("guest-purchase", PRODUCT_IDS.JUNIOR);
    await call(guest, "POST", "entitlements/verify-purchase", { productId: PRODUCT_IDS.JUNIOR, purchaseToken: "guest-purchase" });
    expect((await call(guest, "POST", "household/accept", { code })).statusCode).toBe(409);
    await call(guest, "DELETE", "household/invitation");
    expect((await call(owner, "GET", "household")).json().invitation).not.toBeNull();
    t.play.sell("guest-purchase", PRODUCT_IDS.JUNIOR, { state: "EXPIRED" });
    await t.runtime.entitlements.refreshFromPlay("guest-purchase");
    expect((await call(guest, "POST", "household/accept", { code })).statusCode).toBe(200);
    await call(guest, "DELETE", "household/member");
    expect((await call(owner, "GET", "household")).json().member.email).toBe("guest@example.com");
    await call(owner, "POST", "household/leave");
    expect((await call(guest, "GET", "entitlements/me")).json().plan).toBe("FREE");
  });
  it("a member reaching the monthly cap does not spend or block the owner's quota", async () => {
    const { owner, guest } = await setup();
    await call(guest, "POST", "household/accept", { code: await invite(owner) });
    await t.stores.usage.add(guest.userId, monthKey(t.runtime.now()), 400);
    await expect(t.runtime.gate.authorize({ userId: guest.userId, clientId: guest.userId }, "recipes")).rejects.toThrow();
    expect(await t.runtime.gate.authorize({ userId: owner.userId, clientId: owner.userId }, "recipes")).toBeTruthy();
    expect((await call(owner, "GET", "entitlements/me")).json().usage.unitsUsed).toBe(0);
  });
  it("deleting either account cleans up shared access", async () => {
    const { owner, guest } = await setup();
    await call(guest, "POST", "household/accept", { code: await invite(owner) });
    await call(owner, "DELETE", "account");
    expect(await t.stores.households.forMember(guest.userId)).toBeNull();
    expect((await call(guest, "GET", "entitlements/me")).json().plan).toBe("FREE");
  });
});
