import { afterEach, describe, expect, it } from "vitest";
import { PRODUCT_IDS } from "../src/billing/plans.js";
import { type AccountsApp, accountsApp } from "./accountsHelpers.js";
let t: AccountsApp;
afterEach(async () => { await t?.app.close(); });
describe("account mascot preference", () => {
  it("defaults off and persists across sign-ins independently of the subscription", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    const read = (headers = ana.headers) => t.app.inject({ method: "GET", url: "/v1/account/mascot", headers });
    expect((await read()).json()).toEqual({ mascotEnabled: false });
    const saved = await t.app.inject({ method: "PUT", url: "/v1/account/mascot", headers: ana.headers, payload: { mascotEnabled: true } });
    expect(saved.statusCode).toBe(200);
    expect((await t.stores.users.findById(ana.userId))?.mascotEnabled).toBe(true);
    const again = await t.signIn();
    expect((await read(again.headers)).json()).toEqual({ mascotEnabled: true });
    const ben = await t.signIn("ben@example.com", "phone-2");
    expect((await read(ben.headers)).json()).toEqual({ mascotEnabled: false });
    await t.app.inject({ method: "PUT", url: "/v1/account/mascot", headers: ana.headers, payload: { mascotEnabled: false } });
    expect((await read()).json()).toEqual({ mascotEnabled: false });
  });
  it("keeps the saved choice after expiry and a new Master purchase", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    await t.app.inject({ method: "PUT", url: "/v1/account/mascot", headers: ana.headers, payload: { mascotEnabled: true } });
    for (const [purchaseToken, state] of [["old-master", "ACTIVE"], ["old-master", "EXPIRED"], ["new-master", "ACTIVE"]] as const) {
      t.play.sell(purchaseToken, PRODUCT_IDS.MASTER, { state });
      const purchase = await t.app.inject({ method: "POST", url: "/v1/entitlements/verify-purchase", headers: ana.headers,
        payload: { productId: PRODUCT_IDS.MASTER, purchaseToken } });
      expect(purchase.statusCode).toBe(200);
      const preference = await t.app.inject({ method: "GET", url: "/v1/account/mascot", headers: ana.plain });
      expect(preference.json()).toEqual({ mascotEnabled: true });
    }
  });
  it("requires authentication and a boolean, and refuses extra account identifiers", async () => {
    t = await accountsApp();
    const ana = await t.signIn();
    expect((await t.app.inject({ method: "GET", url: "/v1/account/mascot" })).statusCode).toBe(401);
    for (const payload of [{}, { mascotEnabled: "true" }, { mascotEnabled: true, userId: "someone-else" }]) {
      expect((await t.app.inject({ method: "PUT", url: "/v1/account/mascot", headers: ana.headers, payload })).statusCode).toBe(400);
    }
  });
});
