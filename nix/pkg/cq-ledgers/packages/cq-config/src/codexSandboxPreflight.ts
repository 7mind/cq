import { realpath } from "node:fs/promises";

/**
 * D266 pre-flight for the read-only Codex reviewer boundary.
 *
 * Root cause (openai/codex#18473): codex 0.146's linux-sandbox seccomp filter
 * EPERMs getsockname/getsockopt/getpeername while allowing AF_UNIX socketpair,
 * so a spawned Node child's libuv `uv_guess_handle` cannot classify its
 * socket-backed stdio, falls back to UV_UNKNOWN_HANDLE, and swaps in dummy
 * streams — captured pipes come back empty with exit status 0. A
 * pipe-sensitive gate suite inside such a sandbox reads the empty captures as
 * real output and can produce silent false failures. The pre-flight runs the
 * P1 repro (one-level `node -e` child with captured pipes) INSIDE the same
 * `codex sandbox -c sandbox_mode="read-only"` the reviewer dispatch will use,
 * before any model turn, and fails fast with a typed environmental verdict.
 *
 * TMPDIR: the Linux read-only sandbox mounts /tmp read-only, which breaks
 * registeredLaunch's mkdtemp for the reviewer's gate. Codex mounts a fresh,
 * empty, writable tmpfs at /dev/shm per Linux sandbox instance (verified live
 * against codex 0.146: host-created /dev/shm content is NOT visible inside).
 * Darwin has no /dev/shm and its sandbox permits /tmp. The injection uses `-c
 * shell_environment_policy.set.TMPDIR=...`, which reaches sandboxed shell
 * commands regardless of the configured inherit policy; the probe asserts the
 * value actually landed (os.tmpdir() inside the sandbox) rather than trusting
 * the override.
 *
 * Probe cadence: once per read-only reviewer dispatch, not cached per process.
 * The probe doubles as the per-dispatch TMPDIR verification and costs ~100 ms
 * against a multi-minute reviewer gate; a process-level cache would need
 * invalidation on codexExecutable/node resolution changes for no measurable
 * saving.
 */

export const CODEX_SANDBOX_PIPE_PROBE_VERDICTS = [
  "node-unavailable",
  "pipe-capture-lost",
  "tmpdir-unwritable",
  "sandbox-probe-failed",
] as const;

export type CodexSandboxPipeProbeVerdict = (typeof CODEX_SANDBOX_PIPE_PROBE_VERDICTS)[number];

export class SandboxPipeProbeError extends Error {
  readonly verdict: CodexSandboxPipeProbeVerdict;

  constructor(verdict: CodexSandboxPipeProbeVerdict, message: string) {
    super(`Codex sandbox pipe probe (${verdict}): ${message}`);
    this.name = "SandboxPipeProbeError";
    this.verdict = verdict;
  }
}

/** The reviewer roles this pre-flight is scoped to (D266); workers never run read-only. */
export const CODEX_REVIEWER_ROLE_SUFFIX = "-reviewer";

/** Writable temporary root available inside Codex's platform sandbox. */
export const CODEX_READ_ONLY_SANDBOX_TMPDIR = process.platform === "darwin" ? "/tmp" : "/dev/shm";

export const CODEX_SANDBOX_PIPE_PROBE_TIMEOUT_MS = 60_000;

const PIPE_DEFECT_EXPLANATION =
  "the codex linux-sandbox seccomp filter EPERMs getsockname/getsockopt/getpeername " +
  "while allowing AF_UNIX socketpair, so a Node child's uv_guess_handle cannot classify " +
  "its socket-backed stdio and falls back to UV_UNKNOWN_HANDLE dummy streams: captured " +
  "pipes come back empty with exit status 0 (openai/codex#18473). A reviewer gate run " +
  "inside this sandbox would misread empty captures as real output; refusing to dispatch.";

export function requiresCodexSandboxPreflight(roleId: string, sandboxMode: string): boolean {
  return sandboxMode === "read-only" && roleId.endsWith(CODEX_REVIEWER_ROLE_SUFFIX);
}

/**
 * The P1 repro plus the TMPDIR check. Reports through fs.writeSync(1): inside
 * the broken sandbox the probe process's OWN console output is a dummy stream,
 * while direct fd writes survive. Exits 0 only when the node child's captured
 * stdout is exactly "1\n" and an mkdtemp under the injected TMPDIR succeeded.
 */
const PROBE_SOURCE = `
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const child = spawnSync(process.execPath, ["-e", "console.log(1)"], { encoding: "utf8" });
let made = null;
try {
  made = fs.mkdtempSync(path.join(os.tmpdir(), "cq-sandbox-preflight-"));
  fs.rmSync(made, { recursive: true, force: true });
} catch {}
const report = {
  pipeStdout: child.stdout,
  pipeStatus: child.status,
  pipeError: child.error === undefined ? null : String(child.error),
  tmpdir: os.tmpdir(),
  mkdtemp: made,
};
fs.writeSync(1, JSON.stringify(report) + "\\n");
process.exit(child.status === 0 && child.stdout === "1\\n" && made !== null ? 0 : 1);
`;

export interface CodexSandboxPipeProbeRequest {
  readonly codexExecutable: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
}

export interface CodexSandboxPipeProbeReport {
  readonly nodeExecutable: string;
  readonly sandboxTmpdir: string;
  readonly mkdtemp: string;
  readonly durationMs: number;
}

interface ProbeSandboxReport {
  readonly pipeStdout: string;
  readonly pipeStatus: number;
  readonly tmpdir: string;
  readonly mkdtemp: string | null;
}

function parseProbeReport(stdout: string): ProbeSandboxReport | undefined {
  const line = stdout
    .split("\n")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate !== "")
    .at(-1);
  if (line === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record["pipeStdout"] !== "string" ||
    typeof record["pipeStatus"] !== "number" ||
    typeof record["tmpdir"] !== "string" ||
    (record["mkdtemp"] !== null && typeof record["mkdtemp"] !== "string")
  ) {
    return undefined;
  }
  return {
    pipeStdout: record["pipeStdout"],
    pipeStatus: record["pipeStatus"],
    tmpdir: record["tmpdir"],
    mkdtemp: record["mkdtemp"],
  };
}

/**
 * Run the pipe/TMPDIR probe inside the same read-only codex sandbox the
 * reviewer dispatch will use. Any failure throws {@link SandboxPipeProbeError}
 * with an explicit environmental verdict; the probe never passes vacuously
 * (a missing node binary is itself a failing verdict).
 */
export async function runCodexSandboxPipeProbe(
  request: CodexSandboxPipeProbeRequest,
): Promise<CodexSandboxPipeProbeReport> {
  const pathEnv = request.env["PATH"];
  const located = pathEnv === undefined ? Bun.which("node") : Bun.which("node", { PATH: pathEnv });
  if (located === null) {
    throw new SandboxPipeProbeError(
      "node-unavailable",
      "no node binary on PATH; the reviewer gate spawns Node children, so the pipe probe " +
        "cannot run and must not pass vacuously",
    );
  }
  const nodeExecutable = await realpath(located);
  const startedAt = Date.now();
  const child = Bun.spawn(
    [
      request.codexExecutable,
      "sandbox",
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      renderSandboxTmpdirOverride(CODEX_READ_ONLY_SANDBOX_TMPDIR),
      "--",
      nodeExecutable,
      "-e",
      PROBE_SOURCE,
    ],
    {
      cwd: request.cwd,
      // TMPDIR in the spawn env covers codex builds that forward the parent
      // environment verbatim; the -c override covers policy-filtered builds.
      env: { ...request.env, TMPDIR: CODEX_READ_ONLY_SANDBOX_TMPDIR },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, request.timeoutMs);
  let exitCode: number;
  try {
    exitCode = await child.exited;
  } finally {
    clearTimeout(timer);
  }
  const [capturedStdout, capturedStderr] = await Promise.all([stdout, stderr]);
  const report = parseProbeReport(capturedStdout);
  if (report === undefined) {
    throw new SandboxPipeProbeError(
      "sandbox-probe-failed",
      `the sandboxed probe produced no parseable report (exit ${String(exitCode)}` +
        `${timedOut ? `, killed after ${String(request.timeoutMs)} ms` : ""}): ` +
        capturedStderr.trim().slice(0, 500),
    );
  }
  // Classify from the report fields, not the exit code: the probe exits 1 for
  // both pipe loss and TMPDIR failure, and each must keep its own verdict.
  if (report.pipeStatus !== 0 || report.pipeStdout !== "1\n") {
    throw new SandboxPipeProbeError(
      "pipe-capture-lost",
      `a one-level node child with captured pipes returned ` +
        `${JSON.stringify(report.pipeStdout)} (status ${String(report.pipeStatus)}) instead of ` +
        `${JSON.stringify("1\n")}: ${PIPE_DEFECT_EXPLANATION}`,
    );
  }
  if (report.tmpdir !== CODEX_READ_ONLY_SANDBOX_TMPDIR) {
    throw new SandboxPipeProbeError(
      "tmpdir-unwritable",
      `the TMPDIR override did not reach the sandboxed process (os.tmpdir() returned ` +
        `${JSON.stringify(report.tmpdir)}, expected ${JSON.stringify(CODEX_READ_ONLY_SANDBOX_TMPDIR)})`,
    );
  }
  if (report.mkdtemp === null) {
    throw new SandboxPipeProbeError(
      "tmpdir-unwritable",
      `mkdtemp under the injected TMPDIR ${JSON.stringify(CODEX_READ_ONLY_SANDBOX_TMPDIR)} ` +
        "failed inside the sandbox",
    );
  }
  if (exitCode !== 0) {
    throw new SandboxPipeProbeError(
      "sandbox-probe-failed",
      `the sandboxed probe reported success but exited ${String(exitCode)}`,
    );
  }
  return Object.freeze({
    nodeExecutable,
    sandboxTmpdir: report.tmpdir,
    mkdtemp: report.mkdtemp,
    durationMs: Date.now() - startedAt,
  });
}

export function renderSandboxTmpdirOverride(tmpdir: string): string {
  return `shell_environment_policy.set.TMPDIR=${JSON.stringify(tmpdir)}`;
}

/**
 * Splice the TMPDIR override into a boundary argv ahead of its trailing "-"
 * stdin marker, so every shell command the reviewer runs inside the sandbox
 * (the gate's registeredLaunch mkdtemp included) sees the writable tmpfs.
 */
export function argvWithSandboxTmpdir(
  argv: readonly string[],
  tmpdir: string,
): readonly string[] {
  if (argv.length === 0 || argv[argv.length - 1] !== "-") {
    throw new SandboxPipeProbeError(
      "sandbox-probe-failed",
      "Codex boundary argv lost its trailing stdin marker",
    );
  }
  return Object.freeze([
    ...argv.slice(0, argv.length - 1),
    "-c",
    renderSandboxTmpdirOverride(tmpdir),
    "-",
  ]);
}
