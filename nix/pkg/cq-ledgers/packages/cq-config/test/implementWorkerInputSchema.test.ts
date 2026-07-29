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
});
