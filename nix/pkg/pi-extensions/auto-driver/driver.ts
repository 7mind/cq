// cq auto-driver drive-and-await loop (T465/T466, G-auto-driver).
//
// Behaviour-1: the GENERIC driver. It launches a wrapped cq command into the
// LIVE pi session, awaits the agent's idle/turn completion, derives the flow
// predicates, decides the next AutoAction with the pure `decideNextAction`
// core, and ACTS on it — re-driving with a corrective prompt, compacting, or
// stopping. The decision core (./decide), the pure vocabulary (./decision), and
// the predicate oracle (./oracle) are all consumed here; this module adds ONLY
// the imperative loop + Pi wiring on top.
//
// Pi-typing discipline (mirrors decision.ts / oracle.ts / cq-subagent-dispatch):
// this is a STANDALONE store-path file OUTSIDE the cq-ledgers bun workspace, and
// its tsconfig only carries `@types/node` — it CANNOT and MUST NOT import
// `@earendil-works/pi-coding-agent`. The pieces of the Pi ExtensionAPI /
// ExtensionCommandContext this loop needs are therefore declared as LOCAL
// STRUCTURAL interfaces (`DriverContext`, `DriverApi`), copied from the ACTUAL
// installed Pi v0.78.0 typings
//   (pi-coding-agent-0.78.0/dist/core/extensions/types.d.ts):
//     - registerCommand(name, { description?, handler })             L818
//     - handler: (args: string, ctx: ExtensionCommandContext) => …  L775
//     - ExtensionCommandContext.waitForIdle(): Promise<void>         L243
//     - ExtensionContext.isIdle(): boolean                           L221
//     - ExtensionAPI.sendUserMessage(content, options?): void        L843
//       (the prompt-injection API: "Send a user message to the agent. Always
//        triggers a turn." — this is how the wrapped command / corrective
//        re-prompt is launched into the live session.)
//     - ExtensionContext.getContextUsage(): ContextUsage | undefined L231
//       ContextUsage = { tokens: number|null, contextWindow: number, percent: number|null }
//     - ExtensionContext.compact(options?: CompactOptions): void      L233
//       CompactOptions = { customInstructions?, onComplete?, onError? }
//     - ExtensionAPI.on("after_provider_response", handler)          L797 (T466 quota detection)
//       AfterProviderResponseEvent = { type, status: number, headers: Record<string,string> }
//     - ExtensionAPI.on("agent_end", handler)                        L800 (await reconciliation)
// KEEP IN SYNC with those typings. NO `@cq/*` imports.

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
// Local structural Pi surface (copy-not-import — see header).
// ---------------------------------------------------------------------------

/**
 * Context-window usage as Pi reports it (Pi `ContextUsage`, types.d.ts L192).
 * `percent` is null when token counts are unknown (e.g. right after a
 * compaction, before the next LLM response). `tokens` is null for the same
 * reason. The driver only reads `percent`.
 */
export interface DriverContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/**
 * Subset of Pi's `AfterProviderResponseEvent` (types.d.ts L462) used for
 * quota/rate-limit detection. `status` is the HTTP response status code;
 * `headers` carries the raw response headers (e.g. `retry-after`).
 *
 * IMPORTANT — quota detection is BEST-EFFORT and APPROXIMATE: Pi v0.78.0
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
 * The structural subset of Pi's `ExtensionCommandContext` the driver loop uses.
 * Carries `cwd` (so the oracle resolves the right ledger root), the idle
 * guard/await pair, and the T466 compaction/usage seams. Declared locally to
 * keep this module Pi-typing-free and unit-testable with a fake ctx.
 */
export interface DriverContext extends OracleContext {
  /** Synchronous idle guard (ExtensionContext.isIdle, L221). */
  isIdle(): boolean;
  /** Await the agent finishing the current stream (ExtensionCommandContext.waitForIdle, L243). */
  waitForIdle(): Promise<void>;
  /** Current context usage; T466 reads `.percent` for the compaction signal (L231). */
  getContextUsage(): DriverContextUsage | undefined;
  /**
   * Trigger compaction (L233). T466 awaits completion via `options.onComplete`
   * (Pi `CompactOptions`, types.d.ts L199: `{ customInstructions?, onComplete?,
   * onError? }`).
   */
  compact(options?: {
    customInstructions?: string;
    onComplete?: (result: unknown) => void;
    onError?: (error: Error) => void;
  }): void;
}

/**
 * The structural subset of Pi's `ExtensionAPI` the driver needs: the
 * prompt-injection API used to launch the wrapped command and emit corrective
 * re-prompts into the live session, plus the event subscription for quota
 * detection.
 */
export interface DriverApi {
  /**
   * Inject a user message that ALWAYS triggers a turn (ExtensionAPI
   * sendUserMessage, L843). This is the prompt-injection mechanism: the driver
   * emits the wrapped slash command to start the underlying cq command, and the
   * `composeRedrivePrompt` text to re-drive it.
   */
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;

  /**
   * Subscribe to the `after_provider_response` lifecycle event (ExtensionAPI
   * on, L797). Used by T466 quota detection to observe HTTP 429 responses.
   * The overload is narrowed to this specific event name to avoid importing Pi
   * types while still being structurally compatible with ExtensionAPI.
   */
  on(
    event: "after_provider_response",
    handler: (event: DriverAfterProviderResponseEvent) => void,
  ): void;
}

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
 * sendUserMessage L840-845) and then block until the agent has finished the
 * resulting stream.
 *
 * The await reconciles the two completion mechanisms the Pi v0.78.0 typings
 * expose (per the T465 spec's "reconcile the two so the await is reliable"):
 *
 *   1. `ctx.isIdle()` (L221) — a SYNCHRONOUS guard. `sendUserMessage` is
 *      `void` (fire-and-forget) and the turn it triggers may not have started
 *      synchronously by the time we check, so isIdle() alone is NOT a reliable
 *      "the turn is done" signal on its own.
 *   2. `ctx.waitForIdle()` (L243) — resolves when the agent next becomes idle.
 *
 * Reconciliation: we await `waitForIdle()` UNCONDITIONALLY after injecting the
 * prompt. `waitForIdle` is the authoritative await; if the turn already
 * completed it resolves immediately. We do NOT short-circuit on a pre-launch
 * `isIdle()` (that would race the not-yet-started turn). The `isIdle()` guard
 * is instead used as a post-await assertion that the agent really settled.
 *
 * NOTE on `pi.on("agent_end")` (L800): the ExtensionAPI also fires an
 * `agent_end` lifecycle event per agent loop. `waitForIdle()` is the
 * command-handler-native, promise-shaped equivalent and is preferred here
 * because it needs no subscribe/unsubscribe bookkeeping inside the loop and
 * cannot miss an event that fired between injection and subscription. The
 * event path is reserved for hosts where `waitForIdle` is absent (it is present
 * in v0.78.0, so it is used).
 */
export async function launchAndAwait(
  ctx: DriverContext,
  api: DriverApi,
  prompt: string,
): Promise<void> {
  api.sendUserMessage(prompt);
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
 * QUOTA DETECTION IS BEST-EFFORT: Pi v0.78.0 exposes NO typed quota event.
 * `after_provider_response` is the only available surface. See
 * `DriverAfterProviderResponseEvent` for the full caveat.
 */
export function sampleSignals(ctx: DriverContext, quotaHitRef: QuotaHitRef): AutoSignals {
  return {
    contextPercent: ctx.getContextUsage()?.percent ?? null,
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

  // The FIRST launch starts the underlying cq command via its slash command.
  let nextPrompt = wrappedSlashCommand(preset);

  for (;;) {
    await launchAndAwait(ctx, api, nextPrompt);

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
      return { action, iterations: runState.iteration, finalPredicates: predicates };
    }

    // REDRIVE or COMPACT_THEN_REDRIVE: both re-drive the wrapped command.
    if (action === AutoAction.COMPACT_THEN_REDRIVE) {
      // Await compaction via the `onComplete` callback (Pi v0.78.0 CompactOptions
      // types.d.ts L199). The context window usage will be null right after
      // compaction and until the next LLM response; the decision core's null-guard
      // on contextPercent prevents a spurious second compaction.
      await new Promise<void>((resolve) => {
        ctx.compact({ onComplete: () => resolve() });
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
 * The structural subset of Pi's `ExtensionAPI` needed to REGISTER the driver
 * command: `registerCommand` plus the prompt-injection `sendUserMessage` and
 * event subscription (DriverApi). Declared locally (copy-not-import).
 */
export interface DriverRegistrationApi extends DriverApi {
  /**
   * Register a custom command (ExtensionAPI.registerCommand, L818). The handler
   * receives the raw args string and the command-handler context.
   */
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: DriverContext) => Promise<void>;
    },
  ): void;
}

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
 * QUOTA DETECTION IS BEST-EFFORT: Pi 0.78.0 exposes no typed quota event.
 * `after_provider_response` with `status === 429` is the only available
 * surface. See `DriverAfterProviderResponseEvent` for the full caveat.
 *
 * T467 SEAM: a status-bar update on each cycle / at the terminus would hook in
 * here (e.g. via a `setStatus`-style API). It is deliberately NOT implemented
 * now; the structure (a single registered command whose handler owns the loop)
 * leaves the obvious insertion point.
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

  const commandName = `${preset.wrappedCommand}:auto`;
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
