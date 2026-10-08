/**
 * What the log says when the database or Redis cannot be reached at startup. The driver's own message ("Server selection timed out after
 * 10000 ms") says nothing about *which* server or what to check, which is all a person reading a deployment log has to go on. The
 * connection string holds the password, so only its host part is ever written.
 */

/** The host part of a connection string: no user, no password, no database, no options. */
export function hostsOf(connectionString: string): string {
  const withoutScheme = connectionString.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  // Everything up to the last "@" is credentials (a password may contain odd characters), so the host starts after it.
  const afterCredentials = withoutScheme.slice(withoutScheme.lastIndexOf("@") + 1);
  const hosts = afterCredentials.split(/[/?#]/, 1)[0] ?? "";
  return hosts.length > 0 ? hosts : "(no host in the connection string)";
}

const isLocal = (hosts: string) => /(^|,)(localhost|127\.0\.0\.1|\[?::1\]?)(:|,|$)/i.test(hosts);

function mongoAdvice(reason: string, hosts: string, production: boolean): string {
  if (/authentication failed|bad auth|AuthenticationFailed/i.test(reason)) {
    return "The server refused the user or the password in MONGODB_URI. Check them; characters such as @ : / ? # in a password must be percent-encoded.";
  }
  if (/ENOTFOUND|EAI_AGAIN|querySrv|getaddrinfo/i.test(reason)) {
    return "The host name does not resolve. Check the host in MONGODB_URI (for a mongodb+srv:// address, the cluster name).";
  }
  if (production && isLocal(hosts)) {
    return "MONGODB_URI points at this same machine (localhost), but a hosted app has no database there. Set it to the connection string of the hosted database.";
  }
  return (
    "No server answered. Check that MONGODB_URI has the right host and that the database accepts connections from where the API runs: " +
    "on MongoDB Atlas, Network Access (the IP access list) must include the app's outbound IP addresses (on Azure App Service they are listed under Networking); " +
    "on Azure Cosmos DB, the firewall and private-network settings."
  );
}

function redisAdvice(reason: string, hosts: string, url: string, production: boolean): string {
  if (/WRONGPASS|NOAUTH|invalid password|ERR AUTH|NOPERM/i.test(reason)) {
    return "Redis refused the user or the password in REDIS_URL. Check them (Azure Cache for Redis: the access key).";
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(reason)) {
    return "The host name does not resolve. Check the host in REDIS_URL.";
  }
  if (production && isLocal(hosts)) {
    return "REDIS_URL points at this same machine (localhost), but a hosted app has no Redis there. Set it to the hosted Redis' address.";
  }
  const tlsHint = url.toLowerCase().startsWith("redis://") && !isLocal(hosts) ? " A hosted Redis usually needs rediss:// (TLS; Azure Cache for Redis listens for it on port 6380)." : "";
  return `No server answered. Check that REDIS_URL has the right host and port and that the firewall lets this app in.${tlsHint}`;
}

/** An error to throw instead of the driver's, saying what was being reached and what to check. The original is kept as its `cause`. */
export function connectionFailure(
  service: "MongoDB" | "Redis",
  connectionString: string,
  error: unknown,
  options: { production?: boolean; detail?: string } = {},
): Error {
  const reason = error instanceof Error ? error.message : String(error);
  const hosts = hostsOf(connectionString);
  const production = options.production ?? false;
  const advice = service === "MongoDB" ? mongoAdvice(reason, hosts, production) : redisAdvice(reason, hosts, connectionString, production);
  const where = options.detail ? `${hosts}, ${options.detail}` : hosts;
  return new Error(`Could not connect to ${service} (${where}): ${reason}. ${advice}`, { cause: error });
}
