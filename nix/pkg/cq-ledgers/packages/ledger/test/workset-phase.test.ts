/**
 * T1952 — phase-aware goal draft vs finalized manifest continuity.
 *
 * Stale/superseded exclusion: clarifying/planning use only parseable
 * planCurrentDraft; planned/building use only planFinalizedManifest.
 */

import { describe, expect, it } from "bun:test";
import {
  buildWorksetActiveState,
  closeWorkset,
  WORKSET_OWNER_EDGE_KIND_FIELD,
  WORKSET_OWNER_REF_FIELD,
  type Item,
} from "../src/index.js";

const NOW = "2026-08-08T12:00:00.000Z";

function item(id: string, status: string, fields: Item["fields"], milestoneId = "M-AMBIENT"): Item {
  return { id, milestoneId, status, fields, createdAt: NOW, updatedAt: NOW };
}

function draftEnvelope(goalId: string, manifest: object): string {
  return JSON.stringify({
    identity: { goalId, claimId: "claim_g", generation: 1, revision: 1 },
    manifest,
  });
}

describe("workset-phase — clarifying/planning current draft", () => {
  it("includes only exact parseable current-draft members", () => {
    const draftManifest = {
      revision: 1,
      milestones: [{ key: "m1", id: "M1" }],
      tasks: [{ key: "t1", id: "T1" }],
    };
    const staleManifest = {
      revision: 0,
      milestones: [{ key: "m0", id: "M0" }],
      tasks: [{ key: "t0", id: "T0" }],
    };
    const goal = item("G1", "planning", {
      title: "g",
      description: "d",
      planCurrentDraft: draftEnvelope("G1", draftManifest),
      // Stale finalized must not join while still planning.
      planFinalizedManifest: JSON.stringify(staleManifest),
    });
    const m1 = item("M1", "open", { title: "current" });
    const t1 = item("T1", "planned", { headline: "current" }, "M1");
    const m0 = item("M0", "open", { title: "stale" });
    const t0 = item("T0", "planned", { headline: "stale" }, "M0");
    const state = buildWorksetActiveState([
      { ledger: "goals", items: [goal] },
      { ledger: "milestones", items: [m1, m0] },
      { ledger: "tasks", items: [t1, t0] },
    ]);
    const graph = closeWorkset(["goals:G1"], state);
    const refs = graph.nodes.map((n) => n.ref).sort();
    expect(refs).toEqual(["goals:G1", "milestones:M1", "tasks:T1"].sort());
    expect(refs).not.toContain("milestones:M0");
    expect(refs).not.toContain("tasks:T0");
    expect(
      graph.edges.some(
        (e) => e.kind === "active-current-draft" && e.to === "tasks:T1",
      ),
    ).toBe(true);
  });

  it("excludes unparseable current draft (stale-draft fail-closed)", () => {
    const goal = item("G1", "clarifying", {
      title: "g",
      description: "d",
      planCurrentDraft: "not-json",
    });
    const t1 = item("T1", "planned", {
      headline: "orphan sealed",
      [WORKSET_OWNER_REF_FIELD]: "goals:G1",
      [WORKSET_OWNER_EDGE_KIND_FIELD]: "active-current-draft",
    });
    const state = buildWorksetActiveState([
      { ledger: "goals", items: [goal] },
      { ledger: "tasks", items: [t1] },
    ]);
    const graph = closeWorkset(["goals:G1"], state);
    expect(graph.nodes.map((n) => n.ref)).toEqual(["goals:G1"]);
  });
});

describe("workset-phase — planned/building finalized manifest", () => {
  it("retains exact finalized manifest across planned and building", () => {
    const manifest = {
      revision: 2,
      milestones: [{ key: "m1", id: "M1" }],
      tasks: [
        { key: "t1", id: "T1" },
        { key: "t2", id: "T2" },
      ],
    };
    const oldDraft = {
      revision: 1,
      milestones: [{ key: "m9", id: "M9" }],
      tasks: [{ key: "t9", id: "T9" }],
    };

    for (const phase of ["planned", "building"] as const) {
      const goal = item("G1", phase, {
        title: "g",
        description: "d",
        planFinalizedManifest: JSON.stringify(manifest),
        planCurrentDraft: draftEnvelope("G1", oldDraft),
      });
      const state = buildWorksetActiveState([
        { ledger: "goals", items: [goal] },
        {
          ledger: "milestones",
          items: [item("M1", "open", { title: "m" }), item("M9", "open", { title: "old" })],
        },
        {
          ledger: "tasks",
          items: [
            item("T1", "planned", { headline: "a" }, "M1"),
            item("T2", "wip", { headline: "b" }, "M1"),
            item("T9", "planned", { headline: "old" }, "M9"),
          ],
        },
      ]);
      const graph = closeWorkset(["goals:G1"], state);
      const refs = graph.nodes.map((n) => n.ref).sort();
      expect(refs).toEqual(
        ["goals:G1", "milestones:M1", "tasks:T1", "tasks:T2"].sort(),
      );
      expect(refs).not.toContain("tasks:T9");
      expect(refs).not.toContain("milestones:M9");
      expect(
        graph.edges.filter((e) => e.kind === "finalized-manifest").length,
      ).toBeGreaterThan(0);
      expect(graph.edges.some((e) => e.kind === "active-current-draft")).toBe(false);
    }
  });

  it("phase continuity: planning→planned drops draft-only nodes and keeps finalized", () => {
    const draftOnly = {
      revision: 1,
      milestones: [{ key: "m1", id: "M1" }],
      tasks: [{ key: "t1", id: "T1" }, { key: "t-draft", id: "T8" }],
    };
    const finalized = {
      revision: 2,
      milestones: [{ key: "m1", id: "M1" }],
      tasks: [{ key: "t1", id: "T1" }],
    };

    const planningGoal = item("G1", "planning", {
      title: "g",
      description: "d",
      planCurrentDraft: draftEnvelope("G1", draftOnly),
    });
    const items = {
      milestones: [item("M1", "open", { title: "m" })],
      tasks: [
        item("T1", "planned", { headline: "kept" }, "M1"),
        item("T8", "planned", { headline: "draft-only" }, "M1"),
      ],
    };
    const planningState = buildWorksetActiveState([
      { ledger: "goals", items: [planningGoal] },
      { ledger: "milestones", items: items.milestones },
      { ledger: "tasks", items: items.tasks },
    ]);
    const planningGraph = closeWorkset(["goals:G1"], planningState);
    expect(planningGraph.nodes.map((n) => n.ref)).toContain("tasks:T8");

    const buildingGoal = item("G1", "building", {
      title: "g",
      description: "d",
      planCurrentDraft: draftEnvelope("G1", draftOnly),
      planFinalizedManifest: JSON.stringify(finalized),
    });
    const buildingState = buildWorksetActiveState([
      { ledger: "goals", items: [buildingGoal] },
      { ledger: "milestones", items: items.milestones },
      { ledger: "tasks", items: items.tasks },
    ]);
    const buildingGraph = closeWorkset(["goals:G1"], buildingState);
    const refs = buildingGraph.nodes.map((n) => n.ref);
    expect(refs).toContain("tasks:T1");
    expect(refs).not.toContain("tasks:T8");
  });
});

describe("workset-phase — superseded review exclusion via owner status", () => {
  it("does not include sealed children when owner status no longer allows the edge", () => {
    // Idea owner must be open/postponed for idea-to-goal. Terminal planned idea
    // must not expand goals.
    const idea = item("I1", "planned", { title: "spent idea" });
    const goal = item("G1", "clarifying", {
      title: "g",
      description: "d",
      [WORKSET_OWNER_REF_FIELD]: "ideas:I1",
      [WORKSET_OWNER_EDGE_KIND_FIELD]: "idea-to-goal",
    });
    const state = buildWorksetActiveState([
      { ledger: "ideas", items: [idea] },
      { ledger: "goals", items: [goal] },
    ]);
    const graph = closeWorkset(["ideas:I1"], state);
    expect(graph.nodes.map((n) => n.ref)).toEqual(["ideas:I1"]);
    expect(graph.nodes.map((n) => n.ref)).not.toContain("goals:G1");
  });
});
