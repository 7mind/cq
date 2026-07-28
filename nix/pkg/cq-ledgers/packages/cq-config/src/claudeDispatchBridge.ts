/**
 * T688 — the EXECUTABLE Claude-surface bridge for the ref-first dispatch
 * protocol tasks:T687 defined.
 *
 * T687's {@link ./claudeDispatchProtocol} is inert by design: it classifies,
 * correlates, gates and decides, but it launches nothing and drives no
 * lifecycle. This module is the part that RUNS — it composes T687's decisions
 * with the REAL shared service in {@link ./dispatchAttestation}
 * (`prepareDispatch` / `storeDispatchResult` / `confirmDispatchCompletion` /
 * `abortDispatch` / `fetchDispatchResult`) and re-implements NONE of it.
 *
 * TODO(T688): sections land incrementally; see the section banners below.
 */

/** The task that defines the protocol this module implements. */
export const CLAUDE_BRIDGE_DEFINED_BY = "T687" as const;

/** The task that proves this implementation end to end against a live child. */
export const CLAUDE_BRIDGE_PROVEN_BY = "T689" as const;
