import { isSafeProjectKey } from "@cq/ledger/projectKeySafety";

/**
 * Match a per-project route pathname `/p/<projectKey>/<leaf>` where `<leaf>` is
 * `mcp` or `ws`. Returns the decoded `projectKey` + `leaf`, or `null` when the
 * pathname is not a per-project route. `<projectKey>` is a single path segment.
 */
export function matchAdminProjectRoute(
  pathname: string,
): { projectKey: string } | null {
  const match = /^\/p\/([^/]+)\/admin\/mcp$/.exec(pathname);
  if (match === null) return null;
  let projectKey: string;
  try {
    projectKey = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  return { projectKey };
}

export function matchProjectRoute(
  pathname: string,
): { projectKey: string; leaf: "mcp" | "ws" } | null {
  const match = /^\/p\/([^/]+)\/(mcp|ws)$/.exec(pathname);
  if (match === null) return null;
  // D138: malformed percent-encoding (e.g. `%ZZ`) must not throw into the
  // hub fetch handler — treat it as a non-match so the caller can 400.
  let projectKey: string;
  try {
    projectKey = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  return {
    projectKey,
    leaf: match[2] as "mcp" | "ws",
  };
}

/** The per-project Bun pub/sub topic for live-change frames. */
export function hubTopic(projectKey: string): string {
  return `ledger:${projectKey}`;
}

/**
 * True when `key` is safe to route into `/p/<key>/{mcp,ws}` — non-blank, not
 * a `.`/`..` dot-segment, and free of path separators or NUL. Delegates to
 * `@cq/ledger`'s single canonical predicate (`isSafeProjectKey`,
 * packages/ledger/src/projectKeySafety.ts, node-free) shared with the
 * server-side route/runtime guards (xdgProjectRuntime.ts, xdgCatalogServe.ts)
 * — imported via the `@cq/ledger/projectKeySafety` leaf export so this module
 * stays importable from the browser bundle (T837 initial-connection seam,
 * main.tsx) without pulling `node:path` (or any other node built-in) into it
 * (T837 round-1 fix / D143 criticism 2: one source of truth, not three).
 */
export function isSafeProjectKeySegment(key: string): boolean {
  return isSafeProjectKey(key);
}
