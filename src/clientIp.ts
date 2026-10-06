/**
 * Rate-limit key for a client. Some reverse proxies append the client's *ephemeral source port* to the
 * address in X-Forwarded-For ("203.0.113.7:51234", "[2001:db8::1]:51234"). Fastify then reports that
 * string as `request.ip`, so every new connection from the same user would get a fresh key and a
 * per-client limit would silently never trigger. Normalise to the bare address.
 */
export function clientKey(ip: string): string {
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(ip);
  if (ipv4WithPort?.[1]) return ipv4WithPort[1];

  const ipv6WithPort = /^\[([0-9a-fA-F:.]+)\]:\d{1,5}$/.exec(ip);
  if (ipv6WithPort?.[1]) return ipv6WithPort[1];

  return ip;
}
