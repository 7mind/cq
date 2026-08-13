import { constants } from "node:os";
import { join, resolve } from "node:path";
import {
  IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
  dispatchPayloadDigest,
  type AuthorizedSupervisedWorkerGateContext,
  type DispatchJSONValue,
  type ImplementWorkerSupervisedGateEvidence,
} from "@cq/config";
import {
  launchRegisteredProcessGroup,
  settleProcessGroups,
  settleWorktreeGateCommands,
  type ProcessGroupRegistration,
} from "@cq/process-control";
import { assertManagedWorktreeDispatchBindingLive } from "./managedWorktree.js";

const FULL_SHA = /^[0-9a-f]{40}$/;
const PASS_COUNT = /(?:^|\n)\s*([0-9]+)\s+pass\b/gu;
const FAIL_COUNT = /(?:^|\n)\s*([0-9]+)\s+fail\b/gu;

/** Host-owned bounds begin only after the child has submitted its result. */
export const SUPERVISED_WORKER_GATE_ADMISSION_TIMEOUT_MS = 60 * 60 * 1_000;
export const SUPERVISED_WORKER_GATE_EXECUTION_TIMEOUT_MS = 30 * 60 * 1_000;

function requiresMutationEvidence(entryPath: string): boolean {
  const basename = entryPath.split("/").at(-1) ?? entryPath;
  return (
    entryPath.startsWith("test/") ||
    entryPath.includes("/test/") ||
    basename.endsWith(".test.ts") ||
    basename.includes("guard") ||
    basename.includes("invariant")
  );
}

export interface SupervisedWorkerGateRunRequest {
  readonly worktreePath: string;
  readonly executionTimeoutMs: number;
}

export interface SupervisedWorkerGateRunResult {
  readonly gateExitCode: number;
  readonly passCount: number;
  readonly failCount: number;
  readonly gateDurationMs: number;
  readonly capturedAt: string;
  readonly outputTail: string;
}

export interface SupervisedWorkerGateRunner {
  run(request: SupervisedWorkerGateRunRequest): Promise<SupervisedWorkerGateRunResult>;
}

export interface SuperviseImplementWorkerGateRequest {
  readonly context: AuthorizedSupervisedWorkerGateContext;
  readonly output: DispatchJSONValue;
}

export interface SuperviseImplementWorkerGateDeps {
  readonly runner?: SupervisedWorkerGateRunner;
  readonly stateDir?: string;
  readonly now?: () => Date;
}

function record(value: DispatchJSONValue, label: string): Record<string, DispatchJSONValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, DispatchJSONValue>;
}

function stringField(
  value: Record<string, DispatchJSONValue>,
  field: string,
  label: string,
): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new Error(`${label}.${field} must be a non-empty string`);
  }
  return candidate;
}

async function git(
  cwd: string,
  args: readonly string[],
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GIT_")) delete environment[key];
  }
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...environment,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      LANG: "C",
      LC_ALL: "C",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function checkedGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args[0] ?? ""} failed (${String(result.exitCode)}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function lastCount(pattern: RegExp, output: string): number | undefined {
  let observed: number | undefined;
  for (const match of output.matchAll(pattern)) observed = Number(match[1]);
  return observed;
}

function tail(output: string, lineCount = 20): string {
  return output.trimEnd().split("\n").slice(-lineCount).join("\n");
}

/** Real host adapter: fixed command, registered process group, absolute deadline, full settlement. */
export const nodeSupervisedWorkerGateRunner: SupervisedWorkerGateRunner = Object.freeze({
  async run(request: SupervisedWorkerGateRunRequest): Promise<SupervisedWorkerGateRunResult> {
    const startedAt = Date.now();
    if (!Number.isInteger(request.executionTimeoutMs) || request.executionTimeoutMs <= 0) {
      throw new Error("supervised worker gate executionTimeoutMs must be a positive integer");
    }
    let registration: ProcessGroupRegistration | undefined;
    let capturedStdout: Promise<string> | undefined;
    let capturedStderr: Promise<string> | undefined;
    const commandCwd = join(request.worktreePath, "nix", "pkg", "cq-ledgers");
    const launched = await launchRegisteredProcessGroup({
      argv: [
        "cq",
        "gate",
        "run",
        "--worktree",
        request.worktreePath,
        "--command-cwd",
        commandCwd,
        "--",
        "bun",
        "run",
        "check",
      ],
      cwd: request.worktreePath,
      env: process.env,
      stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" } as const,
      register: async (observed) => {
        registration = observed;
      },
      launchBootstrap: (specification) => {
        const child = Bun.spawn([...specification.argv], {
          cwd: specification.cwd,
          detached: specification.detached,
          env: specification.env,
          stdin: specification.stdio.stdin,
          stdout: specification.stdio.stdout,
          stderr: specification.stdio.stderr,
        });
        const stdout = new Response(child.stdout).text();
        const stderr = new Response(child.stderr).text();
        capturedStdout = stdout;
        capturedStderr = stderr;
        return {
          process: { child, stdout, stderr },
          pid: child.pid,
          exited: child.exited,
          outputDrained: Promise.all([stdout, stderr]).then(() => undefined),
          resultFromTargetOutcome: (outcome) => {
            if (outcome.exitCode !== null) return outcome.exitCode;
            if (outcome.signal === null) return 1;
            return 128 + (constants.signals[outcome.signal] ?? 1);
          },
          terminate: (signal: NodeJS.Signals) => child.kill(signal),
        };
      },
    });
    if (capturedStdout === undefined || capturedStderr === undefined) {
      throw new Error("supervised worker gate produced no output capture");
    }
    const processResult = Promise.all([launched.exited, capturedStdout, capturedStderr]).then(
      ([gateExitCode, stdout, stderr]) => ({ gateExitCode, stdout, stderr }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("supervised worker gate exceeded its host execution deadline")),
          request.executionTimeoutMs,
        );
      });
      const result = await Promise.race([processResult, timeout]);
      const gateSettlement = await settleWorktreeGateCommands({ worktree: request.worktreePath });
      const rootSettlement =
        registration === undefined
          ? { signaled: [], survivors: [] }
          : await settleProcessGroups([registration]);
      if (
        gateSettlement.signaled.length > 0 ||
        gateSettlement.survivors.length > 0 ||
        rootSettlement.survivors.length > 0
      ) {
        throw new Error("supervised worker gate left an unsettled process group");
      }
      const combined = `${result.stdout}\n${result.stderr}`;
      const passCount = lastCount(PASS_COUNT, combined) ?? 0;
      const failCount = lastCount(FAIL_COUNT, combined) ?? (result.gateExitCode === 0 ? 0 : 1);
      return Object.freeze({
        gateExitCode: result.gateExitCode,
        passCount,
        failCount,
        gateDurationMs: Date.now() - startedAt,
        capturedAt: new Date().toISOString(),
        outputTail: tail(combined),
      });
    } catch (error) {
      await settleWorktreeGateCommands({ worktree: request.worktreePath });
      if (registration !== undefined) await settleProcessGroups([registration]);
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  },
});

/**
 * Validate the exact manager-bound result tip, run the fixed host gate, and
 * return a new result carrying evidence no child can mint or substitute.
 */
export async function superviseImplementWorkerGate(
  request: SuperviseImplementWorkerGateRequest,
  deps: SuperviseImplementWorkerGateDeps = {},
): Promise<DispatchJSONValue> {
  const output = record(request.output, "worker result");
  if (Object.hasOwn(output, "supervisedGateEvidence")) {
    throw new Error("worker result must not carry caller-minted supervised gate evidence");
  }
  if (Object.hasOwn(output, "gateDurationMs")) {
    throw new Error("Codex brokered worker must use the runner-supervised gate arm");
  }
  if (output["status"] !== "pass") return request.output;

  const { context } = request;
  await assertManagedWorktreeDispatchBindingLive(context, {
    ...(deps.stateDir === undefined ? {} : { stateDir: deps.stateDir }),
  });
  const resultCommit = stringField(output, "resultCommit", "worker result");
  const branch = stringField(output, "branch", "worker result");
  const actualWorktreePath = stringField(output, "actualWorktreePath", "worker result");
  if (!FULL_SHA.test(resultCommit)) throw new Error("worker resultCommit must be a full SHA");
  if (output["taskId"] !== context.taskId) throw new Error("worker taskId substitution");
  if (branch !== context.branch) throw new Error("worker branch substitution");
  if (resolve(actualWorktreePath) !== resolve(context.worktreePath)) {
    throw new Error("worker worktree substitution");
  }
  const branchTip = await checkedGit(context.worktreePath, ["rev-parse", "--verify", context.ref]);
  if (branchTip !== resultCommit) throw new Error("supervised gate requires the exact branch tip");
  if ((await checkedGit(context.worktreePath, ["cat-file", "-t", resultCommit])) !== "commit") {
    throw new Error("supervised gate resultCommit is not a commit object");
  }
  const status = await checkedGit(context.worktreePath, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (status !== "") {
    throw new Error(`supervised gate requires a clean result tree: ${status}`);
  }
  for (const [label, ancestor] of [
    ["managed base", context.baseCommit],
    ["dispatch base", context.dispatchBaseCommit],
    ["starting", context.startingCommit],
  ] as const) {
    const ancestry = await git(context.worktreePath, [
      "merge-base",
      "--is-ancestor",
      ancestor,
      resultCommit,
    ]);
    if (ancestry.exitCode !== 0) {
      throw new Error(`supervised gate resultCommit is outside ${label} ancestry`);
    }
  }
  const baseVerification = record(output["baseVerification"] ?? null, "baseVerification");
  if (
    baseVerification["status"] !== "verified" ||
    baseVerification["baseCommit"] !== context.dispatchBaseCommit ||
    baseVerification["headCommit"] !== resultCommit
  ) {
    throw new Error("worker baseVerification does not match the exact supervised tip");
  }
  if (!Array.isArray(output["filesTouched"]) || !Array.isArray(output["gitReceipts"])) {
    throw new Error("supervised gate requires filesTouched and the complete Git receipt chain");
  }
  if (
    output["filesTouched"].some(
      (entry) => typeof entry === "string" && requiresMutationEvidence(entry),
    ) &&
    (!Array.isArray(output["mutationTable"]) || output["mutationTable"].length === 0)
  ) {
    throw new Error("supervised gate requires mutation evidence for every changed test or guard");
  }

  const run = await (deps.runner ?? nodeSupervisedWorkerGateRunner).run({
    worktreePath: context.worktreePath,
    executionTimeoutMs: SUPERVISED_WORKER_GATE_EXECUTION_TIMEOUT_MS,
  });
  if (run.gateExitCode !== 0 || run.failCount !== 0 || run.passCount <= 0) {
    throw new Error(
      `supervised worker gate rejected exit=${String(run.gateExitCode)} pass=${String(run.passCount)} fail=${String(run.failCount)}\n${run.outputTail}`,
    );
  }
  if (
    (await checkedGit(context.worktreePath, ["rev-parse", "--verify", context.ref])) !==
    resultCommit
  ) {
    throw new Error("supervised worker branch tip moved during the gate");
  }
  if (
    (await checkedGit(context.worktreePath, ["status", "--porcelain", "--untracked-files=all"])) !==
    ""
  ) {
    throw new Error("supervised worker tree became dirty during the gate");
  }

  const evidence: ImplementWorkerSupervisedGateEvidence = Object.freeze({
    kind: "cq-supervised-gate-evidence",
    version: 1,
    attestationId: context.attestationId,
    generation: context.generation,
    roleId: "implement-worker",
    roleVersion: context.promptProvenance.version,
    surface: "codex",
    promptDigest: context.promptProvenance.promptDigest,
    catalogHash: context.promptProvenance.catalogHash,
    inputDigest: context.promptProvenance.inputDigest,
    taskId: context.taskId,
    worktreePath: context.worktreePath,
    branch: context.branch,
    baseCommit: context.dispatchBaseCommit,
    startingCommit: context.startingCommit,
    resultCommit,
    clean: true,
    command: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
    gateExitCode: 0,
    passCount: run.passCount,
    failCount: 0,
    gateDurationMs: run.gateDurationMs,
    capturedAt: run.capturedAt,
    filesTouchedDigest: dispatchPayloadDigest(output["filesTouched"]),
    gitReceiptsDigest: dispatchPayloadDigest(output["gitReceipts"]),
    mutationTableDigest: dispatchPayloadDigest(output["mutationTable"] ?? null),
  });
  return Object.freeze({
    ...output,
    supervisedGateEvidence: evidence as unknown as DispatchJSONValue,
  });
}
