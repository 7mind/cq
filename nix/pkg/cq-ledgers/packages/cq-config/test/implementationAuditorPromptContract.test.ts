import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  implementationAuditorSidecar,
  validateAgainstSchema,
} from "../src/index.js";

const prompt = readFileSync(
  fileURLToPath(new URL("../../../../cq-assets/agents/implementation-auditor.md", import.meta.url)),
  "utf8",
);

function input() {
  return {
    manifestId: "historical-v1",
    manifestDigest: "a".repeat(64),
    recordKey: "T10",
    taskId: "T10",
    taskRef: "tasks:T10",
    ownerGoalRef: "goals:G176",
    finalizedManifest: "exact finalized manifest",
    historicalReview: null,
    baseCommit: "b".repeat(40),
    resultCommit: "c".repeat(40),
    repositoryHead: "d".repeat(40),
    diff: "diff --git a/a b/a",
    acceptance: { clauses: ["green"] },
    gateObservations: { exitCode: 0, passCount: 1, failCount: 0 },
    auditRoster: [
      {
        alias: "native",
        harness: "codex",
        model: "frontier",
        provider: null,
        effort: null,
        launch: "native",
        adapterId: "codex:native",
      },
    ],
    requiredObservations: ["commit-retained", "gate-green"],
  };
}

describe("implementation-auditor prompt and strict sidecar [BA]", () => {
  test("accepts only the server-assembled historical record contract", () => {
    expect(validateAgainstSchema(implementationAuditorSidecar.inputSchema, input()).ok).toBe(true);
    for (const forged of [
      { ...input(), worktreePath: "/caller/worktree" },
      { ...input(), workerResult: { status: "pass" } },
      { ...input(), evidence: { callerAuthored: true } },
      { ...input(), taskRefs: ["tasks:T999"] },
    ]) {
      expect(validateAgainstSchema(implementationAuditorSidecar.inputSchema, forged).ok).toBe(false);
    }
  });

  test("requires exact ordered observation evidence for a read-only verdict", () => {
    const verdict = {
      taskId: "T10",
      verdict: "approve",
      criticism: [],
      questions: [],
      observations: [
        { name: "commit-retained", status: "verified", detail: "ancestor observed" },
        { name: "gate-green", status: "verified", detail: "green gate observed" },
      ],
      rationale: "Both required observations were verified.",
      manifestDigest: "a".repeat(64),
      baseCommit: "b".repeat(40),
      resultCommit: "c".repeat(40),
      repositoryHead: "d".repeat(40),
    };
    expect(validateAgainstSchema(implementationAuditorSidecar.outputSchema, verdict).ok).toBe(true);
    expect(
      validateAgainstSchema(implementationAuditorSidecar.outputSchema, {
        ...verdict,
        observations: [
          { name: "commit-retained", status: "not-verified", detail: "missing" },
        ],
      }).ok,
    ).toBe(false);
  });

  test("forbids repository and ledger mutations in the canonical role body", () => {
    expect(prompt).toContain("Never edit a repository, mutate a\nledger, spawn a child");
    expect(prompt).toContain("not an ordinary implement-reviewer worktree\ncontract");
    expect(prompt).toContain("caller-authored\nevidence object");
  });
});
