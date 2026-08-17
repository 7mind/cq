#!/usr/bin/env -S bun run

import { appendFile, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { createProcessWorksetEffectAdmissionProvider } from "@cq/process-control";
import {
  assertCodexBoundaryEffectTargetRef,
  assertCodexDispatchedRoleId,
  CODEX_PRETURN_OBSERVATION_PATH_ENV,
  CodexRoleBoundaryError,
  createCodexRoleBoundaryPlan,
  executeCodexParentGateFinalizer,
  executeCodexRoleBoundary,
  formatCodexRoleBoundaryDiagnostic,
  loadConfig,
  resolveCodexRoleSandboxPolicy,
  WORKSET_CREDENTIAL_ENV_NAMES,
  type CodexRoleBoundaryDiagnostic,
  type CodexRoleBoundaryInvocation,
} from "../src/index.js";
import { readOneBoundedNewlineTerminatedRequest } from "../src/codexRoleRequestFraming.js";

const PROMPT_ROOT_ENV = "CQ_PROMPT_ROOT";
const LEDGER_COMMAND_ENV = "CQ_CODEX_LEDGER_COMMAND";
const CODEX_EXECUTABLE_ENV = "CQ_CODEX_EXECUTABLE";
function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`codex-role-dispatch: ${name} must name the packaged Codex prompt root`);
  }
  return value;
}

function boundaryDiagnosticFromError(
  error: unknown,
): CodexRoleBoundaryDiagnostic | undefined {
  if (error instanceof CodexRoleBoundaryError) return error.diagnostic;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const diagnostic = boundaryDiagnosticFromError(nested);
      if (diagnostic !== undefined) return diagnostic;
    }
  }
  return undefined;
}

export async function main(): Promise<void> {
  const inheritedCredential = WORKSET_CREDENTIAL_ENV_NAMES.find(
    (name) => process.env[name] !== undefined,
  );
  if (inheritedCredential !== undefined) {
    throw new Error("codex-role-dispatch: inherited ledger credentials");
  }
  const request = await readOneBoundedNewlineTerminatedRequest(process.stdin);
  let parsed: unknown;
  try {
    parsed = JSON.parse(request);
  } catch {
    throw new Error("codex-role-dispatch: request must contain one valid JSON object");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("codex-role-dispatch: request must contain one valid JSON object");
  }
  const wireInvocation = parsed as CodexRoleBoundaryInvocation;
  const { effectTargetRef: untrustedEffectTargetRef, ...invocation } = wireInvocation;
  const effectTargetRef = assertCodexBoundaryEffectTargetRef(untrustedEffectTargetRef);
  const roleId = assertCodexDispatchedRoleId(invocation.roleId);
  const promptRoot = requiredEnvironment(PROMPT_ROOT_ENV);
  const roleInstructions = await readFile(
    path.join(promptRoot, "roles", `${roleId}.md`),
    "utf8",
  );
  const boundaryRequest = {
    ...invocation,
    roleId,
    roleInstructions,
    promptRoot,
    ledgerCommand: process.env[LEDGER_COMMAND_ENV] ?? "cq",
    codexExecutable: process.env[CODEX_EXECUTABLE_ENV] ?? "codex",
  };
  const requestedPlan = createCodexRoleBoundaryPlan(boundaryRequest);
  const config = loadConfig(requestedPlan.effectivePreturn.ledgerCwd);
  const sandboxPolicy = resolveCodexRoleSandboxPolicy(
    requestedPlan.sandboxMode,
    config?.dispatch.unsafeDisableCodexReadOnlySandbox ?? false,
  );
  const plan = sandboxPolicy.readOnlySandboxSuppressed
    ? createCodexRoleBoundaryPlan({
        ...boundaryRequest,
        sandboxMode: sandboxPolicy.effectiveMode,
      })
    : requestedPlan;
  if (sandboxPolicy.readOnlySandboxSuppressed) {
    process.stderr.write(
      "codex-role-dispatch: warning: [dispatch] unsafeDisableCodexReadOnlySandbox=true; " +
        `${roleId} requested read-only but will run with danger-full-access\n`,
    );
  }
  const observationPath = process.env[CODEX_PRETURN_OBSERVATION_PATH_ENV];
  if (observationPath !== undefined) {
    await writeFile(observationPath, `${JSON.stringify(plan.effectivePreturn)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  }
  const correlationId = process.env["CQ_CODEX_ROLE_CORRELATION_ID"];
  if (observationPath !== undefined && (correlationId === undefined || correlationId.trim() === "")) {
    throw new Error("codex-role-dispatch: runner observation requires a correlation id");
  }
  const worksetEffect = {
    provider: createProcessWorksetEffectAdmissionProvider({
      command: process.env[LEDGER_COMMAND_ENV] ?? "cq",
      args: ["__workset-effect-provider", "--cwd", invocation.ledgerCwd],
      cwd: invocation.ledgerCwd,
      env: process.env,
    }),
    targetRef: effectTargetRef,
  };
  const execution =
    correlationId === undefined
      ? await executeCodexRoleBoundary(plan, worksetEffect)
      : await executeCodexRoleBoundary(plan, correlationId, undefined, worksetEffect);
  const handle = "observation" in execution ? execution.handle : execution;
  if (roleId === "implement-worker") {
    if (invocation.parentGateCapability === undefined) {
      throw new Error("codex-role-dispatch: implement-worker requires parent gate authority");
    }
    await executeCodexParentGateFinalizer({
      command: process.env[LEDGER_COMMAND_ENV] ?? "cq",
      ledgerCwd: invocation.ledgerCwd,
      promptRoot,
      handle,
      parentGateCapability: invocation.parentGateCapability,
      timeoutMs: plan.effectivePreturn.parentGateWindowMs,
    });
  }
  if (observationPath !== undefined && "observation" in execution) {
    await appendFile(
      observationPath,
      `${JSON.stringify({
        kind: "cq-codex-effective-outcome",
        version: 1,
        handle: execution.handle,
        observedFailureControls: execution.observedFailureControls,
      })}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(handle)}\n`);
}

const meta = import.meta as unknown as { main?: boolean };
if (meta.main === true) {
  void main().catch((error: unknown) => {
    const diagnostic = boundaryDiagnosticFromError(error);
    if (diagnostic !== undefined) {
      process.stderr.write(`${formatCodexRoleBoundaryDiagnostic(diagnostic)}\n`);
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
