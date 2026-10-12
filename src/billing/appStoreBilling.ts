import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { SignJWT, compactVerify, decodeProtectedHeader, importPKCS8, importX509 } from "jose";
import { ApiError } from "../errors.js";
import type { SubscriptionState } from "../accounts/stores.js";

/** What the App Store knows about one auto-renewable subscription (all the purchases of one person in one subscription group). */
export interface AppleSubscription {
  /** The first transaction of the subscription. It stays the same through renewals and plan changes, so it identifies the subscription. */
  originalTransactionId: string;
  productId: string;
  state: SubscriptionState;
  expiresAtMillis: number;
  autoRenewing: boolean;
  /** The UUID the app gave StoreKit when buying (lower case); ties the purchase to one Chef account. */
  appAccountToken: string | null;
  /** When Apple signed what this was read from. A later note about the same subscription replaces an earlier one, never the other way round. */
  signedAtMillis: number;
}

/** What Apple's "server notification" says happened, with the subscription it happened to. */
export interface AppleNotification {
  uuid: string;
  type: string;
  subscription: AppleSubscription | null;
}

export interface AppStoreBillingVerifier {
  /** The subscription behind a signed transaction the app sent, or null when it is not a genuine purchase of this app. Rejects with an ApiError when Apple cannot be reached. */
  verify(signedTransaction: string): Promise<AppleSubscription | null>;
  /** Asks Apple for the subscription as it is now. Null when Apple does not know it, or when no App Store Server API key is set. */
  refresh(originalTransactionId: string): Promise<AppleSubscription | null>;
  /** Whether {@link refresh} can answer at all. */
  readonly canRefresh: boolean;
  /** Reads a server notification; null when it was not signed by Apple or is not about this app. */
  notification(signedPayload: string): Promise<AppleNotification | null>;
}

/** Apple Root CA - G3, from https://www.apple.com/certificateauthority/ (SHA-256 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79). */
export const APPLE_ROOT_CA_G3 = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;

/** Marks the leaf certificate Apple signs transactions and notifications with (a developer's own certificates chain to the same root but lack it). */
const LEAF_MARKER_OID = "1.2.840.113635.100.6.11.1";
/** Marks Apple's intermediate certificate for that leaf. */
const INTERMEDIATE_MARKER_OID = "1.2.840.113635.100.6.2.1";

// --- The little of DER that checking a certificate's extensions takes ---

interface Der {
  tag: number;
  /** Start and end of the content. */
  start: number;
  end: number;
}

function readDer(bytes: Buffer, offset: number): Der | null {
  if (offset + 2 > bytes.length) return null;
  const tag = bytes[offset]!;
  let length = bytes[offset + 1]!;
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || start + count > bytes.length) return null;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[start + i]!;
    start += count;
  }
  const end = start + length;
  return end <= bytes.length ? { tag, start, end } : null;
}

function derChildren(bytes: Buffer, parent: Der): Der[] {
  const children: Der[] = [];
  for (let offset = parent.start; offset < parent.end; ) {
    const child = readDer(bytes, offset);
    if (!child) return [];
    children.push(child);
    offset = child.end;
  }
  return children;
}

function encodeOid(oid: string): Buffer {
  const parts = oid.split(".").map(Number);
  const bytes: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const group = [part & 0x7f];
    for (let rest = Math.floor(part / 128); rest > 0; rest = Math.floor(rest / 128)) group.unshift((rest & 0x7f) | 0x80);
    bytes.push(...group);
  }
  return Buffer.from(bytes);
}

/** Whether a certificate carries the extension [oid]. Reads the extensions list itself, so the OID cannot be faked by text elsewhere in the certificate. */
export function hasCertificateExtension(certificate: Buffer, oid: string): boolean {
  const root = readDer(certificate, 0);
  const tbs = root && derChildren(certificate, root)[0];
  if (!tbs) return false;
  const extensions = derChildren(certificate, tbs).find((child) => child.tag === 0xa3);
  const list = extensions && derChildren(certificate, extensions)[0];
  if (!list) return false;
  const wanted = encodeOid(oid);
  return derChildren(certificate, list).some((extension) => {
    const id = derChildren(certificate, extension)[0];
    return id?.tag === 0x06 && certificate.subarray(id.start, id.end).equals(wanted);
  });
}

/** Checks things Apple signed: a compact JWS whose header carries the certificate chain that leads to Apple's root. */
export class AppleJwsVerifier {
  private readonly roots: X509Certificate[];

  constructor(
    roots: readonly string[] = [APPLE_ROOT_CA_G3],
    private readonly now: () => number = Date.now,
  ) {
    this.roots = roots.map((pem) => new X509Certificate(pem));
  }

  /** The payload when [jws] was signed by Apple, else null. */
  async verify(jws: string): Promise<Record<string, unknown> | null> {
    try {
      const header = decodeProtectedHeader(jws);
      // Apple sends the leaf, the intermediate and the root, in that order.
      if (header.alg !== "ES256" || !Array.isArray(header.x5c) || header.x5c.length !== 3 || !header.x5c.every((c) => typeof c === "string")) return null;
      const chain = header.x5c.map((cert) => new X509Certificate(Buffer.from(cert, "base64")));
      const [leaf, intermediate, root] = chain as [X509Certificate, X509Certificate, X509Certificate];

      // The chain has to end at a root we already trust: whatever the header says about itself proves nothing.
      if (!this.roots.some((trusted) => trusted.raw.equals(root.raw))) return null;
      if (!intermediate.checkIssued(root) || !intermediate.verify(root.publicKey)) return null;
      if (!leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey)) return null;
      if (!hasCertificateExtension(leaf.raw, LEAF_MARKER_OID) || !hasCertificateExtension(intermediate.raw, INTERMEDIATE_MARKER_OID)) return null;

      const verified = await compactVerify(jws, await importX509(leaf.toString(), "ES256"), { algorithms: ["ES256"] });
      const payload: unknown = JSON.parse(new TextDecoder().decode(verified.payload));
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;

      // The leaf is renewed every so often: what counts is that it was valid when Apple signed, not today.
      const signedAt = (payload as { signedDate?: unknown }).signedDate;
      const at = typeof signedAt === "number" ? signedAt : this.now();
      if (chain.some((cert) => at < Date.parse(cert.validFrom) || at > Date.parse(cert.validTo))) return null;
      return payload as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

// --- Reading what Apple signed ---

interface TransactionPayload {
  originalTransactionId?: unknown;
  bundleId?: unknown;
  productId?: unknown;
  type?: unknown;
  expiresDate?: unknown;
  revocationDate?: unknown;
  appAccountToken?: unknown;
  signedDate?: unknown;
}

interface RenewalPayload {
  autoRenewStatus?: unknown;
  gracePeriodExpiresDate?: unknown;
}

/** `Auto-Renewable Subscription` is the only kind Chef sells. */
const SUBSCRIPTION_TYPE = "Auto-Renewable Subscription";

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * Turns Apple's data into ours. [status] is the App Store Server API's number for the subscription (1 active, 2 expired, 3 billing
 * retry, 4 grace period, 5 revoked) when Apple gave one; without it the dates decide, as of [at].
 */
export function appleSubscription(transaction: TransactionPayload, renewal: RenewalPayload | null, status: number | null, at: number): AppleSubscription | null {
  if (!isText(transaction.originalTransactionId) || !isText(transaction.productId) || !isNumber(transaction.expiresDate)) return null;
  const renews = renewal && isNumber(renewal.autoRenewStatus) ? renewal.autoRenewStatus === 1 : null;
  let expiresAtMillis = transaction.expiresDate;
  let state: SubscriptionState;

  if (isNumber(transaction.revocationDate) || status === 5 || status === 2) {
    state = "EXPIRED";
  } else if (status === 3) {
    state = "ON_HOLD";
  } else if (status === 4) {
    // The subscription lapsed but Apple is still trying to charge: access goes on until the grace period ends.
    state = "IN_GRACE_PERIOD";
    if (renewal && isNumber(renewal.gracePeriodExpiresDate)) expiresAtMillis = Math.max(expiresAtMillis, renewal.gracePeriodExpiresDate);
  } else if (status === 1 || (status === null && expiresAtMillis > at)) {
    state = renews === false ? "CANCELED" : "ACTIVE";
  } else if (status === null) {
    state = "EXPIRED";
  } else {
    state = "UNKNOWN";
  }

  const token = isText(transaction.appAccountToken) ? transaction.appAccountToken.toLowerCase() : null;
  return {
    originalTransactionId: transaction.originalTransactionId,
    productId: transaction.productId,
    state,
    expiresAtMillis,
    // When Apple has not said (no renewal info), an active subscription is taken to renew.
    autoRenewing: renews ?? (state === "ACTIVE" || state === "IN_GRACE_PERIOD"),
    appAccountToken: token,
    signedAtMillis: isNumber(transaction.signedDate) ? transaction.signedDate : at,
  };
}

// --- The App Store Server API ---

export interface AppStoreKey {
  keyId: string;
  issuerId: string;
  /** The `.p8` file's PKCS #8 text. */
  privateKey: string;
}

/** The In-App Purchase key from App Store Connect, from a file path or from Base64 (how an App Service setting holds it). Undefined when none is set. */
export function loadAppStoreKey(options: { keyId?: string; issuerId?: string; path?: string; base64?: string }): AppStoreKey | undefined {
  const raw = options.base64 ? Buffer.from(options.base64, "base64").toString("utf8") : options.path ? readFileSync(options.path, "utf8") : undefined;
  if (!raw && !options.keyId && !options.issuerId) return undefined;
  if (!raw || !options.keyId || !options.issuerId) throw new Error("The App Store Server API key needs APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID and the .p8 key (APPLE_IAP_PRIVATE_KEY or APPLE_IAP_PRIVATE_KEY_BASE64) together");
  return { keyId: options.keyId, issuerId: options.issuerId, privateKey: raw };
}

const PRODUCTION_API = "https://api.storekit.itunes.apple.com";
const SANDBOX_API = "https://api.storekit-sandbox.itunes.apple.com";
const API_AUDIENCE = "appstoreconnect-v1";

interface SubscriptionStatusAnswer {
  data?: Array<{ lastTransactions?: Array<{ originalTransactionId?: unknown; status?: unknown; signedTransactionInfo?: unknown; signedRenewalInfo?: unknown }> }>;
}

/** Asks the App Store Server API about a subscription. Sandbox purchases (TestFlight, App Review) live on their own server, tried second. */
export class AppStoreServerApi {
  private cached: { token: string; expiresAtMillis: number } | null = null;

  constructor(
    private readonly key: AppStoreKey,
    private readonly bundleId: string,
    private readonly http: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** The answer for one subscription, or null when neither server knows it. */
  async subscriptionStatus(originalTransactionId: string): Promise<{ status: number | null; signedTransaction: string; signedRenewal: string | null } | null> {
    for (const host of [PRODUCTION_API, SANDBOX_API]) {
      const response = await this.http(`${host}/inApps/v1/subscriptions/${encodeURIComponent(originalTransactionId)}`, {
        headers: { authorization: `Bearer ${await this.token()}` },
      }).catch((cause: unknown) => {
        throw new ApiError("upstream_error", "The App Store could not be reached.", { cause });
      });
      // 404 is "not on this server" (or never existed); 400 a transaction id that is malformed.
      if (response.status === 404 || response.status === 400) continue;
      if (!response.ok) throw new ApiError("upstream_error", "The App Store could not verify the purchase.", { cause: new Error(`App Store answered ${response.status}`) });
      const body = (await response.json()) as SubscriptionStatusAnswer;
      const last = (body.data ?? []).flatMap((group) => group.lastTransactions ?? []).find((entry) => entry.originalTransactionId === originalTransactionId);
      if (!last || !isText(last.signedTransactionInfo)) return null;
      return {
        status: isNumber(last.status) ? last.status : null,
        signedTransaction: last.signedTransactionInfo,
        signedRenewal: isText(last.signedRenewalInfo) ? last.signedRenewalInfo : null,
      };
    }
    return null;
  }

  private async token(): Promise<string> {
    if (this.cached && this.cached.expiresAtMillis - 60_000 > this.now()) return this.cached.token;
    const issuedAt = Math.floor(this.now() / 1000);
    const expiresAt = issuedAt + 20 * 60;
    const token = await new SignJWT({ bid: this.bundleId })
      .setProtectedHeader({ alg: "ES256", kid: this.key.keyId, typ: "JWT" })
      .setIssuer(this.key.issuerId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .setAudience(API_AUDIENCE)
      .sign(await importPKCS8(this.key.privateKey, "ES256"));
    this.cached = { token, expiresAtMillis: expiresAt * 1000 };
    return token;
  }
}

/** The App Store as the rest of the API sees it. The only place that reads what Apple signs. */
export class AppStoreBilling implements AppStoreBillingVerifier {
  constructor(
    private readonly bundleId: string,
    private readonly jws: AppleJwsVerifier = new AppleJwsVerifier(),
    private readonly api: AppStoreServerApi | null = null,
    private readonly now: () => number = Date.now,
  ) {}

  get canRefresh(): boolean {
    return this.api !== null;
  }

  async verify(signedTransaction: string): Promise<AppleSubscription | null> {
    const transaction = await this.transaction(signedTransaction);
    const signed = transaction && appleSubscription(transaction, null, null, this.now());
    if (!signed || !this.api) return signed;
    // Apple's own answer wins when we can ask: it knows about refunds and renewals after this transaction was signed.
    return this.refresh(signed.originalTransactionId);
  }

  async refresh(originalTransactionId: string): Promise<AppleSubscription | null> {
    if (!this.api) return null;
    const answer = await this.api.subscriptionStatus(originalTransactionId);
    if (!answer) return null;
    const transaction = await this.transaction(answer.signedTransaction);
    if (!transaction) return null;
    const renewal = answer.signedRenewal ? ((await this.jws.verify(answer.signedRenewal)) as RenewalPayload | null) : null;
    return appleSubscription(transaction, renewal, answer.status, this.now());
  }

  async notification(signedPayload: string): Promise<AppleNotification | null> {
    const payload = (await this.jws.verify(signedPayload)) as {
      notificationType?: unknown;
      notificationUUID?: unknown;
      signedDate?: unknown;
      data?: { bundleId?: unknown; status?: unknown; signedTransactionInfo?: unknown; signedRenewalInfo?: unknown };
    } | null;
    if (!payload || !isText(payload.notificationUUID) || !isText(payload.notificationType)) return null;
    const { data } = payload;
    const notification = { uuid: payload.notificationUUID, type: payload.notificationType };
    // A TEST notification carries no data; any other one is only of use when it is about this app.
    if (!data || data.bundleId !== this.bundleId || !isText(data.signedTransactionInfo)) return { ...notification, subscription: null };

    const transaction = await this.transaction(data.signedTransactionInfo);
    if (!transaction) return { ...notification, subscription: null };
    const renewal = isText(data.signedRenewalInfo) ? ((await this.jws.verify(data.signedRenewalInfo)) as RenewalPayload | null) : null;
    const at = isNumber(payload.signedDate) ? payload.signedDate : this.now();
    return { ...notification, subscription: appleSubscription(transaction, renewal, isNumber(data.status) ? data.status : null, at) };
  }

  /** A transaction signed by Apple, for this app, that is a Chef-style subscription. */
  private async transaction(signed: string): Promise<TransactionPayload | null> {
    const transaction = (await this.jws.verify(signed)) as TransactionPayload | null;
    if (!transaction || transaction.bundleId !== this.bundleId || transaction.type !== SUBSCRIPTION_TYPE) return null;
    return transaction;
  }
}
