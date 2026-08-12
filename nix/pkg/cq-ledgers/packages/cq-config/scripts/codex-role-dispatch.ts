#!/usr/bin/env -S bun run

import { appendFile, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  assertCodexDispatchedRoleId,
  CODEX_PRETURN_OBSERVATION_PATH_ENV,
  CodexRoleBoundaryError,
  createCodexRoleBoundaryPlan,
  executeCodexRoleBoundary,
  formatCodexRoleBoundaryDiagnostic,
  type CodexRoleBoundaryDiagnostic,
  type CodexRoleBoundaryInvocation,
} from "../src/index.js";

const PROMPT_ROOT_ENV = "CQ_PROMPT_ROOT";
const LEDGER_COMMAND_ENV = "CQ_CODEX_LEDGER_COMMAND";
const CODEX_EXECUTABLE_ENV = "CQ_CODEX_EXECUTABLE";
const MAX_ROLE_REQUEST_BYTES = 64 * 1024;

/**
 * The role request arrives through a PTY-backed pipe in installed dispatches.
 * A complete line is sufficient authority to construct the boundary; waiting
 * for EOF lets a still-open PTY turn a valid request into a deadlock. Bound the
 * accepted line before JSON parsing so malformed peers cannot retain an
 * unbounded capability-bearing buffer.
 */
export async function readOneBoundedNewlineTerminatedRequest(
  input: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  return await new Promise<string>((resolveRequest, rejectRequest) => {
    let buffered = Buffer.alloc(0);
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      callback();
    };
    const fail = (message: string): void => settle(() => rejectRequest(new Error(message)));
    const onData = (chunk: Buffer | string): void => {
      const next = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const newline = next.indexOf(0x0a);
      if (newline < 0) {
        if (next.length > MAX_ROLE_REQUEST_BYTES) {
          fail(`codex-role-dispatch: request exceeds ${String(MAX_ROLE_REQUEST_BYTES)} bytes before newline`);
          return;
        }
        buffered = next;
        return;
      }
      if (newline > MAX_ROLE_REQUEST_BYTES) {
        fail(`codex-role-dispatch: request exceeds ${String(MAX_ROLE_REQUEST_BYTES)} bytes before newline`);
        return;
      }
      const line = next.subarray(0, newline);
      if (line.length > 0 && line[line.length - 1] === 0x0d) {
        fail("codex-role-dispatch: request must use newline, not CRLF framing");
        return;
      }
      settle(() => resolveRequest(line.toString("utf8")));
    };
    const onEnd = (): void => fail("codex-role-dispatch: request ended before a newline-terminated JSON value");
    const onError = (error: Error): void => settle(() => rejectRequest(error));
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
  });
}

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
  const invocation = JSON.parse(await readOneBoundedNewlineTerminatedRequest()) as CodexRoleBoundaryInvocation;
  const roleId = assertCodexDispatchedRoleId(invocation.roleId);
  const promptRoot = requiredEnvironment(PROMPT_ROOT_ENV);
  const roleInstructions = await readFile(
    path.join(promptRoot, "roles", `${roleId}.md`),
    "utf8",
  );
  const plan = createCodexRoleBoundaryPlan({
    ...invocation,
    roleId,
    roleInstructions,
    promptRoot,
    ledgerCommand: process.env[LEDGER_COMMAND_ENV] ?? "cq",
    codexExecutable: process.env[CODEX_EXECUTABLE_ENV] ?? "codex",
  });
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
  const execution = await executeCodexRoleBoundary(plan, correlationId);
  const handle = "observation" in execution ? execution.handle : execution;
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
