/**
 * Unit tests for the role→actions catalogue module (T315).
 *
 * Asserts the structural invariants the Flows tab relies on:
 *   - exactly four flows in the canonical order (plan, investigate,
 *     implement, advance);
 *   - every edge's from/to references a node id declared in that flow;
 *   - each flow has ≥1 role node and ≥1 labeled action edge;
 *   - each flow's model is assignable to DiagramModel (compile-time +
 *     run-time check).
 */

import { describe, it, expect } from "bun:test";
import { ROLE_FLOWS, fillForRoleKind, type RoleNode } from "../src/roleActions";
import { AGENT_ROLES } from "../src/agentsCatalogue";
import type { DiagramModel } from "../src/diagramLayout";

/** All RoleNodes across every flow, flattened (with their flow id for context). */
const ALL_NODES: { flow: string; node: RoleNode }[] = ROLE_FLOWS.flatMap((f) =>
  (f.model.nodes as RoleNode[]).map((node) => ({ flow: f.id, node })),
);

/** The abstract RoleKinds that NEVER carry an agentId (T327 (a)). */
const ABSTRACT_KINDS = new Set(["user", "main", "worktree", "ledger"]);

/** Look up one flow's model by id. */
function flow(id: string): DiagramModel {
  const f = ROLE_FLOWS.find((x) => x.id === id);
  if (f === undefined) throw new Error(`no such flow: ${id}`);
  return f.model;
}

/** Edge labels present in a flow (non-empty). */
function edgeLabels(id: string): string[] {
  return flow(id)
    .edges.map((e) => e.label)
    .filter((l): l is string => l !== undefined && l.length > 0);
}

describe("ROLE_FLOWS catalogue", () => {
  it("exports exactly four flows in canonical order", () => {
    expect(ROLE_FLOWS.map((f) => f.id)).toEqual([
      "plan",
      "investigate",
      "implement",
      "advance",
    ]);
  });

  it("every flow has a non-empty id and title", () => {
    for (const flow of ROLE_FLOWS) {
      expect(flow.id.length).toBeGreaterThan(0);
      expect(flow.title.length).toBeGreaterThan(0);
    }
  });

  it("every flow has ≥1 role node", () => {
    for (const flow of ROLE_FLOWS) {
      expect(flow.model.nodes.length).toBeGreaterThan(0);
    }
  });

  it("every flow has ≥1 labeled action edge", () => {
    for (const flow of ROLE_FLOWS) {
      const labeled = flow.model.edges.filter(
        (e) => e.label !== undefined && e.label.length > 0,
      );
      expect(labeled.length).toBeGreaterThan(0);
    }
  });

  it("resolves every edge from/to to a declared node id in the same flow", () => {
    for (const flow of ROLE_FLOWS) {
      const ids = new Set(flow.model.nodes.map((n) => n.id));
      for (const edge of flow.model.edges) {
        expect(ids.has(edge.from)).toBe(true);
        expect(ids.has(edge.to)).toBe(true);
      }
    }
  });

  it("uses unique node ids within each flow", () => {
    for (const flow of ROLE_FLOWS) {
      const ids = flow.model.nodes.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("every flow's model is assignable to DiagramModel", () => {
    for (const flow of ROLE_FLOWS) {
      // Compile-time + run-time check: DiagramModel = { nodes, edges }.
      const model: DiagramModel = flow.model;
      expect(model.nodes.length).toBe(flow.model.nodes.length);
      expect(model.edges.length).toBe(flow.model.edges.length);
    }
  });
});

// ---------------------------------------------------------------------------
// T327 (a) — agentId activation map.
// ---------------------------------------------------------------------------

describe("agentId activation map (T327 (a))", () => {
  const catalogueIds = new Set(AGENT_ROLES.map((r) => r.id));

  it("the agents catalogue actually contains the ids the flows reference", () => {
    // Guard: if the .gen catalogue were empty/stale, the ∈-membership test
    // below would pass vacuously for absent ids. Pin the ids the map depends on.
    for (const id of [
      "plan-advance",
      "plan-reviewer",
      "implement-worker",
      "implement-reviewer",
      "implement-conflict-resolver",
      "investigate-explorer",
      "investigate-prober",
      "investigate/advance",
      "plan/advance",
      "implement/advance",
    ]) {
      expect(catalogueIds.has(id)).toBe(true);
    }
  });

  it("every authored agentId is an id in AGENT_ROLES (imported from ./agentsCatalogue)", () => {
    for (const { flow, node } of ALL_NODES) {
      if (node.agentId !== undefined) {
        expect({ flow, id: node.id, agentId: node.agentId, inCatalogue: catalogueIds.has(node.agentId) }).toEqual(
          { flow, id: node.id, agentId: node.agentId, inCatalogue: true },
        );
      }
    }
  });

  it("abstract nodes (user/main/worktree/ledger/flow-lane) carry agentId === undefined", () => {
    for (const { node } of ALL_NODES) {
      if (node.roleKind !== undefined && ABSTRACT_KINDS.has(node.roleKind)) {
        expect(node.agentId).toBeUndefined();
      }
    }
  });

  it("maps each concrete dispatched subagent to its EXACT catalogue id", () => {
    const idOf = (flowId: string, nodeId: string): string | undefined =>
      (flow(flowId).nodes as RoleNode[]).find((n) => n.id === nodeId)?.agentId;

    // plan flow
    expect(idOf("plan", "planner")).toBe("plan-advance");
    expect(idOf("plan", "reviewer")).toBe("plan-reviewer");
    // implement flow
    expect(idOf("implement", "worker")).toBe("implement-worker");
    expect(idOf("implement", "reviewer")).toBe("implement-reviewer");
    expect(idOf("implement", "conflict-resolver")).toBe("implement-conflict-resolver");
    // investigate flow
    expect(idOf("investigate", "explore")).toBe("investigate-explorer");
    expect(idOf("investigate", "prober")).toBe("investigate-prober");
    // advance sequencer lanes → sub-flow command ids
    expect(idOf("advance", "investigate-flow")).toBe("investigate/advance");
    expect(idOf("advance", "plan-flow")).toBe("plan/advance");
    expect(idOf("advance", "implement-flow")).toBe("implement/advance");
  });
});

// ---------------------------------------------------------------------------
// T327 (b) — every formalized op surfaced as a labeled edge + infra node.
// ---------------------------------------------------------------------------

describe("formalized ops surfaced as edges + infra nodes (T327 (b))", () => {
  it("implement flow has a conflict-resolver node", () => {
    const kinds = (flow("implement").nodes as RoleNode[]).map((n) => n.roleKind);
    expect(kinds).toContain("conflict-resolver");
  });

  it("implement flow carries worktree create + teardown/prune + merge-by-SHA + ≥1 ledger-commit against infra nodes", () => {
    const edges = flow("implement").edges;
    const nodeKind = (id: string): string | undefined =>
      (flow("implement").nodes as RoleNode[]).find((n) => n.id === id)?.roleKind;

    const worktreeEdges = edges.filter((e) => nodeKind(e.to) === "worktree");
    expect(worktreeEdges.some((e) => /creates worktree/.test(e.label ?? ""))).toBe(true);
    expect(worktreeEdges.some((e) => /tears down|prune/.test(e.label ?? ""))).toBe(true);

    // merge-by-SHA (or cherry-pick) against the main infra node.
    const mergeEdge = edges.find(
      (e) => nodeKind(e.to) === "main" && /merges by SHA|cherry-pick/.test(e.label ?? ""),
    );
    expect(mergeEdge).toBeDefined();

    // ≥1 ledger-commit edge against the ledger infra node.
    const ledgerCommit = edges.filter(
      (e) => nodeKind(e.to) === "ledger" && /commit/i.test(e.label ?? ""),
    );
    expect(ledgerCommit.length).toBeGreaterThanOrEqual(1);
  });

  it("plan flow carries a cross-flow handoff edge that files a defect → investigate", () => {
    expect(edgeLabels("plan").some((l) => /defect → investigate/.test(l))).toBe(true);
  });

  it("investigate flow carries a cross-flow handoff edge that seeds a goal → plan", () => {
    expect(edgeLabels("investigate").some((l) => /goal → plan/.test(l))).toBe(true);
  });

  it("investigate flow surfaces the prober worktree create + teardown", () => {
    const edges = flow("investigate").edges;
    const nodeKind = (id: string): string | undefined =>
      (flow("investigate").nodes as RoleNode[]).find((n) => n.id === id)?.roleKind;
    const worktreeEdges = edges.filter((e) => nodeKind(e.to) === "worktree");
    expect(worktreeEdges.some((e) => /creates probe worktree/.test(e.label ?? ""))).toBe(true);
    expect(worktreeEdges.some((e) => /tears down|prune/.test(e.label ?? ""))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T333 — terminal nodes: zero outgoing edges ↔ terminal===true.
// ---------------------------------------------------------------------------

describe("terminal-node derivation (T333)", () => {
  it("every node with zero outgoing edges has terminal===true in every flow", () => {
    for (const f of ROLE_FLOWS) {
      const sources = new Set(f.model.edges.map((e) => e.from));
      for (const node of f.model.nodes as RoleNode[]) {
        if (!sources.has(node.id)) {
          expect({ flow: f.id, id: node.id, terminal: node.terminal }).toEqual({
            flow: f.id,
            id: node.id,
            terminal: true,
          });
        }
      }
    }
  });

  it("every node with ≥1 outgoing edge has terminal!==true in every flow", () => {
    for (const f of ROLE_FLOWS) {
      const sources = new Set(f.model.edges.map((e) => e.from));
      for (const node of f.model.nodes as RoleNode[]) {
        if (sources.has(node.id)) {
          expect({ flow: f.id, id: node.id, terminal: node.terminal }).toEqual({
            flow: f.id,
            id: node.id,
            terminal: undefined,
          });
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// T327 (c) — every node's fill is authored from its roleKind.
// ---------------------------------------------------------------------------

describe("authored fill === fillForRoleKind(roleKind) on every node (T327 (c))", () => {
  it("every node has a roleKind", () => {
    for (const { flow, node } of ALL_NODES) {
      expect({ flow, id: node.id, hasKind: node.roleKind !== undefined }).toEqual({
        flow,
        id: node.id,
        hasKind: true,
      });
    }
  });

  it("every node's fill equals fillForRoleKind(node.roleKind)", () => {
    for (const { flow, node } of ALL_NODES) {
      expect({ flow, id: node.id, fill: node.fill }).toEqual({
        flow,
        id: node.id,
        fill: fillForRoleKind(node.roleKind!),
      });
    }
  });
});
