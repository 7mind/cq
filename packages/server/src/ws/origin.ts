/**
 * Same-origin check for WebSocket upgrades.
 *
 * The canonical same-origin invariant for an upgrade is: the request's
 * `Origin` header authority (host:port) must equal the request's `Host`
 * header authority. Both are sent by the browser; if they match, the page
 * was served from the same authority it's now opening a WS to.
 *
 * Why NOT compare against the server's bind config: when the server binds
 * to `0.0.0.0`, it can be reached via any DNS name resolving to one of its
 * interfaces (`vm`, the VPN IP, etc.). The bind host string is "the listen
 * address", not "the public name" — comparing against it spuriously
 * rejects legitimate requests from the configured names.
 *
 * Returns true iff:
 *   - both `Origin` and `Host` headers are present and parsable
 *   - their authorities (host + port, with default-port normalization)
 *     are byte-equal
 *
 * Rejection strategy (PR-06 option A): the caller rejects pre-upgrade with
 * HTTP 403. `srv.upgrade` is never called for bad origins. The 1008
 * POLICY_VIOLATION close code is reserved for client-side classification;
 * the server never emits it for Origin failures.
 */
export function isOriginAllowed(request: Request): boolean {
  const originHeader = request.headers.get("Origin");
  if (originHeader === null || originHeader === "") return false;

  const hostHeader = request.headers.get("Host");
  if (hostHeader === null || hostHeader === "") return false;

  let originUrl: URL;
  try {
    originUrl = new URL(originHeader);
  } catch {
    return false;
  }

  const originAuthority = normalizeAuthority(
    originUrl.hostname,
    originUrl.port !== ""
      ? Number(originUrl.port)
      : originUrl.protocol === "https:"
        ? 443
        : 80,
  );

  // `Host` is `name` or `name:port`. We treat WS upgrades as ws://, so default
  // port is 80 when omitted. (Production deployments per the brief don't use
  // wss:// — same VPN deployment context — but the comparison is consistent
  // either way because the browser uses the same default for both.)
  const colonIdx = hostHeader.lastIndexOf(":");
  // IPv6 addresses contain colons; only treat the last colon as a port
  // separator if it's after the closing `]`.
  const hasPort = colonIdx !== -1 && hostHeader.lastIndexOf("]") < colonIdx;
  const hostName = hasPort ? hostHeader.slice(0, colonIdx) : hostHeader;
  const hostPort = hasPort ? Number(hostHeader.slice(colonIdx + 1)) : 80;
  if (!Number.isInteger(hostPort)) return false;

  const hostAuthority = normalizeAuthority(hostName, hostPort);

  return originAuthority === hostAuthority;
}

function normalizeAuthority(host: string, port: number): string {
  // Strip IPv6 brackets so `[::1]` and `::1` compare equal.
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return `${h.toLowerCase()}:${port}`;
}
