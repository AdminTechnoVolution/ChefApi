import { readFileSync } from "node:fs";
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

  it("every setting in .env.example parses", () => {
    const text = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    const env: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (match) env[match[1]!] = match[2]!;
    }

    expect(Object.keys(env).length).toBeGreaterThan(10);
    expect(() => loadConfig(env)).not.toThrow();
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
