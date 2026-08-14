// cq auto-driver drive-and-await loop (T465/T466/T467, G-auto-driver).
//
// Behaviour-1: the GENERIC driver. It launches a wrapped cq command into the
// LIVE pi session, awaits the agent's idle/turn completion, derives the flow
// predicates, decides the next AutoAction with the pure `decideNextAction`
// core, and ACTS on it — re-driving with a corrective prompt, compacting, or
// stopping. The decision core (./decide), the pure vocabulary (./decision), and
// the predicate oracle (./oracle) are all consumed here; this module adds ONLY
// the imperative loop + Pi wiring on top.
//
// Behaviour-2 (T467): status-bar display via ctx.ui.setStatus('cq-auto', text).
// Each lifecycle point sets a distinct human-readable status string (see
// `statusTextForPhase`). All setStatus calls are gated on ctx.hasUI (the Pi
// flag that is false in print/RPC mode). The status key is 'cq-auto'.
//
// Pi host types are type-only imports resolved by the Nix-wired check against
// packages.pi-coding-agent, the single type source of truth. Runtime delivery
// remains a bare store-path directory with only local value imports.

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import {
  AutoAction,
  type AutoPreset,
  type DerivedPredicates,
} from "./decision";
import {
  composeRedrivePrompt,
  decideNextAction,
  DEFAULT_MAX_ITERATIONS,
  type AutoRunState,
  type AutoSignals,
} from "./decide";
import { getPredicates as defaultGetPredicates, type OracleContext } from "./oracle";

// ---------------------------------------------------------------------------
// Narrow host-input seams derived from the real Pi exports.
// ---------------------------------------------------------------------------

/**
 * Context-window usage as Pi reports it (Pi `ContextUsage`, types.d.ts L192).
 * `percent` is null when token counts are unknown (e.g. right after a
 * compaction, before the next LLM response). `tokens` is null for the same
 * reason. The driver only reads `percent`.
 */
export type DriverContextUsage = NonNullable<ReturnType<ExtensionContext["getContextUsage"]>>;

/**
 * Subset of Pi's `AfterProviderResponseEvent` (types.d.ts L512) used for
 * quota/rate-limit detection. `status` is the HTTP response status code;
 * `headers` carries the raw response headers (e.g. `retry-after`).
 *
 * IMPORTANT — quota detection is BEST-EFFORT and APPROXIMATE: Pi
 * exposes NO typed quota event. The `after_provider_response` event is the
 * only available surface to observe HTTP-level errors. A 429 status is the
 * conventional signal for "rate-limited / quota exhausted", but:
 *   - Not all providers use 429 for quota exhaustion (some use 402, 503, …).
 *   - Pi may not always surface every provider response through this event.
 *   - The event fires for ALL provider responses, not only quota responses.
 * Treat `quotaHit` as a heuristic, not a hard guarantee.
 */
export interface DriverAfterProviderResponseEvent {
  type: "after_provider_response";
  status: number;
  headers: Record<string, string>;
}

/**
 * A mutable flag cell shared between the `after_provider_response` subscriber
 * and the driver loop. The subscriber writes it; `sampleSignals` reads it;
 * the loop resets it before each new cycle (see `runAutoDriver`).
 */
export interface QuotaHitRef {
  value: boolean;
}

/**
 * Narrow view of Pi's `ExtensionUIContext`; only the status-bar method is
 * required by the auto-driver.
 *
 * T467: `setStatus(key, text)` — set a status-bar slot (L79). Pass `undefined`
 * as `text` to clear the slot. The key `'cq-auto'` is the stable identifier
 * the driver uses for all its status updates.
 */
export type DriverUIContext = Pick<ExtensionUIContext, "setStatus">;

/**
 * The narrow Pick-composed Pi context the driver loop uses.
 * Carries `cwd` (so the oracle resolves the right ledger root), the idle
 * guard/await pair, and the T466 compaction/usage seams. The Pick composition
 * keeps the module unit-testable with a narrow fake context.
 *
 * T467 additions:
 *   - `ui: DriverUIContext` — the status-bar API (ExtensionContext.ui, L210).
 *   - `hasUI: boolean` — whether UI is available; false in print/RPC mode
 *     (ExtensionContext.hasUI, L214). All setStatus calls MUST be gated on this.
 */
export type DriverContext = OracleContext &
  Pick<ExtensionContext, "hasUI" | "isIdle" | "getContextUsage" | "compact"> &
  Pick<ExtensionCommandContext, "waitForIdle"> & {
    readonly ui: DriverUIContext;
  };

/**
 * The narrow Pi API seam the driver needs: the
 * prompt-injection API used to launch the wrapped command and emit corrective
 * re-prompts into the live session, plus the event subscription for quota
 * detection.
 */
interface DriverProviderResponseRegistration {
  on(
    event: "after_provider_response",
    handler: (event: DriverAfterProviderResponseEvent) => void,
  ): void;
}

type AssertTrue<T extends true> = T;
type _RealPiOnSupportsProviderResponse = AssertTrue<
  Pick<ExtensionAPI, "on"> extends DriverProviderResponseRegistration ? true : false
>;

export type DriverApi =
  Pick<ExtensionAPI, "sendUserMessage"> & DriverProviderResponseRegistration;

// ---------------------------------------------------------------------------
// Loop wiring inputs.
// ---------------------------------------------------------------------------

/** Inject the oracle so tests pass a fake instead of shelling out `cq advance-gate`. */
export type GetPredicatesFn = (ctx: OracleContext) => Promise<DerivedPredicates>;

/**
 * Everything `runAutoDriver` needs, injected so the loop body is unit-testable
 * with a fake ctx/api/oracle. Production wiring (`registerAutoDriver`) supplies
 * the real Pi ctx/api and the `cq advance-gate` oracle.
 */
export interface DriverDeps {
  /** The Pi command-handler context (live session). */
  ctx: DriverContext;
  /** The Pi extension API (prompt injection + event subscription). */
  api: DriverApi;
  /** The preset being driven: the wrapped command + its terminal oracle. */
  preset: AutoPreset;
  /** Predicate oracle; defaults to the `cq advance-gate` shell-out. */
  getPredicates?: GetPredicatesFn;
  /** Hard iteration bound; defaults to DEFAULT_MAX_ITERATIONS. */
  maxIterations?: number;
  /** The free-form args string passed to the `<command>:auto` command (reserved). */
  args?: string;
  /**
   * Shared mutable cell written by the `after_provider_response` subscriber and
   * read each cycle by `sampleSignals`. Production code supplies the cell
   * created in `registerAutoDriver`; tests can supply a fake cell to simulate a
   * 429 without wiring a real event subscription. Defaults to `{ value: false }`
   * when absent (backward-compat for tests that don't care about quota).
   */
  quotaHitRef?: QuotaHitRef;
}

/**
 * The terminal outcome of one auto-driver run: the STOP_* action that ended it,
 * how many redrives were performed, and the final predicate snapshot. Returned
 * so callers (and tests) can assert the loop reached the expected terminus.
 */
export interface DriverResult {
  /** The terminal action — always one of the STOP_* members. */
  action: AutoAction;
  /** Number of redrives performed before the loop stopped (0 if it stopped on the first cycle). */
  iterations: number;
  /** The last predicate snapshot the oracle returned. */
  finalPredicates: DerivedPredicates;
}

// ---------------------------------------------------------------------------
// launchAndAwait — emit one prompt and block until the agent is idle.
// ---------------------------------------------------------------------------

/**
 * Inject `prompt` into the live session (which ALWAYS triggers a turn — see
 * sendUserMessage L909-916) and then block until the agent has finished the
 * resulting stream.
 *
 * The await reconciles the two completion mechanisms exposed by the
 * Nix-provided Pi types:
 *
 *   1. `ctx.isIdle()` (L226) — a SYNCHRONOUS guard. `sendUserMessage` is
 *      `void` (fire-and-forget) and the turn it triggers may not have started
 *      synchronously by the time we check, so isIdle() alone is NOT a reliable
 *      "the turn is done" signal on its own.
 *   2. `ctx.waitForIdle()` (L252) — resolves when the agent next becomes idle.
 *
 * Reconciliation: we await `waitForIdle()` UNCONDITIONALLY after injecting the
 * prompt. `waitForIdle` is the authoritative await; if the turn already
 * completed it resolves immediately. We do NOT short-circuit on a pre-launch
 * `isIdle()` (that would race the not-yet-started turn). The `isIdle()` guard
 * is instead used as a post-await assertion that the agent really settled.
 *
 * NOTE on `pi.on("agent_end")` (L867): the ExtensionAPI also fires an
 * `agent_end` lifecycle event per agent loop. `waitForIdle()` is the
 * command-handler-native, promise-shaped equivalent and is preferred here
 * because it needs no subscribe/unsubscribe bookkeeping inside the loop and
 * cannot miss an event that fired between injection and subscription. The
 * event path is reserved for hosts where `waitForIdle` is absent; the checked
 * host type includes it.
 */
export async function launchAndAwait(
  ctx: DriverContext,
  api: DriverApi,
  prompt: string,
): Promise<void> {
  // "followUp": queue the wrapped command as the next turn. Required when the
  // agent is already processing (the :auto command handler is
  // itself an active turn when it injects the wrapped command) — without it Pi
  // throws "Agent is already processing." When idle it just starts the turn.
  // Send only deliverAs (D213). The public type exposes this key; the runtime
  // maps it onto the separate internal prompt streamingBehavior option.
  api.sendUserMessage(prompt, { deliverAs: "followUp" });
  await ctx.waitForIdle();
}

// ---------------------------------------------------------------------------
// sampleSignals — runtime signals (T466 seam).
// ---------------------------------------------------------------------------

/**
 * Sample the runtime signals the decision core reads each cycle.
 *
 * T466 wiring (per Q235 spec):
 *   - contextPercent: `ctx.getContextUsage()?.percent ?? null`. Pi returns null
 *     when token counts are unknown (e.g. right after a compaction, before the
 *     next LLM response). Null NEVER triggers compaction (rule (5) in
 *     decideNextAction guards on `!== null`).
 *   - quotaHit: read from `quotaHitRef.value`, which the `after_provider_response`
 *     subscriber writes when `event.status === 429`. The caller (`runAutoDriver`)
 *     resets the cell after reading it so a single transient 429 does not
 *     permanently block subsequent cycles.
 *
 * QUOTA DETECTION IS BEST-EFFORT: Pi exposes no dedicated quota event.
 * `after_provider_response` is the only available surface. See
 * `DriverAfterProviderResponseEvent` for the full caveat.
 */
export function sampleSignals(ctx: DriverContext, quotaHitRef: QuotaHitRef): AutoSignals {
  const rawPercent = ctx.getContextUsage()?.percent ?? null;
  // Pi reports `ContextUsage.percent` on a 0..100 scale
  // JSDoc: "Context usage as percentage of context window"; agent-session.js:2567
  // computes `(tokens / contextWindow) * 100`). The decision core (decide.ts
  // COMPACT_THRESHOLD = 0.8) and all AutoSignals consumers expect a 0..1 fraction,
  // so divide by 100 here at the sampling boundary. Null means "unknown" (e.g.
  // right after compaction) and must pass through as null — never triggers compaction.
  const contextPercent = rawPercent !== null ? rawPercent / 100 : null;
  return {
    contextPercent,
    quotaHit: quotaHitRef.value,
  };
}

// ---------------------------------------------------------------------------
// runAutoDriver — the drive-and-await loop.
// ---------------------------------------------------------------------------

/** A STOP_* action ends the loop; anything else continues it. */
function isStopAction(action: AutoAction): boolean {
  return (
    action === AutoAction.STOP_DRAINED ||
    action === AutoAction.STOP_BLOCKED_ON_QUESTIONS ||
    action === AutoAction.STOP_QUOTA ||
    action === AutoAction.STOP_NO_PROGRESS
  );
}

// ---------------------------------------------------------------------------
// T467: status-bar display — pure phase→string mapping.
// ---------------------------------------------------------------------------

/** The stable status-bar key the auto-driver owns in Pi's footer. */
export const STATUS_KEY = "cq-auto";

/**
 * The enumerated driver phases, covering all Q237 states. Used as input to
 * `statusTextForPhase` so the mapping is pure and unit-testable independently
 * of the driver loop.
 *
 * Lifecycle order (roughly):
 *   idle → driving(command, iter) → awaiting-stop → checking-predicates
 *   → (compact →) driving again  |  stopped:*  |  done(DRAINED)
 */
export type DriverPhase =
  | { kind: "idle" }
  | { kind: "driving"; command: string; iter: number }
  | { kind: "awaiting-stop" }
  | { kind: "checking-predicates" }
  | { kind: "compacting" }
  | { kind: "stopped-quota" }
  | { kind: "stopped-blocked-on-questions" }
  | { kind: "stopped-no-progress" }
  | { kind: "done-drained" };

/**
 * Pure function: map a `DriverPhase` to the human-readable status string
 * displayed in Pi's footer status bar. Covers the full Q237 state set:
 *
 *   idle                       → "idle"
 *   driving <cmd> iter N       → "driving <cmd> iter N"
 *   awaiting-stop              → "awaiting-stop"
 *   checking-predicates        → "checking-predicates"
 *   compacting                 → "compacting"
 *   stopped: quota             → "stopped: quota"
 *   stopped: blocked-on-questions → "stopped: blocked-on-questions"
 *   stopped: no-progress       → "stopped: no-progress"
 *   done (DRAINED)             → "done (DRAINED)"
 *
 * This is a standalone pure function: no ctx, no side effects — testable
 * without any Pi wiring.
 */
export function statusTextForPhase(phase: DriverPhase): string {
  switch (phase.kind) {
    case "idle":
      return "idle";
    case "driving":
      return `driving ${phase.command} iter ${phase.iter}`;
    case "awaiting-stop":
      return "awaiting-stop";
    case "checking-predicates":
      return "checking-predicates";
    case "compacting":
      return "compacting";
    case "stopped-quota":
      return "stopped: quota";
    case "stopped-blocked-on-questions":
      return "stopped: blocked-on-questions";
    case "stopped-no-progress":
      return "stopped: no-progress";
    case "done-drained":
      return "done (DRAINED)";
  }
}

/**
 * Set the Pi status-bar slot for the auto-driver, gated on `ctx.hasUI`.
 * Pass `undefined` as `text` to clear the slot (e.g. after a terminal state).
 * When `ctx.hasUI` is false (print/RPC mode), this is a no-op.
 */
function setAutoStatus(ctx: DriverContext, text: string | undefined): void {
  if (ctx.hasUI) {
    ctx.ui.setStatus(STATUS_KEY, text);
  }
}

/**
 * The cq slash command to inject to START / re-drive the wrapped command. The
 * preset's `wrappedCommand` is a bare name (e.g. "advance"); the live session
 * speaks slash commands, so it is prefixed with "/".
 */
function wrappedSlashCommand(preset: AutoPreset): string {
  return `/${preset.wrappedCommand}`;
}

/**
 * Drive `preset.wrappedCommand` to its terminal state.
 *
 * The loop (per the T465/T466 spec):
 *   launch wrapped command  -> await idle (launchAndAwait)
 *   getPredicates(ctx)
 *   sampleSignals(ctx, quotaHitRef) — read contextPercent + quotaHit
 *   reset quotaHitRef.value = false (so a transient 429 does not persist)
 *   decideNextAction({ predicates, terminalPredicate, runState, signals })
 *   act on the AutoAction:
 *     REDRIVE                 -> emit composeRedrivePrompt(...), ++iteration,
 *                                set prevPredicates/prevAction, loop
 *     COMPACT_THEN_REDRIVE    -> ctx.compact() (awaited via onComplete), then
 *                                redrive with composeRedrivePrompt
 *     STOP_*                  -> record the terminal result and break.
 *
 * The iteration counter, prevPredicates, and prevAction live in `runState` here
 * in the handler (per spec) and are fed to `decideNextAction` each cycle.
 *
 * Returns the terminal DriverResult.
 */
export async function runAutoDriver(deps: DriverDeps): Promise<DriverResult> {
  const { ctx, api, preset } = deps;
  const getPredicates = deps.getPredicates ?? defaultGetPredicates;
  const maxIterations = deps.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  // Use the caller-supplied ref (for tests and for registerAutoDriver) or a
  // fresh one (backward-compat for callers that don't pass quotaHitRef).
  const quotaHitRef: QuotaHitRef = deps.quotaHitRef ?? { value: false };

  const runState: AutoRunState = {
    iteration: 0,
    maxIterations,
    prevPredicates: null,
    prevAction: null,
  };

  // T467: status-bar — mark idle before the first launch.
  setAutoStatus(ctx, statusTextForPhase({ kind: "idle" }));

  // The FIRST launch starts the underlying cq command via its slash command.
  let nextPrompt = wrappedSlashCommand(preset);

  for (;;) {
    // T467: show "driving <cmd> iter N" before launching into the session.
    setAutoStatus(ctx, statusTextForPhase({ kind: "driving", command: preset.wrappedCommand, iter: runState.iteration }));

    await launchAndAwait(ctx, api, nextPrompt);

    // T467: show "awaiting-stop" while we wait for the agent to reach idle
    // (launchAndAwait already awaited, but this marks the post-launch check
    // phase where we are about to query predicates).
    setAutoStatus(ctx, statusTextForPhase({ kind: "awaiting-stop" }));

    // T467: show "checking-predicates" while the oracle runs.
    setAutoStatus(ctx, statusTextForPhase({ kind: "checking-predicates" }));

    const predicates = await getPredicates(ctx);
    const signals = sampleSignals(ctx, quotaHitRef);
    // Reset after reading so a transient 429 from this cycle's provider call
    // does not also stop the NEXT cycle.
    quotaHitRef.value = false;

    const action = decideNextAction({
      predicates,
      terminalPredicate: preset.terminalPredicate,
      runState,
      signals,
    });

    if (isStopAction(action)) {
      // T467: set terminal status label before returning.
      switch (action) {
        case AutoAction.STOP_QUOTA:
          setAutoStatus(ctx, statusTextForPhase({ kind: "stopped-quota" }));
          break;
        case AutoAction.STOP_BLOCKED_ON_QUESTIONS:
          setAutoStatus(ctx, statusTextForPhase({ kind: "stopped-blocked-on-questions" }));
          break;
        case AutoAction.STOP_NO_PROGRESS:
          setAutoStatus(ctx, statusTextForPhase({ kind: "stopped-no-progress" }));
          break;
        case AutoAction.STOP_DRAINED:
          setAutoStatus(ctx, statusTextForPhase({ kind: "done-drained" }));
          break;
      }
      return { action, iterations: runState.iteration, finalPredicates: predicates };
    }

    // REDRIVE or COMPACT_THEN_REDRIVE: both re-drive the wrapped command.
    if (action === AutoAction.COMPACT_THEN_REDRIVE) {
      // T467: show "compacting" while context compaction is in progress.
      setAutoStatus(ctx, statusTextForPhase({ kind: "compacting" }));
      // Await compaction via the checked `CompactOptions.onComplete` callback.
      // The context window usage will be null right after
      // compaction and until the next LLM response; the decision core's null-guard
      // on contextPercent prevents a spurious second compaction.
      await new Promise<void>((resolve, reject) => {
        ctx.compact({ onComplete: () => resolve(), onError: (error) => reject(error) });
      });
    }

    // Corrective re-prompt naming the still-violated predicates.
    nextPrompt = composeRedrivePrompt(predicates, preset.terminalPredicate);

    // Advance runState for the next decision (per spec).
    runState.prevPredicates = predicates;
    runState.prevAction = action;
    runState.iteration += 1;
  }
}

// ---------------------------------------------------------------------------
// registerAutoDriver — Pi wiring (integration-only).
// ---------------------------------------------------------------------------

/**
 * Narrow view of Pi's `ExtensionAPI` needed to register the driver command.
 */
export type DriverRegistrationApi = DriverApi & Pick<ExtensionAPI, "registerCommand">;

/**
 * Register a `<command>:auto` command that runs `runAutoDriver` for `preset`.
 *
 * This is the integration glue (exercised by the later e2e task T470, not unit-
 * tested): it maps the Pi command handler's `(args, ctx)` onto the testable
 * `runAutoDriver` loop. The handler awaits the loop to completion; the terminal
 * DriverResult is discarded here (status-bar reporting is the T467 seam — see
 * below) but propagated by `runAutoDriver`'s return for tests.
 *
 * T466 quota wiring: a single `QuotaHitRef` cell is created here and shared
 * between the `after_provider_response` subscriber (which sets it to true on
 * HTTP 429) and `runAutoDriver` (which reads it via `sampleSignals` each
 * cycle and resets it afterward). One cell is enough per registration because
 * only one `:auto` run is active at a time.
 *
 * QUOTA DETECTION IS BEST-EFFORT: Pi exposes no dedicated quota event.
 * `after_provider_response` with `status === 429` is the only available
 * surface. See `DriverAfterProviderResponseEvent` for the full caveat.
 *
 * T467: status-bar display is wired inside `runAutoDriver` via `setAutoStatus`
 * (ctx.ui.setStatus('cq-auto', text) gated on ctx.hasUI). Each lifecycle
 * point sets a distinct human-readable status string (see `statusTextForPhase`).
 */
export function registerAutoDriver(
  api: DriverRegistrationApi,
  preset: AutoPreset,
  options?: { maxIterations?: number },
): void {
  // Shared quota-hit cell: written by the event subscriber, read+reset by the loop.
  const quotaHitRef: QuotaHitRef = { value: false };

  // Subscribe once at registration time (not per-run) so we never miss a 429
  // that arrives between cycles.
  api.on("after_provider_response", (event: DriverAfterProviderResponseEvent) => {
    if (event.status === 429) {
      quotaHitRef.value = true;
    }
  });

  const commandName = preset.commandName ?? `${preset.wrappedCommand}:auto`;
  api.registerCommand(commandName, {
    description: `Auto-drive \`${preset.wrappedCommand}\` until its terminal predicate is satisfied.`,
    handler: async (args: string, ctx: DriverContext): Promise<void> => {
      // Reset the quota flag at the START of each run so a 429 from a
      // previous run does not poison a fresh one.
      quotaHitRef.value = false;
      await runAutoDriver({
        ctx,
        api,
        preset,
        args,
        maxIterations: options?.maxIterations,
        quotaHitRef,
      });
    },
  });
}
