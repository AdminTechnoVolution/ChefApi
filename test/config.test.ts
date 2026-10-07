import { describe, expect, it } from "vitest";
import { DEV_APP_KEY, loadConfig, swaggerEnabled } from "../src/config.js";

const production = { NODE_ENV: "production", CHEF_APP_KEY: "a-long-production-secret-key-123456" };

describe("loadConfig", () => {
  it("has safe development defaults", () => {
    const config = loadConfig({});

    expect(config).toMatchObject({
      NODE_ENV: "development",
      PORT: 8080,
      CHEF_APP_KEY: DEV_APP_KEY,
      OPENROUTER_MODEL: "google/gemini-2.5-flash-lite",
      OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
      OPENROUTER_MAX_TOKENS: 3_000,
      OPENROUTER_TEMPERATURE: 0.7,
      OPENROUTER_ZDR: true,
      OPENROUTER_VISION_MODEL: "google/gemini-2.5-flash",
      OPENROUTER_VISION_MAX_TOKENS: 2_000,
      OPENROUTER_VISION_TIMEOUT_MS: 30_000,
      SCAN_RATE_LIMIT_MAX: 6,
      TRUST_PROXY: false,
      REQUEST_DEADLINE_MS: 75_000,
      UPSTREAM_TIMEOUT_MS: 40_000,
    });
  });

  it("parses boolean flags", () => {
    expect(loadConfig({ TRUST_PROXY: "true" }).TRUST_PROXY).toBe(true);
    expect(loadConfig({ OPENROUTER_ZDR: "0" }).OPENROUTER_ZDR).toBe(false);
  });

  it("coerces numeric settings", () => {
    expect(loadConfig({ PORT: "9090", RATE_LIMIT_MAX: "5" })).toMatchObject({ PORT: 9090, RATE_LIMIT_MAX: 5 });
  });

  it("rejects invalid values with a readable message", () => {
    expect(() => loadConfig({ PORT: "99999" })).toThrow(/PORT/);
    expect(() => loadConfig({ OPENROUTER_TEMPERATURE: "5" })).toThrow(/OPENROUTER_TEMPERATURE/);
    expect(() => loadConfig({ OPENROUTER_MAX_TOKENS: "10" })).toThrow(/OPENROUTER_MAX_TOKENS/);
    expect(() => loadConfig({ OPENROUTER_BASE_URL: "not a url" })).toThrow(/OPENROUTER_BASE_URL/);
    expect(() => loadConfig({ OPENROUTER_BASE_URL: "ftp://example.com" })).toThrow(/OPENROUTER_BASE_URL/);
    expect(() => loadConfig({ OPENROUTER_ZDR: "maybe" })).toThrow(/OPENROUTER_ZDR/);
    expect(() => loadConfig({ OPENROUTER_VISION_MAX_TOKENS: "10" })).toThrow(/OPENROUTER_VISION_MAX_TOKENS/);
    expect(() => loadConfig({ OPENROUTER_VISION_TIMEOUT_MS: "100" })).toThrow(/OPENROUTER_VISION_TIMEOUT_MS/);
    expect(() => loadConfig({ SCAN_RATE_LIMIT_MAX: "0" })).toThrow(/SCAN_RATE_LIMIT_MAX/);
  });

  it("keeps the request deadline below the Android client's 90 s call timeout", () => {
    expect(() => loadConfig({ REQUEST_DEADLINE_MS: "90000" })).toThrow(/REQUEST_DEADLINE_MS/);
    expect(() => loadConfig({ REQUEST_DEADLINE_MS: "85000" })).not.toThrow();
  });

  it("treats an empty API key (as left by `KEY=` in a copied .env.example) as not set", () => {
    expect(loadConfig({ OPENROUTER_API_KEY: "" }).OPENROUTER_API_KEY).toBeUndefined();
  });

  it("keeps real API keys", () => {
    expect(loadConfig({ OPENROUTER_API_KEY: "sk-or-abc" }).OPENROUTER_API_KEY).toBe("sk-or-abc");
  });

  describe("swagger switch", () => {
    const enabled = (env: Record<string, string>) => swaggerEnabled(loadConfig(env));

    it("is on outside production and off in production when not set", () => {
      expect(enabled({})).toBe(true);
      expect(enabled({ NODE_ENV: "development" })).toBe(true);
      expect(enabled({ NODE_ENV: "test" })).toBe(true);
      expect(enabled(production)).toBe(false);
    });

    it("can be forced either way with ENABLE_SWAGGER", () => {
      expect(enabled({ ...production, ENABLE_SWAGGER: "1" })).toBe(true);
      expect(enabled({ ...production, ENABLE_SWAGGER: "true" })).toBe(true);
      expect(enabled({ NODE_ENV: "development", ENABLE_SWAGGER: "0" })).toBe(false);
      expect(enabled({ NODE_ENV: "development", ENABLE_SWAGGER: "false" })).toBe(false);
    });

    it("treats an empty ENABLE_SWAGGER (as left by `KEY=` in a copied .env.example) as not set", () => {
      expect(enabled({ ENABLE_SWAGGER: "" })).toBe(true);
      expect(enabled({ ...production, ENABLE_SWAGGER: "" })).toBe(false);
    });

    it("rejects garbage", () => {
      expect(() => loadConfig({ ENABLE_SWAGGER: "maybe" })).toThrow(/ENABLE_SWAGGER/);
    });
  });

  describe("production guards", () => {
    it("accepts a properly configured production environment", () => {
      expect(() => loadConfig(production)).not.toThrow();
    });

    it("refuses the development key", () => {
      expect(() => loadConfig({ ...production, CHEF_APP_KEY: DEV_APP_KEY })).toThrow(/CHEF_APP_KEY/);
    });

    it("refuses a short key", () => {
      expect(() => loadConfig({ ...production, CHEF_APP_KEY: "short" })).toThrow(/CHEF_APP_KEY/);
    });

    it("refuses a non-https OpenRouter url", () => {
      expect(() => loadConfig({ ...production, OPENROUTER_BASE_URL: "http://gateway.internal/api/v1" })).toThrow(
        /OPENROUTER_BASE_URL/,
      );
      expect(() => loadConfig({ ...production, OPENROUTER_BASE_URL: "https://gateway.internal/api/v1" })).not.toThrow();
    });

  });
});

describe("accounts and plans", () => {
  const jwt = { AUTH_MODE: "jwt", JWT_SECRET: "s".repeat(40), GOOGLE_CLIENT_ID: "client-id" };

  it("keeps the shared-key mode unless told otherwise, with the database named chef", () => {
    const config = loadConfig({ NODE_ENV: "test" });

    expect(config.AUTH_MODE).toBe("app-key");
    expect(config.MONGODB_DB).toBe("chef");
    expect(config.REDIS_KEY_PREFIX).toBe("chef");
    expect(config.MONGODB_URI).toBeUndefined();
    expect(config.REDIS_URL).toBeUndefined();
  });

  it("gives the plans the allowances the product was designed with", () => {
    const config = loadConfig({ NODE_ENV: "test" });

    expect([config.AI_FREE_MONTHLY_UNITS, config.AI_JUNIOR_MONTHLY_UNITS, config.AI_MASTER_MONTHLY_UNITS]).toEqual([5, 150, 400]);
    expect([config.JWT_ACCESS_TTL_SECONDS, config.REFRESH_TTL_DAYS]).toEqual([900, 60]);
  });

  it("treats empty values in a .env file as not set", () => {
    const config = loadConfig({ NODE_ENV: "test", MONGODB_URI: "", REDIS_URL: "", JWT_SECRET: "", DEV_UNLOCK_PLAN: "" });

    expect(config.MONGODB_URI).toBeUndefined();
    expect(config.REDIS_URL).toBeUndefined();
    expect(config.DEV_UNLOCK_PLAN).toBeUndefined();
  });

  it("needs a long enough secret and a Google client to sign people in", () => {
    expect(() => loadConfig({ NODE_ENV: "test", AUTH_MODE: "jwt", GOOGLE_CLIENT_ID: "c" })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ NODE_ENV: "test", AUTH_MODE: "jwt", JWT_SECRET: "short", GOOGLE_CLIENT_ID: "c" })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ NODE_ENV: "test", AUTH_MODE: "jwt", JWT_SECRET: "s".repeat(40) })).toThrow(/GOOGLE_CLIENT_ID/);
    expect(loadConfig({ NODE_ENV: "test", ...jwt }).AUTH_MODE).toBe("jwt");
  });

  it("lets local development sign in without Google", () => {
    expect(loadConfig({ NODE_ENV: "development", AUTH_MODE: "jwt", JWT_SECRET: "s".repeat(40), DEV_GOOGLE_AUTH: "1" }).DEV_GOOGLE_AUTH).toBe(true);
  });

  it("refuses in production the shortcuts meant for development", () => {
    const production = { NODE_ENV: "production", CHEF_APP_KEY: "k".repeat(32), MONGODB_URI: "mongodb://x", REDIS_URL: "redis://x", ...jwt };

    expect(() => loadConfig({ ...production, DEV_UNLOCK_PLAN: "MASTER" })).toThrow(/DEV_UNLOCK_PLAN/);
    expect(() => loadConfig({ ...production, DEV_GOOGLE_AUTH: "1" })).toThrow(/DEV_GOOGLE_AUTH/);
  });

  it("needs MongoDB and Redis in production once accounts are on", () => {
    const production = { NODE_ENV: "production", CHEF_APP_KEY: "k".repeat(32), ...jwt };

    expect(() => loadConfig({ ...production, REDIS_URL: "redis://x" })).toThrow(/MONGODB_URI/);
    expect(() => loadConfig({ ...production, MONGODB_URI: "mongodb://x" })).toThrow(/REDIS_URL/);
    expect(loadConfig({ ...production, MONGODB_URI: "mongodb://x", REDIS_URL: "redis://x" }).AUTH_MODE).toBe("jwt");
  });

  it("needs a stronger secret in production than a test does", () => {
    const production = { NODE_ENV: "production", CHEF_APP_KEY: "k".repeat(32), MONGODB_URI: "mongodb://x", REDIS_URL: "redis://x", ...jwt };

    expect(() => loadConfig({ ...production, JWT_SECRET: "s".repeat(20) })).toThrow(/JWT_SECRET/);
  });

  it("does not ask for the shared key once accounts are on, since nobody sends it", () => {
    const production = { NODE_ENV: "production", MONGODB_URI: "mongodb://x", REDIS_URL: "redis://x", ...jwt };

    expect(loadConfig(production).AUTH_MODE).toBe("jwt");
    // ...while the shared-key mode still insists on a real one.
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/CHEF_APP_KEY/);
  });

  it("does not ask for any of it in the shared-key mode, even in production", () => {
    expect(loadConfig({ NODE_ENV: "production", CHEF_APP_KEY: "k".repeat(32) }).AUTH_MODE).toBe("app-key");
  });
});
