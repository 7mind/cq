import { describe, expect, test } from "bun:test";
import {
  D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE,
  deriveImplementationEvidenceActivationCohort,
  resolveImplementationEvidenceActivationTaskMappings,
  type ImplementationEvidenceActivationTaskObservation,
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

function observation(
  taskRef: string,
  status: string,
  retainedAtBoundary: boolean,
): ImplementationEvidenceActivationTaskObservation {
  return {
    taskRef,
    ownerGoalRef: "goals:G176",
    ownerEdgeKind: "finalized-manifest",
    status,
    resultCommit: "a".repeat(40),
    retainedAtBoundary,
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

  test("includes retained successors and excludes abandoned and post-boundary work", () => {
    const manifest = finalized(["T3000", "T3001", "T3002"]);
    manifest.tasks.push(
      { key: "t-successor", id: "T3003" },
      { key: "t-abandoned", id: "T3004" },
      { key: "t-post-boundary", id: "T3005" },
    );
    expect(
      deriveImplementationEvidenceActivationCohort(
        manifest,
        D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE,
        [
          observation("tasks:T3000", "done", true),
          observation("tasks:T3001", "done", true),
          observation("tasks:T3002", "planned", false),
          observation("tasks:T3003", "done", true),
          observation("tasks:T3004", "abandoned", true),
          observation("tasks:T3005", "done", false),
          observation("tasks:T2999", "done", true),
        ],
      ),
    ).toEqual({
      evidenceTaskRef: "tasks:T3000",
      auditTaskRef: "tasks:T3001",
      activationTaskRef: "tasks:T3002",
      taskRefs: ["tasks:T3000", "tasks:T3001", "tasks:T3003"],
    });
  });

  test("refuses an incomplete qualifying bootstrap cohort", () => {
    expect(() =>
      deriveImplementationEvidenceActivationCohort(
        finalized(["T3000", "T3001", "T3002"]),
        D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE,
        [observation("tasks:T3000", "done", true)],
      ),
    ).toThrow("omits a finalized bootstrap task");
  });
});
