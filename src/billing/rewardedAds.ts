import { createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import type { AdRewardReservation, AdRewardStore } from "../accounts/stores.js";
import type { Config } from "../config.js";
import { ApiError } from "../errors.js";
import { monthKey } from "./plans.js";
import type { EntitlementService } from "./entitlements.js";

export const REWARDED_AD_CREDITS = 5;
export const REWARDED_ADS_PER_DAY = 5;
export const REWARDED_AD_RESERVATION_MS = 15 * 60_000;
const KEY_URL = "https://www.gstatic.com/admob/reward/verifier-keys.json";
const GOOGLE_TEST_UNITS = ["ca-app-pub-3940256099942544/5224354917", "ca-app-pub-3940256099942544/1712485313"];

interface AdMobKeys { keys: Array<{ keyId: number; pem: string }> }
interface AdMobCallback {
  ad_unit: string;
  custom_data: string;
  key_id: string;
  reward_amount: string;
  reward_item: string;
  signature: string;
  timestamp: string;
  transaction_id: string;
}

/** Verifies the unmodified, signed query string from AdMob's SSV callback. Keys refresh at most every 23 hours. */
export class AdMobSSVVerifier {
  private cached: { until: number; keys: Map<number, string> } | null = null;
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  async verify(rawUrl: string): Promise<AdMobCallback | null> {
    const queryStart = rawUrl.indexOf("?");
    if (queryStart < 0) return null;
    const rawQuery = rawUrl.slice(queryStart + 1);
    const parameters = rawQuery.split("&");
    const signatureParameters = parameters.filter(parameter => parameter.startsWith("signature="));
    const keyIdParameters = parameters.filter(parameter => parameter.startsWith("key_id="));
    if (signatureParameters.length !== 1 || keyIdParameters.length !== 1) return null;
    const signedData = parameters
      .filter(parameter => !parameter.startsWith("signature=") && !parameter.startsWith("key_id="))
      .join("&");
    const search = new URLSearchParams(rawQuery);
    const signature = search.get("signature");
    const keyId = Number(search.get("key_id"));
    if (!signature || !Number.isSafeInteger(keyId)) return null;
    const callback = Object.fromEntries(search.entries()) as Partial<AdMobCallback>;
    if (!callback.ad_unit || !callback.custom_data || !callback.reward_amount || !callback.reward_item || !callback.transaction_id || !callback.timestamp) return null;
    const keys = await this.publicKeys();
    const pem = keys.get(keyId);
    if (!pem) return null;
    const bytes = Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const valid = verifySignature("sha256", Buffer.from(signedData, "utf8"), createPublicKey(pem), bytes);
    return valid ? callback as AdMobCallback : null;
  }

  private async publicKeys(): Promise<Map<number, string>> {
    if (this.cached && this.cached.until > this.now()) return this.cached.keys;
    let response: Response;
    try { response = await this.fetcher(KEY_URL, { signal: AbortSignal.timeout(5_000) }); }
    catch (error) { throw new ApiError("upstream_error", "AdMob verification keys are unavailable.", { cause: error }); }
    if (!response.ok) throw new ApiError("upstream_error", "AdMob verification keys are unavailable.");
    const parsed = await response.json() as AdMobKeys;
    if (!Array.isArray(parsed.keys) || parsed.keys.length === 0) throw new ApiError("upstream_error", "AdMob returned no verification keys.");
    const keys = new Map(parsed.keys.map(key => [key.keyId, key.pem]));
    this.cached = { keys, until: this.now() + 23 * 60 * 60_000 };
    return keys;
  }
}

export interface RewardedAdStatus {
  eligible: boolean;
  creditsPerAd: number;
  completedToday: number;
  availableToday: number;
  reservationActive: boolean;
  monthlyCredits: number;
}

export class RewardedAdService {
  constructor(
    private readonly store: AdRewardStore,
    private readonly entitlements: EntitlementService,
    private readonly verifier: AdMobSSVVerifier,
    private readonly config: Pick<Config, "NODE_ENV" | "ADMOB_REWARDED_ANDROID_UNIT_ID" | "ADMOB_REWARDED_IOS_UNIT_ID">,
    private readonly now: () => number = Date.now,
  ) {}

  async status(userId: string): Promise<RewardedAdStatus> {
    const now = this.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const month = monthKey(now);
    const { plan } = await this.entitlements.effectivePlan(userId);
    const eligible = plan === "FREE";
    const [daily, activeReservation, monthlyCredits] = await Promise.all([
      this.store.daily(userId, today, now),
      this.store.activeReservation(userId, now),
      eligible ? this.store.monthlyCredits(userId, month) : Promise.resolve(0),
    ]);
    return {
      eligible,
      creditsPerAd: REWARDED_AD_CREDITS,
      completedToday: daily.completed,
      availableToday: eligible && !activeReservation ? Math.max(0, REWARDED_ADS_PER_DAY - daily.completed) : 0,
      reservationActive: !!activeReservation,
      monthlyCredits,
    };
  }

  async reserve(userId: string): Promise<{ token: string; expiresAtMillis: number; status: RewardedAdStatus }> {
    const current = await this.status(userId);
    if (!current.eligible) throw new ApiError("plan_required", "Rewarded ads are available on the free plan.");
    if (current.availableToday === 0) throw new ApiError("conflict", "No rewarded ads are available right now.");
    const now = this.now();
    const token = randomBytes(32).toString("base64url");
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const reservation: AdRewardReservation = { userId, dayKey, monthKey: monthKey(now), token, expiresAtMillis: now + REWARDED_AD_RESERVATION_MS };
    if (!await this.store.reserve(reservation, now)) throw new ApiError("conflict", "A rewarded ad is already in progress or the daily limit was reached.");
    return { token, expiresAtMillis: reservation.expiresAtMillis, status: await this.status(userId) };
  }

  async cancel(userId: string, token: string): Promise<RewardedAdStatus> {
    const reservation = await this.store.findReservation(token);
    if (reservation?.userId === userId) await this.store.cancel(userId, reservation.dayKey, token);
    return this.status(userId);
  }

  async completeFromClient(userId: string, token: string): Promise<RewardedAdStatus> {
    const result = await this.store.completeFromClient(userId, token, this.now());
    if (result === "invalid") throw new ApiError("conflict", "The rewarded-ad reservation is missing or expired.");
    return this.status(userId);
  }

  async handleCallback(rawUrl: string): Promise<"awarded" | "duplicate"> {
    const callback = await this.verifier.verify(rawUrl);
    if (!callback) throw new ApiError("unauthorized", "The AdMob reward callback could not be verified.");
    if (callback.reward_amount !== String(REWARDED_AD_CREDITS) || callback.reward_item !== "credits") {
      throw new ApiError("invalid_request", "The AdMob callback has an unexpected reward.");
    }
    const validUnits = new Set([this.config.ADMOB_REWARDED_ANDROID_UNIT_ID, this.config.ADMOB_REWARDED_IOS_UNIT_ID].filter(Boolean));
    if (this.config.NODE_ENV !== "production") GOOGLE_TEST_UNITS.forEach(unit => validUnits.add(unit));
    const unitSuffix = callback.ad_unit.includes("/") ? callback.ad_unit.split("/").at(-1) : callback.ad_unit;
    const allowed = [...validUnits].some(unit => unit === callback.ad_unit || unit.endsWith(`/${unitSuffix}`));
    if (!allowed) throw new ApiError("invalid_request", "The AdMob callback used an unknown ad unit.");
    const reservation = await this.store.findReservation(callback.custom_data);
    if (!reservation) {
      if (await this.store.hasTransaction(callback.transaction_id) || await this.store.hasCompletedReservation(callback.custom_data)) {
        return "duplicate";
      }
      throw new ApiError("invalid_request", "The reward reservation is missing or expired.");
    }
    const result = await this.store.complete({ ...reservation, transactionId: callback.transaction_id }, this.now());
    if (result === "invalid") throw new ApiError("invalid_request", "The reward reservation is missing or expired.");
    return result;
  }
}
