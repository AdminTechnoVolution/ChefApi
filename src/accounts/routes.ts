import { canonicalAllergens } from "../allergens/catalog.js";
import { registerHouseholdRoutes } from "./households.js";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AccountIdentitiesSchema,
  AllergyPreferenceSchema,
  AppleLinkRequestSchema,
  EntitlementSchema,
  AppleSignInRequestSchema,
  GoogleSignInRequestSchema,
  LogoutRequestSchema,
  OkSchema,
  RefreshRequestSchema,
  SessionSchema,
  TokensSchema,
  VerifyAppleTransactionRequestSchema,
  VerifyPurchaseRequestSchema,
} from "../accountSchema.js";
import { CONFLICT_RESPONSE, ERROR_RESPONSES } from "../apiDocs.js";
import { monthlyUnits } from "../billing/plans.js";
import type { AppStoreBillingVerifier } from "../billing/appStoreBilling.js";
import type { Config } from "../config.js";
import { ApiError } from "../errors.js";
import type { AccountsRuntime } from "./runtime.js";

/** Sign-in, session renewal and the stores' notifications: the calls made before there is (or without) an access token. */
export async function registerPublicAccountRoutes(app: FastifyInstance, accounts: AccountsRuntime, config: Config): Promise<void> {
  // Signing in is the one call anybody can make, so it gets a tighter limit than the rest.
  const signInLimit = { rateLimit: { max: 10, timeWindow: config.RATE_LIMIT_WINDOW_MS } };

  app.withTypeProvider<ZodTypeProvider>().get("/webhooks/admob/rewarded", {
    config: { rateLimit: { max: 600, timeWindow: config.RATE_LIMIT_WINDOW_MS } },
    schema: {
      tags: ["billing"],
      summary: "AdMob rewarded-ad server-side verification callback",
      description: "Validates the unmodified AdMob SSV callback URL and atomically credits a previously reserved reward. AdMob retries when the server responds with an error.",
      response: { 200: z.object({ ok: z.literal(true), duplicate: z.boolean().optional() }), ...ERROR_RESPONSES },
    },
  }, async (request) => {
    const result = await accounts.rewardedAds.handleCallback(request.raw.url ?? "");
    return { ok: true as const, ...(result === "duplicate" ? { duplicate: true } : {}) };
  });

  app.withTypeProvider<ZodTypeProvider>().post("/v1/auth/apple", {
    config: signInLimit,
    schema: { tags: ["account"], summary: "Sign in with Apple", body: AppleSignInRequestSchema,
      response: { 200: SessionSchema, 400: ERROR_RESPONSES[400], 401: ERROR_RESPONSES[401], 409: CONFLICT_RESPONSE, 429: ERROR_RESPONSES[429] } },
  }, async request => {
    const profile = await accounts.appleTokens?.verify(request.body.identityToken, request.body.nonce);
    if (!profile) throw new ApiError("unauthorized", "Apple sign-in could not be verified.");
    const user = await accounts.stores.users.upsertByApple(profile, request.body.name ?? null, accounts.now());
    const tokens = await accounts.tokens.issue(user.id, request.body.deviceId ?? null);
    return { ...tokens, user: { id: user.id, email: user.email, name: user.name } };
  });

  app.withTypeProvider<ZodTypeProvider>().post(
    "/v1/auth/google",
    {
      config: signInLimit,
      schema: {
        tags: ["account"],
        summary: "Sign in with Google",
        description:
          "Trades the ID token Google gave the app for a Chef session. The first sign-in creates the account. Everything else in the API needs the access token this returns.",
        body: GoogleSignInRequestSchema,
        response: { 200: SessionSchema, 401: ERROR_RESPONSES[401], 409: CONFLICT_RESPONSE, 429: ERROR_RESPONSES[429] },
      },
    },
    async (request) => {
      const profile = await accounts.idTokens.verify(request.body.idToken);
      if (!profile) throw new ApiError("unauthorized", "Google sign-in could not be verified.");
      const user = await accounts.stores.users.upsertByGoogle(profile, accounts.now());
      const tokens = await accounts.tokens.issue(user.id, request.body.deviceId ?? null);
      return { ...tokens, user: { id: user.id, email: user.email, name: user.name } };
    },
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    "/v1/auth/refresh",
    {
      config: signInLimit,
      schema: {
        tags: ["account"],
        summary: "Renew the session",
        description: "Trades a refresh token for a new access token and a new refresh token. A refresh token works once: keep the new one.",
        body: RefreshRequestSchema,
        response: { 200: TokensSchema, 401: ERROR_RESPONSES[401], 429: ERROR_RESPONSES[429] },
      },
    },
    async (request) => {
      const renewed = await accounts.tokens.refresh(request.body.refreshToken);
      // The account may have been deleted since: a session for nobody must not come back to life.
      if (!renewed || !(await accounts.stores.users.findById(renewed.userId))) {
        if (renewed) await accounts.tokens.revokeAll(renewed.userId);
        throw new ApiError("unauthorized", "The session has expired. Sign in again.");
      }
      return { accessToken: renewed.accessToken, refreshToken: renewed.refreshToken, expiresInSeconds: renewed.expiresInSeconds };
    },
  );

  // Served only when Google's push can be verified; never open in production.
  if (accounts.pubsub || config.NODE_ENV !== "production") {
    registerRtdnWebhook(app, accounts, config);
  }
  // Apple signs its notifications itself, so this one needs nothing else to be safe to serve.
  if (accounts.appStore) registerAppStoreWebhook(app, accounts, config, accounts.appStore);
}

const AppStoreNotificationSchema = z.object({ signedPayload: z.string().min(100).max(65_536) });

function registerAppStoreWebhook(app: FastifyInstance, accounts: AccountsRuntime, config: Config, appStore: AppStoreBillingVerifier): void {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/webhooks/apple/app-store",
    {
      // Apple's push, not a person: its own limit, and no key or token of ours.
      config: { rateLimit: { max: 600, timeWindow: config.RATE_LIMIT_WINDOW_MS } },
      schema: {
        tags: ["billing"],
        summary: "App Store Server Notifications",
        description:
          "Where the App Store (server notifications, version 2) says a subscription renewed, was cancelled, refunded or ran out. Authenticated by Apple's signature on the payload, not by an app key. Redeliveries are recognised and ignored; a failure answers 5xx so Apple retries.",
        body: AppStoreNotificationSchema,
        response: { 200: z.object({ ok: z.literal(true), duplicate: z.boolean().optional(), ignored: z.boolean().optional(), test: z.boolean().optional() }), 401: ERROR_RESPONSES[401] },
      },
    },
    async (request) => {
      const notification = await appStore.notification(request.body.signedPayload);
      if (!notification) {
        request.log.warn({ event: "app_store_rejected", reason: "not_signed_by_apple" }, "App Store notification rejected");
        throw new ApiError("unauthorized", "Not from the App Store.");
      }
      const log = request.log.child({ notificationUUID: notification.uuid, notificationType: notification.type });
      if (notification.type === "TEST") {
        log.warn({ event: "app_store_test_received" }, "¡Conexión exitosa! Se recibió la notificación de prueba de App Store Connect.");
        return { ok: true as const, test: true };
      }
      if (!notification.subscription) {
        log.info({ event: "app_store_ignored", reason: "no_subscription" }, "App Store notification ignored");
        return { ok: true as const, ignored: true };
      }
      const seen = `apple:${notification.uuid}`;
      if (!(await accounts.stores.rtdn.firstSeen(seen, accounts.now()))) {
        log.info({ event: "app_store_duplicate" }, "App Store notification duplicate skipped");
        return { ok: true as const, duplicate: true };
      }
      try {
        const updated = await accounts.entitlements.applyAppleNotification(notification);
        log.info({ event: "app_store_processed", updated }, "App Store notification processed");
      } catch (error) {
        log.error({ event: "app_store_failed", code: error instanceof ApiError ? error.code : "internal_error", retryable: true }, "App Store notification processing failed; delivery can be retried");
        // Handling failed: let Apple's retry be handled instead of skipped as a duplicate.
        await accounts.stores.rtdn.forget(seen);
        throw error;
      }
      return { ok: true as const };
    },
  );
}

const DeveloperNotificationSchema = z.object({
  packageName: z.string().optional(),
  testNotification: z.object({ version: z.string().min(1) }).optional(),
  subscriptionNotification: z.object({ purchaseToken: z.string().min(1), notificationType: z.number().int().optional() }).optional(),
});

const PushEnvelopeSchema = z.object({
  message: z.object({ data: z.string().optional(), messageId: z.string().min(1) }),
});

function registerRtdnWebhook(app: FastifyInstance, accounts: AccountsRuntime, config: Config): void {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/webhooks/google-play/rtdn",
    {
      // Google's push, not a person: its own limit, and no key or token of ours.
      config: { rateLimit: { max: 600, timeWindow: config.RATE_LIMIT_WINDOW_MS } },
      onRequest: async (request) => {
        request.log.info({ event: "rtdn_received" }, "Google Play RTDN request received");
      },
      onResponse: async (request, reply) => {
        request.log.info({ event: "rtdn_response", statusCode: reply.statusCode, latencyMs: Math.round(reply.elapsedTime) }, "Google Play RTDN response sent");
      },
      schema: {
        tags: ["billing"],
        summary: "Google Play real-time notifications",
        description:
          "Where Google Play (through Pub/Sub push) says a subscription renewed, was cancelled or ran out. Authenticated by Google's OIDC token, not by an app key. Redeliveries are recognised and ignored; a failure answers 5xx so Pub/Sub retries.",
        body: PushEnvelopeSchema,
        response: { 200: z.object({ ok: z.literal(true), duplicate: z.boolean().optional(), ignored: z.boolean().optional(), test: z.boolean().optional() }), 401: ERROR_RESPONSES[401] },
      },
    },
    async (request) => {
      if (accounts.pubsub) {
        const verification = accounts.pubsub.verifyDetailed
          ? await accounts.pubsub.verifyDetailed(request.headers.authorization)
          : { valid: await accounts.pubsub.verify(request.headers.authorization), reason: "verification_failed" };
        if (!verification.valid) {
          request.log.warn({ event: "rtdn_rejected", reason: "invalid_auth", authReason: verification.reason }, "Google Play RTDN authentication rejected");
          throw new ApiError("unauthorized", "Not from Google Pub/Sub.");
        }
      }
      const { messageId, data } = request.body.message;
      const log = request.log.child({ messageId });

      let notification: z.infer<typeof DeveloperNotificationSchema> | null = null;
      try {
        notification = DeveloperNotificationSchema.parse(JSON.parse(Buffer.from(data ?? "", "base64").toString("utf8")));
      } catch {
        log.info({ event: "rtdn_ignored", reason: "invalid_notification" }, "Google Play RTDN notification ignored");
        // Invalid JSON or notification: answer 2xx so Google stops resending it.
        return { ok: true as const, ignored: true };
      }
      if (notification.packageName && notification.packageName !== config.GOOGLE_PLAY_PACKAGE_NAME) {
        log.info({ event: "rtdn_ignored", reason: "package_mismatch" }, "Google Play RTDN notification ignored");
        return { ok: true as const, ignored: true };
      }
      if (notification.testNotification) {
        log.warn({ event: "rtdn_test_received" }, "¡Conexión exitosa! Se recibió la notificación de prueba de Google Play Console.");
        return { ok: true as const, test: true };
      }
      const purchaseToken = notification.subscriptionNotification?.purchaseToken;
      if (!purchaseToken) {
        log.info({ event: "rtdn_ignored", reason: "not_subscription_notification" }, "Google Play RTDN notification ignored");
        return { ok: true as const, ignored: true };
      }

      if (!(await accounts.stores.rtdn.firstSeen(messageId, accounts.now()))) {
        log.info({ event: "rtdn_duplicate" }, "Google Play RTDN duplicate skipped");
        return { ok: true as const, duplicate: true };
      }
      try {
        const updated = await accounts.entitlements.refreshFromPlay(purchaseToken);
        log.info({ event: "rtdn_processed", notificationType: notification.subscriptionNotification?.notificationType, updated }, "Google Play RTDN notification processed");
      } catch (error) {
        log.error({ event: "rtdn_failed", code: error instanceof ApiError ? error.code : "internal_error", retryable: true }, "Google Play RTDN processing failed; delivery can be retried");
        // Handling failed: let Pub/Sub's retry be handled instead of skipped as a duplicate.
        await accounts.stores.rtdn.forget(messageId);
        throw error;
      }
      return { ok: true as const };
    },
  );
}

/** What needs a signed-in user: ending a session, deleting the account, and reading and settling the plan. Registered inside the authenticated scope. */
export function registerAuthedAccountRoutes(v1: FastifyInstance, accounts: AccountsRuntime, config: Config): void {
  registerHouseholdRoutes(v1, accounts, config);
  const route = v1.withTypeProvider<ZodTypeProvider>();
  const security = [{ bearer: [] }];

  route.post("/auth/link/apple", {
    config: { rateLimit: { max: 5, timeWindow: config.RATE_LIMIT_WINDOW_MS } },
    schema: {
      tags: ["account"],
      summary: "Link Apple sign-in to the current account",
      description:
        "Requires the signed-in account and a fresh Apple identity token. If that Apple ID already has an Apple-only Chef account, its App Store subscriptions, AI usage, rewarded-ad credits and allergen preferences are merged into this account. Accounts in a shared household or with another sign-in provider cannot be merged.",
      security,
      body: AppleLinkRequestSchema,
      response: { 200: OkSchema, 400: ERROR_RESPONSES[400], 401: ERROR_RESPONSES[401], 409: CONFLICT_RESPONSE, 429: ERROR_RESPONSES[429] },
    },
  }, async request => {
    const primaryUserId = requireUser(request.client?.userId);
    const profile = await accounts.appleTokens?.verify(request.body.identityToken, request.body.nonce);
    if (!profile) throw new ApiError("unauthorized", "Apple sign-in could not be verified.");
    const retiredUserId = await accounts.stores.appleAccountLinks.linkAppleAccount(
      primaryUserId,
      profile,
      request.body.name ?? null,
      monthlyUnits("FREE", config),
      accounts.now(),
    );
    if (retiredUserId) await accounts.tokens.revokeAll(retiredUserId);
    return { ok: true as const };
  });

  route.post(
    "/auth/logout",
    {
      schema: {
        tags: ["account"],
        summary: "End this device's session",
        description: "Ends this device's session: its refresh token and the access token of this call stop working at once. The user's other devices stay signed in.",
        security,
        body: LogoutRequestSchema,
        response: { 200: OkSchema, 401: ERROR_RESPONSES[401] },
      },
    },
    async (request) => {
      await accounts.tokens.logout(request.body.refreshToken, request.client?.access ? { userId: requireUser(request.client.userId), ...request.client.access } : undefined);
      return { ok: true as const };
    },
  );

  route.delete(
    "/account",
    {
      schema: {
        tags: ["account"],
        summary: "Delete the account",
        description:
          "Deletes the user and everything Chef holds about them (sessions, subscription records, usage), and signs every device out at once, access tokens included. It does not cancel a Google Play subscription: that is done in Play.",
        security,
        response: { 200: OkSchema, 401: ERROR_RESPONSES[401] },
      },
    },
    async (request) => {
      const userId = requireUser(request.client?.userId);
      // Every session and every access token of the user, gone before the data is.
      await accounts.tokens.revokeAll(userId);
      await accounts.stores.entitlements.deleteForUser(userId);
      await accounts.stores.usage.deleteForUser(userId);
      await accounts.stores.adRewards.deleteForUser(userId);
      await accounts.stores.households.deleteForUser(userId);
      await accounts.stores.users.deleteById(userId);
      return { ok: true as const };
    },
  );

  route.get("/account/allergies", {
    schema: { tags: ["account"], summary: "Read the user's selected food allergens", security,
      response: { 200: AllergyPreferenceSchema, 401: ERROR_RESPONSES[401] } },
  }, async (request) => {
    const user = await accounts.stores.users.findById(requireUser(request.client?.userId));
    if (!user) throw new ApiError("unauthorized", "Sign in to use this.");
    return { allergens: canonicalAllergens(user.allergens ?? []) };
  });

  route.get("/account/identities", {
    schema: {
      tags: ["account"],
      summary: "Read linked sign-in identities",
      security,
      response: { 200: AccountIdentitiesSchema, 401: ERROR_RESPONSES[401] },
    },
  }, async request => {
    const user = await accounts.stores.users.findById(requireUser(request.client?.userId));
    if (!user) throw new ApiError("unauthorized", "Sign in to use this.");
    return {
      apple: user.appleSub ? { email: user.appleEmail ?? null, name: user.appleName ?? null } : null,
    };
  });
  route.put("/account/allergies", {
    schema: { tags: ["account"], summary: "Save the user's selected food allergens", security,
      body: AllergyPreferenceSchema,
      response: { 200: AllergyPreferenceSchema, 400: ERROR_RESPONSES[400], 401: ERROR_RESPONSES[401] } },
  }, async (request) => {
    const saved = await accounts.stores.users.setAllergens(requireUser(request.client?.userId), request.body.allergens);
    if (!saved) throw new ApiError("unauthorized", "Sign in to use this.");
    return { allergens: canonicalAllergens(request.body.allergens) };
  });

  const MascotPreferenceSchema = z.object({ mascotEnabled: z.boolean() }).strict();
  route.get("/account/mascot", {
    schema: { tags: ["account"], summary: "Read the user's mascot preference", security,
      response: { 200: MascotPreferenceSchema, 401: ERROR_RESPONSES[401] } },
  }, async (request) => {
    const user = await accounts.stores.users.findById(requireUser(request.client?.userId));
    if (!user) throw new ApiError("unauthorized", "Sign in to use this.");
    return { mascotEnabled: user.mascotEnabled ?? false };
  });
  route.put("/account/mascot", {
    schema: { tags: ["account"], summary: "Save the user's mascot preference", security,
      body: MascotPreferenceSchema,
      response: { 200: MascotPreferenceSchema, 400: ERROR_RESPONSES[400], 401: ERROR_RESPONSES[401] } },
  }, async (request) => {
    const saved = await accounts.stores.users.setMascotEnabled(requireUser(request.client?.userId), request.body.mascotEnabled);
    if (!saved) throw new ApiError("unauthorized", "Sign in to use this.");
    return request.body;
  });

  route.get(
    "/entitlements/me",
    {
      // Account reads occur on opening sheets, returning to the app and after AI actions.
      // Keep their budget separate from the smaller global AI request budget.
      config: { rateLimit: { max: 60, timeWindow: config.RATE_LIMIT_WINDOW_MS } },
      schema: {
        tags: ["billing"],
        summary: "The signed-in user's plan",
        description: "The plan, what it includes, and how much of this month's AI allowance is spent. The app reads it to show padlocks and the plans screen.",
        security,
        response: { 200: EntitlementSchema, 401: ERROR_RESPONSES[401], 429: ERROR_RESPONSES[429] },
      },
    },
    async (request) => accounts.entitlements.describe(requireUser(request.client?.userId)),
  );

  const RewardedAdStatusSchema = z.object({
    eligible: z.boolean(), creditsPerAd: z.number().int(), completedToday: z.number().int(),
    availableToday: z.number().int(), reservationActive: z.boolean(), monthlyCredits: z.number().int(),
  });
  route.post("/ads/rewarded/reserve", {
    schema: {
      tags: ["billing"], summary: "Reserve a rewarded ad for 5 free AI credits", security,
      response: {
        200: z.object({ token: z.string(), expiresAtMillis: z.number(), status: RewardedAdStatusSchema }),
        401: ERROR_RESPONSES[401], 403: ERROR_RESPONSES[403], 409: CONFLICT_RESPONSE, 429: ERROR_RESPONSES[429],
      },
    },
  }, async (request) => accounts.rewardedAds.reserve(requireUser(request.client?.userId)));

  const CancelRewardedAdSchema = z.object({ token: z.string().min(32).max(128) }).strict();
  route.post("/ads/rewarded/cancel", {
    schema: {
      tags: ["billing"], summary: "Cancel an uncompleted rewarded-ad reservation", security, body: CancelRewardedAdSchema,
      response: { 200: RewardedAdStatusSchema, 401: ERROR_RESPONSES[401], 429: ERROR_RESPONSES[429] },
    },
  }, async (request) => accounts.rewardedAds.cancel(requireUser(request.client?.userId), request.body.token));

  route.post("/ads/rewarded/complete", {
    schema: {
      tags: ["billing"], summary: "Credit a rewarded ad completed in the mobile SDK", security,
      body: CancelRewardedAdSchema,
      response: { 200: EntitlementSchema, 401: ERROR_RESPONSES[401], 409: CONFLICT_RESPONSE, 429: ERROR_RESPONSES[429] },
    },
  }, async (request) => {
    const userId = requireUser(request.client?.userId);
    await accounts.rewardedAds.completeFromClient(userId, request.body.token);
    return accounts.entitlements.describe(userId);
  });

  route.post(
    "/entitlements/verify-purchase",
    {
      schema: {
        tags: ["billing"],
        summary: "Settle a Google Play purchase",
        description:
          "Call it after every purchase and on restore. The server asks Google Play about the purchase token, ties it to this account, and returns the new plan. A purchase made for another account is refused with `409`.",
        security,
        body: VerifyPurchaseRequestSchema,
        response: { 200: EntitlementSchema, 400: ERROR_RESPONSES[400], 401: ERROR_RESPONSES[401], 409: CONFLICT_RESPONSE, 502: ERROR_RESPONSES[502] },
      },
    },
    async (request) =>
      accounts.entitlements.verifyPurchase(requireUser(request.client?.userId), request.body.productId, request.body.purchaseToken),
  );

  route.post(
    "/entitlements/verify-apple-purchase",
    {
      schema: {
        tags: ["billing"],
        summary: "Settle an App Store purchase",
        description:
          "Call it after every purchase and on restore on iOS. The server checks Apple's signature on the StoreKit 2 transaction (and asks the App Store about it when it has an App Store Server API key), then assigns the verified subscription to the currently signed-in Mero Chef account. The Apple account token is retained as purchase metadata and does not block reassignment between Mero Chef accounts.",
        security,
        body: VerifyAppleTransactionRequestSchema,
        response: { 200: EntitlementSchema, 400: ERROR_RESPONSES[400], 401: ERROR_RESPONSES[401], 409: CONFLICT_RESPONSE, 502: ERROR_RESPONSES[502] },
      },
    },
    async (request) => accounts.entitlements.verifyAppleTransaction(requireUser(request.client?.userId), request.body.signedTransaction),
  );
}

function requireUser(userId: string | undefined): string {
  if (!userId) throw new ApiError("unauthorized", "Sign in to use this.");
  return userId;
}
