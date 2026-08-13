import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import {
  CODEX_ROLE_BOUNDARY_DIAGNOSTIC_PREFIX,
  CodexRoleBoundaryError,
  interceptCodexRoleBoundaryResult,
  type CodexRoleBoundaryDiagnostic,
} from "@cq/config";

const HANDLE = {
  attestationId: "att_0123456789abcdefghijklmnopqrstuvwxyz",
  generation: 3,
} as const;
const DISPATCH_SCRIPT = fileURLToPath(
  new URL("../scripts/codex-role-dispatch.ts", import.meta.url),
);
const FINAL_NARRATIVE_SENTINEL = "FINAL_NARRATIVE_SENTINEL";
const RESULT_BODY_SENTINEL = "RESULT_BODY_SENTINEL";
const CAPABILITY_SENTINEL = "CAPABILITY_SENTINEL";
const STREAM_CONTENT_SENTINEL = "STREAM_CONTENT_SENTINEL";
const MALFORMED_JSONL_SENTINEL = "MALFORMED_JSONL_STREAM_SENTINEL";

function completedAgentMessage(text: string): string {
  return JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text },
  });
}

function storedResultToolEvent(): string {
  return JSON.stringify({
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "ledger",
      tool: "store_result",
      arguments: {
        output: RESULT_BODY_SENTINEL,
        resultCapability: CAPABILITY_SENTINEL,
      },
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              state: "result-stored",
              result: {
                state: "result-stored",
                ...HANDLE,
                storedAt: "2026-08-02T19:00:00.000Z",
                outputDigest: "sha256:stored-result",
              },
            }),
          },
        ],
        structured_content: null,
      },
      error: null,
      status: "completed",
    },
  });
}

function captureBoundaryError(jsonl: string): CodexRoleBoundaryError {
  try {
    interceptCodexRoleBoundaryResult(jsonl, HANDLE);
  } catch (error) {
    expect(error).toBeInstanceOf(CodexRoleBoundaryError);
    return error as CodexRoleBoundaryError;
  }
  throw new Error("expected Codex role boundary rejection");
}

function expectNoBoundaryContent(value: unknown): void {
  const rendered = JSON.stringify(value);
  for (const sentinel of [
    FINAL_NARRATIVE_SENTINEL,
    RESULT_BODY_SENTINEL,
    CAPABILITY_SENTINEL,
    STREAM_CONTENT_SENTINEL,
    MALFORMED_JSONL_SENTINEL,
    HANDLE.attestationId,
    "att_wrong",
  ]) {
    expect(rendered).not.toContain(sentinel);
  }
}

describe("T1628 Codex boundary diagnostics", () => {
  test("retains a typed bounded diagnostic without retaining boundary content", () => {
    const finalMessage = FINAL_NARRATIVE_SENTINEL;
    const jsonl = [
      MALFORMED_JSONL_SENTINEL,
      completedAgentMessage(finalMessage),
    ].join("\n");

    const observed = captureBoundaryError(jsonl);
    expect(observed).toMatchObject({
      diagnostic: {
        version: 1,
        verdict: "unparseable",
        detailCode: "invalid-json",
        finalMessageByteLength: Buffer.byteLength(finalMessage),
        finalMessageSha256: createHash("sha256").update(finalMessage).digest("hex"),
        completedAgentMessageCount: 1,
        malformedJsonlCount: 1,
        matchingResultStoredAcknowledgementPresent: false,
      },
    });
    expectNoBoundaryContent(observed);
  });

  test("records a matching stored acknowledgement before an unsupported final", () => {
    const unsupportedFinal = JSON.stringify({
      ...HANDLE,
      narrative: FINAL_NARRATIVE_SENTINEL,
      output: RESULT_BODY_SENTINEL,
      capability: CAPABILITY_SENTINEL,
      stream: STREAM_CONTENT_SENTINEL,
    });
    const observed = captureBoundaryError(
      [
        MALFORMED_JSONL_SENTINEL,
        completedAgentMessage("intermediate message"),
        storedResultToolEvent(),
        completedAgentMessage(unsupportedFinal),
      ].join("\n"),
    );

    expect(observed.diagnostic).toEqual({
      version: 1,
      verdict: "echo",
      detailCode: "surplus-fields",
      finalMessageByteLength: Buffer.byteLength(unsupportedFinal),
      finalMessageSha256: createHash("sha256").update(unsupportedFinal).digest("hex"),
      completedAgentMessageCount: 2,
      malformedJsonlCount: 1,
      matchingResultStoredAcknowledgementPresent: true,
    });
    expectNoBoundaryContent(observed);
  });

  test("reduces wrong handles and missing messages to closed codes", () => {
    const wrongHandle = JSON.stringify({ attestationId: "att_wrong", generation: 19 });
    const wrong = captureBoundaryError(completedAgentMessage(wrongHandle));
    expect(wrong.diagnostic).toMatchObject({
      verdict: "wrong-handle",
      detailCode: "mismatched-handle",
      completedAgentMessageCount: 1,
      malformedJsonlCount: 0,
      matchingResultStoredAcknowledgementPresent: false,
    });
    expectNoBoundaryContent(wrong);

    const missing = captureBoundaryError(MALFORMED_JSONL_SENTINEL);
    expect(missing.diagnostic).toEqual({
      version: 1,
      verdict: "no-completed-message",
      detailCode: "no-completed-agent-message",
      finalMessageByteLength: 0,
      finalMessageSha256: createHash("sha256").update("").digest("hex"),
      completedAgentMessageCount: 0,
      malformedJsonlCount: 1,
      matchingResultStoredAcknowledgementPresent: false,
    });
    expectNoBoundaryContent(missing);
  });

  test("counts syntactically valid non-event JSON without escaping a raw TypeError", () => {
    const observed = captureBoundaryError(
      ["null", completedAgentMessage(FINAL_NARRATIVE_SENTINEL)].join("\n"),
    );
    expect(observed.diagnostic).toMatchObject({
      verdict: "unparseable",
      detailCode: "invalid-json",
      completedAgentMessageCount: 1,
      malformedJsonlCount: 1,
      matchingResultStoredAcknowledgementPresent: false,
    });
    expectNoBoundaryContent(observed);
  });

  test("preserves the valid one-line handle contract without a diagnostic", () => {
    expect(
      interceptCodexRoleBoundaryResult(
        [storedResultToolEvent(), completedAgentMessage(HANDLE.attestationId)].join("\n"),
        HANDLE,
      ),
    ).toEqual(HANDLE);
  });

  test("cq-codex-role emits exactly one canonical machine-readable diagnostic line", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-codex-boundary-diagnostic-"));
    try {
      const worktree = join(root, "worktree");
      const promptRoot = join(root, "prompts");
      const fakeCodex = join(root, "fake-codex");
      await mkdir(worktree);
      await mkdir(join(promptRoot, "roles"), { recursive: true });
      const git = spawnSync("git", ["init", "--quiet", worktree], { encoding: "utf8" });
      if (git.status !== 0) throw new Error(`git init failed: ${git.stderr}`);
      await writeFile(join(promptRoot, "roles", "implement-worker.md"), "Store one result.\n");
      await writeFile(
        fakeCodex,
        `#!/bin/sh\nprintf '%s\\n' 'null' '${completedAgentMessage(FINAL_NARRATIVE_SENTINEL)}'\n`,
      );
      await chmod(fakeCodex, 0o700);
      const child = Bun.spawn([process.execPath, "run", DISPATCH_SCRIPT], {
        cwd: worktree,
        env: {
          ...process.env,
          CQ_PROMPT_ROOT: promptRoot,
          CQ_CODEX_EXECUTABLE: fakeCodex,
          CQ_CODEX_LEDGER_COMMAND: "cq-not-invoked-by-fake",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      child.stdin.write(`${JSON.stringify({
        roleId: "implement-worker",
        handle: HANDLE,
        inputCapability: { scope: "fetch-input", token: CAPABILITY_SENTINEL },
        resultCapability: { scope: "store-result", token: CAPABILITY_SENTINEL },
        cwd: worktree,
        ledgerCwd: worktree,
        model: "fake-model",
        reasoningEffort: "high",
        sandboxMode: "danger-full-access",
        timeoutMs: 10_000,
      })}\n`);
      child.stdin.end();
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      const diagnosticLines = stderr
        .split("\n")
        .filter((line) => line.startsWith(CODEX_ROLE_BOUNDARY_DIAGNOSTIC_PREFIX));
      expect(diagnosticLines).toHaveLength(1);
      const diagnostic = JSON.parse(
        diagnosticLines[0]!.slice(CODEX_ROLE_BOUNDARY_DIAGNOSTIC_PREFIX.length),
      ) as CodexRoleBoundaryDiagnostic;
      expect(Object.keys(diagnostic)).toEqual([
        "version",
        "verdict",
        "detailCode",
        "finalMessageByteLength",
        "finalMessageSha256",
        "completedAgentMessageCount",
        "malformedJsonlCount",
        "matchingResultStoredAcknowledgementPresent",
      ]);
      expect(diagnostic).toMatchObject({
        version: 1,
        verdict: "unparseable",
        detailCode: "invalid-json",
        completedAgentMessageCount: 1,
        malformedJsonlCount: 1,
        matchingResultStoredAcknowledgementPresent: false,
      });
      expect(stderr).not.toContain(FINAL_NARRATIVE_SENTINEL);
      expect(stderr).not.toContain(CAPABILITY_SENTINEL);
      expect(stderr).not.toContain(HANDLE.attestationId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
