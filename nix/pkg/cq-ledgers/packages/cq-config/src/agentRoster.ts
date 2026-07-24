/**
 * The Q148/Q158 agent-role model-resolution view, generated from the canonical
 * Nix prompt catalog's `(roleId, roleKind)` pairs.
 *
 * Two consumers must agree on the SAME 24 roles and which of them carry an
 * `[agent_tiers]` key:
 *  - the ledger-mcp `computeAgentModels` capability (the `get_agent_models`
 *    server payload), and
 *  - the ledger-web `gen-agents-catalogue.ts` codegen (the committed
 *    `AGENT_ROLES` catalogue).
 *
 * The generated projection keeps the server's per-role model overlay and the
 * web catalogue from drifting apart without another authored roster.
 */

import { PROMPT_CATALOG_PROJECTION } from "./promptCatalog.gen.js";

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
 * The Q148 roles in canonical Nix-catalog order. Dispatched roles remain
 * model-configurable by their role id; orchestrator commands remain null.
 */
export const AGENT_ROLE_TIERS: readonly AgentRoleTier[] =
  PROMPT_CATALOG_PROJECTION.catalog.map((role) => ({
    id: role.roleId,
    agentTierKey: role.roleKind === "dispatched-subagent" ? role.roleId : null,
  }));
