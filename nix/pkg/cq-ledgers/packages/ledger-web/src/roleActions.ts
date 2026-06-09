/**
 * Hand-authored role→actions catalogue for the Flows tab (T315).
 *
 * This module mirrors {@link ./flowData.ts} in export style: a typed model
 * plus a single exported array the UI tab consumes. Where `flowData` models
 * LEDGER STATES (goals, defects, tasks) and their transitions, this module
 * models ROLES (orchestrator, planner, reviewer, worker, …) and the labeled
 * ACTIONS they exchange in each cq: flow.
 *
 * The shape is intentionally type-assignable to the same {@link DiagramModel}
 * the {@link layoutDiagram} / {@link DiagramSvg} pipeline consumes. Each
 * flow's `nodes` are roles (one box per actor) and each `edges` entry is an
 * action message from one role to another.
 *
 * Hand-authored — do NOT parse prompts or generate this file. Keep it in sync
 * with the role descriptions in `nix/pkg/cq-assets/`.
 *
 * This module is node-free / browser-bundleable: no `node:*` imports.
 */

import type { DiagramModel, DiagramNode, DiagramEdge } from "./diagramLayout.js";

/**
 * The kind of actor (or infra element) a {@link RoleNode} represents.
 *
 * Role actors:
 * - `orchestrator` — the flow's controlling agent (owns ledger mutations).
 * - `planner`       — produces / revises the plan candidate.
 * - `reviewer`      — adversarially reviews outputs (plan or implementation).
 * - `worker`        — the implement-flow worker subagent.
 * - `conflict-resolver` — settles reviewer disputes.
 * - `explore`       — read-only explorer spawned by investigate-flow.
 * - `user`          — the human interacting via questions/answers.
 * - `external`      — an external system or flow receiving a handoff.
 *
 * Infra elements (T327 — git/ledger substrate the agents act on):
 * - `worktree`      — an isolated git worktree a worker operates in.
 * - `main`          — the main checkout / branch merge-back targets.
 * - `ledger`        — the markdown-backed planning ledger.
 */
export type RoleKind =
  | "orchestrator"
  | "planner"
  | "reviewer"
  | "worker"
  | "conflict-resolver"
  | "explore"
  | "user"
  | "external"
  | "worktree"
  | "main"
  | "ledger";

/**
 * One distinct hue per {@link RoleKind}, keyed exhaustively on the named type
 * (the `Record<RoleKind, string>` annotation forces every kind to be present).
 * T327 authors `node.fill` from this map; the {@link DiagramSvg} renderer does
 * NOT consult it — it honors only the authored `fill` (locked Q181).
 */
export const ROLE_KIND_FILL: Record<RoleKind, string> = {
  orchestrator: "#4ea1ff",
  planner: "#9d7bff",
  reviewer: "#e0b341",
  worker: "#57d18a",
  "conflict-resolver": "#ff7b9d",
  explore: "#41d6e0",
  user: "#f0f0f0",
  external: "#8b93a7",
  worktree: "#c98a3a",
  main: "#3a6ec9",
  ledger: "#7bc94f",
};

/** Resolve the fill hue for a {@link RoleKind} from {@link ROLE_KIND_FILL}. */
export function fillForRoleKind(kind: RoleKind): string {
  return ROLE_KIND_FILL[kind];
}

/**
 * A role node in a flow diagram. Widens {@link DiagramNode} with a
 * `roleKind` discriminator for optional downstream styling, and an optional
 * `agentId` (inherited from {@link DiagramNode}) that makes the node
 * activatable in {@link DiagramSvg}. Assignable to `DiagramNode`, so the array
 * feeds `layoutDiagram` directly.
 */
export interface RoleNode extends DiagramNode {
  roleKind?: RoleKind;
}

/** A role action edge — identical to the generic {@link DiagramEdge}. */
export type RoleEdge = DiagramEdge;

/** One flow's role→actions render-data: an id, a human title, and its graph. */
export interface RoleFlowDefinition {
  id: string;
  title: string;
  model: DiagramModel;
}

// ---------------------------------------------------------------------------
// Plan flow — orchestrator ↔ planner ↔ reviewer ↔ user
// ---------------------------------------------------------------------------

const planRoleNodes: RoleNode[] = [
  { id: "orchestrator", label: "orchestrator", roleKind: "orchestrator" },
  { id: "planner", label: "planner", roleKind: "planner" },
  { id: "reviewer", label: "reviewer", roleKind: "reviewer" },
  { id: "user", label: "user", roleKind: "user" },
];

const planRoleEdges: RoleEdge[] = [
  { from: "orchestrator", to: "planner", label: "dispatches planner" },
  { from: "planner", to: "orchestrator", label: "emits candidate plan" },
  { from: "orchestrator", to: "reviewer", label: "dispatches reviewer" },
  { from: "reviewer", to: "orchestrator", label: "returns verdict" },
  // Critic loop: reviewer disapproves → orchestrator re-dispatches planner.
  { from: "orchestrator", to: "planner", label: "re-dispatches (criticism)" },
  // Planner needs user input → orchestrator registers open questions.
  { from: "planner", to: "user", label: "files questions" },
  { from: "user", to: "orchestrator", label: "answers questions" },
  // Orchestrator locks the plan once reviewer approves.
  { from: "orchestrator", to: "orchestrator", label: "locks plan (decision)" },
];

const planRoleFlow: RoleFlowDefinition = {
  id: "plan",
  title: "Plan flow — roles & actions",
  model: { nodes: planRoleNodes, edges: planRoleEdges },
};

// ---------------------------------------------------------------------------
// Investigate flow — orchestrator ↔ explore ↔ user
// ---------------------------------------------------------------------------

const investigateRoleNodes: RoleNode[] = [
  { id: "orchestrator", label: "orchestrator", roleKind: "orchestrator" },
  { id: "explore", label: "explorer", roleKind: "explore" },
  { id: "user", label: "user", roleKind: "user" },
];

const investigateRoleEdges: RoleEdge[] = [
  { from: "orchestrator", to: "explore", label: "dispatches explorer" },
  { from: "explore", to: "orchestrator", label: "returns citations" },
  // Orchestrator adjudicates hypothesis nodes and re-dispatches on new leads.
  { from: "orchestrator", to: "explore", label: "re-dispatches (new lead)" },
  // Confirmed root cause seeds a goal → plan flow handoff.
  { from: "orchestrator", to: "orchestrator", label: "seeds goal → plan" },
  // User can close or wontfix the defect at any point.
  { from: "user", to: "orchestrator", label: "wontfix / close" },
];

const investigateRoleFlow: RoleFlowDefinition = {
  id: "investigate",
  title: "Investigate flow — roles & actions",
  model: { nodes: investigateRoleNodes, edges: investigateRoleEdges },
};

// ---------------------------------------------------------------------------
// Implement flow — orchestrator ↔ worker ↔ reviewer ↔ user
// ---------------------------------------------------------------------------

const implementRoleNodes: RoleNode[] = [
  { id: "orchestrator", label: "orchestrator", roleKind: "orchestrator" },
  { id: "worker", label: "worker", roleKind: "worker" },
  { id: "reviewer", label: "reviewer", roleKind: "reviewer" },
  { id: "user", label: "user", roleKind: "user" },
  { id: "main", label: "main branch", roleKind: "external" },
];

const implementRoleEdges: RoleEdge[] = [
  { from: "orchestrator", to: "worker", label: "dispatches worker" },
  { from: "worker", to: "orchestrator", label: "emits result commit" },
  { from: "orchestrator", to: "reviewer", label: "dispatches reviewer" },
  { from: "reviewer", to: "orchestrator", label: "returns verdict" },
  // Autonomous criticism loop: reviewer disapproves → re-dispatch worker.
  { from: "orchestrator", to: "worker", label: "re-dispatches (criticism)" },
  // Reviewer files out-of-scope defect → investigate.
  { from: "reviewer", to: "orchestrator", label: "files defect" },
  // User questions park the task.
  { from: "worker", to: "user", label: "registers question" },
  { from: "user", to: "orchestrator", label: "answers question" },
  // Merge-back: orchestrator rebases and pushes to main.
  { from: "orchestrator", to: "main", label: "merges by SHA" },
];

const implementRoleFlow: RoleFlowDefinition = {
  id: "implement",
  title: "Implement flow — roles & actions",
  model: { nodes: implementRoleNodes, edges: implementRoleEdges },
};

// ---------------------------------------------------------------------------
// Advance sequencer — orchestrator drives all three flows in sequence
// ---------------------------------------------------------------------------

const advanceRoleNodes: RoleNode[] = [
  { id: "orchestrator", label: "orchestrator", roleKind: "orchestrator" },
  { id: "investigate-flow", label: "investigate flow", roleKind: "external" },
  { id: "plan-flow", label: "plan flow", roleKind: "external" },
  { id: "implement-flow", label: "implement flow", roleKind: "external" },
  { id: "user", label: "user", roleKind: "user" },
];

const advanceRoleEdges: RoleEdge[] = [
  // Orchestrator drives investigate, plan, implement in sequence each cycle.
  { from: "orchestrator", to: "investigate-flow", label: "advances investigate" },
  { from: "investigate-flow", to: "orchestrator", label: "done / seeded goal" },
  { from: "orchestrator", to: "plan-flow", label: "advances plan" },
  { from: "plan-flow", to: "orchestrator", label: "done / planned" },
  { from: "orchestrator", to: "implement-flow", label: "advances implement" },
  { from: "implement-flow", to: "orchestrator", label: "done / merged" },
  // After a full cycle the orchestrator checks for further work.
  { from: "orchestrator", to: "orchestrator", label: "checks drain condition" },
  // Blocked on user questions.
  { from: "orchestrator", to: "user", label: "registers blocking questions" },
  { from: "user", to: "orchestrator", label: "answers questions" },
];

const advanceRoleFlow: RoleFlowDefinition = {
  id: "advance",
  title: "Advance sequencer — roles & actions",
  model: { nodes: advanceRoleNodes, edges: advanceRoleEdges },
};

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

/**
 * The four per-flow role→actions catalogues, in the canonical order:
 * plan, investigate, implement, advance.
 *
 * Each entry's `model` is assignable to {@link DiagramModel} and feeds
 * `layoutDiagram` / `DiagramSvg` directly.
 */
export const ROLE_FLOWS: readonly RoleFlowDefinition[] = [
  planRoleFlow,
  investigateRoleFlow,
  implementRoleFlow,
  advanceRoleFlow,
];
