/**
 * T372 / G44 (fixes D50; Q204 item 2) — INTEGRATION test of the Claude Code
 * Stop-hook WRAPPER's stdout/exit CONTRACT, driven against a STUBBED gate.
 *
 * The wrapper under test is the `claudeStopGateHook` `pkgs.writeShellScript`
 * `"claude-stop-advance-gate"` in `nix/hm/claude.nix`. It is a let-binding
 * INSIDE the HM module, not an exposed flake attr, so we cannot `nix build` it
 * directly. To keep ONE source of truth (the committed wrapper body in
 * claude.nix) while running it hermetically, this test EXTRACTS the exact shell
 * body from claude.nix and realizes it to a runnable temp script:
 *
 *   - the Nix-escaped antiquotation `''${…}` is un-escaped to `${…}`
 *     (Nix `''${` → literal `${` inside a `''…''` string);
 *   - the single real Nix antiquotation `${pkgs.jq}/bin/jq` is rewritten to
 *     plain `jq` — resolved from PATH in the test (jq is on PATH here, exactly
 *     as the comment in claude.nix states it is at runtime via the harness).
 *
 * No other transformation is applied, so the realized script is byte-for-byte
 * the wrapper's logic. T364's review verified the wrapper via an ad-hoc
 * "stubbed-cq smoke test"; this is that smoke test, committed and hermetic.
 *
 * The gate (`cq advance-gate`) is STUBBED via PATH: a temp dir whose `cq` is a
 * shell script that — keyed on the `STUB_CQ_MODE` env — returns either
 *   (block) exit NON-ZERO + stdout = a neutral verdict JSON
 *           `{block,reason,predicates}`, or
 *   (allow) exit 0 + stdout = an allow verdict.
 * The wrapper must translate (block) → `{"decision":"block","reason":<reason>}`
 * on stdout, and (allow) → empty stdout. The test never touches the live
 * harness, the real `cq` binary, or the real ledger.
 *
 * Contract asserted (matches claude.nix's documented Stop-hook protocol):
 *   (a) stub cq exits NON-ZERO + reason ⇒ wrapper stdout parses to
 *       `{decision:"block", reason:<the gate's .reason>}` and exits 0;
 *   (b) stub cq exits 0 ⇒ wrapper ALLOWS: empty stdout, no `decision:block`,
 *       exit 0;
 *   (c) no `$CLAUDE_CODE_SESSION_ID` ⇒ wrapper ALLOWS without invoking cq:
 *       empty stdout, exit 0.
 *
 * Runs as part of `bun run check` (`bun test`). Requires `jq` + `bash` on PATH
 * (present in this dev shell); if `jq` is absent the (a) case is skipped with a
 * logged note rather than failing spuriously.
 */

import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// --- temp-dir bookkeeping ---------------------------------------------------

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});
async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// --- extract the wrapper body from claude.nix (single source of truth) ------

const CLAUDE_NIX = path.resolve(import.meta.dir, "../../../../../hm/claude.nix");
const WRAPPER_MARKER = 'pkgs.writeShellScript "claude-stop-advance-gate" ';

/**
 * Pull the exact shell body of the `claudeStopGateHook` `writeShellScript` out
 * of claude.nix and realize it as a runnable POSIX-sh script string.
 *
 * Nix `''…''` string semantics undone here: `''${` → `${` (escaped
 * antiquotation) and `${pkgs.jq}/bin/jq` → `jq` (the sole real antiquotation,
 * resolved from PATH in the test). Throws if the marker / delimiters are not
 * found so a future rename of the binding fails LOUDLY instead of silently
 * testing nothing.
 */
async function extractWrapperBody(): Promise<string> {
  const src = await readFile(CLAUDE_NIX, "utf8");
  const markerIdx = src.indexOf(WRAPPER_MARKER);
  if (markerIdx === -1) {
    throw new Error(`claude.nix: could not find ${WRAPPER_MARKER} (wrapper renamed?)`);
  }
  const openIdx = src.indexOf("''", markerIdx);
  if (openIdx === -1) throw new Error("claude.nix: wrapper opening '' not found");
  const closeIdx = src.indexOf("'';", openIdx + 2);
  if (closeIdx === -1) throw new Error("claude.nix: wrapper closing ''; not found");
  let body = src.slice(openIdx + 2, closeIdx);
  // Drop the leading newline right after the opening `''`.
  if (body.startsWith("\n")) body = body.slice(1);
  // Un-escape Nix's `''${` → `${`, then resolve the jq antiquotation to PATH.
  body = body.replaceAll("''${", "${");
  body = body.replaceAll("${pkgs.jq}/bin/jq", "jq");
  // Sanity: no unresolved Nix antiquotation must remain in the realized script.
  if (/\$\{pkgs\./.test(body)) {
    throw new Error("claude.nix: unresolved Nix antiquotation in extracted wrapper body");
  }
  return body;
}

// --- the block-mode neutral verdict the stub gate emits ---------------------

const BLOCK_REASON =
  "P-implement=TRUE and unblocked; continue per D41 — turn-pause is not a stop condition";
const STUB_BLOCK_VERDICT = JSON.stringify({
  block: true,
  reason: BLOCK_REASON,
  predicates: {
    pInvestigate: { value: false, items: [] },
    pPlan: { value: false, items: [] },
    pImplement: { value: true, items: ["T999"] },
  },
});
const STUB_ALLOW_VERDICT = JSON.stringify({
  block: false,
  reason: "no actionable predicate",
  predicates: {
    pInvestigate: { value: false, items: [] },
    pPlan: { value: false, items: [] },
    pImplement: { value: false, items: [] },
  },
});

const SESSION_ID = "claude-stop-hook-contract-session";
const HAVE_JQ = Bun.which("jq") !== null;

// --- harness: realize wrapper + stub cq, then run the wrapper ---------------

interface RunResult {
  stdout: string;
  exitCode: number;
}

let wrapperPath: string;
let stubBinDir: string;

beforeAll(async () => {
  const wrapperBody = await extractWrapperBody();
  const scriptDir = await makeTmpDir("cq-stophook-script-");
  wrapperPath = path.join(scriptDir, "claude-stop-advance-gate.sh");
  await writeFile(wrapperPath, wrapperBody, "utf8");
  await chmod(wrapperPath, 0o755);

  // Stub `cq`: a shell script that, keyed on $STUB_CQ_MODE, prints the chosen
  // verdict to stdout and exits 0 (allow) or 1 (block). It also records that it
  // was invoked, so the no-session case can assert cq was NOT called.
  stubBinDir = await makeTmpDir("cq-stophook-bin-");
  const stubCq = [
    "#!/usr/bin/env bash",
    "set -eu",
    'echo "invoked $*" >> "$STUB_CQ_CALLLOG"',
    'if [ "${STUB_CQ_MODE}" = "block" ]; then',
    `  printf '%s' '${STUB_BLOCK_VERDICT.replaceAll("'", "'\\''")}'`,
    "  exit 1",
    "fi",
    `printf '%s' '${STUB_ALLOW_VERDICT.replaceAll("'", "'\\''")}'`,
    "exit 0",
    "",
  ].join("\n");
  await writeFile(path.join(stubBinDir, "cq"), stubCq, "utf8");
  await chmod(path.join(stubBinDir, "cq"), 0o755);
});

/** Run the realized wrapper with a freshly-prepared env + stub `cq` on PATH. */
async function runWrapper(opts: {
  mode: "block" | "allow";
  session: string | undefined;
}): Promise<RunResult & { callLog: string }> {
  const callLog = path.join(stubBinDir, `calllog-${Math.random().toString(36).slice(2)}`);
  const env: NodeJS.ProcessEnv = {
    // Minimal hermetic env: only PATH (stub cq + system jq/bash) and the stub's
    // controls. Inherit the existing PATH so jq/bash resolve in the dev shell.
    PATH: `${stubBinDir}:${process.env["PATH"] ?? ""}`,
    STUB_CQ_MODE: opts.mode,
    STUB_CQ_CALLLOG: callLog,
  };
  if (opts.session !== undefined) env["CLAUDE_CODE_SESSION_ID"] = opts.session;

  let stdout = "";
  let exitCode = 0;
  try {
    const res = await execFileAsync("bash", [wrapperPath], { env, cwd: stubBinDir });
    stdout = res.stdout;
  } catch (e) {
    const err = e as { stdout?: string; code?: number };
    stdout = err.stdout ?? "";
    exitCode = typeof err.code === "number" ? err.code : 1;
  }
  const callLogContent = await readFile(callLog, "utf8").catch(() => "");
  return { stdout, exitCode, callLog: callLogContent };
}

describe("claude-stop-advance-gate wrapper — stdout/exit contract vs a stubbed gate (T372)", () => {
  it.skipIf(!HAVE_JQ)(
    "(a) stub cq exits NON-ZERO with a reason → wrapper emits {decision:block, reason:<gate reason>}, exit 0",
    async () => {
      const { stdout, exitCode } = await runWrapper({ mode: "block", session: SESSION_ID });

      // Wrapper itself exits 0 — the BLOCK is carried in the JSON, not the code.
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim()) as { decision: string; reason: string };
      expect(parsed.decision).toBe("block");
      expect(parsed.reason).toBe(BLOCK_REASON);
      // Exactly the two contract keys — the wrapper drops block/predicates.
      expect(Object.keys(parsed).sort()).toEqual(["decision", "reason"]);
    },
  );

  it("(b) stub cq exits 0 → wrapper ALLOWS: empty stdout, no decision:block, exit 0", async () => {
    const { stdout, exitCode } = await runWrapper({ mode: "allow", session: SESSION_ID });

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
    expect(stdout).not.toContain("block");
  });

  it("(c) no $CLAUDE_CODE_SESSION_ID → wrapper ALLOWS without invoking cq: empty stdout, exit 0", async () => {
    const { stdout, exitCode, callLog } = await runWrapper({ mode: "block", session: undefined });

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
    // The gate must not even be consulted when there is no session id.
    expect(callLog).toBe("");
  });
});
