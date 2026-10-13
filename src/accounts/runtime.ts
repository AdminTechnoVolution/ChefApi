import { AppleIdTokenVerifier, type AppleTokenVerifier } from "../auth/appleIdToken.js";
import type { IdTokenVerifier } from "../auth/googleIdToken.js";
import type { PubSubAuth } from "../auth/pubsubAuth.js";
import { TokenService } from "../auth/tokenService.js";
import { AiGate } from "../billing/aiGate.js";
import type { AppStoreBillingVerifier } from "../billing/appStoreBilling.js";
import { EntitlementService } from "../billing/entitlements.js";
import type { PlayBillingVerifier } from "../billing/playBilling.js";
import type { Config } from "../config.js";
import type { AccountStores } from "./stores.js";
import type { TokenControl } from "./tokenControl.js";

/** Everything accounts and plans need, assembled once and handed to the app. */
export interface AccountsRuntime {
  stores: AccountStores;
  tokenControl: TokenControl;
  tokens: TokenService;
  idTokens: IdTokenVerifier;
  appleTokens?: AppleTokenVerifier;
  entitlements: EntitlementService;
  /** The App Store, as far as purchases and its notifications go. Null means they cannot be checked. */
  appStore: AppStoreBillingVerifier | null;
  gate: AiGate;
  /** Verifies Google Play's real-time notifications. Null means the webhook is not served. */
  pubsub: PubSubAuth | null;
  now: () => number;
}

export interface AccountsRuntimeOptions {
  config: Config;
  stores: AccountStores;
  /** Where revoked access tokens are remembered. Redis in production. */
  tokenControl: TokenControl;
  idTokens: IdTokenVerifier;
  appleTokens?: AppleTokenVerifier;
  playBilling: PlayBillingVerifier | null;
  appStoreBilling?: AppStoreBillingVerifier | null;
  pubsub: PubSubAuth | null;
  now?: () => number;
  warn?: (message: string) => void;
}

export function createAccountsRuntime(options: AccountsRuntimeOptions): AccountsRuntime {
  const { config, stores } = options;
  const now = options.now ?? Date.now;
  if (!config.JWT_SECRET) throw new Error("JWT_SECRET is required to run accounts");

  const appStore = options.appStoreBilling ?? null;
  const entitlements = new EntitlementService(stores, options.playBilling, config, now, appStore, options.warn);
  return {
    stores,
    tokenControl: options.tokenControl,
    tokens: new TokenService(
      { secret: config.JWT_SECRET, accessTtlSeconds: config.JWT_ACCESS_TTL_SECONDS, refreshTtlMillis: config.REFRESH_TTL_DAYS * 86_400_000 },
      stores.refreshTokens,
      options.tokenControl,
      now,
    ),
    idTokens: options.idTokens,
    appleTokens: options.appleTokens ?? new AppleIdTokenVerifier((config.APPLE_CLIENT_ID ?? "").split(",").map(id => id.trim()).filter(Boolean), undefined, now),
    entitlements,
    appStore,
    gate: new AiGate(entitlements, stores.usage, config, now),
    pubsub: options.pubsub,
    now,
  };
}
