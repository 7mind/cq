/**
 * The fixed Q148/Q158 agent-role roster — the SHARED anti-drift source of
 * truth for the `(id, agentTierKey)` pairs (T285).
 *
 * Two consumers must agree on the SAME 23 roles and which of them carry an
 * `[agent_tiers]` key:
 *  - the ledger-mcp `computeAgentModels` capability (the `get_agent_models`
 *    server payload), and
 *  - the ledger-web `gen-agents-catalogue.ts` codegen (the committed
 *    `AGENT_ROLES` catalogue).
 *
 * Defining the pairs ONCE here — rather than duplicating the literal list in
 * both places — keeps the server's per-role model overlay and the web
 * catalogue from drifting apart. The codegen owns the per-role DISPLAY
 * metadata (`name`/`kind`/`source`); this module owns only the join key (`id`)
 * and the model-configurability key (`agentTierKey`).
 */

/**
 * One role's stable identity for model resolution: its `AgentRole.id` (the
 * Q158 join key) and its `[agent_tiers]` lookup key, or `null` for a role that
 * is not separately model-configurable (every orchestrator command, which only
 * chains subagents).
 */
export interface AgentRoleTier {
  /** Stable role id (the `AgentRole.id` / `[agent_tiers]` key). */
  readonly id: string;
  /**
   * The `[agent_tiers]` lookup key for a model-configurable subagent, or null
   * for a role that is not separately model-configurable.
   */
  readonly agentTierKey: string | null;
}

/**
 * The 23 Q148 roles, in a fixed order matching the codegen ROLES table: the 9
 * subagents first (each model-configurable, `agentTierKey === id`), then the 14
 * orchestrator commands (not model-configurable, `agentTierKey === null`).
 */
export const AGENT_ROLE_TIERS: readonly AgentRoleTier[] = [
  // --- subagents (model-configurable) ---
  { id: "plan-advance", agentTierKey: "plan-advance" },
  { id: "plan-reviewer", agentTierKey: "plan-reviewer" },
  { id: "implement-worker", agentTierKey: "implement-worker" },
  { id: "implement-reviewer", agentTierKey: "implement-reviewer" },
  { id: "implement-conflict-resolver", agentTierKey: "implement-conflict-resolver" },
  { id: "investigate-explorer", agentTierKey: "investigate-explorer" },
  { id: "investigate-prober", agentTierKey: "investigate-prober" },
  { id: "research-explorer", agentTierKey: "research-explorer" },
  { id: "research-experimenter", agentTierKey: "research-experimenter" },
  // --- orchestrator commands (not model-configurable) ---
  { id: "advance", agentTierKey: null },
  { id: "plan", agentTierKey: null },
  { id: "plan/advance", agentTierKey: null },
  { id: "plan/follow-up", agentTierKey: null },
  { id: "investigate", agentTierKey: null },
  { id: "investigate/advance", agentTierKey: null },
  { id: "research", agentTierKey: null },
  { id: "research/advance", agentTierKey: null },
  { id: "implement/start", agentTierKey: null },
  { id: "implement/advance", agentTierKey: null },
  { id: "plan-review", agentTierKey: null },
  { id: "implement-review", agentTierKey: null },
  { id: "planners", agentTierKey: null },
  { id: "reviewers", agentTierKey: null },
];
