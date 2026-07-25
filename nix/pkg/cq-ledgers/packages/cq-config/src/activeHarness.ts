/**
 * Active-harness resolution from the process environment (T473, Q238).
 *
 * cq runs under one of the ACTIVE CONFIGURATION SELECTORS
 * ({@link ActiveHarness}: "claude" | "pi" | "codex"). At runtime we need to
 * know WHICH one launched the current invocation so the config layer can pick
 * the matching `[harness.<name>]` block.
 *
 * NOTE the domain (T861): this resolver ranges over {@link ActiveHarness}, NOT
 * over the narrower EXECUTABLE {@link Harness} dispatch-token domain. `codex`
 * selects a configuration block; it is never a dispatchable reviewer/planner
 * transport. The resolution rule (Q238 decision) is, in priority order:
 *
 *  1. An EXPLICIT `CQ_HARNESS` signal wins. `nix/hm/pi.nix` sets
 *     `CQ_HARNESS=pi` when it launches pi (wired in a later task); we also
 *     honour `CQ_HARNESS=claude` for symmetry and `CQ_HARNESS=codex` for a
 *     Codex-hosted invocation. Any other non-empty value is a CqConfigError
 *     (fail fast — an unknown selector is a configuration error, not a silent
 *     fallback).
 *  2. Else, if `CLAUDE_CODE_SESSION_ID` is a non-empty string, the invocation
 *     runs under Claude Code => "claude".
 *  3. Else default to {@link DEFAULT_HARNESS} ("claude"), preserving today's
 *     behaviour for a bare `cq` invocation with no signal.
 *
 * {@link resolveActiveHarness} is a PURE function over an injected env map (no
 * direct `process.env` read inside) so it is unit-testable;
 * {@link resolveActiveHarnessFromProcess} is the thin boundary convenience that
 * reads `process.env`.
 */

import {
  activeHarnessList,
  isActiveHarness,
  type ActiveHarness,
} from "./types.js";
import { CqConfigError } from "./config.js";

/** The environment variable that carries an explicit harness signal. */
export const CQ_HARNESS_ENV = "CQ_HARNESS";

/** The Claude Code session-id env var; its presence implies the claude harness. */
export const CLAUDE_CODE_SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";

/**
 * The selector assumed when no signal is present (Q238). "claude" preserves
 * today's behaviour for a bare `cq` invocation.
 */
export const DEFAULT_HARNESS: ActiveHarness = "claude";

/**
 * Resolve the active configuration selector from an injected environment map
 * (pure).
 *
 * See the module docstring for the Q238 priority rule. Throws a precise
 * {@link CqConfigError} when `CQ_HARNESS` is set to a non-empty value that is
 * not a known selector.
 */
export function resolveActiveHarness(
  env: Record<string, string | undefined>,
): ActiveHarness {
  const explicit = env[CQ_HARNESS_ENV];
  if (explicit !== undefined && explicit !== "") {
    if (!isActiveHarness(explicit)) {
      throw new CqConfigError(
        `${CQ_HARNESS_ENV}="${explicit}" is not a known harness (expected ${activeHarnessList()})`,
      );
    }
    return explicit;
  }

  const claudeSession = env[CLAUDE_CODE_SESSION_ID_ENV];
  if (typeof claudeSession === "string" && claudeSession !== "") {
    return "claude";
  }

  return DEFAULT_HARNESS;
}

/**
 * Thin boundary convenience: resolve the active selector from `process.env`.
 *
 * Delegates to {@link resolveActiveHarness}; keep the impure `process.env`
 * read confined here so the resolver stays unit-testable.
 */
export function resolveActiveHarnessFromProcess(): ActiveHarness {
  return resolveActiveHarness(process.env);
}
