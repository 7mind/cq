/**
 * D119/T903 — the verified dispatch base is a required worker input.
 *
 * These Behavioral-Active Blackbox-Atomic fixtures exercise the public
 * prompt-catalog schema-validation boundary. They keep the verified base in
 * the machine-checked envelope rather than relying only on prompt prose.
 */
import { describe, expect, test } from "bun:test";
import { implementWorkerSidecar, validateAgainstSchema } from "@cq/config";

function baseInputPayload(): Record<string, unknown> {
  return {
    taskId: "T903",
    acceptance: "Every rejection scenario fails closed.",
    worktreePath: "/tmp/cq-implement-T903",
    branch: "implement/T903",
    baseCommit: "a".repeat(40),
    round: 0,
    startingCommit: "b".repeat(40),
  };
}

describe("D119/T903 implement-worker inputSchema", () => {
  test("a complete input carrying the verified base is accepted", () => {
    expect(
      validateAgainstSchema(implementWorkerSidecar.inputSchema, baseInputPayload()).ok,
    ).toBe(true);
  });

  test("missing baseCommit is rejected", () => {
    const payload = baseInputPayload();
    delete payload.baseCommit;
    const result = validateAgainstSchema(implementWorkerSidecar.inputSchema, payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.params.missingProperty === "baseCommit")).toBe(true);
    }
  });

  for (const requiredField of ["round", "startingCommit"] as const) {
    test(`missing ${requiredField} is rejected`, () => {
      const payload = baseInputPayload();
      delete payload[requiredField];
      const result = validateAgainstSchema(implementWorkerSidecar.inputSchema, payload);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.params.missingProperty === requiredField)).toBe(true);
      }
    });
  }

  test("malformed startingCommit and round are rejected", () => {
    expect(
      validateAgainstSchema(implementWorkerSidecar.inputSchema, {
        ...baseInputPayload(),
        startingCommit: "abc",
      }).ok,
    ).toBe(false);
    expect(
      validateAgainstSchema(implementWorkerSidecar.inputSchema, {
        ...baseInputPayload(),
        round: 0.5,
      }).ok,
    ).toBe(false);
  });

  const SHA_C = "c".repeat(40);
  const SHA_D = "d".repeat(40);

  function guardedLineage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      guardedRebase: `cq-guarded-rebase:v1:${"9".repeat(64)}`,
      oldResultCommit: SHA_C,
      ontoCommit: "a".repeat(40),
      rebasedStartCommit: SHA_D,
      exactTip: true,
      ...overrides,
    };
  }

  test("T2150: a complete server-injected guardedRebaseLineage is accepted", () => {
    expect(
      validateAgainstSchema(implementWorkerSidecar.inputSchema, {
        ...baseInputPayload(),
        baseCommit: "a".repeat(40),
        startingCommit: SHA_D,
        priorResultCommit: SHA_C,
        round: 1,
        guardedRebaseLineage: guardedLineage(),
      }).ok,
    ).toBe(true);
  });

  test("T2150: the guardedRebaseLineage is closed against substitution", () => {
    for (const lineage of [
      { ...guardedLineage(), guardedRebase: "not-an-opaque-reference" },
      { ...guardedLineage(), guardedRebase: `cq-guarded-rebase:v0:${"9".repeat(64)}` },
      { ...guardedLineage(), oldResultCommit: "abc" },
      { ...guardedLineage(), exactTip: "yes" },
      { ...guardedLineage(), callerNote: "minted by a caller" },
    ]) {
      const result = validateAgainstSchema(implementWorkerSidecar.inputSchema, {
        ...baseInputPayload(),
        guardedRebaseLineage: lineage,
      });
      expect(result.ok).toBe(false);
    }
  });

  test("T2150: an incomplete guardedRebaseLineage is rejected", () => {
    for (const missing of [
      "guardedRebase",
      "oldResultCommit",
      "ontoCommit",
      "rebasedStartCommit",
      "exactTip",
    ]) {
      const lineage = guardedLineage();
      delete lineage[missing];
      const result = validateAgainstSchema(implementWorkerSidecar.inputSchema, {
        ...baseInputPayload(),
        guardedRebaseLineage: lineage,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.params.missingProperty === missing)).toBe(true);
      }
    }
  });
});
