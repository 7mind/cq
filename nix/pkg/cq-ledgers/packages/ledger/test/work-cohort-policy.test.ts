import { describe, expect, test } from "bun:test";

import {
  COHORT_EXCLUSION_PRIORITY_V1,
  COHORT_PHASE_ORDER_V1,
  constructCohortDecisionsV1,
} from "../src/workCohort.js";
import { observationFor } from "./workCohortFixture.js";

describe("cohort admission policy", () => {
  test("asserts the closed exclusion priority and phase order", () => {
    expect(COHORT_EXCLUSION_PRIORITY_V1).toEqual([
      "stale-binding",
      "phase-mismatch",
      "ownership-or-manifest",
      "dependency",
      "authority",
      "repository-or-environment",
      "cohort-witness-empty",
      "validation-boundary-empty",
      "reviewer-boundary-empty",
      "deployment-boundary-empty",
      "finalization-boundary-empty",
      "eligibility-tuple-empty",
    ]);
    expect(COHORT_PHASE_ORDER_V1).toEqual(["investigation", "implementation"]);
  });

  test("fuses every qualifying scanned member independent of source permutation", async () => {
    const specs = [{ ref: "tasks:T1" }, { ref: "tasks:T2" }, { ref: "tasks:T3" }] as const;
    const ordered = constructCohortDecisionsV1(await observationFor(specs));
    const permuted = constructCohortDecisionsV1(
      await observationFor(specs, { sourceOrder: ["tasks:T3", "tasks:T1", "tasks:T2"] }),
    );

    expect(ordered).toHaveLength(1);
    expect(ordered[0]?.includedMemberRefs).toEqual(["tasks:T1", "tasks:T2", "tasks:T3"]);
    expect(permuted[0]?.decisionDigest).toBe(ordered[0]?.decisionDigest);
  });

  test("uses the first priority reason and emits singletons only after no admission", async () => {
    const observation = await observationFor([
      { ref: "defects:D1", phase: "investigation", atoms: [{ cause: "root" }] },
      { ref: "tasks:T1", owner: "other", unavailable: true },
    ]);
    const decisions = constructCohortDecisionsV1(observation);

    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.excluded[0]).toEqual({
      memberRef: "tasks:T1",
      reason: "stale-binding",
      againstMemberRef: "defects:D1",
    });
    expect(decisions[0]?.includedMemberRefs).toEqual(["defects:D1"]);
    expect(decisions[1]?.includedMemberRefs).toEqual(["tasks:T1"]);
  });

  test("rejects pairwise-only witness overlap at the cumulative boundary", async () => {
    const observation = await observationFor([
      { ref: "tasks:A", atoms: [{ witness: "w1" }, { witness: "w2" }] },
      { ref: "tasks:B", atoms: [{ witness: "w1" }, { witness: "w3" }] },
      { ref: "tasks:C", atoms: [{ witness: "w2" }, { witness: "w3" }] },
    ]);
    const decisions = constructCohortDecisionsV1(observation);

    expect(decisions[0]?.includedMemberRefs).toEqual(["tasks:A", "tasks:B"]);
    expect(decisions[0]?.excluded[0]?.reason).toBe("cohort-witness-empty");
  });

  test("rejects pairwise-but-not-global regression/gate overlap", async () => {
    const observation = await observationFor([
      { ref: "tasks:A", atoms: [{ regression: "r1" }, { regression: "r2" }] },
      { ref: "tasks:B", atoms: [{ regression: "r1" }, { regression: "r3" }] },
      { ref: "tasks:C", atoms: [{ regression: "r2" }, { regression: "r3" }] },
    ]);
    const decisions = constructCohortDecisionsV1(observation);

    expect(decisions[0]?.includedMemberRefs).toEqual(["tasks:A", "tasks:B"]);
    expect(decisions[0]?.excluded[0]?.reason).toBe("validation-boundary-empty");
  });

  test("does not infer a tuple from overlapping scalar projections", async () => {
    const observation = await observationFor([
      {
        ref: "tasks:A",
        atoms: [
          { witness: "w1", regression: "r1" },
          { witness: "w2", regression: "r2" },
        ],
      },
      {
        ref: "tasks:B",
        atoms: [
          { witness: "w1", regression: "r2" },
          { witness: "w2", regression: "r1" },
        ],
      },
    ]);
    const [decision] = constructCohortDecisionsV1(observation);

    expect(decision?.excluded[0]?.reason).toBe("eligibility-tuple-empty");
  });

  test("shared full-suite identity alone does not create a validation boundary", async () => {
    const observation = await observationFor([
      { ref: "tasks:A", atoms: [{ witness: "a", regression: "focused-a" }] },
      { ref: "tasks:B", atoms: [{ witness: "b", regression: "focused-b" }] },
    ]);

    expect(constructCohortDecisionsV1(observation)[0]?.excluded[0]?.reason).toBe(
      "cohort-witness-empty",
    );
  });

  test("split conditions are correlated atom data, not a heuristic threshold", async () => {
    const observation = await observationFor([
      { ref: "tasks:A", atoms: [{ split: ["linux"] }] },
      { ref: "tasks:B", atoms: [{ split: ["darwin"] }] },
    ]);

    expect(constructCohortDecisionsV1(observation)[0]?.excluded[0]?.reason).toBe(
      "eligibility-tuple-empty",
    );
  });

  test("ownership, dependency, and authority constraints precede atom diagnostics", async () => {
    const ownership = await observationFor([
      { ref: "tasks:A" },
      { ref: "tasks:B", owner: "other" },
    ]);
    const dependency = await observationFor([
      { ref: "tasks:A" },
      { ref: "tasks:B", dependencies: ["tasks:A"] },
    ]);
    const authority = await observationFor([
      { ref: "tasks:A" },
      { ref: "tasks:B", authority: "other" },
    ]);

    expect(constructCohortDecisionsV1(ownership)[0]?.excluded[0]?.reason).toBe(
      "ownership-or-manifest",
    );
    expect(constructCohortDecisionsV1(dependency)[0]?.excluded[0]?.reason).toBe("dependency");
    expect(constructCohortDecisionsV1(authority)[0]?.excluded[0]?.reason).toBe("authority");
  });

  test("same-code ties name the earliest canonically included member", async () => {
    const observation = await observationFor(
      [
        { ref: "tasks:A", atoms: [{ witness: "shared" }, { witness: "a-only" }] },
        { ref: "tasks:B", atoms: [{ witness: "shared" }, { witness: "b-only" }] },
        { ref: "tasks:C", atoms: [{ witness: "c-only" }] },
      ],
      { membersOrder: ["tasks:B", "tasks:A", "tasks:C"] },
    );

    expect(constructCohortDecisionsV1(observation)[0]?.excluded[0]).toEqual({
      memberRef: "tasks:C",
      reason: "cohort-witness-empty",
      againstMemberRef: "tasks:B",
    });
  });

  test.each([
    ["reviewer", { reviewer: "other" }, "reviewer-boundary-empty"],
    ["deployment", { deployment: "other" }, "deployment-boundary-empty"],
    ["finalization", { finalization: "other" }, "finalization-boundary-empty"],
  ] as const)("splits on changed %s boundary", async (_label, changed, reason) => {
    const observation = await observationFor([
      { ref: "tasks:A" },
      { ref: "tasks:B", atoms: [changed] },
    ]);
    expect(constructCohortDecisionsV1(observation)[0]?.excluded[0]?.reason).toBe(reason);
  });
});
