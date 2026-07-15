// index.ts — cq ledger-status Pi extension entry point (T535, G76, decision
// Q257/Q258).
//
// Paints a compact `Q d/t  T d/t  D d/t` status-bar line from `cq counts`
// (T533) into Pi's footer, in a DISTINCT slot from the auto-driver's `cq-auto`
// slot (Q257 — the two must coexist). The pure parse/format logic lives in
// ./counts (T534); this module is the imperative Pi wiring on top.
//
// Pi-typing discipline (mirrors auto-driver/driver.ts, oracle.ts,
// cq-subagent-dispatch): this is a STANDALONE store-path file OUTSIDE the
// cq-ledgers bun workspace; its tsconfig only carries `@types/node` and it
// CANNOT/​MUST NOT import `@earendil-works/pi-*` or `@cq/*`. The pieces of the
// Pi ExtensionAPI / ExtensionContext this extension needs are therefore
// declared as LOCAL STRUCTURAL interfaces, copied from the ACTUAL installed Pi
// v0.80.6 typings (D86 corrected the stale 0.80.3 comment; the vendored
// version is 0.80.6 — read from the real store path, not assumed):
//   pi-coding-agent-0.80.6/lib/node_modules/pi-monorepo/dist/core/extensions/types.d.ts
//     - ExtensionUIContext.setStatus(key, text|undefined): void            L79
//     - ExtensionContext.ui: ExtensionUIContext                            L210
//     - ExtensionContext.hasUI: boolean (false in print/RPC mode)          L214
//     - ExtensionContext.cwd: string                                       L216
//     - ExtensionAPI.on("session_start",   ExtensionHandler<…>)            L842
//     - ExtensionAPI.on("turn_end",        ExtensionHandler<…>)            L860
//     - ExtensionAPI.on("tool_execution_end", ExtensionHandler<…>)         L866
//     - ExtensionAPI.on("session_shutdown", ExtensionHandler<…>)           L848
//     - ExtensionHandler<E> = (event, ctx: ExtensionContext) => …          L835
//     - ExtensionFactory = (pi: ExtensionAPI) => void|Promise<void>        L1060
// KEEP IN SYNC with those typings. NO `@cq/*` / `@earendil-works/*` imports.

import { execFile } from "node:child_process";
import { parseCounts, formatStatus } from "./counts";

// ---------------------------------------------------------------------------
// Local structural Pi surface (copy-not-import — see header).
// ---------------------------------------------------------------------------

/**
 * Structural subset of Pi's `ExtensionUIContext` (types.d.ts L67-191). Only the
 * status-bar method is needed. `setStatus(key, text|undefined)` (L79) sets a
 * footer slot; pass `undefined` to clear it.
 */
export interface StatusUIContext {
  setStatus(key: string, text: string | undefined): void;
}

/**
 * Structural subset of Pi's `ExtensionContext` (types.d.ts L208-241) delivered
 * to every event handler. Carries `cwd` (so `cq counts` resolves the right
 * ledger root), the status-bar `ui`, and the `hasUI` guard (false in
 * print/RPC mode — ALL setStatus calls are gated on it).
 */
export interface StatusContext {
  cwd: string;
  hasUI: boolean;
  ui: StatusUIContext;
}

/**
 * Structural subset of Pi's `ExtensionAPI` (types.d.ts L839-999) this extension
 * registers against: only the `on(event, handler)` lifecycle subscription for
 * the four events we use. Overloads pinned to the exact event-name literals so
 * the real `ExtensionAPI` (which carries these among many) is assignable here.
 * The event payload is typed loosely (`{ type: string }`) because this
 * extension reads NOTHING from the event — only the ctx.
 */
export interface StatusRegistrationApi {
  on(event: "session_start", handler: (event: { type: string }, ctx: StatusContext) => void): void;
  on(event: "turn_end", handler: (event: { type: string }, ctx: StatusContext) => void): void;
  on(event: "tool_execution_end", handler: (event: { type: string }, ctx: StatusContext) => void): void;
  on(event: "session_shutdown", handler: (event: { type: string }, ctx: StatusContext) => void): void;
}

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

/**
 * The stable status-bar slot key this extension owns in Pi's footer. DISTINCT
 * from the auto-driver's `cq-auto` slot (decision Q257) so the two coexist.
 */
export const SLOT_KEY = "cq-ledger";

/** Periodic poll cadence for external/concurrent ledger mutations (Q258 (c)). */
export const POLL_INTERVAL_MS = 15_000;

/** Cap on captured stdout/stderr — the counts JSON is small (< 1 KiB). */
const MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Short marker painted on a spawn/parse failure so the slot degrades visibly
 * instead of throwing into the host loop (fail-fast at the boundary, Q258).
 */
const FAILURE_MARKER = "Q?/T?/D?";

// ---------------------------------------------------------------------------
// cq counts shell-out (invocation copied VERBATIM from auto-driver/oracle.ts).
// ---------------------------------------------------------------------------

/**
 * Run `cq counts` in `cwd` and resolve its stdout. Mirrors oracle.ts
 * `runPredicates`: bare PATH-resolved `cq`, resolve on NON-EMPTY stdout,
 * tolerate a non-zero exit (only reject when the process fails to spawn or
 * produced no stdout).
 */
function defaultRunCounts(cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "cq",
      ["counts"],
      { cwd, maxBuffer: MAX_BUFFER_BYTES, encoding: "utf-8" },
      (error, stdout, stderr) => {
        const out = stdout.trim();
        if (out.length > 0) {
          resolve(out);
          return;
        }
        const reason = error
          ? `cq counts failed: ${error.message}`
          : "cq counts produced no stdout";
        reject(new Error(stderr.trim().length > 0 ? `${reason}\n${stderr.trim()}` : reason));
      },
    );
  });
}

/** Create the poll interval and unref it so it never keeps the process alive. */
function defaultSetInterval(cb: () => void, ms: number): unknown {
  const handle = setInterval(cb, ms);
  (handle as { unref?: () => void }).unref?.();
  return handle;
}

/** Clear a poll interval created by `defaultSetInterval`. */
function defaultClearInterval(handle: unknown): void {
  clearInterval(handle as Parameters<typeof clearInterval>[0]);
}

// ---------------------------------------------------------------------------
// registration.
// ---------------------------------------------------------------------------

/**
 * Injectable seams so the wiring is unit-testable with a fake api/ctx without
 * shelling out `cq counts` or arming a real timer. Production wiring (the
 * default export) supplies none of these and gets the real shell-out + timer.
 */
export interface LedgerStatusOptions {
  /** Counts fetcher; defaults to the `cq counts` shell-out. */
  runCounts?: (cwd: string) => Promise<string>;
  /** Poll cadence override; defaults to POLL_INTERVAL_MS. */
  pollIntervalMs?: number;
  /** Timer factory; defaults to a self-unref-ing setInterval. */
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  /** Timer disposer; defaults to clearInterval. */
  clearIntervalFn?: (handle: unknown) => void;
}

/**
 * Wire the ledger-status refresh pipeline into a live Pi session.
 *
 * Refresh triggers satisfy Q258's intent against the REAL pi 0.80.6 events
 * (verified in dist/core/extensions/types.d.ts — NOT assumed):
 *   (a) initial on-load paint  → `session_start`   (L842)
 *   (b) post-turn / post-tool  → `turn_end` (L860) + `tool_execution_end` (L866)
 *   (c) periodic poll          → setInterval(POLL_INTERVAL_MS)
 *
 * The on-load paint does NOT hard-depend on `session_start`: `turn_end`,
 * `tool_execution_end`, and the poll ALL paint too, so an initial paint still
 * occurs if `session_start` never fires. Disposal (`session_shutdown`, L848)
 * clears the poll. The refresh is SINGLE-FLIGHT (overlapping triggers do not
 * stack `cq counts` spawns) and NEVER throws into the host loop.
 */
export function registerLedgerStatus(api: StatusRegistrationApi, options?: LedgerStatusOptions): void {
  const runCounts = options?.runCounts ?? defaultRunCounts;
  const pollIntervalMs = options?.pollIntervalMs ?? POLL_INTERVAL_MS;
  const setIntervalFn = options?.setIntervalFn ?? defaultSetInterval;
  const clearIntervalFn = options?.clearIntervalFn ?? defaultClearInterval;

  let inFlight = false;
  // Latest ctx seen from any event; the poll (which carries no ctx of its own)
  // reuses it.
  let lastCtx: StatusContext | undefined;

  function setStatus(ctx: StatusContext, text: string): void {
    if (ctx.hasUI) {
      ctx.ui.setStatus(SLOT_KEY, text);
    }
  }

  async function refresh(ctx: StatusContext): Promise<void> {
    lastCtx = ctx;
    // Single-flight: skip if a refresh is already running so overlapping
    // triggers (turn_end + tool_execution_end + poll) don't stack spawns.
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      const stdout = await runCounts(ctx.cwd);
      setStatus(ctx, formatStatus(parseCounts(stdout)));
    } catch {
      // Fail-fast at the boundary: on spawn or parse failure, degrade the slot
      // to a short marker. NEVER throw into the host loop, never spam.
      setStatus(ctx, FAILURE_MARKER);
    } finally {
      inFlight = false;
    }
  }

  // Chosen event names — VERIFIED present in the installed pi 0.80.6 extension
  // typings (dist/core/extensions/types.d.ts): session_start (L842), turn_end
  // (L860), tool_execution_end (L866), session_shutdown (L848).
  api.on("session_start", (_event, ctx) => {
    void refresh(ctx); // (a) initial on-load paint
  });
  api.on("turn_end", (_event, ctx) => {
    void refresh(ctx); // (b) post-turn
  });
  api.on("tool_execution_end", (_event, ctx) => {
    void refresh(ctx); // (b) post-tool
  });

  // (c) periodic poll for external/concurrent ledger mutations.
  const pollHandle = setIntervalFn(() => {
    if (lastCtx) {
      void refresh(lastCtx);
    }
  }, pollIntervalMs);

  // Lifecycle: clear the poll on teardown (quit/reload/session replacement).
  api.on("session_shutdown", () => {
    clearIntervalFn(pollHandle);
  });
}

/**
 * Pi extension default export: the loader calls this with the live
 * `ExtensionAPI`, which satisfies `StatusRegistrationApi` structurally.
 */
export default function cqLedgerStatus(pi: StatusRegistrationApi): void {
  registerLedgerStatus(pi);
}
