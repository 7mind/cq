import * as path from "node:path";
import {
  readProcessIdentity,
  settleProcessGroups,
  settleWorktreeGateCommands,
  type ProcessGroupRegistration,
  type SettleProcessGroupsResult,
} from "@cq/process-control";
import type {
  DispatchHandle,
  InputCapability,
  ResultCapability,
} from "./compactDispatchProtocol.js";
import { classifyCodexFinalMessage } from "./codexDispatchProtocol.js";
import { DISPATCHED_ROLE_IDS } from "./promptCatalogStore.js";
import {
  exposedLedgerToolsForRole,
  type LedgerCapabilityToolName,
} from "./roleToolProfiles.js";

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
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly expectedHandle: DispatchHandle;
  readonly ledgerMcp: CodexRoleLedgerMcpConfiguration;
  /** The child JSONL stream stays inside the adapter; only a verified handle escapes. */
  readonly interceptStdout: true;
}

export class CodexRoleBoundaryError extends Error {
  constructor(message: string) {
    super(`Codex role boundary: ${message}`);
    this.name = "CodexRoleBoundaryError";
  }
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
  readonly item?: {
    readonly type?: unknown;
    readonly text?: unknown;
  };
}

function finalAgentMessage(jsonl: string): string | undefined {
  let finalMessage: string | undefined;
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    let event: CodexExecEvent;
    try {
      event = JSON.parse(line) as CodexExecEvent;
    } catch {
      continue;
    }
    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      finalMessage = event.item.text;
    }
  }
  return finalMessage;
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
    Object.keys(candidate).length === keys.length && keys.every((key) => Object.hasOwn(candidate, key));
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
      hasExactKeys(nested, [
        "state",
        "attestationId",
        "generation",
        "storedAt",
        "outputDigest",
      ]) &&
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

/**
 * Intercept the raw Codex JSONL stream and release only the expected dispatch
 * handle. The exact fixed `result-stored` acknowledgement is projected to that
 * handle; child prose, result bodies, and other echoed output never reach the
 * caller.
 */
export function interceptCodexRoleBoundaryResult(
  jsonl: string,
  expectedHandle: DispatchHandle,
): DispatchHandle {
  const finalMessage = finalAgentMessage(jsonl);
  if (finalMessage === undefined) {
    throw new CodexRoleBoundaryError("child emitted no completed agent message");
  }
  const storedAcknowledgement = resultStoredAcknowledgementHandle(finalMessage, expectedHandle);
  if (storedAcknowledgement !== undefined) {
    return storedAcknowledgement;
  }
  const verdict = classifyCodexFinalMessage(finalMessage, expectedHandle);
  if (verdict.verdict !== "handle-only") {
    throw new CodexRoleBoundaryError(
      `child final message failed the handle-only contract (${verdict.verdict})`,
    );
  }
  return verdict.handle;
}

/**
 * Execute one already-resolved plan. Exit status remains corroborating only:
 * a valid stored-result handle wins even when Codex exits non-zero during
 * teardown, matching the compact dispatch protocol's completion semantics.
 */
export async function executeCodexRoleBoundary(
  plan: CodexRoleBoundaryPlan,
): Promise<DispatchHandle> {
  const child = Bun.spawn([...plan.argv], {
    cwd: plan.cwd,
    detached: true,
    env: process.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const rootIdentity = readProcessIdentity(child.pid).then(
    (leader): ProcessGroupRegistration | undefined =>
      leader === null ? undefined : { pgid: child.pid, leader },
  );
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

  let settlement: Promise<void> | undefined;
  const settle = (): Promise<void> => {
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
        const registration = await rootIdentity;
        if (registration !== undefined) {
          rootResult = await settleProcessGroups([registration]);
        }
      } catch (error) {
        rootError = error;
      }

      const survivors = [
        ...(gateResult?.survivors ?? []),
        ...rootResult.survivors,
      ];
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
    })();
    return settlement;
  };

  try {
    child.stdin.write(plan.stdin);
    child.stdin.end();
    return await Promise.race([
      Promise.all([
        rootIdentity,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]).then(([, stdout]) => interceptCodexRoleBoundaryResult(stdout, plan.expectedHandle)),
      stopRequested.then(async (cause) => {
        await settle();
        if (cause === "timeout") {
          throw new CodexRoleBoundaryError(
            `child exceeded its ${String(plan.timeoutMs)} ms window`,
          );
        }
        throw new CodexRoleBoundaryError(`wrapper received ${cause}`);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}
