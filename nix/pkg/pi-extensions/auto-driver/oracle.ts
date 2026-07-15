// cq auto-driver predicate oracle adapter (T463, T478, G-auto-driver).
//
// PINNED CHANNEL: shell out the `cq predicates` CLI and parse its
// `predicates` object. EXACTLY ONE channel is implemented — no prefer/fallback
// branching remains.
//
// EVIDENCE for the channel decision (STEP 1, verified against the ACTUAL
// installed Pi v0.78.0 typings, not assumptions):
//   The Pi ExtensionAPI CANNOT invoke an MCP tool from extension code. The
//   `ExtensionAPI` interface (dist/core/extensions/types.d.ts L785-939 of
//   @earendil-works/pi-coding-agent 0.78.0) exposes registerTool / getAllTools /
//   getActiveTools / setActiveTools / `exec(cmd,args)` / sendUserMessage / … but
//   NO callTool / invokeTool / runTool / mcp() member; neither do
//   ExtensionContext / ExtensionCommandContext (same file, L207-279). A grep of
//   the whole `dist/index.d.ts` export surface finds NO `Mcp*` / `callTool` /
//   `invokeTool` symbol. MCP tools (the ledger via pi-mcp-adapter, wired in
//   nix/hm/pi.nix `enableMcpIntegration`) are surfaced ONLY to the LLM, never to
//   extension code. The only programmatic escape hatch is the shell (`exec`).
//   => the in-process MCP channel is CONFIRMED ABSENT.
//
// CHOSEN CHANNEL (STEP 2): the `cq predicates` CLI subcommand. It prints a
//   JSON object `{ predicates: { pInvestigate, pSeed, pPlan, pImplement,
//   openQuestionGate, belowFloor } }` to stdout, where `predicates` shares the SAME
//   `derivePredicates` single source of truth as the ledger MCP
//   `derive_predicates` tool. `cq predicates` is harness-agnostic — it ALWAYS
//   derives from the fs store, uses NO session, requires NO marker, and ALWAYS
//   exits 0. Chosen over the prior Claude-Stop-hook-specific, session-dependent
//   subcommand and over a child `pi -p` turn (the
//   cq-subagent-dispatch.ts spawn pattern) because it is the lower-dependency,
//   DETERMINISTIC, harness-agnostic option: one `cq predicates` shell-out vs. a
//   non-deterministic child LLM turn that would itself need the MCP adapter to
//   reach the tool.
//
// Like the rest of pi-extensions/auto-driver, this module imports NOTHING from
// `@cq/*` (standalone store-path file outside the cq-ledgers bun workspace); the
// `DerivedPredicates` contract is imported from the sibling `./decision` module
// (itself a copy of @cq/ledger's predicates.ts shape).

import { execFile } from "node:child_process";
import type { DerivedPredicates, PredicateVerdict } from "./decision";

/**
 * The minimal context this oracle needs: the working directory the `cq`
 * invocation runs in (so `cq predicates` resolves the right ledger root). A
 * structural subset of the Pi `ExtensionContext` (which carries `cwd: string`),
 * declared locally to keep this module Pi-typing-free and unit-testable.
 */
export interface OracleContext {
  cwd: string;
}

/** The `cq` CLI command and the subcommand that prints the predicates JSON. */
const CQ_COMMAND = "cq";
const PREDICATES_ARGS = ["predicates"];

/** The predicate keys, in the canonical order of `DerivedPredicates`. */
const PREDICATE_KEYS = [
  "pInvestigate",
  "pSeed",
  "pPlan",
  "pImplement",
  "openQuestionGate",
  "belowFloor",
] as const;
type PredicateKey = (typeof PREDICATE_KEYS)[number];

/** Cap on captured stdout/stderr — the verdict JSON is small (< 1 KiB). */
const MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Run `cq predicates` in `cwd` and return its stdout. `cq predicates` ALWAYS
 * exits 0 (harness-agnostic, no session required), so we resolve on stdout
 * unconditionally and only reject when the process fails to spawn (ENOENT etc.)
 * or produced no stdout.
 */
function runPredicates(cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      CQ_COMMAND,
      PREDICATES_ARGS,
      { cwd, maxBuffer: MAX_BUFFER_BYTES, encoding: "utf-8" },
      (error, stdout, stderr) => {
        const out = stdout.trim();
        if (out.length > 0) {
          resolve(out);
          return;
        }
        // No stdout: a genuine failure (spawn error, or empty output).
        const reason = error
          ? `cq predicates failed: ${error.message}`
          : "cq predicates produced no stdout";
        reject(new Error(stderr.trim().length > 0 ? `${reason}\n${stderr.trim()}` : reason));
      },
    );
  });
}

/** Narrow an arbitrary value to a non-null object (a string-keyed record). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parse ONE `{ value: boolean, items: string[] }` verdict from an arbitrary
 * value under `keyName` (used only for error messages). Fails fast on a missing
 * or mistyped field — the auto-driver must never act on a malformed verdict.
 */
function parseVerdict(raw: unknown, keyName: string): PredicateVerdict {
  if (!isRecord(raw)) {
    throw new Error(`predicate "${keyName}" is not an object: ${JSON.stringify(raw)}`);
  }
  const { value, items } = raw;
  if (typeof value !== "boolean") {
    throw new Error(`predicate "${keyName}".value is not a boolean: ${JSON.stringify(value)}`);
  }
  if (!Array.isArray(items) || !items.every((it): it is string => typeof it === "string")) {
    throw new Error(`predicate "${keyName}".items is not a string[]: ${JSON.stringify(items)}`);
  }
  return { value, items };
}

/**
 * Parse a full `DerivedPredicates` out of the `cq predicates` stdout JSON.
 * Exported for unit-testing the parser against a sample verdict literal without
 * shelling out. Handles the documented `{ value, items[] }` shape for every key
 * in PREDICATE_KEYS; throws on malformed JSON or any missing/mistyped key.
 */
export function parsePredicatesOutput(stdout: string): DerivedPredicates {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`cq predicates stdout is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`cq predicates stdout is not a JSON object: ${stdout}`);
  }
  const predicates = parsed.predicates;
  if (!isRecord(predicates)) {
    throw new Error(`cq predicates stdout has no "predicates" object: ${stdout}`);
  }
  const result = {} as Record<PredicateKey, PredicateVerdict>;
  for (const key of PREDICATE_KEYS) {
    result[key] = parseVerdict(predicates[key], key);
  }
  return result;
}

/**
 * Obtain the four derived flow-detection predicates at runtime via the pinned
 * `cq predicates` channel. Runs the CLI in `ctx.cwd` and parses its
 * `predicates` object into the copied `DerivedPredicates` type.
 */
export async function getPredicates(ctx: OracleContext): Promise<DerivedPredicates> {
  const stdout = await runPredicates(ctx.cwd);
  return parsePredicatesOutput(stdout);
}
