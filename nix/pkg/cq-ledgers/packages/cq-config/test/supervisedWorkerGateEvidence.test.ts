/**
 * T2081 / D323 regression: a Codex brokered worker cannot run the registered
 * full gate across the workspace-write process boundary. The trusted host must
 * attach exact-tip supervised-gate evidence before the pass becomes consumable.
 */
import { describe, expect, test } from "bun:test";
import { implementWorkerSidecar, validateAgainstSchema } from "@cq/config";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const DIGEST = "c".repeat(64);
const CANONICAL_GATE =
  'cq gate run --worktree "$PWD" --command-cwd "$PWD/nix/pkg/cq-ledgers" -- bun run check';

function supervisedGateEvidence(overrides: Record<string, unknown> = {}) {
  return {
    kind: "cq-supervised-gate-evidence",
    version: 1,
    attestationId: `att_${"A".repeat(32)}`,
    generation: 1,
    roleId: "implement-worker",
    roleVersion: 7,
    surface: "codex",
    promptDigest: DIGEST,
    catalogHash: DIGEST,
    inputDigest: DIGEST,
    taskId: "T2081",
    worktreePath: "/tmp/repository/.claude/worktrees/T2081",
    branch: "implement/T2081",
    baseCommit: SHA_A,
    startingCommit: SHA_A,
    resultCommit: SHA_B,
    clean: true,
    command: CANONICAL_GATE,
    gateExitCode: 0,
    passCount: 12,
    failCount: 0,
    gateDurationMs: 4_321,
    capturedAt: "2026-08-12T20:00:00.000Z",
    filesTouchedDigest: DIGEST,
    gitReceiptsDigest: DIGEST,
    mutationTableDigest: DIGEST,
    ...overrides,
  };
}

function workerPass(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "T2081",
    status: "pass",
    resultCommit: SHA_B,
    branch: "implement/T2081",
    actualWorktreePath: "/tmp/repository/.claude/worktrees/T2081",
    filesTouched: ["packages/cq-config/src/schemas/implement-worker.ts"],
    gitReceipts: [
      {
        kind: "cq-git-change-receipt",
        version: 1,
        attestationId: `att_${"A".repeat(32)}`,
        generation: 1,
        taskId: "T2081",
        operationId: "implementation",
        requestDigest: DIGEST,
        oldHead: SHA_A,
        newHead: SHA_B,
        tree: SHA_B,
        objectOids: [SHA_B],
        paths: ["packages/cq-config/src/schemas/implement-worker.ts"],
        committedAt: "2026-08-12T19:59:00.000Z",
      },
    ],
    checkSummary: "runner-supervised gate attached by store_result",
    baseVerification: {
      status: "verified",
      relation: "descendant",
      baseCommit: SHA_A,
      headCommit: SHA_B,
    },
    summary: "Exact-tip supervised gate passed.",
    supervisedGateEvidence: supervisedGateEvidence(),
    ...overrides,
  };
}

describe("T2081 implement-worker supervised-gate evidence schema [BA]", () => {
  test("accepts the complete versioned runner-owned arm without an in-child duration", () => {
    expect(validateAgainstSchema(implementWorkerSidecar.outputSchema, workerPass())).toEqual({
      ok: true,
    });
  });

  test("retains the existing in-child gate arm", () => {
    const pass = workerPass({ gateDurationMs: 4_321 }) as Record<string, unknown>;
    delete pass.supervisedGateEvidence;
    expect(validateAgainstSchema(implementWorkerSidecar.outputSchema, pass)).toEqual({ ok: true });
  });

  test("rejects incomplete or red supervised evidence", () => {
    const incomplete = supervisedGateEvidence() as Record<string, unknown>;
    delete incomplete.promptDigest;
    expect(
      validateAgainstSchema(
        implementWorkerSidecar.outputSchema,
        workerPass({ supervisedGateEvidence: incomplete }),
      ).ok,
    ).toBe(false);
    expect(
      validateAgainstSchema(
        implementWorkerSidecar.outputSchema,
        workerPass({ supervisedGateEvidence: supervisedGateEvidence({ gateExitCode: 1 }) }),
      ).ok,
    ).toBe(false);
    expect(
      validateAgainstSchema(
        implementWorkerSidecar.outputSchema,
        workerPass({ supervisedGateEvidence: supervisedGateEvidence({ passCount: 0 }) }),
      ).ok,
    ).toBe(false);
  });

  test("rejects role, command, and dirty-tree substitutions at the shape boundary", () => {
    for (const substitution of [
      { roleId: "implement-reviewer" },
      { command: "bun run check" },
      { clean: false },
    ]) {
      expect(
        validateAgainstSchema(
          implementWorkerSidecar.outputSchema,
          workerPass({ supervisedGateEvidence: supervisedGateEvidence(substitution) }),
        ).ok,
      ).toBe(false);
    }
  });
});
