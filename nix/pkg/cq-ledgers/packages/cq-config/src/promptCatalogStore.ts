/**
 * The typed prompt-catalog STORE (T341, goal G41) — the node-free registry that
 * joins each DISPATCHED-SUBAGENT role id to its per-role schema sidecar
 * (storage-format decision 3). This is the SINGLE SOURCE of the dispatched
 * roles' input/output contracts:
 *
 *  - the ledger-web `gen-agents-catalogue.ts` codegen reads it to emit the typed
 *    `inputSchema`/`outputSchema` onto the committed `AGENT_ROLES` catalogue, and
 *  - ledger-mcp can import it DIRECTLY (it already depends on `@cq/config`) — no
 *    duplicate copy of the schemas anywhere.
 *
 * Only the seven DISPATCHED-SUBAGENT roles (non-null `agentTierKey` in
 * {@link AGENT_ROLE_TIERS}) have a sidecar here; orchestrator-command roles carry
 * prompt + metadata only and intentionally have no entry (role-scope decision 1).
 *
 * The module is browser-bundleable: it imports no `node:*` builtins, only the
 * pure sidecar objects. An invariant test (cq-config) asserts the map's key set
 * EXACTLY equals the dispatched-role subset of the shared roster, so a new
 * dispatched role cannot be added to the roster without its sidecar.
 */

import { AGENT_ROLE_TIERS } from "./agentRoster.js";
import type { RoleSchemaSidecar } from "./promptCatalog.js";
import { planAdvanceSidecar } from "./schemas/plan-advance.js";
import { planReviewerSidecar } from "./schemas/plan-reviewer.js";
import { implementWorkerSidecar } from "./schemas/implement-worker.js";
import { implementReviewerSidecar } from "./schemas/implement-reviewer.js";
import { implementConflictResolverSidecar } from "./schemas/implement-conflict-resolver.js";
import { investigateExplorerSidecar } from "./schemas/investigate-explorer.js";
import { investigateProberSidecar } from "./schemas/investigate-prober.js";
import { researchExplorerSidecar } from "./schemas/research-explorer.js";
import { researchExperimenterSidecar } from "./schemas/research-experimenter.js";

/**
 * The per-role schema sidecar for every DISPATCHED-SUBAGENT role, keyed by role
 * id. Insertion order follows the {@link AGENT_ROLE_TIERS} subagent order for
 * deterministic iteration. Orchestrator-command roles are absent by design.
 */
export const DISPATCHED_ROLE_SIDECARS: Readonly<Record<string, RoleSchemaSidecar>> = {
  "plan-advance": planAdvanceSidecar,
  "plan-reviewer": planReviewerSidecar,
  "implement-worker": implementWorkerSidecar,
  "implement-reviewer": implementReviewerSidecar,
  "implement-conflict-resolver": implementConflictResolverSidecar,
  "investigate-explorer": investigateExplorerSidecar,
  "investigate-prober": investigateProberSidecar,
  "research-explorer": researchExplorerSidecar,
  "research-experimenter": researchExperimenterSidecar,
};

/** The dispatched-subagent role ids (non-null agentTierKey) from the shared roster. */
export const DISPATCHED_ROLE_IDS: readonly string[] = AGENT_ROLE_TIERS.filter(
  (r) => r.agentTierKey !== null,
).map((r) => r.id);

/**
 * Look up the schema sidecar for a dispatched role id, or `undefined` for an
 * orchestrator-command id (which has no parent-validated contract).
 */
export function getRoleSidecar(roleId: string): RoleSchemaSidecar | undefined {
  return DISPATCHED_ROLE_SIDECARS[roleId];
}
