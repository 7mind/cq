/**
 * `cq advance-gate` (T362 / G44, fixes D50) — the HARNESS-AGNOSTIC stop-gate
 * verdict emitter for the `/cq:advance` flow.
 *
 * It answers ONE question: while a `/cq:advance` run is active, may the harness
 * pause its turn, or must the flow continue? The verdict is derived from the
 * SHARED `derivePredicates(store)` engine (the single source of truth in
 * `@cq/ledger`), so the CLI and the MCP server agree on actionability.
 *
 * ## Behaviour (LOCKED decisions Q199/Q200/Q201/Q202)
 *  1. Resolve the session id from `--session <id>` OR `$CLAUDE_CODE_SESSION_ID`,
 *     and compute the marker path
 *     `${XDG_RUNTIME_DIR:-/tmp}/cq-advance-active-<session-id>`.
 *  2. Marker ABSENT → ALLOW (block=false). The gate only engages during an
 *     active `/cq:advance` run, so without the marker we do NOT even read the
 *     ledger.
 *  3. Marker PRESENT and its contents carry a non-empty `external-signal: "..."`
 *     line → ALLOW (block=false).
 *  4. Else construct the store IN-PROCESS via `createLedgerStore(cwd)`
 *     (exactly like `runInit` — NO MCP server), call
 *     `derivePredicates(store)`, dispose, and: if ANY of
 *     pInvestigate/pSeed/pPlan/pResearch/pImplement is TRUE-and-unblocked →
 *     BLOCK (block=true), naming the FIRST such predicate in flow order
 *     (investigate → seed → plan → research → implement); else ALLOW.
 *     The informational `belowFloor` and `goalDrift` companions are NEVER
 *     part of the block decision.
 *  5. Emit on stdout the NEUTRAL verdict JSON
 *     `{ block, reason, predicates: { pInvestigate, pSeed, pPlan, pResearch,
 *     pImplement, openQuestionGate, belowFloor, goalDrift } }`. EXIT CODE:
 *     0 = allow, non-zero = block.
 *
 * The CLI emits NO Claude-Code `{decision}` JSON — translating the neutral
 * verdict to a harness-specific hook response is the wrapper's job (T364).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  createLedgerStore,
  derivePredicates,
  type DerivedPredicates,
} from "@cq/ledger";

/** Exit code for an ALLOW verdict (block=false). */
export const EXIT_ALLOW = 0;
/** Exit code for a BLOCK verdict (block=true). */
export const EXIT_BLOCK = 1;

/** The marker filename prefix under `${XDG_RUNTIME_DIR:-/tmp}`. */
const MARKER_PREFIX = "cq-advance-active-";
/** Default runtime dir when `$XDG_RUNTIME_DIR` is unset/empty. */
const DEFAULT_RUNTIME_DIR = "/tmp";
/** The marker line, when present and non-empty, that forces an ALLOW. */
const EXTERNAL_SIGNAL_PREFIX = "external-signal:";

/** Inputs the gate needs: the resolved ledger root + the optional session id. */
export interface AdvanceGateArgs {
  /** Resolved ledger root (--cwd > $LEDGER_ROOT > CWD, absolute). */
  readonly cwd: string;
  /** `--session <id>`; `null` when absent (then $CLAUDE_CODE_SESSION_ID). */
  readonly session: string | null;
}

/** IO seam so tests can capture stdout and the resolved exit code. */
export interface AdvanceGateIo {
  out(line: string): void;
  err(line: string): void;
}

/** The dispatcher's outcome — the exit code main() propagates. */
export interface AdvanceGateOutcome {
  exitCode: number;
}

/** The neutral, harness-agnostic verdict serialised to stdout. */
export interface AdvanceGateVerdict {
  block: boolean;
  reason: string;
  predicates: DerivedPredicates;
}

/**
 * Resolve the session id: explicit `--session` wins, else
 * `$CLAUDE_CODE_SESSION_ID`. Fail fast when neither is present — without a
 * session id there is no marker path to consult.
 */
function resolveSessionId(args: AdvanceGateArgs): string {
  if (args.session !== null && args.session !== "") {
    return args.session;
  }
  const env = process.env["CLAUDE_CODE_SESSION_ID"];
  if (env !== undefined && env !== "") {
    return env;
  }
  throw new Error(
    "cq advance-gate: no session id (pass --session <id> or set $CLAUDE_CODE_SESSION_ID)",
  );
}

/** The marker path for `sessionId` under `${XDG_RUNTIME_DIR:-/tmp}`. */
function markerPath(sessionId: string): string {
  const runtimeDir = process.env["XDG_RUNTIME_DIR"];
  const base = runtimeDir !== undefined && runtimeDir !== "" ? runtimeDir : DEFAULT_RUNTIME_DIR;
  return path.join(base, `${MARKER_PREFIX}${sessionId}`);
}

/**
 * Read the marker file's contents, or `null` when it is ABSENT. Any other read
 * error (permissions, etc.) propagates — fail fast rather than mis-classify an
 * unreadable marker as absent.
 */
async function readMarker(markerFile: string): Promise<string | null> {
  try {
    return await fs.readFile(markerFile, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      return null;
    }
    throw err;
  }
}

/** True iff `err` is a Node ENOENT (no such file) error. */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * True iff `contents` carries a non-empty `external-signal: "..."` line — a
 * caller-provided override that forces an ALLOW regardless of ledger state.
 * "Non-empty" means the value after the prefix, once trimmed of whitespace and
 * surrounding quotes, is a non-empty string.
 */
function hasExternalSignal(contents: string): boolean {
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith(EXTERNAL_SIGNAL_PREFIX)) continue;
    const value = line.slice(EXTERNAL_SIGNAL_PREFIX.length).trim().replace(/^"|"$/g, "").trim();
    if (value !== "") return true;
  }
  return false;
}

/**
 * Compute the neutral verdict for `args`, reading the marker + (only when
 * needed) the ledger via the SHARED `derivePredicates`.
 */
export async function computeVerdict(args: AdvanceGateArgs): Promise<AdvanceGateVerdict> {
  const sessionId = resolveSessionId(args);
  const markerFile = markerPath(sessionId);
  const markerContents = await readMarker(markerFile);

  // (2) Marker absent → the gate is dormant. ALLOW without reading the ledger.
  if (markerContents === null) {
    return allowVerdict("no active /cq:advance run (marker absent) — allow");
  }

  // (3) An external signal in the marker forces an ALLOW.
  if (hasExternalSignal(markerContents)) {
    return allowVerdict("external-signal present in advance marker — allow");
  }

  // (4) Derive the predicates from the in-process fs-backed store.
  const { store } = await createLedgerStore(args.cwd);
  let predicates: DerivedPredicates;
  try {
    predicates = derivePredicates(store);
  } finally {
    await store.dispose();
  }

  const blocking = firstBlockingPredicate(predicates);
  if (blocking !== null) {
    return {
      block: true,
      reason:
        `P-${blocking}=TRUE and unblocked; continue per D41 — ` +
        `turn-pause is not a stop condition`,
      predicates,
    };
  }

  return {
    block: false,
    reason:
      "no actionable predicate (P-investigate/P-seed/P-plan/P-research/P-implement all FALSE) — allow",
    predicates,
  };
}

/**
 * The first TRUE-and-unblocked detection predicate, in flow order
 * (investigate → seed → plan → research → implement), or `null` when none is
 * TRUE. The returned label names the predicate in the BLOCK reason. The
 * informational `belowFloor` and `goalDrift` (report-only, G84/D113)
 * companions are intentionally NOT consulted — they never block.
 */
function firstBlockingPredicate(
  p: DerivedPredicates,
): "investigate" | "seed" | "plan" | "research" | "implement" | null {
  if (p.pInvestigate.value) return "investigate";
  if (p.pSeed.value) return "seed";
  if (p.pPlan.value) return "plan";
  if (p.pResearch.value) return "research";
  if (p.pImplement.value) return "implement";
  return null;
}

/**
 * An ALLOW verdict carrying EMPTY predicate verdicts — used on the marker-absent
 * / external-signal paths where the ledger is intentionally NOT read, so the
 * neutral JSON shape stays uniform.
 */
function allowVerdict(reason: string): AdvanceGateVerdict {
  const empty = { value: false, items: [] as string[] };
  return {
    block: false,
    reason,
    predicates: {
      pInvestigate: empty,
      pSeed: empty,
      pPlan: empty,
      pResearch: empty,
      pImplement: empty,
      openQuestionGate: empty,
      belowFloor: empty,
      goalDrift: empty,
    },
  };
}

/**
 * `cq advance-gate`: emit the neutral verdict JSON on stdout and resolve the
 * exit code (0 = allow, non-zero = block). Matches the `runInit`/`runReset`
 * DispatchIo style — IO and exit code only, derivation delegated.
 */
export async function runAdvanceGate(
  args: AdvanceGateArgs,
  io: AdvanceGateIo,
): Promise<AdvanceGateOutcome> {
  const verdict = await computeVerdict(args);
  io.out(JSON.stringify(verdict));
  return { exitCode: verdict.block ? EXIT_BLOCK : EXIT_ALLOW };
}
