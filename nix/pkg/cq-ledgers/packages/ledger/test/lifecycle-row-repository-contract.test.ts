import { LedgerError } from "../src/types.js";
import { createInMemoryGenericMutationDataSource } from "../src/store/genericMutationDataSource.js";
import { claimScopeKey, operationScopeKey } from "../src/store/planLifecycleDump.js";
import type { LifecycleClaimKey, LifecycleOperationKey } from "../src/store/lifecycleRowRepository.js";
import {
  LIFECYCLE_ARCHIVED_ITEM, LIFECYCLE_LEDGER_METADATA, LIFECYCLE_PUBLIC_ITEMS,
  lifecycleClaim, lifecycleOperation, runLifecycleRowRepositoryContract,
  type LifecycleRowsFixture,
} from "./lifecycleRowRepositoryContract.js";

const claimIdentity = (key: LifecycleClaimKey): string => [key.goalId, key.claimId, key.generation].join("\u0000");
const operationIdentity = (key: LifecycleOperationKey): string =>
  operationScopeKey(key.goalId, key.claimId, key.generation, key.operation, key.operationId);

function restorePoint<K, V>(map: Map<K, V>): () => void {
  const saved = structuredClone(map);
  return () => {
    map.clear();
    for (const [key, value] of saved) map.set(key, value);
  };
}

function memoryFixture(): LifecycleRowsFixture {
  const claims = new Map(["G1", "G2"].map((goalId) => {
    const claim = lifecycleClaim(goalId);
    return [claimScopeKey(goalId, claim.claimRequestId), claim] as const;
  }));
  const byIdentity = new Map([...claims].map(([scope, claim]) => [claimIdentity(claim), scope]));
  const active = new Map([...claims].map(([scope, claim]) => [claim.goalId, scope]));
  const existing = lifecycleOperation("existing");
  const operations = new Map([[operationIdentity(existing.replay), existing]]);
  const completionBindings = new Map<string, string>();
  const taskGroups = new Map<string, string[]>();
  for (const { ledgerId, item } of LIFECYCLE_PUBLIC_ITEMS) {
    if (ledgerId !== "tasks") continue;
    let members = taskGroups.get(item.milestoneId);
    if (members === undefined) { members = []; taskGroups.set(item.milestoneId, members); }
    members.push(`tasks:${item.id}`);
  }
  const publicRows = createInMemoryGenericMutationDataSource({
    ledgers: structuredClone(LIFECYCLE_LEDGER_METADATA),
    activeItems: structuredClone(LIFECYCLE_PUBLIC_ITEMS),
    archivedItems: [{ ledgerId: "tasks", pointerId: "M2", item: structuredClone(LIFECYCLE_ARCHIVED_ITEM) }],
  });
  let inTransaction = false;
  return {
    rows: {
      publicRows: {
        listLedgers: () => structuredClone(publicRows.listLedgers()),
        fetchActiveItem: (ref) => structuredClone(publicRows.fetchActiveItem(ref)),
        fetchArchivedItem: (ref) => structuredClone(publicRows.fetchArchivedItem(ref)),
        referenceTargets: publicRows.referenceTargets,
        referenceSources: publicRows.referenceSources,
      },
      fetchGroup: (ledgerId, groupId) => ledgerId === "tasks" && groupId === "M1"
        ? { id: "M1", title: "members", description: "selected" } : undefined,
      taskRefsByMilestones: (milestoneIds) => [...taskGroups]
        .filter(([id]) => milestoneIds.includes(id)).flatMap(([, members]) => members),
      fetchClaimByRequest: (key) => structuredClone(claims.get(claimScopeKey(key.goalId, key.claimRequestId))),
      fetchClaimByIdentity: (key) => {
        const scope = byIdentity.get(claimIdentity(key));
        return scope === undefined ? undefined : structuredClone(claims.get(scope));
      },
      fetchActiveClaim: (goalId) => {
        const scope = active.get(goalId);
        return scope === undefined ? undefined : structuredClone(claims.get(scope));
      },
      fetchOperation: (key) => structuredClone(operations.get(operationIdentity(key))),
      fetchImplementationCompletionBinding: (taskId) => {
        const reviewRef = completionBindings.get(taskId);
        return reviewRef === undefined ? undefined : { taskId, reviewRef };
      },
      persistPrivateRecords(changes) {
        if (!inTransaction) throw new LedgerError("lifecycle row persistence requires a write transaction");
        for (const claim of changes.claims) {
          const scope = claimScopeKey(claim.goalId, claim.claimRequestId);
          const identity = claimIdentity(claim);
          const owner = byIdentity.get(identity);
          if (owner !== undefined && owner !== scope) throw new LedgerError("duplicate claim identity");
          const activeOwner = active.get(claim.goalId);
          if (claim.state === "active" && activeOwner !== undefined && activeOwner !== scope) {
            throw new LedgerError("duplicate active goal");
          }
          const prior = claims.get(scope);
          if (prior !== undefined) byIdentity.delete(claimIdentity(prior));
          if (activeOwner === scope) active.delete(claim.goalId);
          claims.set(scope, structuredClone(claim));
          byIdentity.set(identity, scope);
          if (claim.state === "active") active.set(claim.goalId, scope);
        }
        for (const operation of changes.operations) {
          const scope = operationIdentity(operation.replay);
          if (operations.has(scope)) throw new LedgerError("duplicate operation identity");
          operations.set(scope, structuredClone(operation));
        }
      },
      persistImplementationCompletionBindings(changes) {
        if (!inTransaction) throw new LedgerError("completion binding persistence requires a write transaction");
        for (const binding of changes) {
          if (completionBindings.has(binding.taskId)) throw new LedgerError("duplicate completion binding");
          completionBindings.set(binding.taskId, binding.reviewRef);
        }
      },
    },
    transaction(body) {
      if (inTransaction) throw new LedgerError("nested lifecycle fixture transaction");
      const restore = [restorePoint(claims), restorePoint(byIdentity), restorePoint(active), restorePoint(operations),
        restorePoint(completionBindings)];
      inTransaction = true;
      try { return body(); }
      catch (error) { for (const reset of restore) reset(); throw error; }
      finally { inTransaction = false; }
    },
    dispose: async () => {},
  };
}

runLifecycleRowRepositoryContract("strict hand-written memory / Atomic", async () => memoryFixture());
