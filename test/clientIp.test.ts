import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { clientKey } from "../src/clientIp.js";
import { StubGenerator, appWith, authHeaders, contractRecipe, contractRequest, testConfig } from "./helpers.js";

describe("clientKey", () => {
  it.each([
    ["203.0.113.7", "203.0.113.7"],
    ["203.0.113.7:51234", "203.0.113.7"],
    ["203.0.113.7:1", "203.0.113.7"],
    ["[2001:db8::1]:51234", "2001:db8::1"],
    ["2001:db8::1", "2001:db8::1"],
    ["::1", "::1"],
    ["::ffff:203.0.113.7", "::ffff:203.0.113.7"],
    ["not-an-ip", "not-an-ip"],
  ])("%s -> %s", (input, expected) => {
    expect(clientKey(input)).toBe(expected);
  });
});

describe("rate limiting behind a proxy that appends the client's source port to X-Forwarded-For", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const post = (instance: FastifyInstance, forwardedFor: string) =>
    instance.inject({
      method: "POST",
      url: "/v1/recipes/generate",
      headers: { ...authHeaders, "x-forwarded-for": forwardedFor },
      remoteAddress: "10.0.0.4",
      payload: contractRequest(),
    });

  it("treats new connections from the same client as the same client (ports differ every time)", async () => {
    app = await appWith(StubGenerator.returning(contractRecipe()), testConfig({ RATE_LIMIT_MAX: "3", TRUST_PROXY: "1" }));

    const statuses: number[] = [];
    for (let port = 50_001; port <= 50_005; port++) statuses.push((await post(app, `203.0.113.7:${port}`)).statusCode);

    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it("still keeps different clients apart", async () => {
    app = await appWith(StubGenerator.returning(contractRecipe()), testConfig({ RATE_LIMIT_MAX: "1", TRUST_PROXY: "1" }));

    expect((await post(app, "203.0.113.7:50001")).statusCode).toBe(200);
    expect((await post(app, "203.0.113.8:50001")).statusCode).toBe(200);
    expect((await post(app, "203.0.113.7:50002")).statusCode).toBe(429);
  });

  it("works the same for plain addresses and for IPv6 with a port", async () => {
    app = await appWith(StubGenerator.returning(contractRecipe()), testConfig({ RATE_LIMIT_MAX: "2", TRUST_PROXY: "1" }));

    const v6 = [(await post(app, "[2001:db8::1]:40001")).statusCode, (await post(app, "[2001:db8::1]:40002")).statusCode, (await post(app, "[2001:db8::1]:40003")).statusCode];
    const plain = [(await post(app, "198.51.100.1")).statusCode, (await post(app, "198.51.100.1")).statusCode, (await post(app, "198.51.100.1")).statusCode];

    expect(v6).toEqual([200, 200, 429]);
    expect(plain).toEqual([200, 200, 429]);
  });
});
