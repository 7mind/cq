import { describe, expect, test } from "bun:test";
import {
  D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE,
  resolveImplementationEvidenceActivationTaskMappings,
} from "../src/index.js";

function finalized(ids: readonly [string, string, string]) {
  return {
    revision: 7,
    milestones: [{ key: "m-implementation-evidence", id: "M1" }],
    tasks: [
      { key: "t-evidence", id: ids[0] },
      { key: "t-historical-evidence", id: ids[1] },
      { key: "t-activate-evidence", id: ids[2] },
    ],
  };
}

describe("implementation evidence activation mapping [BA]", () => {
  test("resolves replacement draft allocations exclusively through finalized keys", () => {
    expect(
      resolveImplementationEvidenceActivationTaskMappings(
        finalized(["T3000", "T3001", "T3002"]),
        D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE,
      ),
    ).toEqual({
      evidenceTaskRef: "tasks:T3000",
      auditTaskRef: "tasks:T3001",
      activationTaskRef: "tasks:T3002",
    });
    expect(
      resolveImplementationEvidenceActivationTaskMappings(
        finalized(["T4000", "T4001", "T4002"]),
        D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE,
      ),
    ).toEqual({
      evidenceTaskRef: "tasks:T4000",
      auditTaskRef: "tasks:T4001",
      activationTaskRef: "tasks:T4002",
    });
  });

  test("rejects a finalized manifest missing any bootstrap mapping", () => {
    const incomplete = finalized(["T3000", "T3001", "T3002"]);
    incomplete.tasks.pop();
    expect(() =>
      resolveImplementationEvidenceActivationTaskMappings(
        incomplete,
        D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE,
      ),
    ).toThrow("omits");
  });
});
