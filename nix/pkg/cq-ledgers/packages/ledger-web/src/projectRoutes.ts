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
