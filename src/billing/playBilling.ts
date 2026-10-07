import { readFileSync } from "node:fs";
import { SignJWT, importPKCS8 } from "jose";
import { ApiError } from "../errors.js";
import type { SubscriptionState } from "../accounts/stores.js";

/** What Google Play knows about one subscription purchase. */
export interface PlaySubscription {
  productId: string;
  state: SubscriptionState;
  expiresAtMillis: number;
  autoRenewing: boolean;
  /** The account id the app gave Play when buying; ties the purchase to one Chef account. */
  obfuscatedAccountId: string | null;
}

export interface PlayBillingVerifier {
  /** The purchase as Play reports it, or null when Play does not know the token. Rejects with an ApiError when Play cannot be reached. */
  fetch(purchaseToken: string): Promise<PlaySubscription | null>;
}

/** Play's `SUBSCRIPTION_STATE_*` names, as ours. */
export function stateFromPlay(state: unknown): SubscriptionState {
  switch (state) {
    case "SUBSCRIPTION_STATE_ACTIVE":
      return "ACTIVE";
    case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD":
      return "IN_GRACE_PERIOD";
    case "SUBSCRIPTION_STATE_CANCELED":
      return "CANCELED";
    case "SUBSCRIPTION_STATE_ON_HOLD":
      return "ON_HOLD";
    case "SUBSCRIPTION_STATE_PAUSED":
      return "PAUSED";
    case "SUBSCRIPTION_STATE_EXPIRED":
      return "EXPIRED";
    case "SUBSCRIPTION_STATE_PENDING":
    case "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED":
      return "PENDING";
    default:
      return "UNKNOWN";
  }
}

/** Reads the answer of `purchases.subscriptionsv2.get`. Null when it holds nothing we can use. */
export function parsePlaySubscription(body: unknown): PlaySubscription | null {
  if (typeof body !== "object" || body === null) return null;
  const json = body as {
    subscriptionState?: unknown;
    lineItems?: Array<{ productId?: unknown; expiryTime?: unknown; autoRenewingPlan?: unknown }>;
    externalAccountIdentifiers?: { obfuscatedExternalAccountId?: unknown };
  };
  // A purchase can carry several line items (an upgrade, an add-on): the one that lasts longest is what the person has.
  const items = (json.lineItems ?? [])
    .filter((item) => typeof item.productId === "string" && typeof item.expiryTime === "string" && !Number.isNaN(Date.parse(item.expiryTime)))
    .map((item) => ({ productId: item.productId as string, expiresAtMillis: Date.parse(item.expiryTime as string), autoRenewing: item.autoRenewingPlan != null }))
    .sort((a, b) => b.expiresAtMillis - a.expiresAtMillis);
  const best = items[0];
  if (!best) return null;
  const account = json.externalAccountIdentifiers?.obfuscatedExternalAccountId;
  return {
    productId: best.productId,
    state: stateFromPlay(json.subscriptionState),
    expiresAtMillis: best.expiresAtMillis,
    autoRenewing: best.autoRenewing,
    obfuscatedAccountId: typeof account === "string" && account.length > 0 ? account : null,
  };
}

export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

/** The Play service account, from a file path or from Base64 (how an App Service setting holds it). Undefined when none is configured. */
export function loadServiceAccount(options: { path?: string; base64?: string }): ServiceAccount | undefined {
  const raw = options.base64 ? Buffer.from(options.base64, "base64").toString("utf8") : options.path ? readFileSync(options.path, "utf8") : undefined;
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
  if (!parsed.client_email || !parsed.private_key) throw new Error("The Google Play service account is missing client_email or private_key");
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

/** Asks the Google Play Developer API, authenticated as the service account. The only place that talks to Play. */
export class GooglePlayBilling implements PlayBillingVerifier {
  private cached: { token: string; expiresAtMillis: number } | null = null;

  constructor(
    private readonly account: ServiceAccount,
    private readonly packageName: string,
    private readonly http: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async fetch(purchaseToken: string): Promise<PlaySubscription | null> {
    const response = await this.http(`${API}/${encodeURIComponent(this.packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`, {
      headers: { authorization: `Bearer ${await this.accessToken()}` },
    }).catch((cause: unknown) => {
      throw new ApiError("upstream_error", "Google Play could not be reached.", { cause });
    });
    // Play answers 400 for a token that is malformed and 404/410 for one it does not know or has forgotten.
    if (response.status === 400 || response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new ApiError("upstream_error", "Google Play could not verify the purchase.", { cause: new Error(`Play answered ${response.status}`) });
    return parsePlaySubscription(await response.json());
  }

  private async accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAtMillis - 60_000 > this.now()) return this.cached.token;
    const issuedAt = Math.floor(this.now() / 1000);
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.account.client_email)
      .setAudience(TOKEN_URL)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 3600)
      .sign(await importPKCS8(this.account.private_key, "RS256"));
    const response = await this.http(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    }).catch((cause: unknown) => {
      throw new ApiError("upstream_error", "Google Play could not be reached.", { cause });
    });
    if (!response.ok) throw new ApiError("upstream_error", "Google Play rejected the service account.", { cause: new Error(`token endpoint answered ${response.status}`) });
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new ApiError("upstream_error", "Google Play gave no access token.");
    this.cached = { token: body.access_token, expiresAtMillis: this.now() + (body.expires_in ?? 3600) * 1000 };
    return this.cached.token;
  }
}
