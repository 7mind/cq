/**
 * cq.toml data model (T170).
 *
 * Pure, typed domain types — no transport/MCP concerns. A `ReviewerToken`
 * names a reviewer harness + model; a `CqConfig` is the fully-parsed (but
 * not yet alias-resolved) configuration: the `[aliases]` table plus the
 * top-level `reviewers` list of alias names.
 */

/** The two reviewer harnesses cq knows how to drive. */
export const HARNESSES = ["claude", "pi"] as const;

/** A reviewer harness identifier (the part before the `:` in a token). */
export type Harness = (typeof HARNESSES)[number];

/**
 * A reviewer token parsed from a `"<harness>:<model>"` string, e.g.
 * `"claude:opus-4.8"` => `{ harness: "claude", model: "opus-4.8" }`.
 */
export interface ReviewerToken {
  readonly harness: Harness;
  readonly model: string;
}

/**
 * The parsed cq.toml configuration.
 *
 * - `aliases`: the `[aliases]` table, each value parsed into a ReviewerToken.
 * - `reviewers`: the top-level `reviewers = [...]` list of ALIAS names
 *   (not yet resolved — see `resolveReviewers`).
 */
export interface CqConfig {
  readonly aliases: Record<string, ReviewerToken>;
  readonly reviewers: readonly string[];
}

/** Type guard: is `value` a known harness? */
export function isHarness(value: string): value is Harness {
  return (HARNESSES as readonly string[]).includes(value);
}
