const MANAGER_OWNED_RELEASE_RESULTS = new WeakSet<object>();

/** Package-internal bridge used only by the managed-worktree implementation. */
export function recordManagerOwnedReleaseResult<T extends object>(value: T): T {
  MANAGER_OWNED_RELEASE_RESULTS.add(value);
  return value;
}

export function isManagerOwnedReleaseResult(value: unknown): boolean {
  return typeof value === "object" && value !== null && MANAGER_OWNED_RELEASE_RESULTS.has(value);
}
