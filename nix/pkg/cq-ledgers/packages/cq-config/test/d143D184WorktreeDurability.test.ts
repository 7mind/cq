/**
 * T2010 — D143 (optional worktreePath + required actualWorktreePath) and
 * D184 (early skeleton + incremental persistence + harvest/resume).
 *
 * Behavioral-Active Blackbox-Atomic against the public sidecars and
 * Blackbox-GoodCommunication prompt/grep guards against the asset sources.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  CLAUDE_WORKTREE_INPUT_PROPERTY,
  CLAUDE_WORKTREE_OUTPUT_PROPERTY,
  implementConflictResolverSidecar,
  implementReviewerSidecar,
  implementWorkerSidecar,
  validateAgainstSchema,
} from "@cq/config";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const WORKER_AGENT = path.join(REPO_ROOT, "nix/pkg/cq-assets/agents/implement-worker.md");
const ADVANCE_CMD = path.join(REPO_ROOT, "nix/pkg/cq-assets/commands/cq/implement/advance.md");

function workerInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: "T2010",
    acceptance: "D184 and D143 fixed.",
    branch: "implement/T2010",
    baseCommit: "a".repeat(40),
    round: 0,
    startingCommit: "b".repeat(40),
    ...overrides,
  };
}

function workerOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: "T2010",
    status: "pass",
    resultCommit: "c".repeat(40),
    branch: "implement/T2010",
    actualWorktreePath: "/tmp/project/.claude/worktrees/T2010",
    filesTouched: ["nix/pkg/cq-assets/agents/implement-worker.md"],
    checkSummary: "ok",
    summary: "durability + worktreePath contract",
    gateDurationMs: 1000,
    baseVerification: {
      status: "verified",
      relation: "descendant",
      baseCommit: "a".repeat(40),
      headCommit: "c".repeat(40),
    },
    ...overrides,
  };
}

describe("D143 implement-role worktreePath contract [BA]", () => {
  test("implement-worker input accepts a payload WITHOUT worktreePath", () => {
    const payload = workerInput();
    expect("worktreePath" in payload).toBe(false);
    expect(validateAgainstSchema(implementWorkerSidecar.inputSchema, payload).ok).toBe(true);
  });

  test("implement-worker input still accepts advisory worktreePath when present", () => {
    expect(
      validateAgainstSchema(
        implementWorkerSidecar.inputSchema,
        workerInput({ worktreePath: "/tmp/project/.claude/worktrees/T2010" }),
      ).ok,
    ).toBe(true);
  });

  test("implement-reviewer input accepts a payload WITHOUT worktreePath", () => {
    const payload = {
      taskId: "T2010",
      acceptance: "ok",
      branch: "implement/T2010",
      baseCommit: "a".repeat(40),
      workerResult: { resultCommit: "c".repeat(40), checkSummary: "ok", filesTouched: [] },
      round: 1,
      responseStoreNow: "2026-08-06T12:01:00.000Z",
      gateCompleteBy: "2026-08-06T12:00:00.000Z",
      synthesisStoreReserveMs: 60_000,
    };
    expect(validateAgainstSchema(implementReviewerSidecar.inputSchema, payload).ok).toBe(true);
  });

  test("implement-conflict-resolver input accepts a payload WITHOUT worktreePath", () => {
    const payload = {
      taskId: "T2010",
      branch: "implement/T2010",
      baseCommit: "a".repeat(40),
      conflictingFiles: ["a.ts"],
    };
    expect(
      validateAgainstSchema(implementConflictResolverSidecar.inputSchema, payload).ok,
    ).toBe(true);
  });

  test("implement-worker output REQUIRES actualWorktreePath", () => {
    const missing = workerOutput();
    delete missing.actualWorktreePath;
    const result = validateAgainstSchema(implementWorkerSidecar.outputSchema, missing);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.params.missingProperty === "actualWorktreePath")).toBe(
        true,
      );
    }
  });

  test("implement-worker output accepts actualWorktreePath on pass and fail", () => {
    expect(validateAgainstSchema(implementWorkerSidecar.outputSchema, workerOutput()).ok).toBe(
      true,
    );
    const failPayload = workerOutput({
      status: "fail",
      resultCommit: null,
      blockedReason:
        "worktreePath unreachable from my confined worktree (expected under .claude/worktrees/)",
    });
    delete failPayload.gateDurationMs;
    expect(validateAgainstSchema(implementWorkerSidecar.outputSchema, failPayload).ok).toBe(true);
  });

  test("sidecar versions advanced for the schema mutation (D185/T1307/T1308)", () => {
    expect(implementWorkerSidecar.version).toBeGreaterThanOrEqual(5);
    expect(implementReviewerSidecar.version).toBeGreaterThanOrEqual(6);
    expect(implementConflictResolverSidecar.version).toBeGreaterThanOrEqual(2);
  });

  test("protocol constants name the input/output path properties", () => {
    expect(CLAUDE_WORKTREE_INPUT_PROPERTY).toBe("worktreePath");
    expect(CLAUDE_WORKTREE_OUTPUT_PROPERTY).toBe("actualWorktreePath");
    const required = implementWorkerSidecar.inputSchema.required as readonly string[];
    expect(required).not.toContain("worktreePath");
    const outRequired = implementWorkerSidecar.outputSchema.required as readonly string[];
    expect(outRequired).toContain("actualWorktreePath");
  });
});

describe("D143/D184 prompt and placement guards [BG]", () => {
  test("implement-worker requires early skeleton + incremental persistence + loud mismatch", () => {
    const body = readFileSync(WORKER_AGENT, "utf8");
    expect(body).toContain("Early skeleton write (load-bearing durability)");
    expect(body).toContain("WIP-<taskId>.md");
    expect(body).toContain("<!-- cq:wip-checkpoint -->");
    expect(body).toContain("Incremental persistence");
    expect(body).toContain("todo");
    expect(body).toContain("unmeasured");
    expect(body).toContain(
      "worktreePath unreachable from my confined worktree (expected under .claude/worktrees/)",
    );
    expect(body).toContain("actualWorktreePath");
    expect(body).toContain("git rev-parse --show-toplevel");
    expect(body).toContain("2. **Implement surgically.**");
    expect(body).toContain("Step 0 — verify prepared evidence only");
    expect(body).not.toMatch(/\brun `bun install`/);
    expect(body).not.toContain("git worktree add ");
    expect(body).not.toContain("git worktree remove");
  });

  test("implement/advance uses worktree_manage prepare/release and harvest/resume", () => {
    const body = readFileSync(ADVANCE_CMD, "utf8");
    expect(body).toContain("worktree_manage");
    expect(body).toContain('operation: "prepare"');
    expect(body).toContain('operation: "release"');
    expect(body).toContain("Harvest then prefer RESUME");
    expect(body).toContain("WIP-<taskId>.md");
    expect(body).toContain("actualWorktreePath");
    expect(body).not.toContain("git worktree add ");
    expect(body).not.toContain("git worktree remove");
    expect(body).not.toContain("git worktree prune");
  });
});
