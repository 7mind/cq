// index.ts — cq ledger-status Pi extension entry point (T535, G76, decision
// Q257/Q258).
//
// Paints a compact `Q d/t  T d/t  D d/t  R d/t` status-bar line from `cq
// counts` (T533) into Pi's footer, in a DISTINCT slot from the auto-driver's
// `cq-auto` slot (Q257 — the two must coexist). The pure parse/format logic
// lives in ./counts (T534, extended T560 for the researches `R` segment);
// this module is the imperative Pi wiring on top.
//
// Pi host types are type-only imports resolved by the Nix-wired check/local
// script against packages.pi-coding-agent, the single type source of truth.
// Runtime delivery remains a bare store-path directory with only node/local
// value imports. By explicit user directive for G136, this supersedes the gen-1
// M585–M587/T1402–T1404 manual host-type refresh and citation checks; host API
// drift now fails compilation.

import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { parseCounts, formatStatus } from "./counts";

// ---------------------------------------------------------------------------
// Narrow host-input seams derived from the real Pi exports.
// ---------------------------------------------------------------------------

/**
 * Narrow view of Pi's `ExtensionUIContext`. Only the status-bar method is
 * needed. `setStatus(key, text|undefined)` sets a
 * footer slot; pass `undefined` to clear it.
 */
export type StatusUIContext = Pick<ExtensionUIContext, "setStatus">;

/**
 * Narrow view of Pi's `ExtensionContext` delivered
 * to every event handler. Carries `cwd` (so `cq counts` resolves the right
 * ledger root), the status-bar `ui`, and the `hasUI` guard (false in
 * print/RPC mode — ALL setStatus calls are gated on it).
 */
export type StatusContext = Pick<ExtensionContext, "cwd" | "hasUI"> & {
  readonly ui: StatusUIContext;
};

/**
 * Narrow registration seam over Pi's `ExtensionAPI`; this extension
 * registers against: only the `on(event, handler)` lifecycle subscription for
 * the four events we use. Overloads pinned to the exact event-name literals so
 * the real `ExtensionAPI` (which carries these among many) is assignable here.
 * The event payload is typed loosely (`{ type: string }`) because this
 * extension reads NOTHING from the event — only the ctx.
 */
type StatusEventName =
  | "session_start"
  | "turn_end"
  | "tool_execution_end"
  | "session_shutdown";

export interface StatusRegistrationApi {
  on(
    event: StatusEventName,
    handler: (event: { type: string }, ctx: StatusContext) => void,
  ): void;
}

type AssertTrue<T extends true> = T;
type _RealPiOnSupportsStatusRegistration = AssertTrue<
  Pick<ExtensionAPI, "on"> extends StatusRegistrationApi ? true : false
>;

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
 * Extended by T560 with the `R?` researches segment, consistent with Q/T/D.
 */
const FAILURE_MARKER = "Q?/T?/D?/R?";

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
  /** Optional observation seam for attributed refresh failures. */
  onError?: (err: unknown, phase: "counts" | "paint" | "terminal") => void;
}

/**
 * Wire the ledger-status refresh pipeline into a live Pi session.
 *
 * Refresh triggers satisfy Q258's intent against the Nix-provided Pi events:
 *   (a) initial on-load paint  → `session_start`   (L852)
 *   (b) post-turn / post-tool  → `turn_end` (L870) + `tool_execution_end` (L876)
 *   (c) periodic poll          → setInterval(POLL_INTERVAL_MS)
 *
 * The on-load paint does NOT hard-depend on `session_start`: `turn_end`,
 * `tool_execution_end`, and the poll ALL paint too, so an initial paint still
 * occurs if `session_start` never fires. Disposal (`session_shutdown`, L852)
 * clears the poll. The refresh is SINGLE-FLIGHT (overlapping triggers do not
 * stack `cq counts` spawns) and NEVER throws into the host loop.
 */
export function registerLedgerStatus(api: StatusRegistrationApi, options?: LedgerStatusOptions): void {
  const runCounts = options?.runCounts ?? defaultRunCounts;
  const pollIntervalMs = options?.pollIntervalMs ?? POLL_INTERVAL_MS;
  const setIntervalFn = options?.setIntervalFn ?? defaultSetInterval;
  const clearIntervalFn = options?.clearIntervalFn ?? defaultClearInterval;
  const onError = options?.onError;

  let active = true;
  let inFlight = false;
  // Latest ctx seen from any event; the poll (which carries no ctx of its own)
  // reuses it.
  let lastCtx: StatusContext | undefined;

  function setStatus(ctx: StatusContext, text: string): void {
    let hasUI: boolean;
    try {
      hasUI = ctx.hasUI;
    } catch {
      return;
    }
    if (hasUI) {
      ctx.ui.setStatus(SLOT_KEY, text);
    }
  }

  async function refresh(ctx: StatusContext): Promise<void> {
    if (!active) {
      return;
    }
    lastCtx = ctx;
    // Single-flight: skip if a refresh is already running so overlapping
    // triggers (turn_end + tool_execution_end + poll) don't stack spawns.
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      let text: string;
      try {
        const stdout = await runCounts(ctx.cwd);
        if (!active) return;
        text = formatStatus(parseCounts(stdout));
      } catch (err) {
        if (!active) return;
        onError?.(err, "counts");
        text = FAILURE_MARKER;
      }
      if (!active) return;
      try {
        setStatus(ctx, text);
      } catch (err) {
        onError?.(err, "paint");
      }
    } finally {
      inFlight = false;
    }
  }

  // These event names are checked against the installed ExtensionAPI.on map.
  api.on("session_start", (_event, ctx) => {
    if (!active) return;
    void refresh(ctx).catch((err: unknown) => onError?.(err, "terminal")); // (a) initial on-load paint
  });
  api.on("turn_end", (_event, ctx) => {
    if (!active) return;
    void refresh(ctx).catch((err: unknown) => onError?.(err, "terminal")); // (b) post-turn
  });
  api.on("tool_execution_end", (_event, ctx) => {
    if (!active) return;
    void refresh(ctx).catch((err: unknown) => onError?.(err, "terminal")); // (b) post-tool
  });

  // (c) periodic poll for external/concurrent ledger mutations.
  const pollHandle = setIntervalFn(() => {
    if (active && lastCtx) {
      void refresh(lastCtx).catch((err: unknown) => onError?.(err, "terminal"));
    }
  }, pollIntervalMs);

  // Lifecycle: clear the poll on teardown (quit/reload/session replacement).
  api.on("session_shutdown", () => {
    active = false;
    clearIntervalFn(pollHandle);
    lastCtx = undefined;
  });
}

/**
 * Pi extension default export: the loader calls this with the live
 * `ExtensionAPI`, which satisfies `StatusRegistrationApi` structurally.
 */
export default function cqLedgerStatus(pi: StatusRegistrationApi): void {
  registerLedgerStatus(pi);
}
