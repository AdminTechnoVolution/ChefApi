import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  EntitlementSchema,
  GoogleSignInRequestSchema,
  LogoutRequestSchema,
  OkSchema,
  RefreshRequestSchema,
  SessionSchema,
  TokensSchema,
  VerifyPurchaseRequestSchema,
} from "../accountSchema.js";
import { CONFLICT_RESPONSE, ERROR_RESPONSES } from "../apiDocs.js";
import type { Config } from "../config.js";
import { ApiError } from "../errors.js";
import type { AccountsRuntime } from "./runtime.js";

/** Sign-in, session renewal and Google Play's notifications: the calls made before there is (or without) an access token. */
export async function registerPublicAccountRoutes(app: FastifyInstance, accounts: AccountsRuntime, config: Config): Promise<void> {
  // Signing in is the one call anybody can make, so it gets a tighter limit than the rest.
  const signInLimit = { rateLimit: { max: 10, timeWindow: config.RATE_LIMIT_WINDOW_MS } };

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
        response: { 200: SessionSchema, 401: ERROR_RESPONSES[401], 429: ERROR_RESPONSES[429] },
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
      if (accounts.pubsub && !(await accounts.pubsub.verify(request.headers.authorization))) {
        request.log.warn({ event: "rtdn_rejected", reason: "invalid_auth" }, "Google Play RTDN authentication rejected");
        throw new ApiError("unauthorized", "Not from Google Pub/Sub.");
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
export function registerAuthedAccountRoutes(v1: FastifyInstance, accounts: AccountsRuntime): void {
  const route = v1.withTypeProvider<ZodTypeProvider>();
  const security = [{ bearer: [] }];

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
      await accounts.stores.users.deleteById(userId);
      return { ok: true as const };
    },
  );

  route.get(
    "/entitlements/me",
    {
      schema: {
        tags: ["billing"],
        summary: "The signed-in user's plan",
        description: "The plan, what it includes, and how much of this month's AI allowance is spent. The app reads it to show padlocks and the plans screen.",
        security,
        response: { 200: EntitlementSchema, 401: ERROR_RESPONSES[401] },
      },
    },
    async (request) => accounts.entitlements.describe(requireUser(request.client?.userId)),
  );

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
}

function requireUser(userId: string | undefined): string {
  if (!userId) throw new ApiError("unauthorized", "Sign in to use this.");
  return userId;
}
