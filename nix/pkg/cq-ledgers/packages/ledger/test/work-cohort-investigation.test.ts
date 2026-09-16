import { describe, expect, test } from "bun:test";

import {
  cohortObservationInvalidationsV1,
  constructCohortDecisionsV1,
} from "../src/workCohort.js";
import { observationFor } from "./workCohortFixture.js";

describe("investigation and repository witnesses", () => {
  test("fuses investigations only under one exact confirmed-cause receipt", async () => {
    const shared = await observationFor([
      { ref: "defects:D1", phase: "investigation", atoms: [{ cause: "root" }] },
      { ref: "defects:D2", phase: "investigation", atoms: [{ cause: "root" }] },
    ]);
    const distinct = await observationFor([
      { ref: "defects:D1", phase: "investigation", atoms: [{ cause: "root-one" }] },
      { ref: "defects:D2", phase: "investigation", atoms: [{ cause: "root-two" }] },
    ]);

    expect(constructCohortDecisionsV1(shared)[0]?.includedMemberRefs).toEqual([
      "defects:D1",
      "defects:D2",
    ]);
    expect(constructCohortDecisionsV1(distinct)[0]?.excluded[0]?.reason).toBe(
      "cohort-witness-empty",
    );
  });

  test("mixed phases split in the declared investigation-first order", async () => {
    const observation = await observationFor(
      [
        { ref: "tasks:T1" },
        { ref: "defects:D1", phase: "investigation", atoms: [{ cause: "root" }] },
      ],
      { membersOrder: ["tasks:T1", "defects:D1"] },
    );
    const decisions = constructCohortDecisionsV1(observation);

    expect(decisions.map((decision) => decision.includedMemberRefs)).toEqual([
      ["defects:D1"],
      ["tasks:T1"],
    ]);
    expect(decisions[0]?.excluded[0]?.reason).toBe("phase-mismatch");
  });

  test("same file with different symbols is not a common witness", async () => {
    const observation = await observationFor([
      { ref: "tasks:T1", atoms: [{ witness: "symbol-one", witnessPath: "contract" }] },
      { ref: "tasks:T2", atoms: [{ witness: "symbol-two", witnessPath: "contract" }] },
    ]);

    expect(constructCohortDecisionsV1(observation)[0]?.excluded[0]?.reason).toBe(
      "cohort-witness-empty",
    );
  });

  test("same package without a shared symbol is not a common witness", async () => {
    const observation = await observationFor([
      { ref: "tasks:T1", atoms: [{ witness: "first-symbol", witnessPath: "package/one" }] },
      { ref: "tasks:T2", atoms: [{ witness: "second-symbol", witnessPath: "package/two" }] },
    ]);

    expect(constructCohortDecisionsV1(observation)[0]?.excluded[0]?.reason).toBe(
      "cohort-witness-empty",
    );
  });

  test("changed cause, reviewer, deployment, or finalization invalidates the observation", async () => {
    const prior = await observationFor([
      { ref: "defects:D1", phase: "investigation", atoms: [{ cause: "root" }] },
    ]);
    const cause = await observationFor([
      { ref: "defects:D1", phase: "investigation", atoms: [{ cause: "changed" }] },
    ]);
    const reviewer = await observationFor([
      {
        ref: "defects:D1",
        phase: "investigation",
        atoms: [{ cause: "root", reviewer: "changed" }],
      },
    ]);
    const deployment = await observationFor([
      {
        ref: "defects:D1",
        phase: "investigation",
        atoms: [{ cause: "root", deployment: "changed" }],
      },
    ]);
    const finalization = await observationFor([
      {
        ref: "defects:D1",
        phase: "investigation",
        atoms: [{ cause: "root", finalization: "changed" }],
      },
    ]);

    expect(cohortObservationInvalidationsV1(prior, cause)).toContain("cause-or-witness");
    expect(cohortObservationInvalidationsV1(prior, reviewer)).toContain("reviewer");
    expect(cohortObservationInvalidationsV1(prior, deployment)).toContain("deployment");
    expect(cohortObservationInvalidationsV1(prior, finalization)).toContain("finalization");
  });
});
