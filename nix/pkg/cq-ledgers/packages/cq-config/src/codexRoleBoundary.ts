import * as path from "node:path";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { constants } from "node:os";
import {
  launchRegisteredProcessGroup,
  settleProcessGroups,
  settleWorktreeGateCommands,
  type ProcessGroupRegistration,
  type SettleProcessGroupsResult,
} from "@cq/process-control";
import type {
  DispatchHandle,
  GitChangeCapability,
  GitConflictCapability,
  InputCapability,
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
} from "./codexSandboxPreflight.js";
import { DISPATCHED_ROLE_IDS } from "./promptCatalogStore.js";
import { exposedLedgerToolsForRole, type LedgerCapabilityToolName } from "./roleToolProfiles.js";

export const CODEX_ROLE_SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

export type CodexRoleSandboxMode = (typeof CODEX_ROLE_SANDBOX_MODES)[number];

export interface CodexRoleBoundaryRequest {
  readonly roleId: string;
  readonly roleInstructions: string;
  readonly handle: DispatchHandle;
  readonly inputCapability: InputCapability;
  readonly resultCapability: ResultCapability;
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

export type CodexRoleBoundaryInvocation = Omit<
  CodexRoleBoundaryRequest,
  "roleInstructions" | "promptRoot" | "ledgerCommand" | "codexExecutable"
>;

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
  readonly expectedHandle: DispatchHandle;
  readonly ledgerMcp: CodexRoleLedgerMcpConfiguration;
  /** The child JSONL stream stays inside the adapter; only a verified handle escapes. */
  readonly interceptStdout: true;
}

export interface CodexRoleBoundaryExecutionResult {
  readonly handle: DispatchHandle;
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

export interface CodexInstalledRoleBoundaryExecution {
  readonly kind: "cq-codex-installed-role-boundary-execution";
  readonly version: 1;
  readonly roleId: "implement-worker" | "implement-conflict-resolver";
  readonly effect: "git-commit" | "git-conflict-continue";
  readonly executable: string;
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
  readonly invocation: CodexRoleBoundaryInvocation;
  readonly managedHandle: ManagedWorktreeHandle;
  readonly expectedChild: { readonly childId: string; readonly runId: string };
  readonly expectedPromptProvenance: DispatchPromptProvenance;
  readonly correlationId: string;
  readonly environment?: NodeJS.ProcessEnv;
}

const RUNNER_OWNED_INSTALLED_EXECUTIONS = new WeakSet<object>();

export function isRunnerOwnedCodexInstalledRoleBoundaryExecution(
  value: unknown,
): value is CodexInstalledRoleBoundaryExecution {
  return typeof value === "object" && value !== null && RUNNER_OWNED_INSTALLED_EXECUTIONS.has(value);
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
  return Object.freeze({
    roleId: resolved.roleId,
    cwd: resolved.cwd,
    sandboxMode: resolved.sandboxMode,
    argv,
    stdin: `${JSON.stringify(launch)}\n`,
    timeoutMs: resolved.timeoutMs,
    expectedHandle: resolved.handle,
    ledgerMcp,
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
  readonly threadIds: readonly string[];
  readonly turnOutcomes: readonly ("completed" | "transport-failed")[];
}

function observeCodexRoleBoundaryStream(
  jsonl: string,
  expectedHandle: DispatchHandle,
): CodexRoleBoundaryStreamObservation {
  let finalMessage: string | undefined;
  let completedAgentMessageCount = 0;
  let malformedJsonlCount = 0;
  let matchingResultStoredAcknowledgementPresent = false;
  const threadIds: string[] = [];
  const turnOutcomes: ("completed" | "transport-failed")[] = [];
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
    if (eventCarriesMatchingResultStoredAcknowledgement(event, expectedHandle)) {
      matchingResultStoredAcknowledgementPresent = true;
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
    threadIds: Object.freeze(threadIds),
    turnOutcomes: Object.freeze(turnOutcomes),
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
    return storedAcknowledgement;
  }
  const abortedAcknowledgement = abortedDispatchAcknowledgement(finalMessage, expectedHandle);
  if (abortedAcknowledgement !== undefined) {
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
export function executeCodexRoleBoundary(plan: CodexRoleBoundaryPlan): Promise<DispatchHandle>;
export function executeCodexRoleBoundary(
  plan: CodexRoleBoundaryPlan,
  correlationId: string,
): Promise<CodexRoleBoundaryExecutionResult>;
export async function executeCodexRoleBoundary(
  plan: CodexRoleBoundaryPlan,
  correlationId?: string,
): Promise<DispatchHandle | CodexRoleBoundaryExecutionResult> {
  type StopCause = "SIGINT" | "SIGTERM" | "timeout";
  let stop: ((cause: StopCause) => void) | undefined;
  let requestedStop: StopCause | undefined;
  const stopRequested = new Promise<StopCause>((resolve) => {
    stop = (cause) => {
      if (requestedStop !== undefined) return;
      requestedStop = cause;
      resolve(cause);
    };
  });
  const requestStop = (cause: StopCause): void => {
    if (stop === undefined) throw new Error("Codex role boundary stop channel was not initialized");
    stop(cause);
  };
  const onSigint = (): void => requestStop("SIGINT");
  const onSigterm = (): void => requestStop("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  const timeout = setTimeout(() => requestStop("timeout"), plan.timeoutMs);

  let rootRegistration: ProcessGroupRegistration | undefined;
  let settlement:
    | Promise<{
        readonly gate: SettleProcessGroupsResult;
        readonly root: SettleProcessGroupsResult;
      }>
    | undefined;
  const settle = (): Promise<{
    readonly gate: SettleProcessGroupsResult;
    readonly root: SettleProcessGroupsResult;
  }> => {
    settlement ??= (async () => {
      let gateResult: SettleProcessGroupsResult | undefined;
      let gateError: unknown;
      try {
        gateResult = await settleWorktreeGateCommands({ worktree: plan.cwd });
      } catch (error) {
        gateError = error;
      }

      let rootResult: SettleProcessGroupsResult = { signaled: [], survivors: [] };
      let rootError: unknown;
      try {
        if (rootRegistration !== undefined) {
          rootResult = await settleProcessGroups([rootRegistration]);
        }
      } catch (error) {
        rootError = error;
      }

      const survivors = [...(gateResult?.survivors ?? []), ...rootResult.survivors];
      if (gateError !== undefined || rootError !== undefined) {
        throw new AggregateError(
          [gateError, rootError].filter((error) => error !== undefined),
          "Codex role boundary could not settle every owned process group",
        );
      }
      if (survivors.length > 0) {
        throw new CodexRoleBoundaryError(
          `process-group settlement left survivors ${survivors.join(", ")}`,
        );
      }
      return {
        gate: gateResult ?? { signaled: [], survivors: [] },
        root: rootResult,
      };
    })();
    return settlement;
  };

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
      await runCodexSandboxPipeProbe({
        codexExecutable,
        cwd: plan.cwd,
        env: process.env,
        timeoutMs: CODEX_SANDBOX_PIPE_PROBE_TIMEOUT_MS,
      });
      argv = argvWithSandboxTmpdir(plan.argv, CODEX_READ_ONLY_SANDBOX_TMPDIR);
    }
    let launched;
    try {
      const childEnvironment: NodeJS.ProcessEnv =
        correlationId === undefined
          ? process.env
          : { ...process.env, CQ_CODEX_ROLE_CORRELATION_ID: correlationId };
      launched = await launchRegisteredProcessGroup({
        argv,
        cwd: plan.cwd,
        env: childEnvironment,
        stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" } as const,
        register: async (registration) => {
          rootRegistration = registration;
          if (requestedStop !== undefined) {
            throw new CodexRoleBoundaryError(`wrapper received ${requestedStop}`);
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
      if (requestedStop === "timeout") {
        throw new CodexRoleBoundaryError(`child exceeded its ${String(plan.timeoutMs)} ms window`);
      }
      throw new CodexRoleBoundaryError(`wrapper received ${requestedStop}`);
    }

    const { child, stdout, stderr } = launched.process;
    child.stdin.write(plan.stdin);
    child.stdin.end();
    const execution = Promise.all([launched.exited, stdout, stderr]).then(
      ([exitStatus, completedStdout]) => ({
        kind: "completed" as const,
        stdout: completedStdout,
        exitStatus,
      }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    const outcome = await Promise.race([
      execution,
      stopRequested.then((cause) => ({ kind: "stopped" as const, cause })),
    ]);
    if (outcome.kind === "stopped") {
      if (outcome.cause === "timeout") {
        throw new CodexRoleBoundaryError(`child exceeded its ${String(plan.timeoutMs)} ms window`);
      }
      throw new CodexRoleBoundaryError(`wrapper received ${outcome.cause}`);
    }
    if (outcome.kind === "failed") throw outcome.error;
    const result =
      correlationId !== undefined
        ? observedCodexRoleBoundaryResult(outcome.stdout, plan, correlationId, outcome.exitStatus)
        : interceptCodexRoleBoundaryResult(outcome.stdout, plan.expectedHandle);
    const ownedSettlement = await settle();
    if (ownedSettlement.gate.signaled.length > 0) {
      throw new CodexRoleBoundaryError(
        "live registered gate at child completion",
        boundaryDiagnostic(
          observeCodexRoleBoundaryStream(outcome.stdout, plan.expectedHandle),
          "live-gate-at-completion",
          "unsettled-full-gate-at-completion",
        ),
      );
    }
    return result;
  } catch (error) {
    try {
      await settle();
    } catch (settlementError) {
      throw new AggregateError(
        [error, settlementError],
        "Codex role boundary failed and process-group settlement failed",
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
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
  const executable = await realpath(requiredString(request.executable, "executable"));
  if (!executable.startsWith("/nix/store/") || path.basename(executable) !== "cq-codex-role") {
    throw new CodexRoleBoundaryError(
      `provider gate requires an installed Nix cq-codex-role; got ${JSON.stringify(executable)}`,
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
        request.invocation.gitConflictCapability !== undefined)) ||
    (roleId === "implement-conflict-resolver" &&
      (request.invocation.gitConflictCapability === undefined ||
        request.invocation.gitChangeCapability !== undefined))
  ) {
    throw new CodexRoleBoundaryError(
      `provider gate ${roleId} did not receive exactly its role-scoped Git capability`,
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

  const invocationJson = JSON.stringify(request.invocation);
  const child = Bun.spawn([executable], {
    cwd: request.managedHandle.absolutePath,
    env: {
      ...process.env,
      ...request.environment,
      CQ_CODEX_ROLE_CORRELATION_ID: request.correlationId,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(`${invocationJson}\n`);
  child.stdin.end();
  const [exitStatus, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
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
