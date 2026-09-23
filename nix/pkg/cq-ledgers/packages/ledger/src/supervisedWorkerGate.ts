import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  CODEX_STAGED_TIMING_BASIS,
  DISPATCH_INVOCATION_ENV_NAMES,
  IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
  IMPLEMENT_WORKER_SUPERVISED_GATE_REJECTION_KIND,
  IMPLEMENT_WORKER_SUPERVISED_GATE_REJECTION_TAIL_BYTE_LIMIT,
  IMPLEMENT_WORKER_SUPERVISED_GATE_DIAGNOSTIC_FIELD_BYTE_LIMIT,
  dispatchPayloadDigest,
  isImplementWorkerSupervisedGateRejectionDetails,
  type AuthorizedSupervisedWorkerGateContext,
  type DispatchJSONValue,
  type ImplementWorkerSupervisedGateRejectionDetails,
  type ImplementWorkerSupervisedGateEvidence,
} from "@cq/config";
import {
  launchRegisteredProcessGroup,
  settleProcessGroups,
  settleWorktreeGateCommands,
  WorksetEffectBroker,
  type ProcessGroupRegistration,
  type RegisteredLaunchBootstrapSpecification,
  type WorksetEffectAdmissionProvider,
  type SettleProcessGroupsResult,
  type SettleWorktreeGateCommandsOptions,
} from "@cq/process-control";
import {
  assertManagedWorktreeDispatchBindingLive,
  findOpenWipCheckpoints,
  recordManagedWorktreeSupervisedGateEvidence,
  assertManagedCohortWorktreeDispatchBindingLive,
  type ManagedCohortWorktreeAuthority,
} from "./managedWorktree.js";
import { gitBrokerSubjectsMatch } from "./gitChangeBroker.js";
import { cohortValueDigestV1, type CohortEvidenceSubjectV1 } from "./workCohort.js";
import { validateCohortExecutionBindingV1, type CohortAcceptanceCandidateV1 } from "./workCohortAcceptance.js";
import { redactSecrets } from "./store/logRedaction.js";

const FULL_SHA = /^[0-9a-f]{40}$/;
const PASS_COUNT = /(?:^|\n)\s*([0-9]+)\s+pass\b/gu;
const FAIL_COUNT = /(?:^|\n)\s*([0-9]+)\s+fail\b/gu;
const BUN_FAILURE_IDENTITY_LINE = /^\(fail\)\s+\S/u;
const FAIL_SUMMARY_LINE = /^\s*[0-9]+\s+fail\b/u;
const OUTPUT_TAIL_LINE_COUNT = 20;
const FAILURE_IDENTITY_LINE_LIMIT = 4;
const FAILURE_IDENTITY_BYTE_LIMIT = 192;
const FAILURE_SUMMARY_CONTEXT_LINE_COUNT = 2;
const FAILURE_SUMMARY_WINDOW_BYTE_LIMIT = 256;
const FAILURE_OUTPUT_TAIL_BYTE_LIMIT = IMPLEMENT_WORKER_SUPERVISED_GATE_REJECTION_TAIL_BYTE_LIMIT;

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
  readonly cancellationSignal: AbortSignal;
  readonly effectAdmission?: {
    readonly provider: WorksetEffectAdmissionProvider;
    readonly targetRef: string;
  };
}

export interface SupervisedWorkerGateRunResult {
  readonly gateExitCode: number;
  readonly passCount: number;
  readonly failCount: number;
  readonly gateDurationMs: number;
  readonly capturedAt: string;
  readonly outputTail: string;
  readonly diagnosticArtifact?: SupervisedWorkerGateRunDiagnosticArtifact;
}

export interface SupervisedWorkerGateFailureDiagnostic {
  readonly identity: string;
  readonly reference: string;
  readonly assertion: string;
}

/** Runner-owned, redacted JUnit index before the broker adds exact attempt binding. */
export interface SupervisedWorkerGateRunDiagnosticArtifact {
  readonly reportDigest: string;
  readonly failures: readonly SupervisedWorkerGateFailureDiagnostic[];
  /** Complete redacted JUnit bytes; omitted only by synthetic runner dummies. */
  readonly report?: string;
}

export interface SupervisedWorkerGateRunner {
  run(request: SupervisedWorkerGateRunRequest): Promise<SupervisedWorkerGateRunResult>;
}

export interface SupervisedWorkerCommandRunRequest extends SupervisedWorkerGateRunRequest {
  readonly command: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
  };
}

export interface SupervisedWorkerCommandRunResult extends SupervisedWorkerGateRunResult {
  readonly executionId: string;
  readonly outputDigest: string;
  readonly completeOutput?: string;
}

export interface SupervisedWorkerCommandRunner {
  run(request: SupervisedWorkerCommandRunRequest): Promise<SupervisedWorkerCommandRunResult>;
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
  readonly cancellationSignal: AbortSignal;
  readonly cohortAuthority?: ManagedCohortWorktreeAuthority;
  readonly effectAdmission?: SupervisedWorkerGateRunRequest["effectAdmission"];
}

async function assertCohortGatePrerequisites(
  context: AuthorizedSupervisedWorkerGateContext,
  resultCommit: string,
  authority: ManagedCohortWorktreeAuthority,
  stateDir: string | undefined,
): Promise<CohortEvidenceSubjectV1> {
  const { envelope, lease, store } = authority;
  if (context.cohort === undefined || envelope.state !== "sealed" ||
      !gitBrokerSubjectsMatch(context, { cohort: envelope }, true)) {
    throw new Error("cohort gate requires exact sealed authority for the producing dispatch");
  }
  await assertManagedCohortWorktreeDispatchBindingLive({ ...context, cohort: envelope }, authority,
    stateDir === undefined ? {} : { stateDir }, false);
  await store.assertLiveAcceptanceAuthority(lease);
  const state = (await store.snapshot()).portable;
  const subject = state.evidenceSubjects.find((entry) => entry.evidenceSubjectDigest === envelope.evidenceSubject.evidenceSubjectDigest);
  const definition = state.definitions.find((entry) => entry.definitionDigest === subject?.definitionDigest);
  const seal = state.candidateSeals.find((entry) => entry.sealDigest === subject?.sealDigest);
  const matrix = state.frozenMatrices.find((entry) => entry.matrixDigest === definition?.acceptanceMatrixDigest);
  const attempt = state.candidateAttempts.find((entry) => entry.candidateAttemptDigest === seal?.candidateAttemptDigest);
  if (subject === undefined || definition === undefined || seal === undefined || matrix === undefined ||
      attempt?.state !== "staged" || seal.resultCommit !== resultCommit ||
      attempt.preparedDispatch.attestationId !== context.attestationId || attempt.preparedDispatch.generation !== context.generation) {
    throw new Error("cohort gate requires its exact sealed qualified worker attempt");
  }
  const candidate: CohortAcceptanceCandidateV1 = { definition, seal, matrix, attempt, evidenceSubjectDigest: subject.evidenceSubjectDigest };
  const latest = new Map<string, (typeof state.commandEvidence)[number]>();
  for (const evidence of state.commandEvidence) {
    if (evidence.evidenceSubjectDigest !== subject.evidenceSubjectDigest) continue;
    if (evidence.execution === null) throw new Error("cohort gate rejects caller-authored command evidence");
    validateCohortExecutionBindingV1(evidence.execution, candidate);
    if (evidence.receiptDigest !== evidence.execution.receiptDigest || evidence.evidenceKind !== evidence.execution.purpose ||
        evidence.passed !== (evidence.execution.outcome.exitCode === 0)) throw new Error("cohort gate command receipt binding changed");
    latest.set(`${evidence.evidenceKind}:${evidence.execution.commandDigest}`, evidence);
  }
  const green = [...latest.values()].filter((evidence) => evidence.passed);
  const covered = new Set(green.filter((evidence) => evidence.evidenceKind === "focused").flatMap((evidence) => evidence.execution!.memberPlanDigests));
  if (matrix.members.some((member) => !covered.has(member.focusedPlanDigest)) ||
      !green.some((evidence) => evidence.evidenceKind === "shared-regression")) {
    throw new Error("cohort full gate requires green protected focused and shared-regression evidence first");
  }
  if (green.some((evidence) => evidence.evidenceKind === "full-gate")) throw new Error("cohort full gate already exists; reuse the exact acceptance ladder evidence");
  return subject;
}

const GATE_CANCELLED_MESSAGE =
  "supervised worker gate cancelled by its authenticated dispatch epoch";

async function observeGateCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error(GATE_CANCELLED_MESSAGE);
  let rejectCancellation!: (error: Error) => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (): void => rejectCancellation(new Error(GATE_CANCELLED_MESSAGE));
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function supervisedGateRejectionDetails(
  run: SupervisedWorkerGateRunResult,
  context: AuthorizedSupervisedWorkerGateContext,
  resultCommit: string,
): ImplementWorkerSupervisedGateRejectionDetails {
  const failureIndex = Object.freeze(
    (run.diagnosticArtifact?.failures ?? []).map((failure) =>
      Object.freeze({
        identity: boundedRedacted(
          failure.identity,
          IMPLEMENT_WORKER_SUPERVISED_GATE_DIAGNOSTIC_FIELD_BYTE_LIMIT,
        ),
        reference: boundedRedacted(
          failure.reference,
          IMPLEMENT_WORKER_SUPERVISED_GATE_DIAGNOSTIC_FIELD_BYTE_LIMIT,
        ),
        assertion: boundedRedacted(
          failure.assertion,
          IMPLEMENT_WORKER_SUPERVISED_GATE_DIAGNOSTIC_FIELD_BYTE_LIMIT,
        ),
      }),
    ),
  );
  const details = {
    kind: IMPLEMENT_WORKER_SUPERVISED_GATE_REJECTION_KIND,
    version: 2,
    command: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND,
    gateExitCode: run.gateExitCode,
    passCount: run.passCount,
    failCount: run.failCount,
    outputTail: truncateUtf8(
      redactSecrets(run.outputTail),
      IMPLEMENT_WORKER_SUPERVISED_GATE_REJECTION_TAIL_BYTE_LIMIT,
    ),
    diagnosticArtifact: Object.freeze({
      kind: "cq-supervised-gate-diagnostic-artifact" as const,
      ...(context.cohort === undefined ? { version: 1 as const, taskId: context.taskId } :
        context.cohort.state === "sealed" ? { version: 3 as const, evidenceSubject: context.cohort.evidenceSubject } :
          (() => { throw new Error("cohort full gate diagnostic requires sealed authority"); })()),
      attestationId: context.attestationId,
      generation: context.generation,
      resultCommit,
      capturedAt: run.capturedAt,
      reportDigest:
        run.diagnosticArtifact?.reportDigest ??
        createHash("sha256").update(redactSecrets(run.outputTail)).digest("hex"),
      firstFailure: failureIndex[0] ?? null,
      failureIndex,
    }),
  } as const;
  if (!isImplementWorkerSupervisedGateRejectionDetails(details)) {
    throw new Error("supervised worker gate runner returned invalid rejection evidence");
  }
  return Object.freeze(details);
}

export class SupervisedWorkerGatePreflightRejectedError extends Error {
  readonly code: "wip-open" | "wip-malformed";

  constructor(code: "wip-open" | "wip-malformed", message: string) {
    super(message);
    this.name = "SupervisedWorkerGatePreflightRejectedError";
    this.code = code;
  }
}

/** A completed host gate whose deterministic result rejects the candidate. */
export class SupervisedWorkerGateRejectedError extends Error {
  readonly details: ImplementWorkerSupervisedGateRejectionDetails;
  readonly #runDiagnosticArtifact: SupervisedWorkerGateRunDiagnosticArtifact | undefined;

  constructor(
    run: SupervisedWorkerGateRunResult,
    context: AuthorizedSupervisedWorkerGateContext,
    resultCommit: string,
  ) {
    const details = supervisedGateRejectionDetails(run, context, resultCommit);
    super(
      `supervised worker gate rejected exit=${String(details.gateExitCode)} ` +
        `pass=${String(details.passCount)} fail=${String(details.failCount)}\n${details.outputTail}`,
    );
    this.name = "SupervisedWorkerGateRejectedError";
    this.details = details;
    this.#runDiagnosticArtifact = run.diagnosticArtifact;
  }

  durableDiagnostic():
    | {
        readonly storagePath: string;
        readonly artifactPath: string;
        readonly artifactDigest: string;
        readonly content: string;
        readonly details: ImplementWorkerSupervisedGateRejectionDetails;
      }
    | undefined {
    const runArtifact = this.#runDiagnosticArtifact;
    if (runArtifact?.report === undefined || this.details.version !== 2) return undefined;
    const publicArtifact = this.details.diagnosticArtifact;
    const storagePath =
      `supervised-gates/${publicArtifact.attestationId}/` +
      `generation-${String(publicArtifact.generation)}-${publicArtifact.resultCommit}.json`;
    const artifactPath = `.cq/logs/${storagePath}`;
    const content = `${JSON.stringify({
      kind: "cq-supervised-gate-diagnostic-log",
      version: 1,
      attestationId: publicArtifact.attestationId,
      generation: publicArtifact.generation,
      ...(publicArtifact.evidenceSubject === undefined ? { taskId: publicArtifact.taskId } : { evidenceSubject: publicArtifact.evidenceSubject }),
      resultCommit: publicArtifact.resultCommit,
      capturedAt: publicArtifact.capturedAt,
      reportDigest: runArtifact.reportDigest,
      report: runArtifact.report,
      failures: runArtifact.failures,
    })}\n`;
    const artifactDigest = createHash("sha256").update(content).digest("hex");
    const { taskId: _taskId, evidenceSubject: _subject, version: _version, ...diagnostic } = publicArtifact;
    const details: ImplementWorkerSupervisedGateRejectionDetails = Object.freeze({
      ...this.details,
      diagnosticArtifact: Object.freeze({
        ...diagnostic,
        ...(publicArtifact.evidenceSubject === undefined ? { version: 2 as const, taskId: publicArtifact.taskId } :
          { version: 4 as const, evidenceSubject: publicArtifact.evidenceSubject }),
        artifactPath,
        artifactDigest,
      }),
    });
    if (!isImplementWorkerSupervisedGateRejectionDetails(details)) {
      throw new Error("durable supervised worker gate diagnostic binding is invalid");
    }
    return Object.freeze({ storagePath, artifactPath, artifactDigest, content, details });
  }
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

function failureIdentityLines(output: string): string {
  return output
    .trimEnd()
    .split("\n")
    .filter((line) => BUN_FAILURE_IDENTITY_LINE.test(line))
    .slice(0, FAILURE_IDENTITY_LINE_LIMIT)
    .map((line) => truncateUtf8(line, FAILURE_IDENTITY_BYTE_LIMIT))
    .join("\n");
}

function decodeXmlAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function xmlAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`, "u").exec(attributes);
  const value = match?.[1] ?? match?.[2];
  return value === undefined ? undefined : decodeXmlAttribute(value);
}

function xmlText(value: string): string {
  return decodeXmlAttribute(value.replaceAll(/<[^>]+>/gu, " ").replaceAll(/\s+/gu, " ").trim());
}

function boundedRedacted(value: string, byteLimit: number): string {
  return truncateUtf8(redactSecrets(value), byteLimit);
}

function junitFailureDiagnostic(report: string): SupervisedWorkerGateRunDiagnosticArtifact {
  const redactedReport = redactSecrets(report);
  const failures: SupervisedWorkerGateFailureDiagnostic[] = [];
  let current:
    | { readonly identity: string; readonly reference: string; failure?: string }
    | undefined;
  const tokens = redactedReport.matchAll(
    /<testcase\b([^>]*?)(\/?)>|<\/testcase\s*>|<failure\b([^>]*?)(?:\/>|>([\s\S]*?)<\/failure\s*>)/gu,
  );
  const finish = (): void => {
    if (current?.failure !== undefined) {
      failures.push(
        Object.freeze({
          identity: current.identity,
          reference: current.reference,
          assertion: current.failure,
        }),
      );
    }
    current = undefined;
  };
  for (const token of tokens) {
    if (token[1] !== undefined) {
      if (current !== undefined) finish();
      const attributes = token[1];
      const identity = xmlAttribute(attributes, "name") ?? "unnamed testcase";
      const reference =
        xmlAttribute(attributes, "file") ??
        xmlAttribute(attributes, "classname") ??
        identity;
      current = { identity, reference };
      if (token[2] === "/") finish();
      continue;
    }
    if (token[0].startsWith("</testcase")) {
      finish();
      continue;
    }
    if (token[3] !== undefined && current !== undefined) {
      const assertion =
        xmlAttribute(token[3], "message") ?? (xmlText(token[4] ?? "") || "failure");
      current.failure = assertion;
    }
  }
  if (current !== undefined) finish();
  return Object.freeze({
    reportDigest: createHash("sha256").update(redactedReport).digest("hex"),
    failures: Object.freeze(failures),
    report: redactedReport,
  });
}

function junitFailureIdentityLines(report: string): string {
  return junitFailureDiagnostic(report)
    .failures.slice(0, FAILURE_IDENTITY_LINE_LIMIT)
    .map(({ identity }) => `(fail) ${identity}`)
    .join("\n");
}

function outputTail(
  stdout: string,
  stderr: string,
  gateExitCode: number,
  junitReport: string,
): string {
  if (gateExitCode === 0)
    return truncateUtf8(
      redactSecrets(tail(`${stdout}\n${stderr}`)),
      FAILURE_OUTPUT_TAIL_BYTE_LIMIT,
    );
  return truncateUtf8(
    redactSecrets(
      [
        junitFailureIdentityLines(junitReport),
        failureIdentityLines(stdout),
        failureIdentityLines(stderr),
        failureSummaryWindow(stdout),
        failureSummaryWindow(stderr),
        tail(stdout),
        tail(stderr),
      ]
        .filter((value) => value.length > 0)
        .join("\n"),
    ),
    FAILURE_OUTPUT_TAIL_BYTE_LIMIT,
  );
}

function hostGateEnvironment(junitPath: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of DISPATCH_INVOCATION_ENV_NAMES) delete environment[key];
  environment["CQ_TEST_JUNIT_PATH"] = junitPath;
  return environment;
}

function createSerializedSupervisedRunner<Request extends SupervisedWorkerGateRunRequest, Result>(
  execute: (request: Request) => Promise<Result>,
): { run(request: Request): Promise<Result> } {
  let admissionTail: Promise<void> = Promise.resolve();
  return Object.freeze({
    async run(request: Request): Promise<Result> {
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
        await observeGateCancellation(
          Promise.race([
            predecessor,
            new Promise<never>((_resolve, reject) => {
              admissionTimer = setTimeout(
                () =>
                  reject(new Error("supervised worker gate exceeded its host admission deadline")),
                request.admissionTimeoutMs,
              );
            }),
          ]),
          request.cancellationSignal,
        );
        if (admissionTimer !== undefined) clearTimeout(admissionTimer);
        return await execute(request);
      } finally {
        if (admissionTimer !== undefined) clearTimeout(admissionTimer);
        releaseAdmission();
      }
    },
  });
}

export function createNodeSupervisedWorkerGateRunner(
  settlement: NodeSupervisedWorkerGateSettlement,
): SupervisedWorkerGateRunner {
  return createSerializedSupervisedRunner((request: SupervisedWorkerGateRunRequest) =>
    runAdmittedNodeSupervisedWorkerGate({ ...request, command: {
      argv: ["bun", "run", "check"], cwd: "nix/pkg/cq-ledgers", environment: {},
    } }, settlement));
}

export function createNodeSupervisedWorkerCommandRunner(
  settlement: NodeSupervisedWorkerGateSettlement,
): SupervisedWorkerCommandRunner {
  return createSerializedSupervisedRunner((request: SupervisedWorkerCommandRunRequest) =>
    runAdmittedNodeSupervisedWorkerGate(request, settlement));
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
async function runAdmittedNodeSupervisedWorkerGateWithReport(
  request: SupervisedWorkerCommandRunRequest,
  settlement: NodeSupervisedWorkerGateSettlement,
  junitPath: string,
): Promise<SupervisedWorkerCommandRunResult> {
  const startedAt = Date.now();
  let registration: ProcessGroupRegistration | undefined;
  let capturedStdout: Promise<string> | undefined;
  let capturedStderr: Promise<string> | undefined;
  let worktreeSettlement: SettlementArmOutcome | undefined;
  let rootSettlement: SettlementArmOutcome | undefined;
  const { command } = request;
  if (command.argv.length === 0 || command.argv.some((arg) => arg.length === 0 || arg.includes("\0")) ||
      command.cwd.length === 0 || isAbsolute(command.cwd) || command.cwd.split(/[\\/]/).includes("..")) {
    throw new Error("supervised command requires exact argv and a worktree-relative cwd");
  }
  const worktree = await realpath(request.worktreePath);
  const commandCwd = await realpath(resolve(worktree, command.cwd));
  const relativeCwd = relative(worktree, commandCwd);
  if (isAbsolute(relativeCwd) || relativeCwd.split(/[\\/]/).includes("..")) {
    throw new Error("supervised command cwd escapes its managed worktree");
  }
  const environment = { ...hostGateEnvironment(junitPath), ...command.environment };
  for (const key of DISPATCH_INVOCATION_ENV_NAMES) delete environment[key];
  environment["CQ_TEST_JUNIT_PATH"] = junitPath;
  const stdio = { stdin: "ignore", stdout: "pipe", stderr: "pipe" } as const;
  const launchSpecification = {
    argv: [
      "cq",
      "gate",
      "run",
      "--worktree",
      request.worktreePath,
      "--command-cwd",
      commandCwd,
      "--",
      ...command.argv,
    ],
    cwd: request.worktreePath,
    env: environment,
    stdio,
    register: async (observed: ProcessGroupRegistration) => {
      registration = observed;
    },
    launchBootstrap: (specification: RegisteredLaunchBootstrapSpecification<typeof stdio>) => {
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
        resultFromTargetOutcome: (outcome: { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }) => {
          if (outcome.exitCode !== null) return outcome.exitCode;
          if (outcome.signal === null) return 1;
          return 128 + (constants.signals[outcome.signal] ?? 1);
        },
        terminate: (signal: NodeJS.Signals) => child.kill(signal),
      };
    },
  };
  const admission = request.effectAdmission;
  const launched = admission === undefined
    ? await launchRegisteredProcessGroup(launchSpecification)
    : await new WorksetEffectBroker({ provider: admission.provider }).launch({
      ...launchSpecification,
      kind: "child-dispatch",
      targetRef: admission.targetRef,
      signal: request.cancellationSignal,
      timeoutMs: request.executionTimeoutMs,
      launchDeadlineMs: Date.now() + request.admissionTimeoutMs,
      settleRegisteredDescendants: async () => {
        worktreeSettlement = await captureSettlementArm(() =>
          settlement.settleWorktreeGateCommands({ worktree: request.worktreePath }));
        if (worktreeSettlement.status === "rejected") throw worktreeSettlement.error;
        if (worktreeSettlement.result.signaled.length > 0 || worktreeSettlement.result.survivors.length > 0) {
          throw new Error("supervised command left an unsettled worktree process group");
        }
      },
    });
  registration = launched.registration;
  if (capturedStdout === undefined || capturedStderr === undefined) {
    throw new Error("supervised worker gate produced no output capture");
  }
  const processResult = Promise.all([launched.exited, capturedStdout, capturedStderr]).then(
    ([gateExitCode, stdout, stderr]) => ({ gateExitCode, stdout, stderr }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let raced: Awaited<typeof processResult> | undefined;
  let originalError: unknown;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("supervised worker gate exceeded its host execution deadline")),
        request.executionTimeoutMs,
      );
    });
    raced = await observeGateCancellation(
      Promise.race([processResult, timeout]),
      request.cancellationSignal,
    );
  } catch (error) {
    originalError = error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // D342: both cleanup arms run exactly once in this unconditional finally;
    // neither a rejection nor survivors in one arm may suppress the other.
    if (worktreeSettlement === undefined) {
      worktreeSettlement = await captureSettlementArm(() =>
        settlement.settleWorktreeGateCommands({ worktree: request.worktreePath }),
      );
    }
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
  const completeOutput = redactSecrets(combined);
  const passCount = lastCount(PASS_COUNT, combined) ?? 0;
  const failCount = lastCount(FAIL_COUNT, combined) ?? (raced.gateExitCode === 0 ? 0 : 1);
  const junitReport = await readFile(junitPath, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  });
  return Object.freeze({
    executionId: randomUUID(),
    outputDigest: createHash("sha256").update(combined).digest("hex"),
    ...(Buffer.byteLength(completeOutput, "utf8") <= FAILURE_OUTPUT_TAIL_BYTE_LIMIT ? { completeOutput } : {}),
    gateExitCode: raced.gateExitCode,
    passCount,
    failCount,
    gateDurationMs: Date.now() - startedAt,
    capturedAt: new Date().toISOString(),
    outputTail: outputTail(raced.stdout, raced.stderr, raced.gateExitCode, junitReport),
    ...(raced.gateExitCode === 0
      ? {}
      : { diagnosticArtifact: junitFailureDiagnostic(junitReport) }),
  });
}

/** Own the per-run JUnit artifact so concurrent gates never share diagnostics. */
async function runAdmittedNodeSupervisedWorkerGate(
  request: SupervisedWorkerCommandRunRequest,
  settlement: NodeSupervisedWorkerGateSettlement,
): Promise<SupervisedWorkerCommandRunResult> {
  const diagnosticDirectory = await mkdtemp(join(tmpdir(), "cq-supervised-gate-"));
  try {
    return await runAdmittedNodeSupervisedWorkerGateWithReport(
      request,
      settlement,
      join(diagnosticDirectory, "junit.xml"),
    );
  } finally {
    await rm(diagnosticDirectory, { recursive: true, force: true });
  }
}

export const nodeSupervisedWorkerGateRunner: SupervisedWorkerGateRunner =
  createNodeSupervisedWorkerGateRunner({ settleWorktreeGateCommands, settleProcessGroups });

/**
 * Validate the exact manager-bound result tip, run the fixed host gate, and
 * return a new result carrying evidence no child can mint or substitute.
 */
export async function superviseImplementWorkerGate(
  request: SuperviseImplementWorkerGateRequest,
  deps: SuperviseImplementWorkerGateDeps,
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
  const resultCommit = stringField(output, "resultCommit", "worker result");
  const authority = deps.cohortAuthority === undefined ? undefined : {
    store: deps.cohortAuthority.store, lease: structuredClone(deps.cohortAuthority.lease), envelope: structuredClone(deps.cohortAuthority.envelope),
  };
  let evidenceSubject: CohortEvidenceSubjectV1 | undefined;
  if (context.cohort === undefined) {
    if (authority !== undefined) throw new Error("task gate cannot use cohort authority");
    await assertManagedWorktreeDispatchBindingLive(context, deps.stateDir === undefined ? {} : { stateDir: deps.stateDir });
    if (output["taskId"] !== context.taskId || Object.hasOwn(output, "cohort")) throw new Error("worker taskId substitution");
  } else {
    if (authority === undefined) throw new Error("cohort full gate requires the sealed cohort acceptance ladder");
    evidenceSubject = await assertCohortGatePrerequisites(context, resultCommit, authority, deps.stateDir);
    if (Object.hasOwn(output, "taskId") || cohortValueDigestV1(output["cohort"]) !== cohortValueDigestV1(context.cohort)) {
      throw new Error("worker cohort envelope substitution");
    }
  }
  const branch = stringField(output, "branch", "worker result");
  const actualWorktreePath = stringField(output, "actualWorktreePath", "worker result");
  if (!FULL_SHA.test(resultCommit)) throw new Error("worker resultCommit must be a full SHA");
  if (branch !== context.branch) throw new Error("worker branch substitution");
  if (resolve(actualWorktreePath) !== resolve(context.worktreePath)) {
    throw new Error("worker worktree substitution");
  }
  const memberTaskIds = context.cohort === undefined ? [context.taskId] : context.cohort.memberAuthorities.map((member) => member.taskRef.slice("tasks:".length));
  for (const taskId of memberTaskIds) {
    const wip = await findOpenWipCheckpoints(
    context.worktreePath,
    { taskId },
    new Set([`WIP-${taskId}.md`]),
    taskId,
  );
  if (wip.status === "malformed") {
    throw new SupervisedWorkerGatePreflightRejectedError(
      "wip-malformed",
      `supervised gate denied malformed WIP artifact ${wip.path}: ${wip.detail}`,
    );
  }
  if (wip.status === "open") {
    throw new SupervisedWorkerGatePreflightRejectedError(
      "wip-open",
      `supervised gate denied open WIP checkpoints: ${wip.findings
        .flatMap((finding) => finding.openCheckpoints)
        .join(", ")}`,
    );
  }
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

  if (context.validationIntent === "focused-only") {
    if (context.cohort !== undefined) throw new Error("cohort acceptance cannot use child-focused-only gate substitution");
    return request.output;
  }

  const run = await (deps.runner ?? nodeSupervisedWorkerGateRunner).run({
    worktreePath: context.worktreePath,
    admissionTimeoutMs: SUPERVISED_WORKER_GATE_ADMISSION_TIMEOUT_MS,
    executionTimeoutMs: SUPERVISED_WORKER_GATE_EXECUTION_TIMEOUT_MS,
    cancellationSignal: deps.cancellationSignal,
    ...(deps.effectAdmission === undefined ? {} : { effectAdmission: deps.effectAdmission }),
  });
  if (run.gateExitCode !== 0 || run.failCount !== 0 || run.passCount <= 0) {
    let diagnosticContext = context;
    if (context.cohort !== undefined) {
      if (authority === undefined) throw new Error("cohort gate lost its sealed authority");
      diagnosticContext = { ...context, cohort: authority.envelope };
    }
    throw new SupervisedWorkerGateRejectedError(run, diagnosticContext, resultCommit);
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
  if (authority !== undefined) await assertCohortGatePrerequisites(context, resultCommit, authority, deps.stateDir);

  const evidenceIdentity = context.cohort === undefined ? { version: 1 as const, taskId: context.taskId } : (() => {
    if (evidenceSubject === undefined) throw new Error("cohort gate lost its sealed evidence subject");
    return { version: 2 as const, evidenceSubject };
  })();
  const evidence: ImplementWorkerSupervisedGateEvidence = Object.freeze({
    kind: "cq-supervised-gate-evidence",
    ...evidenceIdentity,
    attestationId: context.attestationId,
    generation: context.generation,
    roleId: "implement-worker",
    roleVersion: context.promptProvenance.version,
    surface: "codex",
    promptDigest: context.promptProvenance.promptDigest,
    catalogHash: context.promptProvenance.catalogHash,
    inputDigest: context.promptProvenance.inputDigest,
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
  if (context.cohort === undefined && evidence.version === 1) await recordManagedWorktreeSupervisedGateEvidence(context, evidence, {
    ...(deps.stateDir === undefined ? {} : { stateDir: deps.stateDir }),
  });
  return Object.freeze({
    ...output,
    supervisedGateEvidence: evidence as unknown as DispatchJSONValue,
  });
}
