/**
 * T894 — evidence-carrying implement-worker outputSchema.
 *
 * Verifies the five acceptance clauses directly against the compiled Ajv
 * schema (not a hand-rolled re-implementation of the rule): a full-sha
 * `resultCommit` pattern, `gateDurationMs` required on a pass, a REAL
 * conditional `mutationTable` requirement keyed on whether `filesTouched`
 * intersects {@link TEST_GUARD_GLOBS}, and `additionalProperties: false`
 * preserved. Clause (d) is the discriminating case: it asserts the ACCEPT
 * direction so an always-required misimplementation of `mutationTable` would
 * fail this suite even though it would pass every other clause.
 */
import { describe, expect, test } from "bun:test";
import { implementWorkerSidecar, TEST_GUARD_GLOBS, validateAgainstSchema } from "@cq/config";

const SHA = "a".repeat(40);

/** A minimal valid pass payload with a non-test/guard filesTouched entry. */
function basePassPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: "T894",
    status: "pass",
    resultCommit: SHA,
    branch: "implement/T894",
    filesTouched: ["packages/cq-config/src/schemas/implement-worker.ts"],
    checkSummary: "tsc: ok, eslint: ok, bun test: 42 pass",
    summary: "Added sha pattern + gateDurationMs + conditional mutationTable.",
    gateDurationMs: 12345,
    ...overrides,
  };
}

describe("T894 implement-worker outputSchema", () => {
  test("TEST_GUARD_GLOBS is the exact classification list the schema description states", () => {
    expect(TEST_GUARD_GLOBS).toEqual(["**/test/**", "**/*.test.ts", "**/*guard*", "**/*invariant*"]);
  });

  test("the mutationTable classification rule is stated in the schema description", () => {
    const mutationTableSchema = (
      implementWorkerSidecar.outputSchema.properties as Record<string, { description?: string }>
    ).mutationTable;
    expect(mutationTableSchema?.description).toBeDefined();
    const description = mutationTableSchema?.description ?? "";
    for (const glob of TEST_GUARD_GLOBS) {
      expect(description).toContain(glob);
    }
  });

  // --- (a) resultCommit sha-pattern rejection --------------------------------

  test("(a) resultCommit='deadbeef' fails Ajv (not a full 40-hex sha)", () => {
    const result = validateAgainstSchema(
      implementWorkerSidecar.outputSchema,
      basePassPayload({ resultCommit: "deadbeef" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "/resultCommit")).toBe(true);
    }
  });

  test("(a) resultCommit=null still passes (fail-status shape)", () => {
    const result = validateAgainstSchema(implementWorkerSidecar.outputSchema, {
      taskId: "T894",
      status: "fail",
      resultCommit: null,
      branch: "implement/T894",
      filesTouched: [],
      checkSummary: "tsc: error",
      summary: "Blocked on ambiguous acceptance.",
      blockedReason: "acceptance contradicts existing behaviour",
    });
    expect(result.ok).toBe(true);
  });

  // --- (b) fully valid pass payload passes ------------------------------------

  test("(b) valid 40-hex resultCommit + gateDurationMs + mutationTable passes", () => {
    const result = validateAgainstSchema(
      implementWorkerSidecar.outputSchema,
      basePassPayload({
        filesTouched: ["packages/cq-config/test/implementWorkerOutputSchema.test.ts"],
        mutationTable: [
          {
            mutation: "flipped the mutationTable if/then to unconditional required",
            observed: "clause (d) payload (no test/guard path, no mutationTable) started failing Ajv",
            restored: "reverted to the conditional if/then keyed on filesTouched",
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("(b) gateDurationMs missing on a pass fails Ajv", () => {
    const payload = basePassPayload();
    delete payload.gateDurationMs;
    const result = validateAgainstSchema(implementWorkerSidecar.outputSchema, payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.params.missingProperty === "gateDurationMs")).toBe(true);
    }
  });

  test("(b) a positive gateDurationMs below 50ms remains schema-accepted so T900 can surface it", () => {
    const result = validateAgainstSchema(
      implementWorkerSidecar.outputSchema,
      basePassPayload({ gateDurationMs: 1 }),
    );
    expect(result.ok).toBe(true);
  });

  // --- (c) test/guard path without mutationTable fails ------------------------

  test.each([
    ["packages/cq-config/test/implementWorkerOutputSchema.test.ts", "**/test/** and **/*.test.ts"],
    ["packages/cq-config/src/schemas/foo.test.ts", "**/*.test.ts"],
    ["packages/cq-config/src/invariantGuard.ts", "**/*invariant*"],
    ["packages/cq-config/src/guardRail.ts", "**/*guard*"],
  ])("(c) filesTouched=[%s] (matches %s) without mutationTable fails", (path) => {
    const result = validateAgainstSchema(
      implementWorkerSidecar.outputSchema,
      basePassPayload({ filesTouched: [path] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.params.missingProperty === "mutationTable")).toBe(true);
    }
  });

  // --- (d) NEGATIVE DIRECTION: no test/guard path, no mutationTable => ACCEPTED

  test("(d) filesTouched with NO test/guard path and NO mutationTable is ACCEPTED", () => {
    const payload = basePassPayload({
      filesTouched: ["packages/cq-config/src/schemas/implement-worker.ts", "packages/cq-config/src/index.ts"],
    });
    expect("mutationTable" in payload).toBe(false);
    const result = validateAgainstSchema(implementWorkerSidecar.outputSchema, payload);
    expect(result.ok).toBe(true);
  });

  // --- (e) additionalProperties still false -----------------------------------

  test("(e) an unknown top-level key is rejected", () => {
    const result = validateAgainstSchema(
      implementWorkerSidecar.outputSchema,
      basePassPayload({ notARealField: "should be rejected" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.keyword === "additionalProperties")).toBe(true);
    }
  });

  test("(e) an unknown mutationTable-entry key is rejected", () => {
    const result = validateAgainstSchema(
      implementWorkerSidecar.outputSchema,
      basePassPayload({
        filesTouched: ["packages/cq-config/test/implementWorkerOutputSchema.test.ts"],
        mutationTable: [{ mutation: "x", observed: "y", restored: "z", extra: "nope" }],
      }),
    );
    expect(result.ok).toBe(false);
  });
});
