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
// Helpers — author node.fill from node.roleKind (locked Q181: authored HERE).
// ---------------------------------------------------------------------------

/**
 * Build a {@link RoleNode} with `fill` authored from its `roleKind` via
 * {@link fillForRoleKind} (T327 (c)). Centralises the rule so EVERY node in
 * every flow carries `fill === fillForRoleKind(node.roleKind)`. `agentId` is
 * set ONLY for concrete dispatched-subagent / sub-flow-command nodes (T327
 * (a)); abstract nodes (user / main / worktree / ledger / flow-lane) omit it.
 */
function roleNode(
  id: string,
  label: string,
  roleKind: RoleKind,
  agentId?: string,
): RoleNode {
  const node: RoleNode = { id, label, roleKind, fill: fillForRoleKind(roleKind) };
  if (agentId !== undefined) node.agentId = agentId;
  return node;
}

/**
 * Post-processing pass (T333): mark each node whose id appears as the source
 * of zero edges in the given `edges` array as `terminal: true`. Nodes that
 * DO have at least one outgoing edge leave `terminal` unset (i.e. the
 * DiagramSvg default, non-terminal, applies).
 *
 * Pure function — returns new node objects; does not mutate the input arrays.
 */
function withTerminalNodes(nodes: RoleNode[], edges: RoleEdge[]): RoleNode[] {
  const hasSources = new Set(edges.map((e) => e.from));
  return nodes.map((n) =>
    hasSources.has(n.id) ? n : { ...n, terminal: true },
  );
}

// ---------------------------------------------------------------------------
// Plan flow — orchestrator ↔ planner ↔ reviewer ↔ user, over the ledger.
// Formalized ops (commands/cq/plan/advance.md): dispatch planner / reviewer,
// emit candidate plan, return verdict, criticism re-dispatch, register
// questions, planning-lock + per-round ledger commit, and the auto-investigate
// cross-flow handoff (file defect → investigate).
// ---------------------------------------------------------------------------

const planRoleNodes: RoleNode[] = [
  roleNode("orchestrator", "orchestrator", "orchestrator"),
  roleNode("planner", "planner", "planner", "plan-advance"),
  roleNode("reviewer", "reviewer", "reviewer", "plan-reviewer"),
  roleNode("user", "user", "user"),
  roleNode("ledger", "ledger", "ledger"),
  roleNode("investigate-flow", "investigate flow", "external", "investigate/advance"),
];

const planRoleEdges: RoleEdge[] = [
  { from: "orchestrator", to: "planner", label: "dispatches planner" },
  { from: "planner", to: "orchestrator", label: "emits candidate plan" },
  { from: "orchestrator", to: "reviewer", label: "dispatches reviewer" },
  { from: "reviewer", to: "orchestrator", label: "returns verdict" },
  // Critic loop: reviewer disapproves → orchestrator re-dispatches planner.
  { from: "orchestrator", to: "planner", label: "re-dispatches (criticism)" },
  // Planner needs user input → orchestrator registers open questions.
  { from: "planner", to: "user", label: "registers questions" },
  { from: "user", to: "orchestrator", label: "answers questions" },
  // Plan reaches `planned`: orchestrator locks the plan into the ledger.
  { from: "orchestrator", to: "ledger", label: "locks plan (planned)" },
  // Per-round ledger commit (planning-lock artifacts) lands in the ledger.
  { from: "orchestrator", to: "ledger", label: "commits ledger (per round)" },
  // Cross-flow: auto-investigate a goal-linked defect → investigate flow.
  { from: "orchestrator", to: "investigate-flow", label: "files defect → investigate" },
];

const planRoleFlow: RoleFlowDefinition = {
  id: "plan",
  title: "Plan flow — roles & actions",
  model: { nodes: withTerminalNodes(planRoleNodes, planRoleEdges), edges: planRoleEdges },
};

// ---------------------------------------------------------------------------
// Investigate flow — orchestrator ↔ explorer ↔ prober ↔ user, over the ledger.
// Formalized ops (commands/cq/investigate/advance.md): dispatch explorer
// (read-only), dispatch prober (isolation=worktree) on a probeRequest, prober
// worktree create + teardown, return citations, hypothesis-tree ledger writes,
// and the file-and-defer cross-flow handoff (seed/extend goal → plan flow).
// ---------------------------------------------------------------------------

const investigateRoleNodes: RoleNode[] = [
  roleNode("orchestrator", "orchestrator", "orchestrator"),
  roleNode("explore", "explorer", "explore", "investigate-explorer"),
  roleNode("prober", "prober", "worker", "investigate-prober"),
  roleNode("user", "user", "user"),
  roleNode("worktree", "probe worktree", "worktree"),
  roleNode("ledger", "ledger", "ledger"),
  roleNode("plan-flow", "plan flow", "external", "plan/advance"),
];

const investigateRoleEdges: RoleEdge[] = [
  { from: "orchestrator", to: "explore", label: "dispatches explorer" },
  { from: "explore", to: "orchestrator", label: "returns citations" },
  // Orchestrator adjudicates hypothesis nodes and re-dispatches on new leads.
  { from: "orchestrator", to: "explore", label: "re-dispatches (new lead)" },
  // Explorer requests a probe → orchestrator dispatches the prober into a
  // throwaway worktree, which is created then torn down after harvest.
  { from: "orchestrator", to: "worktree", label: "creates probe worktree" },
  { from: "orchestrator", to: "prober", label: "dispatches prober" },
  { from: "prober", to: "orchestrator", label: "returns probe evidence" },
  { from: "orchestrator", to: "worktree", label: "tears down / prunes worktree" },
  // Validated hypothesis-tree mutations land in the ledger.
  { from: "orchestrator", to: "ledger", label: "writes hypothesis tree" },
  // Confirmed root cause: file-and-defer — seed/extend a goal → plan flow.
  { from: "orchestrator", to: "plan-flow", label: "seeds goal → plan" },
  // User can close or wontfix the defect at any point.
  { from: "user", to: "orchestrator", label: "wontfix / close" },
];

const investigateRoleFlow: RoleFlowDefinition = {
  id: "investigate",
  title: "Investigate flow — roles & actions",
  model: { nodes: withTerminalNodes(investigateRoleNodes, investigateRoleEdges), edges: investigateRoleEdges },
};

// ---------------------------------------------------------------------------
// Implement flow — orchestrator ↔ worker ↔ reviewer ↔ conflict-resolver ↔ user,
// over the worktree / main / ledger git+ledger substrate.
// Formalized ops (commands/cq/implement/advance.md): worktree prune sweep +
// create, dispatch worker (isolation=worktree), emit result commit, dispatch
// reviewer, return verdict, criticism re-dispatch, register questions, file
// out-of-scope defect → investigate (file-and-defer), rebase-before-merge,
// dispatch conflict-resolver on conflict, merge-by-SHA into main, explicit
// worktree teardown/prune, and per-task ledger commit after every merge-back.
// ---------------------------------------------------------------------------

const implementRoleNodes: RoleNode[] = [
  roleNode("orchestrator", "orchestrator", "orchestrator"),
  roleNode("worker", "worker", "worker", "implement-worker"),
  roleNode("reviewer", "reviewer", "reviewer", "implement-reviewer"),
  roleNode("conflict-resolver", "conflict-resolver", "conflict-resolver", "implement-conflict-resolver"),
  roleNode("user", "user", "user"),
  roleNode("worktree", "worktree", "worktree"),
  roleNode("main", "main branch", "main"),
  roleNode("ledger", "ledger", "ledger"),
  roleNode("investigate-flow", "investigate flow", "external", "investigate/advance"),
];

const implementRoleEdges: RoleEdge[] = [
  // Start-of-pass sweep + per-task worktree creation on the worktree substrate.
  { from: "orchestrator", to: "worktree", label: "creates worktree" },
  { from: "orchestrator", to: "worker", label: "dispatches worker" },
  { from: "worker", to: "orchestrator", label: "emits result commit" },
  { from: "orchestrator", to: "reviewer", label: "dispatches reviewer" },
  { from: "reviewer", to: "orchestrator", label: "returns verdict" },
  // Autonomous criticism loop: reviewer disapproves → re-dispatch worker.
  { from: "orchestrator", to: "worker", label: "re-dispatches (criticism)" },
  // Reviewer files out-of-scope defect → investigate (file-and-defer).
  { from: "orchestrator", to: "investigate-flow", label: "files defect → investigate" },
  // User questions park the task.
  { from: "worker", to: "user", label: "registers question" },
  { from: "user", to: "orchestrator", label: "answers question" },
  // Merge-back: rebase the branch onto the current base before merging.
  { from: "orchestrator", to: "worktree", label: "rebases branch" },
  // On a rebase conflict → dispatch the conflict-resolver.
  { from: "orchestrator", to: "conflict-resolver", label: "dispatches on conflict" },
  { from: "conflict-resolver", to: "orchestrator", label: "returns resolved commit" },
  // Clean rebase → fast-forward merge the result commit into main.
  { from: "orchestrator", to: "main", label: "merges by SHA" },
  // Per-task ledger commit after every merge-back.
  { from: "orchestrator", to: "ledger", label: "commits ledger (per task)" },
  // Explicit worktree teardown + prune after a merged task.
  { from: "orchestrator", to: "worktree", label: "tears down / prunes worktree" },
];

const implementRoleFlow: RoleFlowDefinition = {
  id: "implement",
  title: "Implement flow — roles & actions",
  model: { nodes: withTerminalNodes(implementRoleNodes, implementRoleEdges), edges: implementRoleEdges },
};

// ---------------------------------------------------------------------------
// Advance sequencer — orchestrator drives all three flows in sequence
// ---------------------------------------------------------------------------

// Each lane is the concrete sub-flow COMMAND the sequencer chains (Q180:
// "if the flow … dispatches a subagent of a particular type — it should be
// visible"); its agentId is that command's catalogue id so the node activates.
const advanceRoleNodes: RoleNode[] = [
  roleNode("orchestrator", "orchestrator", "orchestrator"),
  roleNode("investigate-flow", "investigate flow", "external", "investigate/advance"),
  roleNode("plan-flow", "plan flow", "external", "plan/advance"),
  roleNode("implement-flow", "implement flow", "external", "implement/advance"),
  roleNode("user", "user", "user"),
  roleNode("ledger", "ledger", "ledger"),
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
  // Run-stop handoff: write the handoffs item + run-stop ledger commit.
  { from: "orchestrator", to: "ledger", label: "commits run-stop handoff" },
  // Blocked on user questions.
  { from: "orchestrator", to: "user", label: "registers blocking questions" },
  { from: "user", to: "orchestrator", label: "answers questions" },
];

const advanceRoleFlow: RoleFlowDefinition = {
  id: "advance",
  title: "Advance sequencer — roles & actions",
  model: { nodes: withTerminalNodes(advanceRoleNodes, advanceRoleEdges), edges: advanceRoleEdges },
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
