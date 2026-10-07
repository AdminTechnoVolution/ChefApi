import type { FastifyInstance } from "fastify";
import { createMemoryStores } from "../src/accounts/memoryStores.js";
import { MemoryTokenControl } from "../src/accounts/tokenControl.js";
import { type AccountsRuntime, createAccountsRuntime } from "../src/accounts/runtime.js";
import type { AccountStores, GoogleProfile } from "../src/accounts/stores.js";
import { buildApp } from "../src/app.js";
import type { IdTokenVerifier } from "../src/auth/googleIdToken.js";
import { JwtVerifier } from "../src/auth/jwtVerifier.js";
import type { PubSubAuth } from "../src/auth/pubsubAuth.js";
import type { PlayBillingVerifier, PlaySubscription } from "../src/billing/playBilling.js";
import { PRODUCT_IDS } from "../src/billing/plans.js";
import type { Config } from "../src/config.js";
import { ApiError } from "../src/errors.js";
import type { RecipeGenerator } from "../src/llm/recipeGenerator.js";
import { StubExtractor, StubGenerator, StubScanner, StubSuggester, contractRecipe, testConfig } from "./helpers.js";

export const JWT_SECRET = "a-test-secret-that-is-at-least-32-characters";
export const START = Date.UTC(2026, 9, 15, 12, 0, 0);

/** Time the test moves by hand. */
export class Clock {
  constructor(public millis: number = START) {}
  now = () => this.millis;
  advance(ms: number) {
    this.millis += ms;
  }
}

/** Google, as a table: a token is known or it is not. */
export class FakeIdTokens implements IdTokenVerifier {
  readonly profiles = new Map<string, GoogleProfile>();
  async verify(idToken: string): Promise<GoogleProfile | null> {
    return this.profiles.get(idToken) ?? null;
  }
}

/** Google Play, as a table of purchase tokens, with a switch for it being down. */
export class FakePlay implements PlayBillingVerifier {
  readonly subscriptions = new Map<string, PlaySubscription>();
  readonly asked: string[] = [];
  failure: ApiError | null = null;

  async fetch(purchaseToken: string): Promise<PlaySubscription | null> {
    this.asked.push(purchaseToken);
    if (this.failure) throw this.failure;
    return this.subscriptions.get(purchaseToken) ?? null;
  }

  /** A subscription that is active for a month from [from]. */
  sell(purchaseToken: string, productId: string, overrides: Partial<PlaySubscription> = {}, from: number = START) {
    this.subscriptions.set(purchaseToken, {
      productId,
      state: "ACTIVE",
      expiresAtMillis: from + 30 * 86_400_000,
      autoRenewing: true,
      obfuscatedAccountId: null,
      ...overrides,
    });
  }
}

export class FakePubSub implements PubSubAuth {
  accept = true;
  async verify(): Promise<boolean> {
    return this.accept;
  }
}

export interface SignedIn {
  userId: string;
  accessToken: string;
  refreshToken: string;
  /** For calls with a JSON body. */
  headers: Record<string, string>;
  /** For calls with no body (GET, DELETE): a content type without a body is an error, as it would be for the app. */
  plain: Record<string, string>;
}

export interface AccountsApp {
  app: FastifyInstance;
  runtime: AccountsRuntime;
  stores: AccountStores;
  clock: Clock;
  google: FakeIdTokens;
  play: FakePlay;
  pubsub: FakePubSub;
  generator: StubGenerator;
  config: Config;
  /** Signs [email] in through the real route and returns their session. */
  signIn(email?: string, deviceId?: string): Promise<SignedIn>;
}

export const bearer = (accessToken: string) => ({ authorization: `Bearer ${accessToken}`, "content-type": "application/json" });

/** The app running with accounts, as production does, but with memory stores and Google and Play replaced by tables. */
export async function accountsApp(
  options: { config?: Record<string, string>; generator?: RecipeGenerator; pubsub?: boolean } = {},
): Promise<AccountsApp> {
  // The limit per client is lifted: these tests make many calls from one address, and the limit has tests of its own.
  const config = testConfig({ AUTH_MODE: "jwt", JWT_SECRET, GOOGLE_CLIENT_ID: "test-client", RATE_LIMIT_MAX: "10000", ...options.config });
  const clock = new Clock();
  const stores = createMemoryStores(clock.now);
  const google = new FakeIdTokens();
  const play = new FakePlay();
  const pubsub = new FakePubSub();
  const runtime = createAccountsRuntime({
    config,
    stores,
    tokenControl: new MemoryTokenControl(clock.now),
    idTokens: google,
    playBilling: play,
    pubsub: options.pubsub === false ? null : pubsub,
    now: clock.now,
  });
  const generator = (options.generator as StubGenerator | undefined) ?? StubGenerator.returning(contractRecipe());
  const app = await buildApp({
    config,
    verifier: new JwtVerifier(runtime.tokens),
    accounts: runtime,
    generator: options.generator ?? generator,
    scanner: StubScanner.returning(),
    suggester: StubSuggester.returning(),
    extractor: StubExtractor.returning(),
    logger: false,
  });

  const signIn = async (email = "ana@example.com", deviceId = "phone-1"): Promise<SignedIn> => {
    google.profiles.set(`token-${email}`, { googleSub: `sub-${email}`, email, name: email.split("@")[0] ?? null });
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/google",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ idToken: `token-${email}`, deviceId }),
    });
    const body = response.json() as { accessToken: string; refreshToken: string; user: { id: string } };
    return {
      userId: body.user.id,
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      headers: bearer(body.accessToken),
      plain: { authorization: `Bearer ${body.accessToken}` },
    };
  };

  return { app, runtime, stores, clock, google, play, pubsub, generator: generator as StubGenerator, config, signIn };
}

export { PRODUCT_IDS };
