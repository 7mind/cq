import * as path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  WorksetEffectBroker,
  settleWorktreeGateCommands,
  type SettleProcessGroupsResult,
  type WorksetEffectAdmissionProvider,
} from "@cq/process-control";
import type {
  DispatchHandle,
  GitChangeCapability,
  GitConflictCapability,
  InputCapability,
  ParentGateCapability,
  DispatchPromptProvenance,
  ResultCapability,
} from "./compactDispatchProtocol.js";
import {
  validateManagedWorktreeHandle,
  type ManagedWorktreeHandle,
} from "./managedWorktreeHandle.js";
import { classifyCodexFinalMessage } from "./codexDispatchProtocol.js";
import {
  CODEX_READ_ONLY_SANDBOX_TMPDIR,
  CODEX_SANDBOX_PIPE_PROBE_TIMEOUT_MS,
  argvWithSandboxTmpdir,
  requiresCodexSandboxPreflight,
  runCodexSandboxPipeProbe,
  SandboxPipeProbeError,
} from "./codexSandboxPreflight.js";
import { DISPATCHED_ROLE_IDS } from "./promptCatalogStore.js";
import { exposedLedgerToolsForRole, type LedgerCapabilityToolName } from "./roleToolProfiles.js";
import { withoutWorksetCredentials } from "./worksetManagementCommand.js";

export const CODEX_ROLE_SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

export type CodexRoleSandboxMode = (typeof CODEX_ROLE_SANDBOX_MODES)[number];

export interface CodexRoleSandboxPolicyResolution {
  readonly requestedMode: CodexRoleSandboxMode;
  readonly effectiveMode: CodexRoleSandboxMode;
  readonly readOnlySandboxSuppressed: boolean;
}

export function resolveCodexRoleSandboxPolicy(
  requestedMode: CodexRoleSandboxMode,
  unsafeDisableCodexReadOnlySandbox: boolean,
): CodexRoleSandboxPolicyResolution {
  const readOnlySandboxSuppressed =
    unsafeDisableCodexReadOnlySandbox && requestedMode === "read-only";
  return Object.freeze({
    requestedMode,
    effectiveMode: readOnlySandboxSuppressed ? "danger-full-access" : requestedMode,
    readOnlySandboxSuppressed,
  });
}

export interface CodexRoleBoundaryRequest {
  readonly roleId: string;
  readonly roleInstructions: string;
  readonly handle: DispatchHandle;
  readonly inputCapability: InputCapability;
  readonly resultCapability: ResultCapability;
  /** Parent-only; deliberately excluded from child stdin and environment. */
  readonly parentGateCapability?: ParentGateCapability;
  /** Present only for a manager-bound implement-worker dispatch. */
  readonly gitChangeCapability?: GitChangeCapability;
  /** Present only for a manager-bound implement-conflict-resolver dispatch. */
  readonly gitConflictCapability?: GitConflictCapability;
  readonly cwd: string;
  readonly ledgerCwd: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly sandboxMode: CodexRoleSandboxMode;
  readonly timeoutMs: number;
  readonly promptRoot: string;
  readonly ledgerCommand: string;
  readonly codexExecutable: string;
}

export interface CodexRoleBoundaryInvocation
  extends Omit<
    CodexRoleBoundaryRequest,
    "roleInstructions" | "promptRoot" | "ledgerCommand" | "codexExecutable"
  > {
  /** Canonical admitted dispatch target; identity only, never an admission capability. */
  readonly effectTargetRef: string;
}

export interface CodexRoleLedgerMcpConfiguration {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly enabledTools: readonly LedgerCapabilityToolName[];
  readonly defaultToolsApprovalMode: "approve";
  readonly required: true;
}

export interface CodexRoleBoundaryPlan {
  readonly roleId: string;
  readonly cwd: string;
  readonly sandboxMode: CodexRoleSandboxMode;
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly childWorkTimeoutMs: number;
  readonly expectedHandle: DispatchHandle;
  readonly ledgerMcp: CodexRoleLedgerMcpConfiguration;
  readonly effectivePreturn: CodexEffectivePreturn;
  /** The child JSONL stream stays inside the adapter; only a verified handle escapes. */
  readonly interceptStdout: true;
}

export interface CodexRoleBoundaryExecutionResult {
  readonly handle: DispatchHandle;
  readonly effectivePreturn: CodexEffectivePreturn;
  readonly observedFailureControls: readonly string[];
  readonly observation: {
    readonly agentType: string;
    /** Parent-minted label carried on the registered subprocess launch, never read from child text. */
    readonly correlationId: string;
    /** Actual thread.started id intercepted from the child JSONL transport. */
    readonly childThreadId: string;
    /** Actual terminal turn event intercepted from the child JSONL transport. */
    readonly outcome: "completed" | "transport-failed";
    /** Actual registered target exit status; corroborating evidence only. */
    readonly exitStatus: number;
  };
}

export interface CodexRoleBoundaryWorksetEffect {
  readonly provider: WorksetEffectAdmissionProvider;
  readonly targetRef: string;
  readonly signal?: AbortSignal;
}

export interface CodexEffectivePreturn {
  readonly kind: "cq-codex-effective-preturn";
  readonly version: 2;
  readonly roleId: string;
  readonly cwd: string;
  readonly ledgerCwd: string;
  readonly handle: DispatchHandle;
  readonly effectCapabilityScope: "git-change" | "git-conflict" | null;
  readonly receiptExpectation:
    | "cq-git-change-receipt"
    | "cq-git-conflict-continuation-receipt"
    | null;
  readonly rolePromptDigest: string;
  readonly enabledTools: readonly LedgerCapabilityToolName[];
  readonly model: string;
  readonly reasoningEffort: string;
  readonly sandboxMode: CodexRoleSandboxMode;
  readonly skillsPolicy: "role-instructions";
  readonly multiAgent: false;
  readonly childWorkTimeoutMs: number;
  readonly storeResultSubmissionBudgetMs: 600_000;
  readonly ledgerToolTimeoutSec: 600;
  readonly postStoreSubmissionFinalizationMs: 300_000;
  readonly outerBoundaryTimeoutMs: number;
  readonly parentGateWindowMs: 5_620_000;
}

export const CODEX_STORE_RESULT_SUBMISSION_BUDGET_MS = 600_000;
export const CODEX_LEDGER_TOOL_TIMEOUT_SEC = 600;
export const CODEX_POST_STORE_FINALIZATION_MS = 300_000;
export const CODEX_PARENT_GATE_WINDOW_MS = 5_620_000;
export const CODEX_OUTER_BOUNDARY_RESERVE_MS = 900_000;
export const CODEX_PARENT_GATE_TERMINATION_GRACE_MS = 1_000;

export interface CodexParentGateFinalizerRequest {
  readonly command: string;
  readonly ledgerCwd: string;
  readonly promptRoot: string;
  readonly handle: DispatchHandle;
  readonly parentGateCapability: ParentGateCapability;
  readonly timeoutMs: number;
  readonly environment?: NodeJS.ProcessEnv;
}

/** Run the parent-only durable finalizer after the Codex child has exited. */
export async function executeCodexParentGateFinalizer(
  input: CodexParentGateFinalizerRequest,
): Promise<void> {
  const child = Bun.spawn(
    [
      input.command,
      "mcp",
      "--cwd",
      input.ledgerCwd,
      "--prompt-surface",
      "codex",
      "--prompt-root",
      input.promptRoot,
      "--parent-gate-finalize",
    ],
    {
      cwd: input.ledgerCwd,
      env: withoutWorksetCredentials({ ...process.env, ...input.environment }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin.write(
    `${JSON.stringify({ ...input.handle, parentGateCapability: input.parentGateCapability })}\n`,
  );
  child.stdin.end();
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), CODEX_PARENT_GATE_TERMINATION_GRACE_MS);
  }, input.timeoutMs);
  const [exitStatus, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => {
    clearTimeout(timer);
    if (killTimer !== undefined) clearTimeout(killTimer);
  });
  if (timedOut) {
    throw new CodexRoleBoundaryError(
      `parent gate exceeded its ${String(input.timeoutMs)} ms window`,
    );
  }
  if (exitStatus !== 0) {
    throw new CodexRoleBoundaryError(
      `parent gate exited ${String(exitStatus)}: ${stderr.trim()}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new CodexRoleBoundaryError("parent gate emitted non-JSON stdout");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CodexRoleBoundaryError("parent gate emitted a malformed acknowledgement");
  }
  const acknowledgement = parsed as Record<string, unknown>;
  if (
    Object.keys(acknowledgement).sort().join(",") !==
      "attestationId,generation,outputDigest,state,storedAt" ||
    acknowledgement["state"] !== "result-stored" ||
    acknowledgement["attestationId"] !== input.handle.attestationId ||
    acknowledgement["generation"] !== input.handle.generation ||
    typeof acknowledgement["storedAt"] !== "string" ||
    typeof acknowledgement["outputDigest"] !== "string"
  ) {
    throw new CodexRoleBoundaryError("parent gate emitted a foreign acknowledgement");
  }
}

export interface CodexInstalledIdentity {
  readonly storePath: string;
  readonly executablePath: string;
  readonly executableDigest: string;
}

export interface CodexInstalledRoleBoundaryExecution {
  readonly kind: "cq-codex-installed-role-boundary-execution";
  readonly version: 1;
  readonly roleId: "implement-worker" | "implement-conflict-resolver";
  readonly effect: "git-commit" | "git-conflict-continue";
  readonly executable: string;
  readonly installedIdentity: {
    readonly storePath: string;
    readonly executablePath: string;
    readonly executableDigest: string;
  };
  readonly expectedInstalledIdentity: CodexInstalledIdentity;
  readonly effectivePreturn: CodexEffectivePreturn;
  readonly observedFailureControls: readonly string[];
  readonly handle: DispatchHandle;
  readonly managedHandle: ManagedWorktreeHandle;
  readonly expectedChild: { readonly childId: string; readonly runId: string };
  readonly expectedPromptProvenance: DispatchPromptProvenance;
  readonly correlationId: string;
  readonly invocationDigest: string;
  readonly stdoutDigest: string;
  readonly exitStatus: 0;
}

export interface CodexInstalledRoleBoundaryRequest {
  readonly executable: string;
  readonly invocation: Omit<CodexRoleBoundaryInvocation, "effectTargetRef">;
  readonly managedHandle: ManagedWorktreeHandle;
  readonly expectedChild: { readonly childId: string; readonly runId: string };
  readonly expectedPromptProvenance: DispatchPromptProvenance;
  readonly correlationId: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export type CodexProviderSandboxControlRoute = "native" | "process";

export interface CodexProviderSandboxControl {
  readonly kind: "cq-codex-provider-sandbox-control";
  readonly version: 1;
  readonly roleId: "implement-worker" | "implement-conflict-resolver";
  readonly route: CodexProviderSandboxControlRoute;
  readonly managedHandle: ManagedWorktreeHandle;
  readonly codexExecutable: string;
  readonly writableSandboxExitStatus: 0;
  readonly writableSandboxStdoutDigest: string;
  readonly writableSandboxRefMatches: true;
  readonly deniedSandboxExitStatus: number;
  readonly deniedSandboxStderrDigest: string;
  readonly deniedSandboxRefAbsent: true;
  readonly credentialEnvironmentAbsent: true;
}

export interface CodexProviderSandboxControlRequest {
  readonly codexExecutable: string;
  readonly gitExecutable: string;
  readonly managedHandle: ManagedWorktreeHandle;
  readonly roleId: "implement-worker" | "implement-conflict-resolver";
  readonly route: CodexProviderSandboxControlRoute;
}

const RUNNER_OWNED_INSTALLED_EXECUTIONS = new WeakSet<object>();
const RUNNER_OWNED_NATIVE_EXECUTIONS = new WeakSet<object>();
const RUNNER_OWNED_SANDBOX_CONTROLS = new WeakSet<object>();

export const CODEX_PRETURN_OBSERVATION_PATH_ENV =
  "CQ_CODEX_PRETURN_OBSERVATION_PATH" as const;

const CODEX_BOUNDARY_EFFECT_TARGET_RE =
  /^(?:tasks:T|goals:G|defects:D|researches:RS)\d+$/u;

export function assertCodexBoundaryEffectTargetRef(value: unknown): string {
  if (typeof value !== "string" || !CODEX_BOUNDARY_EFFECT_TARGET_RE.test(value)) {
    throw new CodexRoleBoundaryError(
      "boundary invocation requires one canonical tasks/goals/defects/researches effect target",
    );
  }
  return value;
}

export function isRunnerOwnedCodexInstalledRoleBoundaryExecution(
  value: unknown,
): value is CodexInstalledRoleBoundaryExecution {
  return typeof value === "object" && value !== null && RUNNER_OWNED_INSTALLED_EXECUTIONS.has(value);
}

export function isRunnerOwnedCodexRoleBoundaryExecution(
  value: unknown,
): value is CodexRoleBoundaryExecutionResult {
  return typeof value === "object" && value !== null && RUNNER_OWNED_NATIVE_EXECUTIONS.has(value);
}

export function isRunnerOwnedCodexProviderSandboxControl(
  value: unknown,
): value is CodexProviderSandboxControl {
  return typeof value === "object" && value !== null && RUNNER_OWNED_SANDBOX_CONTROLS.has(value);
}

export const CODEX_ROLE_BOUNDARY_DIAGNOSTIC_PREFIX = "CQ_CODEX_BOUNDARY_DIAGNOSTIC ";

export const CODEX_ROLE_BOUNDARY_DIAGNOSTIC_VERDICTS = [
  "no-completed-message",
  "echo",
  "wrong-handle",
  "unparseable",
  "live-gate-at-completion",
] as const;

export type CodexRoleBoundaryDiagnosticVerdict =
  (typeof CODEX_ROLE_BOUNDARY_DIAGNOSTIC_VERDICTS)[number];

export const CODEX_ROLE_BOUNDARY_DIAGNOSTIC_DETAIL_CODES = [
  "no-completed-agent-message",
  "surplus-fields",
  "mismatched-handle",
  "invalid-json",
  "invalid-shape",
  "invalid-handle-shape",
  "unsettled-full-gate-at-completion",
] as const;

export type CodexRoleBoundaryDiagnosticDetailCode =
  (typeof CODEX_ROLE_BOUNDARY_DIAGNOSTIC_DETAIL_CODES)[number];

export interface CodexRoleBoundaryDiagnostic {
  readonly version: 1;
  readonly verdict: CodexRoleBoundaryDiagnosticVerdict;
  readonly detailCode: CodexRoleBoundaryDiagnosticDetailCode;
  readonly finalMessageByteLength: number;
  readonly finalMessageSha256: string;
  readonly completedAgentMessageCount: number;
  readonly malformedJsonlCount: number;
  readonly matchingResultStoredAcknowledgementPresent: boolean;
}

export class CodexRoleBoundaryError extends Error {
  readonly diagnostic: CodexRoleBoundaryDiagnostic | undefined;

  constructor(message: string, diagnostic?: CodexRoleBoundaryDiagnostic) {
    super(`Codex role boundary: ${message}`);
    this.name = "CodexRoleBoundaryError";
    this.diagnostic = diagnostic;
  }
}

/** A verified environmental refusal before any child capability can be consumed. */
export class CodexOperationalAbstentionError extends CodexRoleBoundaryError {
  readonly operationalAbstention: {
    readonly source: "sandbox-preflight";
    readonly verdict: string;
  };

  constructor(error: SandboxPipeProbeError) {
    super(error.message);
    this.name = "CodexOperationalAbstentionError";
    this.operationalAbstention = Object.freeze({
      source: "sandbox-preflight",
      verdict: error.verdict,
    });
  }
}

export function formatCodexRoleBoundaryDiagnostic(diagnostic: CodexRoleBoundaryDiagnostic): string {
  return `${CODEX_ROLE_BOUNDARY_DIAGNOSTIC_PREFIX}${JSON.stringify(diagnostic)}`;
}

const DISPATCHED_ROLE_ID_SET: ReadonlySet<string> = new Set(DISPATCHED_ROLE_IDS);
const SANDBOX_MODE_SET: ReadonlySet<string> = new Set(CODEX_ROLE_SANDBOX_MODES);

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CodexRoleBoundaryError(`${field} must be a non-empty string`);
  }
  return value;
}

export function assertCodexDispatchedRoleId(roleId: string): string {
  if (!DISPATCHED_ROLE_ID_SET.has(roleId)) {
    throw new CodexRoleBoundaryError(
      `unknown dispatched role ${JSON.stringify(roleId)}; expected one of ` +
        DISPATCHED_ROLE_IDS.join(", "),
    );
  }
  return roleId;
}

function assertBoundaryRequest(request: CodexRoleBoundaryRequest): CodexRoleBoundaryRequest {
  assertCodexDispatchedRoleId(request.roleId);
  requiredString(request.roleInstructions, "roleInstructions");
  requiredString(request.model, "model");
  requiredString(request.reasoningEffort, "reasoningEffort");
  requiredString(request.promptRoot, "promptRoot");
  requiredString(request.ledgerCommand, "ledgerCommand");
  requiredString(request.codexExecutable, "codexExecutable");
  if (!path.isAbsolute(request.cwd)) {
    throw new CodexRoleBoundaryError("cwd must be absolute");
  }
  if (!path.isAbsolute(request.ledgerCwd)) {
    throw new CodexRoleBoundaryError("ledgerCwd must be absolute");
  }
  if (!SANDBOX_MODE_SET.has(request.sandboxMode)) {
    throw new CodexRoleBoundaryError(
      `sandboxMode must be one of ${CODEX_ROLE_SANDBOX_MODES.join(", ")}`,
    );
  }
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new CodexRoleBoundaryError("timeoutMs must be a positive integer");
  }
  if (
    typeof request.handle?.attestationId !== "string" ||
    request.handle.attestationId.trim() === "" ||
    !Number.isInteger(request.handle.generation)
  ) {
    throw new CodexRoleBoundaryError(
      "handle must contain a non-empty attestationId and integer generation",
    );
  }
  if (
    request.gitConflictCapability !== undefined &&
    (request.gitConflictCapability.scope !== "git-conflict" ||
      typeof request.gitConflictCapability.token !== "string" ||
      request.gitConflictCapability.token.trim() === "")
  ) {
    throw new CodexRoleBoundaryError(
      'gitConflictCapability must contain scope "git-conflict" and a non-empty token',
    );
  }
  if (
    request.inputCapability?.scope !== "fetch-input" ||
    typeof request.inputCapability.token !== "string" ||
    request.inputCapability.token.trim() === ""
  ) {
    throw new CodexRoleBoundaryError(
      'inputCapability must contain scope "fetch-input" and a non-empty token',
    );
  }
  if (
    request.resultCapability?.scope !== "store-result" ||
    typeof request.resultCapability.token !== "string" ||
    request.resultCapability.token.trim() === ""
  ) {
    throw new CodexRoleBoundaryError(
      'resultCapability must contain scope "store-result" and a non-empty token',
    );
  }
  if (
    request.parentGateCapability !== undefined &&
    (request.parentGateCapability.scope !== "parent-gate" ||
      typeof request.parentGateCapability.token !== "string" ||
      request.parentGateCapability.token.trim() === "")
  ) {
    throw new CodexRoleBoundaryError(
      'parentGateCapability must contain scope "parent-gate" and a non-empty token',
    );
  }
  if (
    request.gitChangeCapability !== undefined &&
    (request.gitChangeCapability.scope !== "git-change" ||
      typeof request.gitChangeCapability.token !== "string" ||
      request.gitChangeCapability.token.trim() === "")
  ) {
    throw new CodexRoleBoundaryError(
      'gitChangeCapability must contain scope "git-change" and a non-empty token',
    );
  }
  return request;
}

function renderLedgerMcpOverride(config: CodexRoleLedgerMcpConfiguration): string {
  const environment = Object.entries(config.env)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join(",");
  const fields = [
    `command=${JSON.stringify(config.command)}`,
    `args=${JSON.stringify(config.args)}`,
    `env={${environment}}`,
    `enabled_tools=${JSON.stringify(config.enabledTools)}`,
    `default_tools_approval_mode=${JSON.stringify(config.defaultToolsApprovalMode)}`,
    `tool_timeout_sec=${String(CODEX_LEDGER_TOOL_TIMEOUT_SEC)}`,
    "required=true",
  ];
  return `mcp_servers.ledger={${fields.join(",")}}`;
}

/**
 * Construct the exact `codex exec` boundary used for every CQ-dispatched role.
 * The same shared role matrix drives both the server-side `--tool-profile` and
 * Codex's client-side `enabled_tools` filter, so neither layer can widen the
 * other through a separately maintained list.
 */
export function createCodexRoleBoundaryPlan(
  request: CodexRoleBoundaryRequest,
): CodexRoleBoundaryPlan {
  const resolved = assertBoundaryRequest(request);
  const enabledTools = exposedLedgerToolsForRole(resolved.roleId);
  const ledgerMcp: CodexRoleLedgerMcpConfiguration = Object.freeze({
    command: resolved.ledgerCommand,
    args: Object.freeze([
      "mcp",
      "--cwd",
      resolved.ledgerCwd,
      "--prompt-surface",
      "codex",
      "--prompt-root",
      resolved.promptRoot,
      "--tool-profile",
      resolved.roleId,
    ]),
    env: Object.freeze({
      CQ_HARNESS: "codex",
      CQ_PROMPT_ROOT: resolved.promptRoot,
      CQ_PROMPT_SURFACE: "codex",
    }),
    enabledTools,
    defaultToolsApprovalMode: "approve" as const,
    required: true as const,
  });
  const launch = {
    attestationId: resolved.handle.attestationId,
    generation: resolved.handle.generation,
    inputCapability: resolved.inputCapability,
    resultCapability: resolved.resultCapability,
    ...(resolved.gitChangeCapability === undefined
      ? {}
      : { gitChangeCapability: resolved.gitChangeCapability }),
    ...(resolved.gitConflictCapability === undefined
      ? {}
      : { gitConflictCapability: resolved.gitConflictCapability }),
  };
  const argv = Object.freeze([
    resolved.codexExecutable,
    "exec",
    "--ignore-user-config",
    "--strict-config",
    "--ephemeral",
    "--json",
    "-C",
    resolved.cwd,
    "-m",
    resolved.model,
    "-s",
    resolved.sandboxMode,
    "-c",
    `model_reasoning_effort=${JSON.stringify(resolved.reasoningEffort)}`,
    "-c",
    'approval_policy="never"',
    "-c",
    "features.multi_agent=false",
    "-c",
    `developer_instructions=${JSON.stringify(resolved.roleInstructions)}`,
    "-c",
    renderLedgerMcpOverride(ledgerMcp),
    "-",
  ]);
  const effectCapabilityScope =
    resolved.gitChangeCapability !== undefined
      ? ("git-change" as const)
      : resolved.gitConflictCapability !== undefined
        ? ("git-conflict" as const)
        : null;
  const receiptExpectation =
    effectCapabilityScope === "git-change"
      ? ("cq-git-change-receipt" as const)
      : effectCapabilityScope === "git-conflict"
        ? ("cq-git-conflict-continuation-receipt" as const)
        : null;
  const effectivePreturn = Object.freeze({
    kind: "cq-codex-effective-preturn" as const,
    version: 2 as const,
    roleId: resolved.roleId,
    cwd: resolved.cwd,
    ledgerCwd: resolved.ledgerCwd,
    handle: Object.freeze({ ...resolved.handle }),
    effectCapabilityScope,
    receiptExpectation,
    rolePromptDigest: createHash("sha256").update(resolved.roleInstructions).digest("hex"),
    enabledTools,
    model: resolved.model,
    reasoningEffort: resolved.reasoningEffort,
    sandboxMode: resolved.sandboxMode,
    skillsPolicy: "role-instructions" as const,
    multiAgent: false as const,
    childWorkTimeoutMs: resolved.timeoutMs,
    storeResultSubmissionBudgetMs: CODEX_STORE_RESULT_SUBMISSION_BUDGET_MS,
    ledgerToolTimeoutSec: CODEX_LEDGER_TOOL_TIMEOUT_SEC,
    postStoreSubmissionFinalizationMs: CODEX_POST_STORE_FINALIZATION_MS,
    outerBoundaryTimeoutMs: resolved.timeoutMs + CODEX_OUTER_BOUNDARY_RESERVE_MS,
    parentGateWindowMs: CODEX_PARENT_GATE_WINDOW_MS,
  });
  return Object.freeze({
    roleId: resolved.roleId,
    cwd: resolved.cwd,
    sandboxMode: resolved.sandboxMode,
    argv,
    stdin: `${JSON.stringify(launch)}\n`,
    timeoutMs: resolved.timeoutMs + CODEX_OUTER_BOUNDARY_RESERVE_MS,
    childWorkTimeoutMs: resolved.timeoutMs,
    expectedHandle: resolved.handle,
    ledgerMcp,
    effectivePreturn,
    interceptStdout: true as const,
  });
}

interface CodexExecEvent {
  readonly type?: unknown;
  readonly thread_id?: unknown;
  readonly item?: {
    readonly type?: unknown;
    readonly text?: unknown;
    readonly server?: unknown;
    readonly tool?: unknown;
    readonly result?: unknown;
    readonly error?: unknown;
    readonly status?: unknown;
    readonly failure_controls?: unknown;
  };
}

function eventCarriesMatchingResultStoredAcknowledgement(
  event: CodexExecEvent,
  expectedHandle: DispatchHandle,
): boolean {
  const item = event.item;
  if (
    event.type !== "item.completed" ||
    item?.type !== "mcp_tool_call" ||
    item.server !== "ledger" ||
    item.tool !== "store_result" ||
    item.result === null ||
    typeof item.result !== "object" ||
    Array.isArray(item.result)
  ) {
    return false;
  }
  const content = (item.result as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return false;
  return content.some((part: unknown) => {
    if (part === null || typeof part !== "object" || Array.isArray(part)) return false;
    const record = part as Record<string, unknown>;
    return (
      record["type"] === "text" &&
      typeof record["text"] === "string" &&
      resultStoredAcknowledgementHandle(record["text"], expectedHandle) !== undefined
    );
  });
}

interface CodexRoleBoundaryStreamObservation {
  readonly finalMessage: string | undefined;
  readonly completedAgentMessageCount: number;
  readonly malformedJsonlCount: number;
  readonly matchingResultStoredAcknowledgementPresent: boolean;
  readonly storeResultRejected: boolean;
  readonly threadIds: readonly string[];
  readonly turnOutcomes: readonly ("completed" | "transport-failed")[];
  readonly failureControls: readonly string[];
}

function observeCodexRoleBoundaryStream(
  jsonl: string,
  expectedHandle: DispatchHandle,
): CodexRoleBoundaryStreamObservation {
  let finalMessage: string | undefined;
  let completedAgentMessageCount = 0;
  let malformedJsonlCount = 0;
  let matchingResultStoredAcknowledgementPresent = false;
  let storeResultRejected = false;
  const threadIds: string[] = [];
  const turnOutcomes: ("completed" | "transport-failed")[] = [];
  const failureControls: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      malformedJsonlCount += 1;
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      malformedJsonlCount += 1;
      continue;
    }
    const event = parsed as CodexExecEvent;
    if (
      event.type === "thread.started" &&
      typeof event.thread_id === "string" &&
      event.thread_id.trim() !== ""
    ) {
      threadIds.push(event.thread_id);
    }
    if (event.type === "turn.completed") turnOutcomes.push("completed");
    if (event.type === "turn.failed") turnOutcomes.push("transport-failed");
    if (
      event.type === "item.completed" &&
      event.item?.type === "cq_provider_gate_observation" &&
      Array.isArray(event.item.failure_controls) &&
      event.item.failure_controls.every((control) => typeof control === "string")
    ) {
      failureControls.push(...(event.item.failure_controls as string[]));
    }
    if (eventCarriesMatchingResultStoredAcknowledgement(event, expectedHandle)) {
      matchingResultStoredAcknowledgementPresent = true;
    }
    if (
      event.type === "item.completed" &&
      event.item?.type === "mcp_tool_call" &&
      event.item.server === "ledger" &&
      event.item.tool === "store_result" &&
      event.item.result === null &&
      (event.item.status === "failed" || event.item.error !== undefined)
    ) {
      storeResultRejected = true;
    }
    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      finalMessage = event.item.text;
      completedAgentMessageCount += 1;
    }
  }
  return Object.freeze({
    finalMessage,
    completedAgentMessageCount,
    malformedJsonlCount,
    matchingResultStoredAcknowledgementPresent,
    storeResultRejected,
    threadIds: Object.freeze(threadIds),
    turnOutcomes: Object.freeze(turnOutcomes),
    failureControls: Object.freeze(failureControls),
  });
}

function observedCodexRoleBoundaryResult(
  jsonl: string,
  plan: CodexRoleBoundaryPlan,
  correlationId: string,
  exitStatus: number,
): CodexRoleBoundaryExecutionResult {
  if (correlationId.trim() === "") {
    throw new CodexRoleBoundaryError("launch correlation id must be non-empty");
  }
  const observation = observeCodexRoleBoundaryStream(jsonl, plan.expectedHandle);
  if (observation.threadIds.length !== 1 || observation.threadIds[0] === undefined) {
    throw new CodexRoleBoundaryError(
      `child emitted ${String(observation.threadIds.length)} thread.started events; expected exactly one`,
    );
  }
  if (observation.turnOutcomes.length !== 1 || observation.turnOutcomes[0] === undefined) {
    throw new CodexRoleBoundaryError(
      `child emitted ${String(observation.turnOutcomes.length)} terminal turn events; expected exactly one`,
    );
  }
  return Object.freeze({
    handle: interceptCodexRoleBoundaryResult(jsonl, plan.expectedHandle),
    effectivePreturn: plan.effectivePreturn,
    observedFailureControls: observation.failureControls,
    observation: Object.freeze({
      agentType: plan.roleId,
      correlationId,
      childThreadId: observation.threadIds[0],
      outcome: observation.turnOutcomes[0],
      exitStatus,
    }),
  });
}

function resultStoredAcknowledgementHandle(
  message: string,
  expected: DispatchHandle,
): DispatchHandle | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.trim()) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const hasExactKeys = (candidate: Record<string, unknown>, keys: readonly string[]): boolean =>
    Object.keys(candidate).length === keys.length &&
    keys.every((key) => Object.hasOwn(candidate, key));
  const matchesHandle = (candidate: Record<string, unknown>): boolean =>
    candidate.attestationId === expected.attestationId &&
    candidate.generation === expected.generation;
  if (
    hasExactKeys(record, ["state", "attestationId", "generation", "outputDigest"]) &&
    record.state === "result-stored" &&
    matchesHandle(record) &&
    typeof record.outputDigest === "string" &&
    record.outputDigest.trim() !== ""
  ) {
    return expected;
  }
  if (
    hasExactKeys(record, ["state", "attestationId", "generation", "outputDigest"]) &&
    record.state === "gate-pending" &&
    matchesHandle(record) &&
    typeof record.outputDigest === "string" &&
    record.outputDigest.trim() !== ""
  ) {
    return expected;
  }
  const result = record.result;
  if (
    hasExactKeys(record, ["state", "result"]) &&
    record.state === "result-stored" &&
    result !== null &&
    typeof result === "object" &&
    !Array.isArray(result)
  ) {
    const nested = result as Record<string, unknown>;
    if (
      hasExactKeys(nested, ["state", "attestationId", "generation", "storedAt", "outputDigest"]) &&
      nested.state === "result-stored" &&
      matchesHandle(nested) &&
      typeof nested.storedAt === "string" &&
      nested.storedAt.trim() !== "" &&
      typeof nested.outputDigest === "string" &&
      nested.outputDigest.trim() !== ""
    ) {
      return expected;
    }
  }
  if (
    hasExactKeys(record, ["state", "result"]) &&
    record.state === "gate-pending" &&
    result !== null &&
    typeof result === "object" &&
    !Array.isArray(result)
  ) {
    const nested = result as Record<string, unknown>;
    if (
      hasExactKeys(nested, [
        "state",
        "attestationId",
        "generation",
        "submittedAt",
        "outputDigest",
      ]) &&
      nested.state === "gate-pending" &&
      matchesHandle(nested) &&
      typeof nested.submittedAt === "string" &&
      nested.submittedAt.trim() !== "" &&
      typeof nested.outputDigest === "string" &&
      nested.outputDigest.trim() !== ""
    ) {
      return expected;
    }
  }
  return undefined;
}

interface RecognizedAbortedDispatchAcknowledgement {
  readonly reason: string;
  readonly details: unknown | undefined;
}

/**
 * Exact typed-abort acknowledgement recognition (D241). Mirrors
 * {@link resultStoredAcknowledgementHandle}: only the flat AbortedDispatchResult
 * shape or the nested store_result outcome wrapper is accepted, and only when the
 * handle matches. Recognized aborts fail closed at the boundary with a bounded
 * diagnostic rather than falling through to echo misclassification.
 */
function abortedDispatchAcknowledgement(
  message: string,
  expected: DispatchHandle,
): RecognizedAbortedDispatchAcknowledgement | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.trim()) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const hasExactKeys = (candidate: Record<string, unknown>, keys: readonly string[]): boolean =>
    Object.keys(candidate).length === keys.length &&
    keys.every((key) => Object.hasOwn(candidate, key));
  const matchesHandle = (candidate: Record<string, unknown>): boolean =>
    candidate.attestationId === expected.attestationId &&
    candidate.generation === expected.generation;
  const asAbortedBody = (
    candidate: Record<string, unknown>,
  ): RecognizedAbortedDispatchAcknowledgement | undefined => {
    const withoutDetails = ["state", "attestationId", "generation", "abortedAt", "reason"] as const;
    const withDetails = [...withoutDetails, "details"] as const;
    if (!hasExactKeys(candidate, withoutDetails) && !hasExactKeys(candidate, withDetails)) {
      return undefined;
    }
    if (candidate.state !== "aborted" || !matchesHandle(candidate)) {
      return undefined;
    }
    if (typeof candidate.abortedAt !== "string" || candidate.abortedAt.trim() === "") {
      return undefined;
    }
    if (typeof candidate.reason !== "string" || candidate.reason.trim() === "") {
      return undefined;
    }
    return Object.freeze({
      reason: candidate.reason,
      details: Object.hasOwn(candidate, "details") ? candidate.details : undefined,
    });
  };
  const flat = asAbortedBody(record);
  if (flat !== undefined) {
    return flat;
  }
  const result = record.result;
  if (
    hasExactKeys(record, ["state", "result"]) &&
    record.state === "aborted" &&
    result !== null &&
    typeof result === "object" &&
    !Array.isArray(result)
  ) {
    return asAbortedBody(result as Record<string, unknown>);
  }
  return undefined;
}

/**
 * Bounded schema diagnostic fragment from invalid-output abort details
 * (summary, else first errors[] path+message). Mirrors invalidOutputDetailsOf
 * without re-entering the attestation service for a pure boundary parse.
 */
function boundedInvalidOutputAbortDiagnostic(
  acknowledgement: RecognizedAbortedDispatchAcknowledgement,
): string | undefined {
  if (acknowledgement.reason !== "invalid-output" || acknowledgement.details === undefined) {
    return undefined;
  }
  if (
    acknowledgement.details === null ||
    typeof acknowledgement.details !== "object" ||
    Array.isArray(acknowledgement.details)
  ) {
    return undefined;
  }
  const record = acknowledgement.details as Record<string, unknown>;
  if (typeof record.summary === "string" && record.summary.trim() !== "") {
    return record.summary;
  }
  const errors = record.errors;
  if (!Array.isArray(errors) || errors[0] === undefined) {
    return undefined;
  }
  const first = errors[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) {
    return undefined;
  }
  const entry = first as Record<string, unknown>;
  if (typeof entry.path !== "string" || typeof entry.message !== "string") {
    return undefined;
  }
  return `${entry.path} ${entry.message}`;
}

function abortedDispatchAcknowledgementMessage(
  acknowledgement: RecognizedAbortedDispatchAcknowledgement,
): string {
  const diagnostic = boundedInvalidOutputAbortDiagnostic(acknowledgement);
  if (diagnostic !== undefined) {
    return (
      `child final message is a typed abort acknowledgement ` +
      `(reason=${acknowledgement.reason}): ${diagnostic}`
    );
  }
  return (
    `child final message is a typed abort acknowledgement ` +
    `(reason=${acknowledgement.reason})`
  );
}

/**
 * Intercept the raw Codex JSONL stream and release only the expected dispatch
 * handle. The exact fixed `result-stored` acknowledgement is projected to that
 * handle; child prose, result bodies, and other echoed output never reach the
 * caller. A typed abort acknowledgement fails closed with a bounded diagnostic
 * (D241) rather than being misclassified as an echo.
 */
export function interceptCodexRoleBoundaryResult(
  jsonl: string,
  expectedHandle: DispatchHandle,
): DispatchHandle {
  const observation = observeCodexRoleBoundaryStream(jsonl, expectedHandle);
  const finalMessage = observation.finalMessage;
  if (finalMessage === undefined) {
    throw new CodexRoleBoundaryError(
      "child emitted no completed agent message",
      boundaryDiagnostic(observation, "no-completed-message", "no-completed-agent-message"),
    );
  }
  const storedAcknowledgement = resultStoredAcknowledgementHandle(finalMessage, expectedHandle);
  if (storedAcknowledgement !== undefined) {
    if (!observation.matchingResultStoredAcknowledgementPresent) {
      throw new CodexRoleBoundaryError(
        "child final message lacks a matching trusted result-stored observation",
      );
    }
    return storedAcknowledgement;
  }
  const abortedAcknowledgement = abortedDispatchAcknowledgement(finalMessage, expectedHandle);
  if (abortedAcknowledgement !== undefined) {
    const diagnostic = boundedInvalidOutputAbortDiagnostic(abortedAcknowledgement);
    const details = abortedAcknowledgement.details;
    if (
      diagnostic === "/resultCommit expected string" &&
      details !== null &&
      typeof details === "object" &&
      !Array.isArray(details) &&
      Object.keys(details).length === 1 &&
      Object.hasOwn(details, "summary")
    ) {
      throw new Error("D340 brokered store_result outcome: typed-abort");
    }
    throw new CodexRoleBoundaryError(
      abortedDispatchAcknowledgementMessage(abortedAcknowledgement),
    );
  }
  const verdict = classifyCodexFinalMessage(finalMessage, expectedHandle);
  if (verdict.verdict !== "handle-only") {
    throw new CodexRoleBoundaryError(
      `child final message failed the handle-only contract (${verdict.verdict})`,
      boundaryDiagnostic(observation, verdict.verdict, diagnosticDetailCode(verdict)),
    );
  }
  if (!observation.matchingResultStoredAcknowledgementPresent) {
    if (finalMessage.trim() === expectedHandle.attestationId) {
      throw new Error(
        `D340 brokered store_result outcome: ${observation.storeResultRejected ? "rejected" : "omitted"}`,
      );
    }
    throw new CodexRoleBoundaryError(
      "child final message lacks a matching trusted result-stored observation",
    );
  }
  return verdict.handle;
}

function diagnosticDetailCode(
  verdict: Exclude<ReturnType<typeof classifyCodexFinalMessage>, { verdict: "handle-only" }>,
): CodexRoleBoundaryDiagnosticDetailCode {
  switch (verdict.verdict) {
    case "echo":
      return "surplus-fields";
    case "wrong-handle":
      return "mismatched-handle";
    case "unparseable":
      if (verdict.detail.startsWith("not JSON:")) return "invalid-json";
      if (verdict.detail === "expected a JSON object carrying exactly the dispatch handle") {
        return "invalid-shape";
      }
      return "invalid-handle-shape";
  }
}

function boundaryDiagnostic(
  observation: CodexRoleBoundaryStreamObservation,
  verdict: CodexRoleBoundaryDiagnosticVerdict,
  detailCode: CodexRoleBoundaryDiagnosticDetailCode,
): CodexRoleBoundaryDiagnostic {
  const finalMessage = observation.finalMessage ?? "";
  return Object.freeze({
    version: 1 as const,
    verdict,
    detailCode,
    finalMessageByteLength: Buffer.byteLength(finalMessage),
    finalMessageSha256: createHash("sha256").update(finalMessage).digest("hex"),
    completedAgentMessageCount: observation.completedAgentMessageCount,
    malformedJsonlCount: observation.malformedJsonlCount,
    matchingResultStoredAcknowledgementPresent:
      observation.matchingResultStoredAcknowledgementPresent,
  });
}

/**
 * Execute one already-resolved plan. Exit status remains corroborating only:
 * a valid stored-result handle wins even when Codex exits non-zero during
 * teardown, matching the compact dispatch protocol's completion semantics.
 */
export function executeCodexRoleBoundary(
  plan: CodexRoleBoundaryPlan,
  worksetEffect: CodexRoleBoundaryWorksetEffect,
): Promise<DispatchHandle>;
export function executeCodexRoleBoundary(
  plan: CodexRoleBoundaryPlan,
  correlationId: string,
  environment: NodeJS.ProcessEnv | undefined,
  worksetEffect: CodexRoleBoundaryWorksetEffect,
): Promise<CodexRoleBoundaryExecutionResult>;
export async function executeCodexRoleBoundary(
  plan: CodexRoleBoundaryPlan,
  correlationOrEffect: string | CodexRoleBoundaryWorksetEffect,
  environment?: NodeJS.ProcessEnv,
  correlatedWorksetEffect?: CodexRoleBoundaryWorksetEffect,
): Promise<DispatchHandle | CodexRoleBoundaryExecutionResult> {
  type StopCause = "SIGINT" | "SIGTERM" | "abort" | "outer-timeout";
  const correlationId =
    typeof correlationOrEffect === "string" ? correlationOrEffect : undefined;
  const worksetEffect =
    typeof correlationOrEffect === "string" ? correlatedWorksetEffect : correlationOrEffect;
  if (worksetEffect === undefined) {
    throw new CodexRoleBoundaryError("boundary execution requires a workset effect admission");
  }
  const abortController = new AbortController();
  let requestedStop: StopCause | undefined;
  const requestStop = (cause: StopCause): void => {
    if (requestedStop !== undefined) return;
    requestedStop = cause;
    abortController.abort(new CodexRoleBoundaryError(`wrapper received ${cause}`));
  };
  const onSigint = (): void => requestStop("SIGINT");
  const onSigterm = (): void => requestStop("SIGTERM");
  const onAbort = (): void => requestStop("abort");
  const outerBoundaryTimer = setTimeout(() => requestStop("outer-timeout"), plan.timeoutMs);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  worksetEffect.signal?.addEventListener("abort", onAbort, { once: true });
  if (worksetEffect.signal?.aborted === true) onAbort();
  let gateSettlement: SettleProcessGroupsResult | undefined;

  try {
    // D266: a read-only reviewer dispatch first proves, inside the same codex
    // sandbox, that node-child pipe captures survive (codex 0.146's seccomp
    // silently empties them — openai/codex#18473) and that the injected
    // TMPDIR is writable; only then does the boundary launch, with the
    // TMPDIR override spliced into the exec argv. The sandbox tmpfs is
    // per-instance, so there is nothing to clean up afterwards.
    let argv = plan.argv;
    if (requiresCodexSandboxPreflight(plan.roleId, plan.sandboxMode)) {
      const codexExecutable = plan.argv[0];
      if (codexExecutable === undefined) {
        throw new CodexRoleBoundaryError("boundary argv has no codex executable");
      }
      try {
        await runCodexSandboxPipeProbe({
          codexExecutable,
          cwd: plan.cwd,
          env: withoutWorksetCredentials(process.env),
          timeoutMs: CODEX_SANDBOX_PIPE_PROBE_TIMEOUT_MS,
        });
      } catch (error) {
        if (error instanceof SandboxPipeProbeError) throw new CodexOperationalAbstentionError(error);
        throw error;
      }
      argv = argvWithSandboxTmpdir(plan.argv, CODEX_READ_ONLY_SANDBOX_TMPDIR);
    }
    const broker = new WorksetEffectBroker({ provider: worksetEffect.provider });
    const childEnvironment: NodeJS.ProcessEnv = withoutWorksetCredentials(
      correlationId === undefined
        ? { ...process.env, ...environment }
        : {
            ...process.env,
            ...environment,
            CQ_CODEX_ROLE_CORRELATION_ID: correlationId,
          },
    );
    let launched;
    try {
      launched = await broker.launch({
        kind: "child-dispatch",
        targetRef: worksetEffect.targetRef,
        argv,
        cwd: plan.cwd,
        env: childEnvironment,
        stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" } as const,
        signal: abortController.signal,
        timeoutMs: plan.childWorkTimeoutMs,
        settleRegisteredDescendants: async () => {
          gateSettlement = await settleWorktreeGateCommands({ worktree: plan.cwd });
          if (gateSettlement.survivors.length > 0) {
            throw new CodexRoleBoundaryError(
              `process-group settlement left survivors ${gateSettlement.survivors.join(", ")}`,
            );
          }
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
            terminate: (signal: NodeJS.Signals) => {
              child.kill(signal);
            },
          };
        },
      });
    } catch (error) {
      if (requestedStop === undefined) throw error;
      throw new CodexRoleBoundaryError(`wrapper received ${requestedStop}`);
    }

    try {
      const { child, stdout, stderr } = launched.process;
      child.stdin.write(plan.stdin);
      child.stdin.end();
      const [exitStatus, completedStdout] = await Promise.all([launched.exited, stdout, stderr]);
      if (launched.terminationReason === "timeout") {
        throw new CodexRoleBoundaryError(
          `child exceeded its ${String(plan.childWorkTimeoutMs)} ms window`,
        );
      }
      if (requestedStop !== undefined) {
        throw new CodexRoleBoundaryError(`wrapper received ${requestedStop}`);
      }
      const result =
        correlationId !== undefined
          ? observedCodexRoleBoundaryResult(completedStdout, plan, correlationId, exitStatus)
          : interceptCodexRoleBoundaryResult(completedStdout, plan.expectedHandle);
      if (correlationId !== undefined) RUNNER_OWNED_NATIVE_EXECUTIONS.add(result);
      if ((gateSettlement?.signaled.length ?? 0) > 0) {
        throw new CodexRoleBoundaryError(
          "live registered gate at child completion",
          boundaryDiagnostic(
            observeCodexRoleBoundaryStream(completedStdout, plan.expectedHandle),
            "live-gate-at-completion",
            "unsettled-full-gate-at-completion",
          ),
        );
      }
      return result;
    } catch (error) {
      try {
        await launched.cancel();
      } catch (settlementError) {
        throw new AggregateError(
          [error, settlementError],
          "Codex role boundary failed and process-group settlement failed",
        );
      }
      throw error;
    }
  } finally {
    clearTimeout(outerBoundaryTimer);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    worksetEffect.signal?.removeEventListener("abort", onAbort);
  }
}

function installedIdentityEqual(
  left: CodexInstalledIdentity,
  right: CodexInstalledIdentity,
): boolean {
  return (
    left.storePath === right.storePath &&
    left.executablePath === right.executablePath &&
    left.executableDigest === right.executableDigest
  );
}

async function trustedRunnerInstalledIdentity(): Promise<CodexInstalledIdentity> {
  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const storePath = path.resolve(path.dirname(modulePath), "..", "..", "..", "..", "..");
  const executablePath = path.join(storePath, "bin", "cq-codex-role");
  const executable = await realpath(executablePath);
  if (
    !/^\/nix\/store\/[0-9a-z]{32}-cq-[^/]+$/.test(storePath) ||
    executable !== executablePath
  ) {
    throw new CodexRoleBoundaryError(
      "installed boundary module does not belong to the trusted cq runner derivation",
    );
  }
  return Object.freeze({
    storePath,
    executablePath,
    executableDigest: createHash("sha256").update(await readFile(executablePath)).digest("hex"),
  });
}

function assertInstalledPreturnObservation(
  value: unknown,
  request: CodexInstalledRoleBoundaryRequest,
): CodexEffectivePreturn {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CodexRoleBoundaryError("installed boundary emitted no effective preturn observation");
  }
  const observed = value as Record<string, unknown>;
  const expectedTools = exposedLedgerToolsForRole(request.invocation.roleId);
  const expectedCapability =
    request.invocation.gitChangeCapability !== undefined ? "git-change" : "git-conflict";
  const expectedReceipt =
    expectedCapability === "git-change"
      ? "cq-git-change-receipt"
      : "cq-git-conflict-continuation-receipt";
  const handle = observed["handle"] as Record<string, unknown> | undefined;
  if (
    observed["kind"] !== "cq-codex-effective-preturn" ||
    observed["version"] !== 2 ||
    observed["roleId"] !== request.invocation.roleId ||
    path.resolve(String(observed["cwd"])) !== path.resolve(request.invocation.cwd) ||
    path.resolve(String(observed["ledgerCwd"])) !== path.resolve(request.invocation.ledgerCwd) ||
    handle?.["attestationId"] !== request.invocation.handle.attestationId ||
    handle["generation"] !== request.invocation.handle.generation ||
    observed["effectCapabilityScope"] !== expectedCapability ||
    observed["receiptExpectation"] !== expectedReceipt ||
    observed["rolePromptDigest"] !== request.expectedPromptProvenance.promptDigest ||
    JSON.stringify(observed["enabledTools"]) !== JSON.stringify(expectedTools) ||
    observed["model"] !== request.invocation.model ||
    observed["reasoningEffort"] !== request.invocation.reasoningEffort ||
    observed["sandboxMode"] !== request.invocation.sandboxMode ||
    observed["skillsPolicy"] !== "role-instructions" ||
    observed["multiAgent"] !== false ||
    observed["childWorkTimeoutMs"] !== request.invocation.timeoutMs ||
    observed["storeResultSubmissionBudgetMs"] !== CODEX_STORE_RESULT_SUBMISSION_BUDGET_MS ||
    observed["ledgerToolTimeoutSec"] !== CODEX_LEDGER_TOOL_TIMEOUT_SEC ||
    observed["postStoreSubmissionFinalizationMs"] !== CODEX_POST_STORE_FINALIZATION_MS ||
    observed["outerBoundaryTimeoutMs"] !==
      request.invocation.timeoutMs + CODEX_OUTER_BOUNDARY_RESERVE_MS ||
    observed["parentGateWindowMs"] !== CODEX_PARENT_GATE_WINDOW_MS
  ) {
    throw new CodexRoleBoundaryError(
      "installed boundary effective preturn differs from the trusted dispatch bindings",
    );
  }
  return Object.freeze(value as CodexEffectivePreturn);
}

async function runInstalledRoleProcess(input: {
  readonly executable: string;
  readonly cwd: string;
  readonly invocationJson: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly correlationId: string;
  readonly request: CodexInstalledRoleBoundaryRequest;
}): Promise<{
  readonly exitStatus: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly effectivePreturn: CodexEffectivePreturn;
  readonly observedFailureControls: readonly string[];
}> {
  const observationRoot = await mkdtemp(path.join(tmpdir(), "cq-codex-preturn-"));
  const observationPath = path.join(observationRoot, "effective-preturn.json");
  try {
    const child = Bun.spawn([input.executable], {
      cwd: input.cwd,
      env: withoutWorksetCredentials({
        ...process.env,
        ...input.environment,
        CQ_CODEX_ROLE_CORRELATION_ID: input.correlationId,
        [CODEX_PRETURN_OBSERVATION_PATH_ENV]: observationPath,
      }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(`${input.invocationJson}\n`);
    child.stdin.end();
    const [exitStatus, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    let observedLines: unknown[];
    try {
      observedLines = (await readFile(observationPath, "utf8"))
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as unknown);
    } catch {
      throw new CodexRoleBoundaryError(
        `installed boundary did not record its effective preturn: ${stderr.trim()}`,
      );
    }
    const outcome = observedLines[1];
    if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) {
      throw new CodexRoleBoundaryError("installed boundary emitted no effective outcome observation");
    }
    const outcomeRecord = outcome as Record<string, unknown>;
    const outcomeHandle = outcomeRecord["handle"] as Record<string, unknown> | undefined;
    const observedFailureControls = outcomeRecord["observedFailureControls"];
    if (
      observedLines.length !== 2 ||
      outcomeRecord["kind"] !== "cq-codex-effective-outcome" ||
      outcomeRecord["version"] !== 1 ||
      outcomeHandle?.["attestationId"] !== input.request.invocation.handle.attestationId ||
      outcomeHandle?.["generation"] !== input.request.invocation.handle.generation ||
      !Array.isArray(observedFailureControls) ||
      !observedFailureControls.every((control) => typeof control === "string")
    ) {
      throw new CodexRoleBoundaryError("installed boundary emitted a malformed effective outcome");
    }
    return {
      exitStatus,
      stdout,
      stderr,
      effectivePreturn: assertInstalledPreturnObservation(observedLines[0], input.request),
      observedFailureControls: Object.freeze([...observedFailureControls] as string[]),
    };
  } finally {
    await rm(observationRoot, { recursive: true, force: true });
  }
}

/**
 * Runner-owned installed-boundary execution used by the Codex provider gates.
 * The opaque result is admitted to the qualification path only while it remains
 * in this module's WeakSet; JSON reconstructed by a caller has no authority.
 */
export async function executeInstalledCodexRoleBoundary(
  request: CodexInstalledRoleBoundaryRequest,
): Promise<CodexInstalledRoleBoundaryExecution> {
  const expectedInstalledIdentity = await trustedRunnerInstalledIdentity();
  const executable = await realpath(requiredString(request.executable, "executable"));
  const storePath = path.dirname(path.dirname(executable));
  if (
    !/^\/nix\/store\/[0-9a-z]{32}-[^/]+$/.test(storePath) ||
    path.dirname(executable) !== path.join(storePath, "bin") ||
    path.basename(executable) !== "cq-codex-role"
  ) {
    throw new CodexRoleBoundaryError(
      `provider gate requires an installed Nix cq-codex-role; got ${JSON.stringify(executable)}`,
    );
  }
  const installedIdentity = Object.freeze({
    storePath,
    executablePath: executable,
    executableDigest: createHash("sha256").update(await readFile(executable)).digest("hex"),
  });
  if (!installedIdentityEqual(installedIdentity, expectedInstalledIdentity)) {
    throw new CodexRoleBoundaryError(
      "installed boundary identity differs from the trusted runner derivation",
    );
  }
  const roleId = assertCodexDispatchedRoleId(request.invocation.roleId);
  if (roleId !== "implement-worker" && roleId !== "implement-conflict-resolver") {
    throw new CodexRoleBoundaryError(
      `provider gate role must be implement-worker or implement-conflict-resolver; got ${JSON.stringify(roleId)}`,
    );
  }
  const handleValidation = validateManagedWorktreeHandle(request.managedHandle);
  if (handleValidation.status === "invalid") {
    throw new CodexRoleBoundaryError(
      `provider gate managed handle is invalid: ${handleValidation.detail}`,
    );
  }
  if (
    path.resolve(request.invocation.cwd) !== path.resolve(request.managedHandle.absolutePath) ||
    path.resolve(request.invocation.ledgerCwd) !== path.resolve(request.managedHandle.repositoryRoot)
  ) {
    throw new CodexRoleBoundaryError(
      "provider gate invocation does not match the managed worktree/repository binding",
    );
  }
  if (request.invocation.sandboxMode !== "workspace-write") {
    throw new CodexRoleBoundaryError("provider gate requires workspace-write sandbox mode");
  }
  const effect = roleId === "implement-worker" ? "git-commit" : "git-conflict-continue";
  if (
    (roleId === "implement-worker" &&
      (request.invocation.gitChangeCapability === undefined ||
        request.invocation.gitConflictCapability !== undefined ||
        request.invocation.parentGateCapability === undefined)) ||
    (roleId === "implement-conflict-resolver" &&
      (request.invocation.gitConflictCapability === undefined ||
        request.invocation.gitChangeCapability !== undefined ||
        request.invocation.parentGateCapability !== undefined))
  ) {
    throw new CodexRoleBoundaryError(
      `provider gate ${roleId} did not receive exactly its role-scoped Git and parent-gate capabilities`,
    );
  }
  if (
    request.expectedPromptProvenance.roleId !== roleId ||
    request.expectedChild.childId.trim() === "" ||
    request.expectedChild.runId.trim() === "" ||
    request.correlationId.trim() === ""
  ) {
    throw new CodexRoleBoundaryError(
      "provider gate expected child, provenance, and correlation bindings must be non-empty and role-matched",
    );
  }

  const invocationJson = JSON.stringify({
    ...request.invocation,
    effectTargetRef: `tasks:${request.managedHandle.taskId}`,
  } satisfies CodexRoleBoundaryInvocation);
  const { exitStatus, stdout, stderr, effectivePreturn, observedFailureControls } =
    await runInstalledRoleProcess({
    executable,
    cwd: request.managedHandle.absolutePath,
    invocationJson,
    ...(request.environment === undefined ? {} : { environment: request.environment }),
    correlationId: request.correlationId,
    request,
    });
  if (exitStatus !== 0) {
    throw new CodexRoleBoundaryError(
      `installed ${roleId} boundary exited ${String(exitStatus)}: ${stderr.trim()}`,
    );
  }
  let output: unknown;
  try {
    output = JSON.parse(stdout.trim()) as unknown;
  } catch {
    throw new CodexRoleBoundaryError(`installed ${roleId} boundary emitted non-JSON stdout`);
  }
  if (
    output === null ||
    typeof output !== "object" ||
    Array.isArray(output) ||
    Object.keys(output).sort().join(",") !== "attestationId,generation"
  ) {
    throw new CodexRoleBoundaryError(
      `installed ${roleId} boundary did not emit exactly the dispatch handle`,
    );
  }
  const returned = output as Record<string, unknown>;
  if (
    returned["attestationId"] !== request.invocation.handle.attestationId ||
    returned["generation"] !== request.invocation.handle.generation
  ) {
    throw new CodexRoleBoundaryError(`installed ${roleId} boundary returned a foreign handle`);
  }
  const execution = Object.freeze({
    kind: "cq-codex-installed-role-boundary-execution" as const,
    version: 1 as const,
    roleId,
    effect,
    executable,
    installedIdentity,
    expectedInstalledIdentity,
    effectivePreturn,
    observedFailureControls,
    handle: Object.freeze({ ...request.invocation.handle }),
    managedHandle: request.managedHandle,
    expectedChild: Object.freeze({ ...request.expectedChild }),
    expectedPromptProvenance: Object.freeze({ ...request.expectedPromptProvenance }),
    correlationId: request.correlationId,
    invocationDigest: createHash("sha256").update(invocationJson).digest("hex"),
    stdoutDigest: createHash("sha256").update(stdout).digest("hex"),
    exitStatus: 0 as const,
  });
  RUNNER_OWNED_INSTALLED_EXECUTIONS.add(execution);
  return execution;
}

async function runControlCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<{ readonly exitStatus: number; readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn([executable, ...args], {
    cwd,
    env: withoutWorksetCredentials({
      ...process.env,
      GIT_AUTHOR_NAME: "cq-codex-sandbox-control",
      GIT_AUTHOR_EMAIL: "cq-codex-sandbox-control@example.invalid",
      GIT_COMMITTER_NAME: "cq-codex-sandbox-control",
      GIT_COMMITTER_EMAIL: "cq-codex-sandbox-control@example.invalid",
      GIT_TERMINAL_PROMPT: "0",
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitStatus, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitStatus, stdout, stderr };
}

async function requireControlSuccess(
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  const result = await runControlCommand(executable, args, cwd);
  if (result.exitStatus !== 0) {
    throw new CodexRoleBoundaryError(
      `sandbox control ${path.basename(executable)} ${args.join(" ")} exited ` +
        `${String(result.exitStatus)}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

/**
 * Execute the same valid Git metadata mutation twice through the actual Codex
 * sandbox in the exact managed worktree. The paired invocations differ only in
 * whether the repository metadata directory is writable or read-only.
 */
export async function executeCodexProviderSandboxControl(
  request: CodexProviderSandboxControlRequest,
): Promise<CodexProviderSandboxControl> {
  const validation = validateManagedWorktreeHandle(request.managedHandle);
  if (validation.status === "invalid") {
    throw new CodexRoleBoundaryError(`sandbox control managed handle is invalid: ${validation.detail}`);
  }
  const codexExecutable = await realpath(requiredString(request.codexExecutable, "codexExecutable"));
  const gitExecutable = await realpath(requiredString(request.gitExecutable, "gitExecutable"));
  if (
    !/^\/nix\/store\/[0-9a-z]{32}-[^/]+\/bin\/codex$/.test(codexExecutable) ||
    !/^\/nix\/store\/[0-9a-z]{32}-[^/]+\/bin\/git$/.test(gitExecutable)
  ) {
    throw new CodexRoleBoundaryError(
      "sandbox controls require exact installed Nix Codex and Git executables",
    );
  }
  const managedHead = await requireControlSuccess(
    gitExecutable,
    ["rev-parse", "HEAD"],
    request.managedHandle.absolutePath,
  );
  const refName =
    `refs/heads/cq-sandbox-${request.roleId === "implement-worker" ? "worker" : "resolver"}-` +
    request.route;
  const sandboxArguments = (gitMetadataPermission: "read" | "write"): readonly string[] => [
    "-c",
    'default_permissions="qualification"',
    "-c",
    `permissions.qualification.filesystem={":minimal"="read",` +
      `${JSON.stringify(request.managedHandle.absolutePath)}="write",` +
      `${JSON.stringify(path.join(request.managedHandle.repositoryRoot, ".git"))}=${JSON.stringify(gitMetadataPermission)}}`,
    "sandbox",
    "-P",
    "qualification",
    "-C",
    request.managedHandle.absolutePath,
    "--",
    gitExecutable,
    "update-ref",
    refName,
    managedHead,
  ];
  const credentialProbeArguments = [
    "-c",
    'default_permissions="qualification"',
    "-c",
    'permissions.qualification.filesystem={":minimal"="read"}',
    "sandbox",
    "-P",
    "qualification",
    "-C",
    request.managedHandle.absolutePath,
    "--",
    "/bin/sh",
    "-c",
    'test -z "$CQ_SERVE_TOKEN$CQ_SERVE_MANAGEMENT_TOKEN$CQ_LEDGER_REMOTE_TOKEN"',
  ] as const;
  try {
    const credentialProbe = await runControlCommand(
      codexExecutable,
      credentialProbeArguments,
      request.managedHandle.absolutePath,
    );
    if (credentialProbe.exitStatus !== 0) {
      throw new CodexRoleBoundaryError(
        `Codex ${request.roleId}/${request.route} sandbox control inherited ledger credentials`,
      );
    }
    const before = await runControlCommand(
      gitExecutable,
      ["show-ref", "--verify", "--quiet", refName],
      request.managedHandle.absolutePath,
    );
    if (before.exitStatus === 0) {
      throw new CodexRoleBoundaryError(`sandbox control target ${refName} already exists`);
    }
    const writableSandbox = await runControlCommand(
      codexExecutable,
      sandboxArguments("write"),
      request.managedHandle.absolutePath,
    );
    if (writableSandbox.exitStatus !== 0) {
      throw new CodexRoleBoundaryError(
        `Codex ${request.roleId}/${request.route} writable-metadata sandbox rejected valid Git mutation: ` +
          writableSandbox.stderr.trim(),
      );
    }
    const writableRef = await requireControlSuccess(
      gitExecutable,
      ["rev-parse", refName],
      request.managedHandle.absolutePath,
    );
    if (writableRef !== managedHead) {
      throw new CodexRoleBoundaryError(
        `Codex ${request.roleId}/${request.route} writable-metadata sandbox changed ref identity`,
      );
    }
    await requireControlSuccess(
      gitExecutable,
      ["update-ref", "-d", refName],
      request.managedHandle.absolutePath,
    );
    const reset = await runControlCommand(
      gitExecutable,
      ["show-ref", "--verify", "--quiet", refName],
      request.managedHandle.absolutePath,
    );
    if (reset.exitStatus === 0) {
      throw new CodexRoleBoundaryError(`sandbox control target ${refName} survived positive reset`);
    }
    const deniedSandbox = await runControlCommand(
      codexExecutable,
      sandboxArguments("read"),
      request.managedHandle.absolutePath,
    );
    const after = await runControlCommand(
      gitExecutable,
      ["show-ref", "--verify", "--quiet", refName],
      request.managedHandle.absolutePath,
    );
    if (deniedSandbox.exitStatus === 0 || after.exitStatus === 0) {
      throw new CodexRoleBoundaryError(
        `Codex ${request.roleId}/${request.route} sandbox admitted direct Git metadata mutation`,
      );
    }
    const result = Object.freeze({
      kind: "cq-codex-provider-sandbox-control" as const,
      version: 1 as const,
      roleId: request.roleId,
      route: request.route,
      managedHandle: request.managedHandle,
      codexExecutable,
      writableSandboxExitStatus: 0 as const,
      writableSandboxStdoutDigest: createHash("sha256")
        .update(writableSandbox.stdout)
        .digest("hex"),
      writableSandboxRefMatches: true as const,
      deniedSandboxExitStatus: deniedSandbox.exitStatus,
      deniedSandboxStderrDigest: createHash("sha256").update(deniedSandbox.stderr).digest("hex"),
      deniedSandboxRefAbsent: true as const,
      credentialEnvironmentAbsent: true as const,
    });
    RUNNER_OWNED_SANDBOX_CONTROLS.add(result);
    return result;
  } finally {
    await runControlCommand(
      gitExecutable,
      ["update-ref", "-d", refName],
      request.managedHandle.absolutePath,
    );
  }
}
