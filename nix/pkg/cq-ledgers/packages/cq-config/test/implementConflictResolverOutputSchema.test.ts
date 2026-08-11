import { describe, expect, test } from "bun:test";
import { implementConflictResolverSidecar, validateAgainstSchema } from "../src/index.js";
import { TEST_GIT_CONFLICT_STATE } from "./fixtures/gitConflictState.js";

const OID = "a".repeat(40);

function receipt() {
  return {
    kind: "cq-git-conflict-continuation-receipt",
    version: 1,
    attestationId: "cq_attest_BBBBBBBBBBBBBBBBBBBBBB",
    generation: 1,
    taskId: "T2043",
    operationId: "T2043-resolution-1",
    requestDigest: "b".repeat(64),
    oldHead: OID,
    newHead: "c".repeat(40),
    objectOids: ["d".repeat(40)],
    paths: ["a.txt"],
    outcome: {
      kind: "conflict",
      tip: "c".repeat(40),
      state: { ...TEST_GIT_CONFLICT_STATE, currentHead: "c".repeat(40) },
    },
    continuedAt: "2026-08-11T00:00:00.000Z",
  };
}

function failOutput(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    taskId: "T2043",
    status: "fail",
    resultCommit: null,
    branch: "implement/T2043",
    actualWorktreePath: "/tmp/t2043-worktree",
    filesResolved: ["a.txt"],
    conflictReceipts: [receipt()],
    checkSummary: "continuation stopped at the next conflict",
    summary: "the durable first step must remain attributable",
    blockedReason: "the next resolution could not be produced",
    ...overrides,
  };
}

describe("implement-conflict-resolver status-dependent output evidence", () => {
  test("fail cannot omit the branch, worktree, or durable receipt chain", () => {
    const output = failOutput();
    delete output.branch;
    delete output.actualWorktreePath;
    delete output.conflictReceipts;
    expect(validateAgainstSchema(implementConflictResolverSidecar.outputSchema, output).ok).toBe(
      false,
    );
  });

  test("fail requires null resultCommit and blockedReason", () => {
    expect(
      validateAgainstSchema(
        implementConflictResolverSidecar.outputSchema,
        failOutput({ resultCommit: OID }),
      ).ok,
    ).toBe(false);
    const output = failOutput();
    delete output.blockedReason;
    expect(validateAgainstSchema(implementConflictResolverSidecar.outputSchema, output).ok).toBe(
      false,
    );
  });

  test("pass requires a full resultCommit and forbids blockedReason", () => {
    const output = failOutput({ status: "pass" });
    delete output.blockedReason;
    expect(
      validateAgainstSchema(
        implementConflictResolverSidecar.outputSchema,
        output,
      ).ok,
    ).toBe(false);
  });

  test("fail accepts the complete nonterminal durable receipt chain", () => {
    expect(validateAgainstSchema(implementConflictResolverSidecar.outputSchema, failOutput()).ok).toBe(
      true,
    );
  });
});
