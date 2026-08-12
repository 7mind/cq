/**
 * T2007 / K235 — parent-attested gate for sandboxed Codex implement-reviewer.
 *
 * Covers: input-schema accept/reject for `parentGateAttestation`, the
 * `validateParentGateAttestation` helper predicates, and prompt/grep guards
 * that pin the sandbox-denied path while keeping the non-sandboxed child gate
 * re-run prose intact.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SANDBOX_DENIED_PRIMITIVES_GATE_REASON,
  implementReviewerSidecar,
  validateAgainstSchema,
  validateParentGateAttestation,
  validateSupervisedWorkerGateEvidenceForReview,
  type ParentGateAttestation,
  type ImplementWorkerSupervisedGateEvidence,
} from "@cq/config";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../../../../..");
const IMPLEMENT_REVIEWER_AGENT = resolve(
  REPOSITORY_ROOT,
  "nix/pkg/cq-assets/agents/implement-reviewer.md",
);
const IMPLEMENT_WORKER_AGENT = resolve(
  REPOSITORY_ROOT,
  "nix/pkg/cq-assets/agents/implement-worker.md",
);
const CODEX_IMPLEMENT_DISPATCH = resolve(
  REPOSITORY_ROOT,
  "nix/pkg/cq-assets/fragments/codex/implement-dispatch-workflow.md",
);
const IMPLEMENT_ADVANCE = resolve(
  REPOSITORY_ROOT,
  "nix/pkg/cq-assets/commands/cq/implement/advance.md",
);
const CLAUDE_IMPLEMENT_DISPATCH = resolve(
  REPOSITORY_ROOT,
  "nix/pkg/cq-assets/fragments/claude/implement-dispatch-workflow.md",
);
const PI_IMPLEMENT_DISPATCH = resolve(
  REPOSITORY_ROOT,
  "nix/pkg/cq-assets/fragments/pi/implement-dispatch-workflow.md",
);

const RESULT_COMMIT = "a".repeat(40);

function baseReviewerInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    taskId: "T2007",
    acceptance: "Codex sandboxed reviewer accepts a green parentGateAttestation.",
    worktreePath: "/tmp/wt-T2007",
    branch: "implement/T2007",
    baseCommit: "b".repeat(40),
    workerResult: {
      resultCommit: RESULT_COMMIT,
      checkSummary: "REAL_CHECK_EXIT=0",
      filesTouched: ["packages/cq-config/src/schemas/implement-reviewer.ts"],
    },
    round: 1,
    responseStoreNow: "2026-08-04T10:02:00.000Z",
    gateCompleteBy: "2026-08-04T10:01:00.000Z",
    synthesisStoreReserveMs: 60_000,
    ...overrides,
  };
}

function supervisedEvidence(
  overrides: Partial<ImplementWorkerSupervisedGateEvidence> = {},
): ImplementWorkerSupervisedGateEvidence {
  return {
    kind: "cq-supervised-gate-evidence",
    version: 1,
    attestationId: `att_${"A".repeat(32)}`,
    generation: 1,
    roleId: "implement-worker",
    roleVersion: 7,
    surface: "codex",
    promptDigest: "a".repeat(64),
    catalogHash: "b".repeat(64),
    inputDigest: "c".repeat(64),
    taskId: "T2007",
    worktreePath: "/tmp/wt-T2007",
    branch: "implement/T2007",
    baseCommit: "b".repeat(40),
    startingCommit: "b".repeat(40),
    resultCommit: RESULT_COMMIT,
    clean: true,
    command:
      'cq gate run --worktree "$PWD" --command-cwd "$PWD/nix/pkg/cq-ledgers" -- bun run check',
    gateExitCode: 0,
    passCount: 12,
    failCount: 0,
    gateDurationMs: 45_000,
    capturedAt: "2026-08-04T10:00:30.000Z",
    filesTouchedDigest: "d".repeat(64),
    gitReceiptsDigest: "e".repeat(64),
    mutationTableDigest: "f".repeat(64),
    ...overrides,
  };
}

function greenAttestation(
  overrides: Partial<ParentGateAttestation> = {},
): ParentGateAttestation {
  return {
    resultCommit: RESULT_COMMIT,
    gateExitCode: 0,
    passCount: 12,
    failCount: 0,
    gateDurationMs: 45_000,
    command:
      'cq gate run --worktree "$PWD" --command-cwd "$PWD/nix/pkg/cq-ledgers" -- bun run check',
    capturedAt: "2026-08-04T10:00:30.000Z",
    ...overrides,
  };
}

describe("T2007 parentGateAttestation input schema", () => {
  test("accepts a complete green parentGateAttestation [BA]", () => {
    const result = validateAgainstSchema(
      implementReviewerSidecar.inputSchema,
      baseReviewerInput({ parentGateAttestation: greenAttestation() }),
    );
    expect(result.ok).toBe(true);
  });

  test("accepts input without parentGateAttestation (non-sandboxed path) [BA]", () => {
    const result = validateAgainstSchema(
      implementReviewerSidecar.inputSchema,
      baseReviewerInput(),
    );
    expect(result.ok).toBe(true);
  });

  test("rejects parentGateAttestation missing a required field [BA]", () => {
    const incomplete = { ...greenAttestation() } as Record<string, unknown>;
    delete incomplete.passCount;
    const result = validateAgainstSchema(
      implementReviewerSidecar.inputSchema,
      baseReviewerInput({ parentGateAttestation: incomplete }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.params.missingProperty === "passCount")).toBe(
        true,
      );
    }
  });

  test("rejects parentGateAttestation with an unknown property [BA]", () => {
    const result = validateAgainstSchema(
      implementReviewerSidecar.inputSchema,
      baseReviewerInput({
        parentGateAttestation: { ...greenAttestation(), extra: "nope" },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.keyword === "additionalProperties")).toBe(true);
    }
  });

  test("rejects negative passCount [BA]", () => {
    const result = validateAgainstSchema(
      implementReviewerSidecar.inputSchema,
      baseReviewerInput({ parentGateAttestation: greenAttestation({ passCount: -1 }) }),
    );
    expect(result.ok).toBe(false);
  });

  test("sidecar version advanced for the schema mutation (D185) [BA]", () => {
    expect(implementReviewerSidecar.version).toBeGreaterThanOrEqual(4);
  });
});

describe("T2007 validateParentGateAttestation", () => {
  test("accepts exact commit match with exit 0, failCount 0, passCount > 0 [BA]", () => {
    expect(validateParentGateAttestation(greenAttestation(), RESULT_COMMIT)).toBe(true);
  });

  test("rejects commit mismatch [BA]", () => {
    expect(
      validateParentGateAttestation(
        greenAttestation({ resultCommit: "c".repeat(40) }),
        RESULT_COMMIT,
      ),
    ).toBe(false);
  });

  test("rejects non-zero exit code [BA]", () => {
    expect(
      validateParentGateAttestation(greenAttestation({ gateExitCode: 1 }), RESULT_COMMIT),
    ).toBe(false);
  });

  test("rejects non-zero failCount [BA]", () => {
    expect(
      validateParentGateAttestation(greenAttestation({ failCount: 1 }), RESULT_COMMIT),
    ).toBe(false);
  });

  test("rejects zero passCount [BA]", () => {
    expect(
      validateParentGateAttestation(greenAttestation({ passCount: 0 }), RESULT_COMMIT),
    ).toBe(false);
  });

  test("gateDurationMs is optional for the helper [BA]", () => {
    const withoutDuration = greenAttestation();
    const { gateDurationMs: _omit, ...rest } = withoutDuration;
    expect(validateParentGateAttestation(rest, RESULT_COMMIT)).toBe(true);
  });
});

describe("T2081 supervised worker evidence reviewer handoff [BA]", () => {
  const expected = {
    taskId: "T2007",
    resultCommit: RESULT_COMMIT,
    branch: "implement/T2007",
    worktreePath: "/tmp/wt-T2007",
  };

  test("accepts the stored exact-tip evidence on reviewer input", () => {
    expect(
      validateAgainstSchema(
        implementReviewerSidecar.inputSchema,
        baseReviewerInput({ supervisedGateEvidence: supervisedEvidence() }),
      ).ok,
    ).toBe(true);
    expect(validateSupervisedWorkerGateEvidenceForReview(supervisedEvidence(), expected)).toBe(
      true,
    );
  });

  test("rejects task, commit, branch, worktree, and gate substitutions", () => {
    for (const substitution of [
      { taskId: "T2008" },
      { resultCommit: "d".repeat(40) },
      { branch: "implement/T2008" },
      { worktreePath: "/tmp/foreign" },
      { passCount: 0 },
      { failCount: 1 },
    ]) {
      expect(
        validateSupervisedWorkerGateEvidenceForReview(
          supervisedEvidence(substitution as Partial<ImplementWorkerSupervisedGateEvidence>),
          expected,
        ),
      ).toBe(false);
    }
  });
});

describe("T2007 sandbox-denied prompt and parent dispatch guards", () => {
  test("Codex worker delegates the canonical gate to trusted result storage [BG]", () => {
    const body = readFileSync(IMPLEMENT_WORKER_AGENT, "utf8");
    expect(body).toContain("gitChangeCapability");
    expect(body).toMatch(/do \*\*not\*\* invoke `cq gate\s+run`\s+inside the sandbox/im);
    expect(body).toContain("store_result");
    expect(body).toContain("supervisedGateEvidence");
  });

  test("implement-reviewer pins sandbox-denied-primitives and keeps child gate prose [BG]", () => {
    const body = readFileSync(IMPLEMENT_REVIEWER_AGENT, "utf8");
    expect(body).toContain(SANDBOX_DENIED_PRIMITIVES_GATE_REASON);
    expect(body).toContain("parentGateAttestation");
    expect(body).toContain("supervisedGateEvidence");
    expect(body).toContain("Do **not** invoke `cq gate run` inside the sandbox");
    expect(body).toContain(
      "`cq gate run --worktree <worktree> --command-cwd <worktree>/nix/pkg/cq-ledgers --deadline <gateCompleteBy> -- bun run check`",
    );
    expect(body).toContain("Non-sandboxed reviewers always take this child re-run path");
    expect(body).toContain("gateExitCode === 0");
    expect(body).toContain("failCount === 0");
    expect(body).toContain("passCount > 0");
  });

  test("Codex parent dispatch attaches parentGateAttestation on the sandboxed path [BG]", () => {
    const body = readFileSync(CODEX_IMPLEMENT_DISPATCH, "utf8");
    expect(body).toContain("parentGateAttestation");
    expect(body).toContain("supervisedGateEvidence");
    expect(body).toMatch(/trusted\s+result-storage boundary/m);
    expect(body).toContain("read-only");
    expect(body).toContain("danger-full-access");
    expect(body).toContain("gateExitCode === 0");
    expect(body).toContain("passCount > 0");
  });

  test("implement/advance pins the parent-attested gate rule [BG]", () => {
    const body = readFileSync(IMPLEMENT_ADVANCE, "utf8");
    expect(body).toContain("parentGateAttestation");
    expect(body).toContain("supervisedGateEvidence");
    expect(body).toContain("gate primitives denied");
    expect(body).toContain("Do not escalate the child sandbox");
    expect(body).toContain("gateReRan=true");
  });

  test("non-Codex parent dispatch fragments omit parentGateAttestation [BG]", () => {
    for (const path of [CLAUDE_IMPLEMENT_DISPATCH, PI_IMPLEMENT_DISPATCH]) {
      const body = readFileSync(path, "utf8");
      expect(body).not.toContain("parentGateAttestation");
      expect(body).toContain(
        "{ taskId, acceptance, worktreePath, branch, baseCommit, workerResult, round, priorCriticism? }",
      );
    }
  });
});
