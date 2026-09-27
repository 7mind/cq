/**
 * T2929 / G184 — placement, ownership, and archive-state contract.
 */

import { describe, expect, it } from "bun:test";
import {
  CANONICAL_LEDGERS,
  DEFECTS_LEDGER,
  GOALS_LEDGER,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  TASKS_LEDGER,
} from "../src/constants.js";
import {
  DETACHED_PLACEMENT,
  HIERARCHY_ARTIFACT_ROLES,
  HIERARCHY_LEGACY_MIGRATION_INPUTS,
  HIERARCHY_WRITE_OPERATIONS,
  HierarchyContractError,
  LEDGER_PLACEMENT_MATRIX,
  assertHierarchyVerdict,
  checkArchive,
  checkPlacementRequest,
  checkStaticPlacement,
  checkUnarchive,
  resolveLedgerPlacementRule,
  validateHierarchyState,
  type HierarchyItemNode,
  type HierarchyMilestoneNode,
  type HierarchyPlacement,
  type HierarchySnapshot,
  type HierarchyVerdict,
} from "../src/hierarchyContract.js";

const inMilestone = (milestoneId: string): HierarchyPlacement => ({
  kind: "milestone",
  milestoneId,
});

function goal(id: string, archived: boolean): HierarchyItemNode {
  return { ledger: GOALS_LEDGER, id, role: "root", placement: DETACHED_PLACEMENT, archived };
}

function milestone(
  id: string,
  parentRef: string | null,
  archived: boolean,
): HierarchyMilestoneNode {
  return { id, parentRef, archived, terminal: archived };
}

function task(id: string, milestoneId: string, archived: boolean): HierarchyItemNode {
  return {
    ledger: TASKS_LEDGER,
    id,
    role: "work-implementation",
    placement: inMilestone(milestoneId),
    archived,
  };
}

function codes(verdict: HierarchyVerdict): string[] {
  return verdict.ok ? [] : verdict.violations.map((v) => v.code);
}

/** G1 → M1 → T1, plus a detached fix goal G2 for defect D1 owning M2. */
const HEALTHY: HierarchySnapshot = {
  milestones: [milestone("M1", "goals:G1", false), milestone("M2", "goals:G2", false)],
  items: [
    goal("G1", false),
    goal("G2", false),
    task("T1", "M1", false),
    {
      ledger: DEFECTS_LEDGER,
      id: "D1",
      role: "root",
      placement: DETACHED_PLACEMENT,
      archived: false,
    },
    {
      ledger: DEFECTS_LEDGER,
      id: "D2",
      role: "work-implementation",
      placement: inMilestone("M1"),
      archived: false,
    },
  ],
};

describe("placement matrix", () => {
  it("enumerates exactly every canonical ledger", () => {
    expect([...LEDGER_PLACEMENT_MATRIX.keys()].sort()).toEqual(
      CANONICAL_LEDGERS.map((c) => c.name).sort(),
    );
    for (const { name } of CANONICAL_LEDGERS) {
      expect(resolveLedgerPlacementRule(name)).toBe(LEDGER_PLACEMENT_MATRIX.get(name)!);
    }
    expect(() => resolveLedgerPlacementRule("scratch")).toThrow(HierarchyContractError);
  });

  it("gives milestones a single goals parent layer", () => {
    expect(resolveLedgerPlacementRule(MILESTONES_LEDGER)).toEqual({
      kind: "milestone-node",
      parentLedger: GOALS_LEDGER,
    });
  });

  it("declares goals.fields.milestones and coordination placement legacy-only", () => {
    expect(HIERARCHY_LEGACY_MIGRATION_INPUTS).toEqual([
      { kind: "goal-milestones-field", ledger: GOALS_LEDGER, field: "milestones" },
      { kind: "coordination-placement", milestoneId: MILESTONES_AMBIENT_ID },
    ]);
  });

  it("never permits a synthetic milestone placement on any ledger or role", () => {
    for (const { name } of CANONICAL_LEDGERS) {
      if (name === MILESTONES_LEDGER) continue;
      for (const role of HIERARCHY_ARTIFACT_ROLES) {
        const violations = checkStaticPlacement(
          name,
          "X1",
          role,
          inMilestone(MILESTONES_AMBIENT_ID),
        );
        expect(violations.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("generic create / import / restore placement", () => {
  it("rejects a goal carrying a real or synthetic milestone attachment", () => {
    for (const operation of HIERARCHY_WRITE_OPERATIONS) {
      for (const milestoneId of ["M1", MILESTONES_AMBIENT_ID]) {
        const verdict = checkPlacementRequest(HEALTHY, operation, {
          ledger: GOALS_LEDGER,
          id: "G9",
          role: "root",
          placement: inMilestone(milestoneId),
          fields: {},
        });
        expect(codes(verdict)).toEqual(["attached-goal"]);
      }
    }
  });

  it("rejects legacy goals.fields.milestones on every generic write", () => {
    for (const operation of HIERARCHY_WRITE_OPERATIONS) {
      const verdict = checkPlacementRequest(HEALTHY, operation, {
        ledger: GOALS_LEDGER,
        id: "G9",
        role: "root",
        placement: DETACHED_PLACEMENT,
        fields: { milestones: ["M1"] },
      });
      expect(codes(verdict)).toEqual(["legacy-goal-milestones-field"]);
    }
  });

  it("keeps root ideas/defects and planning coordination artifacts detached", () => {
    const attached: Array<[string, (typeof HIERARCHY_ARTIFACT_ROLES)[number]]> = [
      ["ideas", "root"],
      ["defects", "root"],
      ["defects", "planning-coordination"],
      ["questions", "planning-coordination"],
      ["decisions", "planning-coordination"],
      ["reviews", "planning-coordination"],
      ["handoffs", "planning-coordination"],
      ["researches", "planning-coordination"],
      ["hypothesis", "planning-coordination"],
      ["memories", "root"],
      ["upstream", "root"],
    ];
    for (const [ledger, role] of attached) {
      expect(
        checkStaticPlacement(ledger, "X1", role, inMilestone("M1")).map((v) => v.code),
      ).toEqual(["detached-required"]);
      expect(checkStaticPlacement(ledger, "X1", role, DETACHED_PLACEMENT)).toEqual([]);
    }
  });

  it("preserves legitimate work placement and requires a live milestone on create", () => {
    const workLedgers = [
      "defects",
      "questions",
      "reviews",
      "handoffs",
      "researches",
      "hypothesis",
      "operatorActions",
    ];
    for (const ledger of workLedgers) {
      for (const placement of [inMilestone("M1"), DETACHED_PLACEMENT]) {
        const request = {
          ledger,
          id: "X1",
          role: "work-implementation" as const,
          placement,
          fields: {},
        };
        for (const operation of HIERARCHY_WRITE_OPERATIONS) {
          expect(checkPlacementRequest(HEALTHY, operation, request)).toEqual({ ok: true });
        }
      }
    }
    const closed: HierarchySnapshot = {
      ...HEALTHY,
      milestones: [
        ...HEALTHY.milestones,
        { id: "M3", parentRef: "goals:G1", archived: false, terminal: true },
      ],
    };
    for (const milestoneId of ["M3", "M404"]) {
      expect(
        codes(
          checkPlacementRequest(closed, "create", {
            ledger: TASKS_LEDGER,
            id: "T9",
            role: "work-implementation",
            placement: inMilestone(milestoneId),
            fields: {},
          }),
        ),
      ).toEqual(["milestone-not-live"]);
    }
  });

  it("requires tasks to live in a real milestone", () => {
    expect(
      checkStaticPlacement(TASKS_LEDGER, "T9", "work-implementation", DETACHED_PLACEMENT).map(
        (v) => v.code,
      ),
    ).toEqual(["work-milestone-required"]);
    expect(
      checkStaticPlacement(TASKS_LEDGER, "T9", "root", inMilestone("M1")).map((v) => v.code),
    ).toEqual(["role-not-permitted"]);
  });
});

describe("hierarchy state invariants", () => {
  it("accepts the healthy goal → milestone → work hierarchy", () => {
    expect(validateHierarchyState(HEALTHY)).toEqual({ ok: true });
    expect(() => assertHierarchyVerdict(validateHierarchyState(HEALTHY))).not.toThrow();
  });

  it("rejects milestones without exactly one sealed goals parent", () => {
    const cases: Array<[string | null, string]> = [
      [null, "milestone-parent-missing"],
      ["defects:D1", "milestone-parent-not-goal"],
      ["G1", "milestone-parent-not-goal"],
      ["goals:G1,goals:G2", "milestone-parent-not-goal"],
    ];
    for (const [parentRef, code] of cases) {
      const snapshot: HierarchySnapshot = {
        ...HEALTHY,
        milestones: [milestone("M1", parentRef, false), HEALTHY.milestones[1]!],
      };
      expect(codes(validateHierarchyState(snapshot))).toEqual([code]);
      expect(() => assertHierarchyVerdict(validateHierarchyState(snapshot))).toThrow(
        HierarchyContractError,
      );
    }
  });

  it("accepts no active or archived state whose milestone parent cannot be resolved", () => {
    for (const archived of [false, true]) {
      const snapshot: HierarchySnapshot = {
        milestones: [milestone("M1", "goals:G404", archived)],
        items: [task("T1", "M1", archived)],
      };
      expect(codes(validateHierarchyState(snapshot))).toEqual(["milestone-parent-unresolved"]);
    }
  });

  it("accepts an archived milestone under an archived goal", () => {
    const snapshot: HierarchySnapshot = {
      milestones: [milestone("M1", "goals:G1", true)],
      items: [goal("G1", true), task("T1", "M1", true)],
    };
    expect(validateHierarchyState(snapshot)).toEqual({ ok: true });
  });

  it("rejects active children of archived parents and unresolvable item milestones", () => {
    const orphanMilestone: HierarchySnapshot = {
      milestones: [milestone("M1", "goals:G1", false)],
      items: [goal("G1", true)],
    };
    expect(codes(validateHierarchyState(orphanMilestone))).toEqual([
      "active-child-of-archived-parent",
    ]);
    const orphanTask: HierarchySnapshot = {
      milestones: [milestone("M1", "goals:G1", true)],
      items: [goal("G1", true), task("T1", "M1", false)],
    };
    expect(codes(validateHierarchyState(orphanTask))).toEqual(["active-child-of-archived-parent"]);
    for (const archived of [false, true]) {
      const dangling: HierarchySnapshot = { milestones: [], items: [task("T1", "M404", archived)] };
      expect(codes(validateHierarchyState(dangling))).toEqual(["item-milestone-unresolved"]);
    }
  });

  it("rejects a persisted attached goal or synthetic placement", () => {
    const attachedGoal: HierarchySnapshot = {
      milestones: [],
      items: [{ ...goal("G1", false), placement: inMilestone(MILESTONES_AMBIENT_ID) }],
    };
    expect(codes(validateHierarchyState(attachedGoal))).toEqual(["attached-goal"]);
  });
});

describe("archive ordering", () => {
  it("archives child-before-parent", () => {
    expect(codes(checkArchive(HEALTHY, { ledger: GOALS_LEDGER, id: "G1" }))).toEqual([
      "archive-with-active-children",
    ]);
    expect(codes(checkArchive(HEALTHY, { ledger: MILESTONES_LEDGER, id: "M1" }))).toEqual([
      "archive-with-active-children",
      "archive-with-active-children",
    ]);
    expect(checkArchive(HEALTHY, { ledger: TASKS_LEDGER, id: "T1" })).toEqual({ ok: true });

    const childrenArchived: HierarchySnapshot = {
      milestones: [milestone("M1", "goals:G1", true)],
      items: [goal("G1", false), task("T1", "M1", true)],
    };
    expect(checkArchive(childrenArchived, { ledger: GOALS_LEDGER, id: "G1" })).toEqual({
      ok: true,
    });
    expect(codes(checkArchive(childrenArchived, { ledger: TASKS_LEDGER, id: "T1" }))).toEqual([
      "node-already-in-state",
    ]);
    expect(codes(checkArchive(childrenArchived, { ledger: TASKS_LEDGER, id: "T404" }))).toEqual([
      "node-not-found",
    ]);
  });

  it("unarchives parent-before-child", () => {
    const allArchived: HierarchySnapshot = {
      milestones: [milestone("M1", "goals:G1", true)],
      items: [goal("G1", true), task("T1", "M1", true)],
    };
    expect(codes(checkUnarchive(allArchived, { ledger: TASKS_LEDGER, id: "T1" }))).toEqual([
      "unarchive-under-archived-parent",
    ]);
    expect(codes(checkUnarchive(allArchived, { ledger: MILESTONES_LEDGER, id: "M1" }))).toEqual([
      "unarchive-under-archived-parent",
    ]);
    expect(checkUnarchive(allArchived, { ledger: GOALS_LEDGER, id: "G1" })).toEqual({ ok: true });

    const goalRestored: HierarchySnapshot = {
      ...allArchived,
      items: [goal("G1", false), task("T1", "M1", true)],
    };
    expect(checkUnarchive(goalRestored, { ledger: MILESTONES_LEDGER, id: "M1" })).toEqual({
      ok: true,
    });
    expect(codes(checkUnarchive(goalRestored, { ledger: GOALS_LEDGER, id: "G1" }))).toEqual([
      "node-already-in-state",
    ]);

    const unresolvedParent: HierarchySnapshot = {
      milestones: [milestone("M1", "goals:G404", true)],
      items: [],
    };
    expect(
      codes(checkUnarchive(unresolvedParent, { ledger: MILESTONES_LEDGER, id: "M1" })),
    ).toEqual(["unarchive-under-archived-parent"]);
  });
});
