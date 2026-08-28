import { constants } from "node:os";
import { join, resolve } from "node:path";
import {
  CODEX_STAGED_TIMING_BASIS,
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
  type SettleProcessGroupsResult,
  type SettleWorktreeGateCommandsOptions,
} from "@cq/process-control";
import {
  assertManagedWorktreeDispatchBindingLive,
  recordManagedWorktreeSupervisedGateEvidence,
} from "./managedWorktree.js";

const FULL_SHA = /^[0-9a-f]{40}$/;
const PASS_COUNT = /(?:^|\n)\s*([0-9]+)\s+pass\b/gu;
const FAIL_COUNT = /(?:^|\n)\s*([0-9]+)\s+fail\b/gu;
const FAIL_SUMMARY_LINE = /^\s*[0-9]+\s+fail\b/u;
const OUTPUT_TAIL_LINE_COUNT = 20;
const FAILURE_SUMMARY_CONTEXT_LINE_COUNT = 2;
const FAILURE_SUMMARY_WINDOW_BYTE_LIMIT = 256;
const FAILURE_OUTPUT_TAIL_BYTE_LIMIT = 896;

/** Host-owned bounds begin only after the child has submitted its result. */
export const SUPERVISED_WORKER_GATE_ADMISSION_TIMEOUT_MS =
  CODEX_STAGED_TIMING_BASIS.parentEffectLockAcquisitionMs;
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
  readonly admissionTimeoutMs: number;
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

/**
 * Injectable settlement arms around the node runner (D342). The production
 * singleton explicitly supplies the real worktree and registered-root
 * settlement helpers; tests substitute hand-written wrappers around those
 * same real helpers.
 */
export interface NodeSupervisedWorkerGateSettlement {
  readonly settleWorktreeGateCommands: (
    options: SettleWorktreeGateCommandsOptions,
  ) => Promise<SettleProcessGroupsResult>;
  readonly settleProcessGroups: (
    registrations: readonly ProcessGroupRegistration[],
  ) => Promise<SettleProcessGroupsResult>;
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

function tail(output: string): string {
  return output.trimEnd().split("\n").slice(-OUTPUT_TAIL_LINE_COUNT).join("\n");
}

function truncateUtf8(value: string, byteLimit: number): string {
  let byteCount = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (byteCount + characterBytes > byteLimit) break;
    byteCount += characterBytes;
    end += character.length;
  }
  return value.slice(0, end);
}

function failureSummaryWindow(output: string): string {
  const lines = output.trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line !== undefined && FAIL_SUMMARY_LINE.test(line)) {
      return lines
        .slice(Math.max(0, index - FAILURE_SUMMARY_CONTEXT_LINE_COUNT + 1), index + 1)
        .map((line) => truncateUtf8(line, FAILURE_SUMMARY_WINDOW_BYTE_LIMIT))
        .join("\n");
    }
  }
  return "";
}

function outputTail(stdout: string, stderr: string, gateExitCode: number): string {
  if (gateExitCode === 0) return tail(`${stdout}\n${stderr}`);
  return truncateUtf8(
    [failureSummaryWindow(stdout), failureSummaryWindow(stderr), tail(stdout), tail(stderr)]
      .filter((value) => value.length > 0)
      .join("\n"),
    FAILURE_OUTPUT_TAIL_BYTE_LIMIT,
  );
}

export function createNodeSupervisedWorkerGateRunner(
  settlement: NodeSupervisedWorkerGateSettlement,
): SupervisedWorkerGateRunner {
  let admissionTail: Promise<void> = Promise.resolve();
  return Object.freeze({
    async run(request: SupervisedWorkerGateRunRequest): Promise<SupervisedWorkerGateRunResult> {
      if (!Number.isInteger(request.admissionTimeoutMs) || request.admissionTimeoutMs <= 0) {
        throw new Error("supervised worker gate admissionTimeoutMs must be a positive integer");
      }
      if (!Number.isInteger(request.executionTimeoutMs) || request.executionTimeoutMs <= 0) {
        throw new Error("supervised worker gate executionTimeoutMs must be a positive integer");
      }
      const predecessor = admissionTail;
      let releaseAdmission!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      admissionTail = predecessor.then(
        () => held,
        () => held,
      );
      let admissionTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          predecessor,
          new Promise<never>((_resolve, reject) => {
            admissionTimer = setTimeout(
              () =>
                reject(new Error("supervised worker gate exceeded its host admission deadline")),
              request.admissionTimeoutMs,
            );
          }),
        ]);
        if (admissionTimer !== undefined) clearTimeout(admissionTimer);
        return await runAdmittedNodeSupervisedWorkerGate(request, settlement);
      } finally {
        if (admissionTimer !== undefined) clearTimeout(admissionTimer);
        releaseAdmission();
      }
    },
  });
}

const SETTLEMENT_DIAGNOSTIC_MESSAGE_LIMIT = 200;
const SETTLEMENT_DIAGNOSTIC_SURVIVOR_LIMIT = 8;

type SettlementArmOutcome =
  | { readonly status: "fulfilled"; readonly result: SettleProcessGroupsResult }
  | { readonly status: "rejected"; readonly error: unknown };

/** All-settled capture: one cleanup arm's rejection never suppresses the other arm (D342). */
async function captureSettlementArm(
  arm: () => Promise<SettleProcessGroupsResult>,
): Promise<SettlementArmOutcome> {
  try {
    return { status: "fulfilled", result: await arm() };
  } catch (error) {
    return { status: "rejected", error };
  }
}

function boundedDiagnosticMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= SETTLEMENT_DIAGNOSTIC_MESSAGE_LIMIT
    ? message
    : `${message.slice(0, SETTLEMENT_DIAGNOSTIC_MESSAGE_LIMIT)}…`;
}

function boundedSurvivorList(survivors: readonly number[]): string {
  const listed = survivors.slice(0, SETTLEMENT_DIAGNOSTIC_SURVIVOR_LIMIT).join(", ");
  const omitted = survivors.length - SETTLEMENT_DIAGNOSTIC_SURVIVOR_LIMIT;
  return omitted <= 0 ? listed : `${listed}, … (+${String(omitted)} more)`;
}

/** Bounded per-arm diagnostics: rejections and survivor identifier lists, in arm order. */
function settlementDiagnostics(
  worktreeSettlement: SettlementArmOutcome,
  rootSettlement: SettlementArmOutcome,
): string[] {
  const diagnostics: string[] = [];
  if (worktreeSettlement.status === "rejected") {
    diagnostics.push(
      `worktree settlement rejected: ${boundedDiagnosticMessage(worktreeSettlement.error)}`,
    );
  } else if (worktreeSettlement.result.survivors.length > 0) {
    diagnostics.push(
      `worktree settlement survivors: ${boundedSurvivorList(worktreeSettlement.result.survivors)}`,
    );
  }
  if (rootSettlement.status === "rejected") {
    diagnostics.push(
      `registered-root settlement rejected: ${boundedDiagnosticMessage(rootSettlement.error)}`,
    );
  } else if (rootSettlement.result.survivors.length > 0) {
    diagnostics.push(
      `registered-root survivors: ${boundedSurvivorList(rootSettlement.result.survivors)}`,
    );
  }
  return diagnostics;
}

/** Success-path settlement gate: any arm rejection, signaled worktree group, or survivor fails closed. */
function settlementFailed(
  worktreeSettlement: SettlementArmOutcome,
  rootSettlement: SettlementArmOutcome,
): boolean {
  if (worktreeSettlement.status === "rejected" || rootSettlement.status === "rejected") {
    return true;
  }
  return (
    worktreeSettlement.result.signaled.length > 0 ||
    worktreeSettlement.result.survivors.length > 0 ||
    rootSettlement.result.survivors.length > 0
  );
}

/** Real host adapter: serialized admission, fixed command, execution deadline, full settlement. */
async function runAdmittedNodeSupervisedWorkerGate(
  request: SupervisedWorkerGateRunRequest,
  settlement: NodeSupervisedWorkerGateSettlement,
): Promise<SupervisedWorkerGateRunResult> {
  const startedAt = Date.now();
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
  let raced: Awaited<typeof processResult> | undefined;
  let originalError: unknown;
  let worktreeSettlement: SettlementArmOutcome | undefined;
  let rootSettlement: SettlementArmOutcome | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("supervised worker gate exceeded its host execution deadline")),
        request.executionTimeoutMs,
      );
    });
    raced = await Promise.race([processResult, timeout]);
  } catch (error) {
    originalError = error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // D342: both cleanup arms run exactly once in this unconditional finally;
    // neither a rejection nor survivors in one arm may suppress the other.
    worktreeSettlement = await captureSettlementArm(() =>
      settlement.settleWorktreeGateCommands({ worktree: request.worktreePath }),
    );
    const registeredRoot = registration;
    rootSettlement =
      registeredRoot === undefined
        ? { status: "fulfilled", result: { signaled: [], survivors: [] } }
        : await captureSettlementArm(() => settlement.settleProcessGroups([registeredRoot]));
  }
  if (worktreeSettlement === undefined || rootSettlement === undefined) {
    throw new Error("supervised worker gate settlement arms did not both run");
  }
  const diagnostics = settlementDiagnostics(worktreeSettlement, rootSettlement);
  if (raced === undefined) {
    if (diagnostics.length > 0) {
      throw new Error(`supervised worker gate cleanup failed: ${diagnostics.join("; ")}`, {
        cause: originalError,
      });
    }
    throw originalError;
  }
  if (settlementFailed(worktreeSettlement, rootSettlement)) {
    throw new Error(
      `supervised worker gate left an unsettled process group${diagnostics.length === 0 ? "" : `: ${diagnostics.join("; ")}`}`,
    );
  }
  const combined = `${raced.stdout}\n${raced.stderr}`;
  const passCount = lastCount(PASS_COUNT, combined) ?? 0;
  const failCount = lastCount(FAIL_COUNT, combined) ?? (raced.gateExitCode === 0 ? 0 : 1);
  return Object.freeze({
    gateExitCode: raced.gateExitCode,
    passCount,
    failCount,
    gateDurationMs: Date.now() - startedAt,
    capturedAt: new Date().toISOString(),
    outputTail: outputTail(raced.stdout, raced.stderr, raced.gateExitCode),
  });
}

export const nodeSupervisedWorkerGateRunner: SupervisedWorkerGateRunner =
  createNodeSupervisedWorkerGateRunner({ settleWorktreeGateCommands, settleProcessGroups });

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
  if (context.guardedRebaseBridge === undefined) {
    if (Object.hasOwn(output, "gitLineage")) {
      throw new Error("an ordinary worker result cannot carry a guarded-rebase lineage");
    }
  } else {
    const lineage = output["gitLineage"];
    if (lineage === null || typeof lineage !== "object" || Array.isArray(lineage)) {
      throw new Error("guarded worker result omitted its resolved lineage");
    }
    const record = lineage as Readonly<Record<string, unknown>>;
    if (
      record["kind"] !== "guarded-rebase" ||
      record["guardedRebase"] !== context.guardedRebaseBridge.guardedRebase ||
      record["ontoCommit"] !== context.guardedRebaseBridge.ontoCommit ||
      record["rebasedStartCommit"] !== context.guardedRebaseBridge.rebasedStartCommit ||
      record["exactTip"] !== context.guardedRebaseBridge.exactTip
    ) {
      throw new Error("guarded worker result substituted its resolved lineage");
    }
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
    admissionTimeoutMs: SUPERVISED_WORKER_GATE_ADMISSION_TIMEOUT_MS,
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
  await recordManagedWorktreeSupervisedGateEvidence(context, evidence, {
    ...(deps.stateDir === undefined ? {} : { stateDir: deps.stateDir }),
  });
  return Object.freeze({
    ...output,
    supervisedGateEvidence: evidence as unknown as DispatchJSONValue,
  });
}
