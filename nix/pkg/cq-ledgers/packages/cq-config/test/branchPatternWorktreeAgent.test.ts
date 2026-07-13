/**
 * D77 (goal G68, root-caused via H57) — the four implement-role `branch` fields
 * hardcoded `pattern: "^implement/T[0-9]+$"`, so ledger-mcp validate_input /
 * validate_output (pure Ajv via `src/validation.ts`) rejected Claude
 * native-isolation branch names (`worktree-agent-<hex>`) even though the
 * implement-worker prompt (`nix/pkg/cq-assets/agents/implement-worker.md`)
 * documents that the harness may supply either naming. Fixed by widening the
 * pattern literal at all four authoring sites to accept BOTH namings.
 *
 * This test file follows the fresh-Ajv `newAjv().compile(...)` pattern of
 * `promptCatalog.test.ts:43-59`.
 */

import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import {
  implementWorkerSidecar,
  implementReviewerSidecar,
  implementConflictResolverSidecar,
  validateAgainstSchema,
} from "@cq/config";

/** A fresh Ajv compiling draft 2020-12 schemas with strict structural checks. */
function newAjv(): Ajv2020 {
  return new Ajv2020({ strict: false, allErrors: true });
}

/** The 8-hex sample from the task description. */
const WORKTREE_AGENT_SHORT = "worktree-agent-ab5ad0ce";
/** The verbatim 17-hex name observed in the field (reviewer note R600). */
const WORKTREE_AGENT_LONG = "worktree-agent-ab5ad0ce40f542f49";
/** A clearly-invalid branch name that must stay rejected by every site. */
const INVALID_BRANCH = "feature/foo";

describe("D77 — implement-worker inputSchema.branch accepts both namings", () => {
  const validate = newAjv().compile(implementWorkerSidecar.inputSchema);
  const base = {
    taskId: "T123",
    acceptance: "a",
    worktreePath: "/tmp/wt",
    baseCommit: "deadbeef",
  };

  test("accepts implement/T123", () => {
    expect(validate({ ...base, branch: "implement/T123" })).toBe(true);
  });

  test("accepts worktree-agent-<8-hex>", () => {
    expect(validate({ ...base, branch: WORKTREE_AGENT_SHORT })).toBe(true);
  });

  test("accepts worktree-agent-<17-hex> (verbatim observed name, R600)", () => {
    expect(validate({ ...base, branch: WORKTREE_AGENT_LONG })).toBe(true);
  });

  test("rejects an unrelated branch name", () => {
    expect(validate({ ...base, branch: INVALID_BRANCH })).toBe(false);
  });
});

describe("D77 — implement-worker outputSchema.branch accepts both namings", () => {
  const validate = newAjv().compile(implementWorkerSidecar.outputSchema);
  const base = {
    taskId: "T123",
    status: "pass",
    resultCommit: "deadbeef",
    filesTouched: [],
    checkSummary: "ok",
    summary: "s",
  };

  test("accepts implement/T123", () => {
    expect(validate({ ...base, branch: "implement/T123" })).toBe(true);
  });

  test("accepts worktree-agent-<8-hex>", () => {
    expect(validate({ ...base, branch: WORKTREE_AGENT_SHORT })).toBe(true);
  });

  test("accepts worktree-agent-<17-hex> (verbatim observed name, R600)", () => {
    expect(validate({ ...base, branch: WORKTREE_AGENT_LONG })).toBe(true);
  });

  test("rejects an unrelated branch name", () => {
    expect(validate({ ...base, branch: INVALID_BRANCH })).toBe(false);
  });
});

describe("D77 — implement-reviewer inputSchema.branch accepts both namings", () => {
  const validate = newAjv().compile(implementReviewerSidecar.inputSchema);
  const base = {
    taskId: "T123",
    acceptance: "a",
    worktreePath: "/tmp/wt",
    baseCommit: "deadbeef",
    workerResult: { resultCommit: "deadbeef", checkSummary: "ok", filesTouched: [] },
    round: 1,
  };

  test("accepts implement/T123", () => {
    expect(validate({ ...base, branch: "implement/T123" })).toBe(true);
  });

  test("accepts worktree-agent-<8-hex>", () => {
    expect(validate({ ...base, branch: WORKTREE_AGENT_SHORT })).toBe(true);
  });

  test("accepts worktree-agent-<17-hex> (verbatim observed name, R600)", () => {
    expect(validate({ ...base, branch: WORKTREE_AGENT_LONG })).toBe(true);
  });

  test("rejects an unrelated branch name", () => {
    expect(validate({ ...base, branch: INVALID_BRANCH })).toBe(false);
  });
});

describe("D77 — implement-conflict-resolver inputSchema.branch accepts both namings", () => {
  const validate = newAjv().compile(implementConflictResolverSidecar.inputSchema);
  const base = {
    taskId: "T123",
    worktreePath: "/tmp/wt",
    baseCommit: "deadbeef",
    conflictingFiles: ["a.ts"],
  };

  test("accepts implement/T123", () => {
    expect(validate({ ...base, branch: "implement/T123" })).toBe(true);
  });

  test("accepts worktree-agent-<8-hex>", () => {
    expect(validate({ ...base, branch: WORKTREE_AGENT_SHORT })).toBe(true);
  });

  test("accepts worktree-agent-<17-hex> (verbatim observed name, R600)", () => {
    expect(validate({ ...base, branch: WORKTREE_AGENT_LONG })).toBe(true);
  });

  test("rejects an unrelated branch name", () => {
    expect(validate({ ...base, branch: INVALID_BRANCH })).toBe(false);
  });
});

describe("D77 — validateAgainstSchema (the exact ledger-mcp validate_input code path)", () => {
  test("ok:true for a COMPLETE implement-worker input payload carrying a worktree-agent branch", () => {
    const payload = {
      taskId: "T507",
      headline: "Widen implement-role branch patterns",
      description: "Fixes D77.",
      acceptance: "bun run check is green.",
      worktreePath: "/tmp/wt-T507",
      branch: WORKTREE_AGENT_LONG,
      baseCommit: "25c189a29555c03456521fa99eba469fe09b3820",
    };
    const result = validateAgainstSchema(implementWorkerSidecar.inputSchema, payload);
    expect(result.ok).toBe(true);
  });
});
