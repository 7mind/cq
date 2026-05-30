/**
 * phaseTimeout.ts — shared resolution of the /plan workflow phase-dispatch
 * timeout, used by all three headless lanes (claudeProducer, claudePhaseSubagent,
 * codexHeadless).
 *
 * Why 300 s (was 120 s): PLAN-D01 gave phase subagents read-only repo access plus
 * an "explore the repository first" instruction, so every phase now reads
 * CLAUDE.md / source / ledgers and reasons over the answered Q&A before
 * submitting. On a large repo a clarify-reviewer / planner digesting that context
 * exceeds the old 120 s budget (observed: `clarify-reviewer#1` timed out in a live
 * dogfood). See defects.md PHASE-TIMEOUT-01. The deeper "explore once in the
 * producer and pass grounding to later phases" optimization is a SEPARATE cycle.
 *
 * Resolution order per dispatch:
 *   1. explicit `optTimeoutMs` (when provided — tests inject short timeouts here),
 *   2. `CQ_WORKFLOW_PHASE_TIMEOUT_MS` env var (when a valid positive integer),
 *   3. `DEFAULT_PHASE_TIMEOUT_MS` (300_000).
 */

/** Default phase-dispatch timeout: 5 minutes. */
export const DEFAULT_PHASE_TIMEOUT_MS = 300_000;

/** Env var that overrides the default phase-dispatch timeout. */
export const PHASE_TIMEOUT_ENV_VAR = "CQ_WORKFLOW_PHASE_TIMEOUT_MS";

/**
 * Parse the env override. Returns the parsed value only when it is a valid
 * positive integer (e.g. "300000"); otherwise `undefined` so the caller falls
 * back to the default. Rejects: absent, empty, non-numeric ("abc"), non-positive
 * ("0", "-1"), and non-integer / trailing-garbage ("1.5", "100ms").
 */
function parseEnvTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  // Require a pure positive-integer token — reject floats and trailing garbage
  // that Number()/parseInt would otherwise silently coerce.
  if (!/^[0-9]+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/**
 * Resolve the effective phase-dispatch timeout in ms.
 *
 * @param optTimeoutMs explicit per-dispatch override (e.g. injected by tests);
 *   when provided it ALWAYS wins, even over the env var.
 * @param env environment to read `CQ_WORKFLOW_PHASE_TIMEOUT_MS` from
 *   (defaults to `process.env`; injectable for tests).
 */
export function resolvePhaseTimeoutMs(
  optTimeoutMs?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (optTimeoutMs !== undefined) return optTimeoutMs;
  const fromEnv = parseEnvTimeoutMs(env[PHASE_TIMEOUT_ENV_VAR]);
  if (fromEnv !== undefined) return fromEnv;
  return DEFAULT_PHASE_TIMEOUT_MS;
}
