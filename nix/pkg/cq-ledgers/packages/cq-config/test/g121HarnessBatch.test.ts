/**
 * T2013 / T1307+T1308+T1309 (G121 harness batch).
 *
 * Behavioral-Active Blackbox-Atomic against the public sidecars plus
 * Blackbox-GoodCommunication prompt guards against the asset sources.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  IMPLEMENT_WORKER_BASE_UNRESOLVABLE_REASONS,
  IMPLEMENT_REVIEWER_BASE_ANCESTRY_UNRESOLVABLE_REASONS,
  IMPLEMENT_REVIEWER_RESULT_COMMIT_UNRESOLVABLE_REASONS,
  implementReviewerSidecar,
  implementWorkerSidecar,
  validateAgainstSchema,
} from "@cq/config";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const WORKER_AGENT = path.join(REPO_ROOT, "nix/pkg/cq-assets/agents/implement-worker.md");
const REVIEWER_AGENT = path.join(REPO_ROOT, "nix/pkg/cq-assets/agents/implement-reviewer.md");
const REVIEW_MIRROR = path.join(REPO_ROOT, "nix/pkg/cq-assets/commands/cq/implement-review.md");
const ADVANCE_CMD = path.join(REPO_ROOT, "nix/pkg/cq-assets/commands/cq/implement/advance.md");
const FRAGMENTS = [
  path.join(REPO_ROOT, "nix/pkg/cq-assets/fragments/claude/implement-dispatch-workflow.md"),
  path.join(REPO_ROOT, "nix/pkg/cq-assets/fragments/codex/implement-dispatch-workflow.md"),
  path.join(REPO_ROOT, "nix/pkg/cq-assets/fragments/pi/implement-dispatch-workflow.md"),
] as const;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function workerInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: "T1307",
    acceptance: "round + baseVerification contract",
    branch: "implement/T1307",
    baseCommit: SHA_A,
    round: 0,
    startingCommit: SHA_B,
    ...overrides,
  };
}

function verifiedBase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "verified",
    relation: "descendant",
    baseCommit: SHA_A,
    headCommit: SHA_C,
    ...overrides,
  };
}

function workerPass(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: "T1307",
    status: "pass",
    resultCommit: SHA_C,
    branch: "implement/T1307",
    actualWorktreePath: "/tmp/project/.claude/worktrees/T1307",
    filesTouched: ["nix/pkg/cq-assets/agents/implement-worker.md"],
    checkSummary: "REAL_CHECK_EXIT=0",
    summary: "ok",
    gateDurationMs: 1000,
    baseVerification: verifiedBase(),
    ...overrides,
  };
}

function reviewerApprove(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: "T1308",
    verdict: "approve",
    criticism: [],
    questions: [],
    defects: [],
    rationale: "commit object + ancestry verified",
    gateReRan: true,
    resultCommitVerified: true,
    resultCommitEvidence: {
      status: "verified",
      resultCommit: SHA_C,
      branchTip: SHA_C,
    },
    baseAncestry: {
      status: "verified",
      relation: "descendant",
      baseCommit: SHA_A,
      resultCommit: SHA_C,
      mergeBase: SHA_A,
    },
    gateDurationMs: 2000,
    ...overrides,
  };
}

describe("T1307 implement-worker round + baseVerification [BA]", () => {
  test("round is required on the final worker input and reaches schema validation", () => {
    expect(validateAgainstSchema(implementWorkerSidecar.inputSchema, workerInput()).ok).toBe(true);
    const missing = workerInput();
    delete missing.round;
    const result = validateAgainstSchema(implementWorkerSidecar.inputSchema, missing);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.params.missingProperty === "round")).toBe(true);
    }
  });

  test("all commit fields require full object SHAs", () => {
    expect(
      validateAgainstSchema(
        implementWorkerSidecar.inputSchema,
        workerInput({ baseCommit: "deadbeef" }),
      ).ok,
    ).toBe(false);
    expect(
      validateAgainstSchema(
        implementWorkerSidecar.inputSchema,
        workerInput({ startingCommit: "abc" }),
      ).ok,
    ).toBe(false);
    expect(
      validateAgainstSchema(
        implementWorkerSidecar.inputSchema,
        workerInput({ priorResultCommit: "notasha" }),
      ).ok,
    ).toBe(false);
    expect(
      validateAgainstSchema(
        implementWorkerSidecar.inputSchema,
        workerInput({ round: 1, priorResultCommit: SHA_B }),
      ).ok,
    ).toBe(true);
  });

  test("pass rejects absent or unresolvable baseVerification", () => {
    const missing = workerPass();
    delete missing.baseVerification;
    expect(validateAgainstSchema(implementWorkerSidecar.outputSchema, missing).ok).toBe(false);

    expect(
      validateAgainstSchema(
        implementWorkerSidecar.outputSchema,
        workerPass({
          baseVerification: {
            status: "unresolvable",
            reason: "base-missing",
            baseCommit: null,
            headCommit: null,
          },
        }),
      ).ok,
    ).toBe(false);

    expect(
      validateAgainstSchema(
        implementWorkerSidecar.outputSchema,
        workerPass({
          baseVerification: {
            status: "verified",
            relation: "descendant",
            baseCommit: "short",
            headCommit: SHA_C,
          },
        }),
      ).ok,
    ).toBe(false);
  });

  test("fail represents every closed unresolvable reason without a fabricated SHA", () => {
    for (const reason of IMPLEMENT_WORKER_BASE_UNRESOLVABLE_REASONS) {
      const payload = workerPass({
        status: "fail",
        resultCommit: null,
        blockedReason: reason,
        baseVerification: {
          status: "unresolvable",
          reason,
          baseCommit: null,
          headCommit: null,
        },
      });
      delete payload.gateDurationMs;
      expect(validateAgainstSchema(implementWorkerSidecar.outputSchema, payload).ok, reason).toBe(
        true,
      );
    }
    const fabricated = workerPass({
      status: "fail",
      resultCommit: null,
      blockedReason: "x",
      baseVerification: {
        status: "unresolvable",
        reason: "base-missing",
        baseCommit: "not-a-real-sha",
        headCommit: null,
      },
    });
    delete fabricated.gateDurationMs;
    expect(validateAgainstSchema(implementWorkerSidecar.outputSchema, fabricated).ok).toBe(false);
  });

  test("sidecar version advanced for the T1307 contract mutation", () => {
    expect(implementWorkerSidecar.version).toBe(8);
  });
});

describe("T1307 implement-worker prompt Step 0 [BG]", () => {
  test("Step 0 is evidence-only; forbids install/reset/rebase/worktree lifecycle", () => {
    const body = readFileSync(WORKER_AGENT, "utf8");
    expect(body).toContain("Step 0 — verify prepared evidence only");
    expect(body).toContain("baseVerification");
    expect(body).toContain("priorResultCommit");
    expect(body).toContain("round > 0");
    expect(body).toContain("Never hard-reset or rebase away from prior criticism commits");
    expect(body).toMatch(/Do not install workspace\s+dependencies/);
    expect(body).not.toMatch(/\brun `bun install`/);
    expect(body).not.toContain("git worktree add ");
    expect(body).not.toContain("git worktree remove");
    expect(body).toContain("Early skeleton write (load-bearing durability)");
    expect(body).toContain("WIP-<taskId>.md");
  });
});

describe("T1308 implement-reviewer resultCommit + baseAncestry [BA]", () => {
  test("approve requires verified resultCommitEvidence and baseAncestry with full SHAs", () => {
    expect(validateAgainstSchema(implementReviewerSidecar.outputSchema, reviewerApprove()).ok).toBe(
      true,
    );

    expect(
      validateAgainstSchema(
        implementReviewerSidecar.outputSchema,
        reviewerApprove({
          resultCommitEvidence: {
            status: "unresolvable",
            reason: "branch-tip-mismatch",
            resultCommit: SHA_C,
            branchTip: SHA_B,
          },
        }),
      ).ok,
    ).toBe(false);

    expect(
      validateAgainstSchema(
        implementReviewerSidecar.outputSchema,
        reviewerApprove({
          baseAncestry: {
            status: "unresolvable",
            reason: "not-ancestor",
            baseCommit: SHA_A,
            resultCommit: SHA_C,
            mergeBase: null,
          },
        }),
      ).ok,
    ).toBe(false);

    expect(
      validateAgainstSchema(
        implementReviewerSidecar.outputSchema,
        reviewerApprove({
          resultCommitEvidence: {
            status: "verified",
            resultCommit: "deadbeef",
            branchTip: "deadbeef",
          },
        }),
      ).ok,
    ).toBe(false);
  });

  test("disapprove may carry unresolvable evidence with closed reasons", () => {
    for (const reason of IMPLEMENT_REVIEWER_RESULT_COMMIT_UNRESOLVABLE_REASONS) {
      expect(
        validateAgainstSchema(
          implementReviewerSidecar.outputSchema,
          reviewerApprove({
            verdict: "disapprove",
            criticism: ["result commit evidence failed"],
            resultCommitVerified: false,
            resultCommitEvidence: {
              status: "unresolvable",
              reason,
              resultCommit: null,
              branchTip: null,
            },
            baseAncestry: {
              status: "unresolvable",
              reason: "result-commit-missing",
              baseCommit: SHA_A,
              resultCommit: null,
              mergeBase: null,
            },
          }),
        ).ok,
        reason,
      ).toBe(true);
    }
    for (const reason of IMPLEMENT_REVIEWER_BASE_ANCESTRY_UNRESOLVABLE_REASONS) {
      expect(
        validateAgainstSchema(
          implementReviewerSidecar.outputSchema,
          reviewerApprove({
            verdict: "disapprove",
            criticism: ["ancestry failed"],
            baseAncestry: {
              status: "unresolvable",
              reason,
              baseCommit: reason.startsWith("base-") ? null : SHA_A,
              resultCommit: reason.includes("result-commit") ? null : SHA_C,
              mergeBase: null,
            },
          }),
        ).ok,
        reason,
      ).toBe(true);
    }
  });

  test("missing structured evidence is rejected", () => {
    const missingCommit = reviewerApprove();
    delete missingCommit.resultCommitEvidence;
    expect(validateAgainstSchema(implementReviewerSidecar.outputSchema, missingCommit).ok).toBe(
      false,
    );
    const missingAncestry = reviewerApprove();
    delete missingAncestry.baseAncestry;
    expect(validateAgainstSchema(implementReviewerSidecar.outputSchema, missingAncestry).ok).toBe(
      false,
    );
  });

  test("sidecar version advanced for the T1308 contract mutation", () => {
    expect(implementReviewerSidecar.version).toBe(7);
  });
});

describe("T1308 implement-reviewer prompt + portable mirror [BG]", () => {
  test("source prompt and portable mirror require commit object + ancestry evidence", () => {
    const agent = readFileSync(REVIEWER_AGENT, "utf8");
    const mirror = readFileSync(REVIEW_MIRROR, "utf8");
    for (const body of [agent, mirror]) {
      expect(body).toContain("resultCommitEvidence");
      expect(body).toContain("baseAncestry");
      expect(body).toContain("merge-base");
      expect(body).toContain("cat-file");
      expect(body).toContain("full SHA");
      expect(body).toContain("not-ancestor");
    }
  });
});

describe("T1309 orchestrator managed prepare/release [BG]", () => {
  test("advance prepares before wip/dispatch, retains handle, releases guarded only", () => {
    const body = readFileSync(ADVANCE_CMD, "utf8");
    expect(body).toContain("Prepare BEFORE wip and BEFORE launch");
    expect(body).toContain("worktree_manage");
    expect(body).toContain('operation: "prepare"');
    expect(body).toContain('operation: "release"');
    expect(body).toContain("resume-required");
    expect(body).toContain("Retain the opaque handle");
    expect(body).toContain("git merge --ff-only <resultCommit>");
    expect(body).not.toContain("git worktree add ");
    expect(body).not.toContain("git worktree remove");
    expect(body).not.toContain("git worktree prune");
    expect(body).toContain("never raw git worktree lifecycle");
  });

  test("T1310: main-advance requires rebase+re-gate; forged/stale results never merge", () => {
    const body = readFileSync(ADVANCE_CMD, "utf8");
    expect(body).toMatch(
      /If main has advanced past the dispatch base, rebase onto current main and rerun\s+gates \+ review before ff-only merge/,
    );
    expect(body).toContain(
      "Fabricated, missing, non-tip, stale-base, or non-ancestor result commits never",
    );
    expect(body).toContain("git merge --ff-only <resultCommit>");
    // Dependency-absent evidence blocks both dispatch and merge.
    expect(body).toMatch(/Missing or\s+unresolvable dependency/);
    expect(body).toContain("missing/unresolvable dependency evidence forbids");
  });

  test("all three harness fragments route through worktree_manage prepare/release", () => {
    for (const fragmentPath of FRAGMENTS) {
      const body = readFileSync(fragmentPath, "utf8");
      expect(body, fragmentPath).toContain("worktree_manage");
      expect(body, fragmentPath).toContain('operation: "prepare"');
      expect(body, fragmentPath).toContain('operation: "release"');
      expect(body, fragmentPath).toContain("resume-required");
      expect(body, fragmentPath).not.toContain("git worktree add ");
      expect(body, fragmentPath).not.toContain("git worktree remove");
      expect(body, fragmentPath).not.toContain("git worktree prune");
      expect(body, fragmentPath).toContain("never raw git worktree lifecycle");
    }
  });
});

describe("T1307/T1308/T1309 real-body mutation control [BG]", () => {
  test("stale worker body fails the Step-0 evidence guard; restoration recovers", () => {
    const original = readFileSync(WORKER_AGENT, "utf8");
    const before = createHash("sha256").update(original).digest("hex");
    const mutated = original.replace(
      "Step 0 — verify prepared evidence only",
      "Step 0 — INSTALL DEPS FIRST",
    );
    expect(mutated).not.toBe(original);
    writeFileSync(WORKER_AGENT, mutated);
    try {
      const body = readFileSync(WORKER_AGENT, "utf8");
      expect(body).not.toContain("Step 0 — verify prepared evidence only");
      expect(body).toContain("INSTALL DEPS FIRST");
    } finally {
      writeFileSync(WORKER_AGENT, original);
    }
    const restored = readFileSync(WORKER_AGENT, "utf8");
    const after = createHash("sha256").update(restored).digest("hex");
    expect(after).toBe(before);
    expect(restored).toContain("Step 0 — verify prepared evidence only");
  });

  test("stale advance body fails the no-raw-worktree guard; restoration recovers", () => {
    const original = readFileSync(ADVANCE_CMD, "utf8");
    const before = createHash("sha256").update(original).digest("hex");
    const forced = `${original}\n\ngit worktree add .claude/worktrees/<taskId> -b implement/<taskId> <baseCommit>\n`;
    writeFileSync(ADVANCE_CMD, forced);
    try {
      const body = readFileSync(ADVANCE_CMD, "utf8");
      expect(body).toContain("git worktree add .claude/worktrees/<taskId>");
    } finally {
      writeFileSync(ADVANCE_CMD, original);
    }
    const restored = readFileSync(ADVANCE_CMD, "utf8");
    const after = createHash("sha256").update(restored).digest("hex");
    expect(after).toBe(before);
    expect(restored).not.toContain("git worktree add .claude/worktrees/<taskId>");
    expect(restored).toContain("never raw git worktree lifecycle");
  });
});
