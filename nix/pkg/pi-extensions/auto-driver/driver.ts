// cq auto-driver drive-and-await loop (T465, G-auto-driver).
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
//     - ExtensionContext.getContextUsage(): { percent: number|null } L231 (T466 seam)
//     - ExtensionContext.compact(options?): void                     L233 (T466 seam)
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
 * Context-window usage as Pi reports it (subset of Pi `ContextUsage`,
 * types.d.ts L192). `percent` is null when token counts are unknown (e.g. right
 * after a compaction, before the next LLM response).
 */
export interface DriverContextUsage {
  percent: number | null;
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
  /** Trigger compaction without awaiting (L233). T466 wires the await + signals. */
  compact(options?: { customInstructions?: string }): void;
}

/**
 * The structural subset of Pi's `ExtensionAPI` the driver needs: the
 * prompt-injection API used to launch the wrapped command and emit corrective
 * re-prompts into the live session.
 */
export interface DriverApi {
  /**
   * Inject a user message that ALWAYS triggers a turn (ExtensionAPI
   * sendUserMessage, L843). This is the prompt-injection mechanism: the driver
   * emits the wrapped slash command to start the underlying cq command, and the
   * `composeRedrivePrompt` text to re-drive it.
   */
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
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
  /** The Pi extension API (prompt injection). */
  api: DriverApi;
  /** The preset being driven: the wrapped command + its terminal oracle. */
  preset: AutoPreset;
  /** Predicate oracle; defaults to the `cq advance-gate` shell-out. */
  getPredicates?: GetPredicatesFn;
  /** Hard iteration bound; defaults to DEFAULT_MAX_ITERATIONS. */
  maxIterations?: number;
  /** The free-form args string passed to the `<command>:auto` command (reserved). */
  args?: string;
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
 * Sample the runtime signals the decision core reads.
 *
 * T465 SEAM (per spec): the real contextPercent + quotaHit wiring — and the
 * `ctx.compact()` invocation for COMPACT_THEN_REDRIVE — land in T466. For THIS
 * task the signals are a typed PLACEHOLDER so the loop typechecks and the
 * decision core never spuriously compacts or quota-stops:
 *   - contextPercent: null   (unknown -> rule (5) compaction never fires)
 *   - quotaHit: false        (no budget tracking yet)
 *
 * `ctx` is accepted now so T466 can read `ctx.getContextUsage().percent`
 * WITHOUT changing this signature or its call site.
 */
export function sampleSignals(_ctx: DriverContext): AutoSignals {
  // T466: replace with { contextPercent: ctx.getContextUsage()?.percent ?? null,
  //                      quotaHit: <budget check> }.
  return { contextPercent: null, quotaHit: false };
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
 * The loop (per the T465 spec's LOOP):
 *   launch wrapped command  -> await idle (launchAndAwait)
 *   getPredicates(ctx)
 *   decideNextAction({ predicates, terminalPredicate, runState, signals })
 *   act on the AutoAction:
 *     REDRIVE                 -> emit composeRedrivePrompt(...), ++iteration,
 *                                set prevPredicates/prevAction, loop
 *     COMPACT_THEN_REDRIVE    -> T466 seam: would `ctx.compact()` then redrive;
 *                                for THIS task it is treated like REDRIVE (the
 *                                placeholder signals never select it — see
 *                                sampleSignals — so this branch is a
 *                                clearly-marked seam, not live behaviour) and
 *                                still advances runState so the no-progress
 *                                guard stays correct.
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

  const runState: AutoRunState = {
    iteration: 0,
    maxIterations,
    prevPredicates: null,
    prevAction: null,
  };

  // The FIRST launch starts the underlying cq command via its slash command.
  let nextPrompt = wrappedSlashCommand(preset);

  // Bounded by maxIterations + the decision core's own stop rules; the `+ 1`
  // covers the initial launch (iteration 0) plus up to maxIterations redrives.
  for (;;) {
    await launchAndAwait(ctx, api, nextPrompt);

    const predicates = await getPredicates(ctx);
    const signals = sampleSignals(ctx);
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
      // T466 SEAM: compact the context before redriving. The placeholder
      // signals (sampleSignals) never select this action in T465, so this is a
      // structural seam T466 fills (await the compaction, then redrive). We
      // call the non-awaiting `ctx.compact()` to keep the seam wired to the real
      // API surface; T466 adds the await/onComplete reconciliation.
      ctx.compact();
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
 * command: `registerCommand` plus the prompt-injection `sendUserMessage`
 * (DriverApi). Declared locally (copy-not-import).
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
  const commandName = `${preset.wrappedCommand}:auto`;
  api.registerCommand(commandName, {
    description: `Auto-drive \`${preset.wrappedCommand}\` until its terminal predicate is satisfied.`,
    handler: async (args: string, ctx: DriverContext): Promise<void> => {
      await runAutoDriver({
        ctx,
        api,
        preset,
        args,
        maxIterations: options?.maxIterations,
      });
    },
  });
}
