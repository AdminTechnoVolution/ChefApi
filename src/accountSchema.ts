import { z } from "zod";
import { FEATURES, PLANS } from "./billing/plans.js";

/** Wire shapes of the account and subscription endpoints. Same role as `schema.ts`: they validate requests and describe responses. */

export const GoogleSignInRequestSchema = z.object({
  idToken: z.string().min(10).max(4096).describe("The ID token Google gave the app after the user signed in."),
  deviceId: z.string().min(1).max(64).optional().describe("A stable id of this installation, to tell a user's phones apart. Optional."),
});

export const SessionUserSchema = z.object({
  id: z.string().describe("The user's id in Chef."),
  email: z.string().describe("The Google account's email."),
  name: z.string().nullable().describe("The name Google has for the account, when it has one."),
});

export const TokensSchema = z.object({
  accessToken: z.string().describe("Send it as `Authorization: Bearer <accessToken>`. Short-lived."),
  refreshToken: z.string().describe("Trades itself for a new pair once, through `/v1/auth/refresh`. Long-lived; keep it private."),
  expiresInSeconds: z.number().int().describe("How long the access token stays valid."),
});

export const SessionSchema = TokensSchema.extend({ user: SessionUserSchema });

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(20).max(256).describe("The refresh token of the session being renewed."),
});

export const LogoutRequestSchema = z.object({
  refreshToken: z.string().min(20).max(256).describe("The refresh token of the session to end on this device."),
});

export const OkSchema = z.object({ ok: z.literal(true) });

export const EntitlementSchema = z.object({
  plan: z.enum(PLANS).describe("`FREE`, `JUNIOR` or `MASTER`."),
  active: z.boolean().describe("A subscription gives access now."),
  source: z.enum(["play", "dev", "none", "household"]).describe("Where the plan comes from: a Google Play subscription, local development, or nothing."),
  productId: z.string().nullable().describe("The Play subscription behind it."),
  expiresAtMillis: z.number().nullable().describe("When it runs out unless it renews, as epoch milliseconds."),
  autoRenewing: z.boolean().describe("Whether it renews by itself."),
  features: z.array(z.enum(FEATURES)).describe("What the plan includes. The app shows a padlock on everything else."),
  usage: z
    .object({
      unitsUsed: z.number().int().describe("Units of this month's AI allowance spent. A recipe is 1, a voice note 1, a photo 2, a video 5."),
      unitsLimit: z.number().int().describe("Units this plan allows a month."),
      resetsAtMillis: z.number().describe("When the allowance starts over, as epoch milliseconds."),
    })
    .describe("This month's AI allowance."),
  billingAccountId: z.string().describe("Give this to Google Play as the obfuscated account id when buying, so the purchase is tied to this account."),
});

export const VerifyPurchaseRequestSchema = z.object({
  productId: z.string().min(1).max(100).describe("`chef_junior_monthly` or `chef_master_monthly`."),
  purchaseToken: z.string().min(10).max(2048).describe("The token Google Play Billing returned for the purchase."),
});

export type Entitlement = z.infer<typeof EntitlementSchema>;
