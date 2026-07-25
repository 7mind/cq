/**
 * Match a per-project route pathname `/p/<projectKey>/<leaf>` where `<leaf>` is
 * `mcp` or `ws`. Returns the decoded `projectKey` + `leaf`, or `null` when the
 * pathname is not a per-project route. `<projectKey>` is a single path segment.
 */
export function matchProjectRoute(
  pathname: string,
): { projectKey: string; leaf: "mcp" | "ws" } | null {
  const match = /^\/p\/([^/]+)\/(mcp|ws)$/.exec(pathname);
  if (match === null) return null;
  return {
    projectKey: decodeURIComponent(match[1]!),
    leaf: match[2] as "mcp" | "ws",
  };
}

/** The per-project Bun pub/sub topic for live-change frames. */
export function hubTopic(projectKey: string): string {
  return `ledger:${projectKey}`;
}

/**
 * True when `key` is safe to route into `/p/<key>/{mcp,ws}` — non-blank, not
 * a `.`/`..` dot-segment, and free of path separators or NUL. Mirrors
 * `@cq/ledger`'s `isSafeProjectKey` (packages/ledger/src/store/sqlite/xdgProjectRuntime.ts,
 * the server-side route/runtime guard), REIMPLEMENTED here without
 * `node:path` so this module stays importable from the browser bundle (T837
 * initial-connection seam, main.tsx) — this file has no node built-ins,
 * unlike the full `@cq/ledger` index. The two predicates must be kept in
 * sync; `path.isAbsolute` adds no case beyond the slash/backslash checks
 * already here (an absolute POSIX/win32 path always contains one).
 */
export function isSafeProjectKeySegment(key: string): boolean {
  return !(
    key.length === 0 ||
    key.trim().length === 0 ||
    key === "." ||
    key === ".." ||
    key.includes("/") ||
    key.includes("\\") ||
    key.includes("\0")
  );
}
