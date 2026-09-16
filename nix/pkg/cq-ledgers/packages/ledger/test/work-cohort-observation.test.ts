import { describe, expect, test } from "bun:test";

import {
  cohortObservationInvalidationsV1,
  constructCohortDecisionsV1,
  produceCohortAdmissionObservationV1,
} from "../src/workCohort.js";
import { commit, observationFor, snapshotFor } from "./workCohortFixture.js";

describe("cohort admission observation", () => {
  test("freezes distinct focused plans under one correlated common atom", async () => {
    const observation = await observationFor([
      { ref: "tasks:T1", atoms: [{ command: "focused-one" }] },
      { ref: "tasks:T2", atoms: [{ command: "focused-two" }] },
    ]);
    const [decision] = constructCohortDecisionsV1(observation);

    expect(decision?.includedMemberRefs).toEqual(["tasks:T1", "tasks:T2"]);
    expect(decision?.matrix.members.map((member) => member.focusedPlanDigest)).toHaveLength(2);
    expect(new Set(decision?.matrix.members.map((member) => member.focusedPlanDigest)).size).toBe(2);
    expect(decision?.matrix.normalizedCommandClasses).toHaveLength(2);
    expect(decision?.benefit.unknownBoundaryDigests).toHaveLength(3);
  });

  test("deduplicates equal normalized commands without collapsing member plans", async () => {
    const observation = await observationFor([
      { ref: "tasks:T1", atoms: [{ command: "same-focused" }] },
      { ref: "tasks:T2", atoms: [{ command: "same-focused" }] },
    ]);
    const [decision] = constructCohortDecisionsV1(observation);

    expect(decision?.matrix.normalizedCommandClasses).toHaveLength(1);
    expect(decision?.matrix.normalizedCommandClasses[0]?.memberRefs).toEqual([
      "tasks:T1",
      "tasks:T2",
    ]);
    expect(new Set(decision?.matrix.members.map((member) => member.focusedPlanDigest)).size).toBe(2);
  });

  test("changed command, manifest, HEAD, source graph, environment, and authority invalidate", async () => {
    const specs = [
      { ref: "tasks:T1", atoms: [{ command: "one" }] },
      { ref: "tasks:T2", atoms: [{ command: "two" }] },
    ] as const;
    const prior = await observationFor(specs);
    const command = await observationFor([
      specs[0],
      { ref: "tasks:T2", atoms: [{ command: "changed" }] },
    ]);
    const manifest = await observationFor(specs, { manifestRevision: "manifest:2" });
    const head = await observationFor(specs, {
      repository: {
        repositoryId: "repository:test",
        headCommit: commit("changed-head"),
        treeOid: commit("changed-tree"),
      },
    });
    const source = await observationFor(specs, { sourceSalt: "changed" });
    const environment = await observationFor(specs, { environment: "changed" });
    const authority = await observationFor([specs[0], { ...specs[1], authority: "changed" }]);
    const workset = await observationFor(specs, { worksetRevision: "workset:2" });

    expect(cohortObservationInvalidationsV1(prior, command)).toContain("command");
    expect(cohortObservationInvalidationsV1(prior, manifest)).toContain("manifest");
    expect(cohortObservationInvalidationsV1(prior, head)).toContain("source-or-tree");
    expect(cohortObservationInvalidationsV1(prior, source)).toContain("source-or-tree");
    expect(cohortObservationInvalidationsV1(prior, environment)).toContain("environment");
    expect(cohortObservationInvalidationsV1(prior, authority)).toContain("authority");
    expect(cohortObservationInvalidationsV1(prior, workset)).toContain("workset");
    expect(constructCohortDecisionsV1(command)[0]?.matrix.matrixDigest).not.toBe(
      constructCohortDecisionsV1(prior)[0]?.matrix.matrixDigest,
    );
  });

  test("caller prose cannot create admission evidence", async () => {
    const specs = [{ ref: "tasks:T1" }, { ref: "tasks:T2" }] as const;
    const snapshot = snapshotFor(specs, {});
    const source = { resolveExactSnapshot: async () => snapshot };
    const plain = await produceCohortAdmissionObservationV1(
      { memberRefs: ["tasks:T1", "tasks:T2"] },
      source,
    );
    const prose = await produceCohortAdmissionObservationV1(
      { memberRefs: ["tasks:T1", "tasks:T2"], assertion: "same package" } as {
        memberRefs: readonly string[];
      },
      source,
    );

    expect(prose.observationDigest).toBe(plain.observationDigest);
  });

  test("rejects repository witness paths not derived through the bounded graph", async () => {
    const snapshot = snapshotFor([{ ref: "tasks:T1" }], {});
    const member = snapshot.members[0]!;
    const malformed = {
      ...snapshot,
      members: [
        {
          ...member,
          boundaryCandidates: [
            {
              ...member.boundaryCandidates[0]!,
              witness: {
                ...member.boundaryCandidates[0]!.witness,
                memberPath: ["src/tasks:T1.ts", "src/not-inspected.ts"],
              },
            },
          ],
        },
      ],
    };
    await expect(
      produceCohortAdmissionObservationV1(
        { memberRefs: ["tasks:T1"] },
        { resolveExactSnapshot: async () => malformed as typeof snapshot },
      ),
    ).rejects.toThrow("does not end at its source node");
  });
});
