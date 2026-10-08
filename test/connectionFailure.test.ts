import { describe, expect, it } from "vitest";
import { connectionFailure, hostsOf } from "../src/accounts/connectionFailure.js";
import { createAccountsFromConfig } from "../src/accounts/createAccounts.js";
import { loadConfig } from "../src/config.js";

const quiet = { info: () => undefined, warn: () => undefined };

describe("which server a connection string names", () => {
  it("is the host alone, with no user, password, database or options", () => {
    expect(hostsOf("mongodb://user:p%40ss@cluster0.abc.mongodb.net/chef?retryWrites=true&w=majority")).toBe("cluster0.abc.mongodb.net");
    expect(hostsOf("mongodb+srv://user:secret@cluster0.abc.mongodb.net/")).toBe("cluster0.abc.mongodb.net");
    expect(hostsOf("mongodb://u:p@h1:27017,h2:27017/db?replicaSet=rs0")).toBe("h1:27017,h2:27017");
    expect(hostsOf("redis://:secret@cache.redis.cache.windows.net:6380")).toBe("cache.redis.cache.windows.net:6380");
    expect(hostsOf("rediss://default:secret@cache.example.com:6380/0")).toBe("cache.example.com:6380");
  });

  it("works without credentials", () => {
    expect(hostsOf("mongodb://localhost:27017")).toBe("localhost:27017");
    expect(hostsOf("redis://127.0.0.1:6379/2")).toBe("127.0.0.1:6379");
  });

  it("never lets a badly written password through, even one with an @ or a / in it", () => {
    expect(hostsOf("mongodb://user:pa@ss/word@host.example.com:27017/chef")).toBe("host.example.com:27017");
    expect(hostsOf("mongodb://user:pa/ssword@host.example.com/chef")).toBe("host.example.com");
    for (const uri of ["mongodb://user:pa@ss/word@host.example.com/chef", "mongodb://user:pa/ssword@host.example.com/chef"]) {
      expect(hostsOf(uri)).not.toContain("pa");
    }
  });

  it("says so when there is no host at all", () => {
    expect(hostsOf("")).toMatch(/no host/);
    expect(hostsOf("mongodb://")).toMatch(/no host/);
  });
});

describe("the error written when a server cannot be reached", () => {
  const mongoUri = "mongodb://user:topsecret@cluster0.abc.mongodb.net/chef";
  const timedOut = new Error("Server selection timed out after 10000 ms");

  it("names the service, the server and the database, keeps the driver's reason and what to check", () => {
    const error = connectionFailure("MongoDB", mongoUri, timedOut, { detail: 'database "chef"' });

    expect(error.message).toContain("Could not connect to MongoDB (cluster0.abc.mongodb.net, database \"chef\")");
    expect(error.message).toContain("Server selection timed out after 10000 ms");
    expect(error.message).toContain("MONGODB_URI");
    expect(error.message).toMatch(/Network Access|IP access list/);
    expect(error.cause).toBe(timedOut);
  });

  it("never contains the password", () => {
    for (const reason of [timedOut, new Error("Authentication failed."), new Error("getaddrinfo ENOTFOUND cluster0.abc.mongodb.net")]) {
      expect(connectionFailure("MongoDB", mongoUri, reason).message).not.toContain("topsecret");
    }
    expect(connectionFailure("Redis", "rediss://:redissecret@cache.example.com:6380", new Error("WRONGPASS")).message).not.toContain("redissecret");
  });

  it("tells a refused password from an unreachable server and from a host that does not exist", () => {
    expect(connectionFailure("MongoDB", mongoUri, new Error("Authentication failed.")).message).toMatch(/user or the password.*percent-encoded/);
    expect(connectionFailure("MongoDB", mongoUri, new Error("querySrv ENOTFOUND _mongodb._tcp.cluster0.abc.mongodb.net")).message).toMatch(/does not resolve/);
    expect(connectionFailure("MongoDB", mongoUri, timedOut).message).toMatch(/No server answered/);
  });

  it("points out a database address that is this very machine, when the app is hosted", () => {
    const local = "mongodb://127.0.0.1:27017";

    expect(connectionFailure("MongoDB", local, timedOut, { production: true }).message).toMatch(/same machine \(localhost\)/);
    // On a developer's own computer that is exactly right, so it is not scolded.
    expect(connectionFailure("MongoDB", local, timedOut, { production: false }).message).not.toMatch(/same machine/);
  });

  it("says what Redis needs: its password, and TLS when it is hosted", () => {
    expect(connectionFailure("Redis", "redis://:x@cache.example.com:6380", new Error("WRONGPASS invalid username-password pair")).message).toMatch(/user or the password in REDIS_URL/);
    expect(connectionFailure("Redis", "redis://cache.example.com:6380", new Error("connect ETIMEDOUT")).message).toMatch(/rediss:\/\/.*6380/);
    expect(connectionFailure("Redis", "rediss://cache.example.com:6380", new Error("connect ETIMEDOUT")).message).not.toMatch(/usually needs rediss/);
    expect(connectionFailure("Redis", "redis://localhost:6379", new Error("connect ECONNREFUSED"), { production: true }).message).toMatch(/same machine \(localhost\)/);
  });
});

describe("starting with servers that cannot be reached", () => {
  const base = { NODE_ENV: "test", AUTH_MODE: "jwt", JWT_SECRET: "j".repeat(40), DEV_GOOGLE_AUTH: "1" };

  it("stops with a message about MongoDB instead of the driver's bare one, and without the password", async () => {
    const config = loadConfig({ ...base, MONGODB_URI: "mongodb://user:topsecret@127.0.0.1:1/chef" });

    const failure = await createAccountsFromConfig(config, quiet, { connectTimeoutMs: 300 }).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure?.message).toContain("Could not connect to MongoDB (127.0.0.1:1");
    expect(failure?.message).toContain('database "chef"');
    expect(failure?.message).not.toContain("topsecret");
  });

  it("stops with a message about Redis instead of waiting for ever", async () => {
    const config = loadConfig({ ...base, REDIS_URL: "redis://:topsecret@127.0.0.1:1" });
    const started = Date.now();

    const failure = await createAccountsFromConfig(config, quiet, { connectTimeoutMs: 300 }).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure?.message).toContain("Could not connect to Redis (127.0.0.1:1)");
    expect(failure?.message).toContain("REDIS_URL");
    expect(failure?.message).not.toContain("topsecret");
    // A few quick tries, not minutes: a start that hangs says nothing in a deployment log.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);
});
