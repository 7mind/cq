import { LedgerError, type ArchivePointer, type Item, type Ledger, type Milestone } from "../../types.js";
import { MILESTONES_LEDGER } from "../../constants.js";
import { isLiveWorksetAdmission, WorksetAdmissionError } from "../../worksetEffectAdmission.js";
import type { AdmittedGenericMutation } from "../../worksetGenericMutation.js";
import { resolveAsyncGenericMutationClosure } from "../genericMutationDataSource.js";
import { genericArchiveKey, type GenericArchiveEntry } from "../genericMutationTransaction.js";
import { createPostgresGenericMutationDataSource } from "./genericMutationDataSource.js";
import { createPostgresLifecycleRowRepository } from "./lifecycleRowRepository.js";
import { postgresRowToItem, type PostgresItemRow } from "./keyedRows.js";
import type { PostgresOperationQueries } from "./operationAccess.js";
import type { PostgresOperationClosure } from "./operationKernel.js";
import { orderedPostgresRowLocks, type PostgresLockTarget, type PostgresRowLock } from "./rowLocks.js";
import { postgresAdmissionMatches } from "./worksetAdmissionRows.js";

export interface PostgresGenericRowPlan {
  readonly ledgers: Map<string, Ledger>;
  readonly beforeLedgers: Map<string, Ledger>;
  readonly archives: Map<string, GenericArchiveEntry>;
  readonly beforeArchives: Map<string, GenericArchiveEntry>;
  readonly unloadedArchiveKeys: ReadonlySet<string>;
}

type ResolvedGenericRows = { readonly kind: "loaded"; readonly rows: PostgresGenericRowPlan }
  | { readonly kind: "rejected"; readonly error: unknown };

const GENERIC_OPERATIONS = new Set(["update-item", "update-milestone", "create-item", "create-milestone", "create-ledger",
  "reopen-item", "unarchive-item", "archive-terminal-items", "archive-milestone", "execute-finalize"]);

export async function resolvePostgresGenericRows(queries: PostgresOperationQueries, context: AdmittedGenericMutation): Promise<PostgresOperationClosure<ResolvedGenericRows>> {
  const targets: PostgresLockTarget[] = [];
  const observed = queries.withReadTargets((target) => targets.push(target));
  const { scope, admission, allocation } = context;
  const allocating = scope.operation === "create-item" || scope.operation === "create-milestone";
  const allocationLedger = allocating ? scope.ledgerIds[0] : undefined;
  const writable = new Set(scope.targetRefs);
  const archiveParents = new Set<string>();
  let plan: ResolvedGenericRows;
  try {
    if (!GENERIC_OPERATIONS.has(scope.operation)) throw new LedgerError(`unknown generic operation ${scope.operation}`);
    if (allocating !== (allocation !== null) || (allocation !== null && allocation.ledgerId !== allocationLedger)) {
      throw new LedgerError("generic operation has mismatched allocation coordinates");
    }
    if (!isLiveWorksetAdmission(admission) || admission.kind !== "generic-write" ||
      JSON.stringify(admission.targets) !== JSON.stringify(scope.targetRefs)) {
      throw new WorksetAdmissionError("caller-minted-admission", "generic transaction requires its exact live operation targets admission");
    }
    if (!(await postgresAdmissionMatches(observed, admission))) {
      throw new WorksetAdmissionError("stale-epoch", "generic transaction admission is no longer the exact durable targets/roots epoch");
    }
    const source = createPostgresGenericMutationDataSource(observed);
    const rows = createPostgresLifecycleRowRepository(observed);
    const metadata = await source.listLedgers();
    const candidates = [...scope.targetRefs, ...scope.referenceCandidates, ...scope.milestoneIds.map((id) => `milestones:${id}`)];
    const membership = new Set(scope.operation === "archive-milestone" || scope.operation === "execute-finalize" || scope.operation === "update-milestone"
      ? scope.milestoneIds : []);
    if (scope.operation === "update-item" || scope.operation === "execute-finalize") {
      for (const ref of scope.targetRefs) if (ref.startsWith("milestones:")) membership.add(ref.slice("milestones:".length));
    }
    for (const id of membership) {
      const refs = await source.itemRefsByMilestone(id);
      candidates.push(...refs);
      if (scope.operation === "archive-milestone" || scope.operation === "execute-finalize") {
        archiveParents.add(id);
        for (const ref of refs) writable.add(ref);
      }
    }
    if (scope.operation === "archive-terminal-items") {
      for (const ledgerId of scope.ledgerIds) {
        const selected = metadata.find(({ id }) => id === ledgerId);
        if (selected === undefined) continue;
        const refs = await source.itemRefsByLedgerStatuses(ledgerId, selected.schema.terminalStatuses);
        candidates.push(...refs);
        for (const ref of refs) writable.add(ref);
      }
    }
    if (allocationLedger !== undefined) {
      observed.recordReadTarget({ table: "ledgers", ledgerId: allocationLedger });
      const selected = metadata.find(({ id }) => id === allocationLedger);
      if (selected !== undefined && allocation !== null && allocation.requestedId === null) {
        let next = selected.counters.item;
        const prefix = selected.schema.idPrefix ?? allocationLedger.slice(0, 1).toUpperCase();
        let candidate: string;
        do { candidate = `${allocationLedger}:${prefix}${++next}`; candidates.push(candidate); }
        while ((await source.fetchActiveItem(candidate)) !== undefined);
      }
    }
    if (scope.operation === "create-ledger") {
      for (const ledgerId of scope.ledgerIds) observed.recordReadTarget({ table: "ledgers", ledgerId });
    }
    const closure = await resolveAsyncGenericMutationClosure(source, admission.roots, { candidateRefs: candidates,
      incidentReferenceFields: scope.operation === "archive-terminal-items" || scope.operation === "archive-milestone" || scope.operation === "execute-finalize"
        ? ["dependsOn", "blockedBy"] : [] });
    const ledgers = new Map<string, Ledger>(metadata.map(({ id, schema, counters }) =>
      [id, { id, schema, counters: { ...counters }, milestones: [], archivePointers: [] }]));
    const groups = new Map<string, Milestone>();
    const includeGroup = async (ledgerId: string, groupId: string): Promise<Milestone | undefined> => {
      const key = `${ledgerId}:${groupId}`;
      const known = groups.get(key);
      if (known !== undefined) return known;
      const group = await rows.fetchGroup(ledgerId, groupId);
      const ledger = ledgers.get(ledgerId);
      if (group === undefined || ledger === undefined) return undefined;
      const selected = { ...group, items: [] as Item[] };
      groups.set(key, selected);
      ledger.milestones.push(selected);
      return selected;
    };
    for (const [ref, item] of closure.activeState.byRef) {
      const ledgerId = ref.slice(0, ref.indexOf(":"));
      const group = await includeGroup(ledgerId, item.milestoneId);
      if (group === undefined) throw new LedgerError(`ledger ${ledgerId}: item ${item.id} references a milestone-group with no groups row`);
      group.items.push(item);
      if (scope.operation === "archive-terminal-items" && writable.has(ref)) archiveParents.add(item.milestoneId);
    }
    for (const ledgerId of scope.ledgerIds) for (const id of scope.milestoneIds) await includeGroup(ledgerId, id);
    const archives = new Map<string, GenericArchiveEntry>();
    for (const target of closure.archivedTargets.values()) {
      const key = genericArchiveKey(target.ledgerId, target.pointerId);
      const entry = archives.get(key);
      if (entry === undefined) archives.set(key, { ledgerId: target.ledgerId, pointerId: target.pointerId, title: "", description: "", items: [target.item] });
      else entry.items.push(target.item);
    }
    const archiveKeys = new Map<string, { ledgerId: string; pointerId: string }>();
    const includeArchiveKey = (ledgerId: string, pointerId: string) => archiveKeys.set(genericArchiveKey(ledgerId, pointerId), { ledgerId, pointerId });
    if (scope.operation === "unarchive-item") {
      for (const ledgerId of scope.ledgerIds) for (const id of scope.milestoneIds) includeArchiveKey(ledgerId, id);
    }
    if (scope.operation === "archive-terminal-items") {
      for (const ref of writable) {
        const item = closure.activeState.byRef.get(ref);
        if (item !== undefined) includeArchiveKey(ref.slice(0, ref.indexOf(":")), item.milestoneId);
      }
    }
    if (scope.operation === "archive-milestone" || scope.operation === "execute-finalize") {
      for (const id of scope.milestoneIds) {
        const pointers = await observed.execute<{ ledger: string; id: string }>({ table: "archive_pointers", phase: "transaction", mode: "read",
          predicate: { kind: "milestone-members", keys: [id] }, lockMode: "none" }, {
          sql: POSTGRES_ARCHIVE_POINTER_MEMBERS_SQL, parameters: [observed.projectKey, id],
        }, ({ ledger, id: pointerId }) => `${ledger}/${pointerId}`);
        for (const pointer of pointers) includeArchiveKey(pointer.ledger, pointer.id);
        for (const [ledgerId, ledger] of ledgers) {
          if (ledger.milestones.some((group) => group.id === id)) includeArchiveKey(ledgerId, id);
        }
        includeArchiveKey(MILESTONES_LEDGER, id);
      }
    }
    const unloadedArchiveKeys = new Set<string>();
    for (const [key, { ledgerId, pointerId }] of archiveKeys) {
      observed.recordReadTarget({ table: "archive_pointers", ledgerId, id: pointerId });
      const pointers = await observed.execute<Omit<ArchivePointer, "path">>({ table: "archive_pointers", phase: "transaction", mode: "read",
        predicate: { kind: "primary-key", keys: [key] }, lockMode: "none" }, {
        sql: "SELECT id, summary, title, status FROM archive_pointers WHERE project_key = $1 AND ledger = $2 AND id = $3",
        parameters: [observed.projectKey, ledgerId, pointerId],
      }, () => key);
      const pointer = pointers[0];
      if (pointer === undefined) continue;
      const ledger = ledgers.get(ledgerId);
      if (ledger === undefined) throw new LedgerError(`archive pointer has no ledger ${key}`);
      ledger.archivePointers.push({ ...pointer, path: `./archive/${ledgerId}/${pointerId}.md` });
      const selectedIds = scope.operation === "unarchive-item" ? scope.targetRefs.filter((ref) => ref.startsWith(`${ledgerId}:`)).map((ref) => ref.slice(ledgerId.length + 1)) : [];
      const selectedItems: Item[] = [];
      for (const id of selectedIds) {
        observed.recordReadTarget({ table: "archived_items", ledgerId, pointerId, id });
        const selected = await observed.execute<PostgresItemRow>({ table: "archived_items", phase: "transaction", mode: "read",
          predicate: { kind: "primary-key", keys: [`${ledgerId}:${pointerId}:${id}`] }, lockMode: "none" }, {
          sql: "SELECT * FROM archived_items WHERE project_key = $1 AND ledger = $2 AND pointer_id = $3 AND id = $4",
          parameters: [observed.projectKey, ledgerId, pointerId, id],
        }, ({ id: itemId }) => `${ledgerId}:${pointerId}:${itemId}`);
        selectedItems.push(...selected.map(postgresRowToItem));
      }
      const remainder = await observed.execute<{ id: string }>({ table: "archived_items", phase: "transaction", mode: "read",
        predicate: { kind: "keys", keys: [key] }, lockMode: "none" }, {
        sql: "SELECT id FROM archived_items WHERE project_key = $1 AND ledger = $2 AND pointer_id = $3 AND NOT (id = ANY($4::text[])) ORDER BY id LIMIT 1",
        parameters: [observed.projectKey, ledgerId, pointerId, selectedIds],
      }, ({ id }) => `${ledgerId}:${pointerId}:${id}`);
      if (remainder.length > 0) unloadedArchiveKeys.add(key);
      archives.set(key, { ledgerId, pointerId, title: pointer.title, description: "", items: selectedItems });
    }
    plan = { kind: "loaded", rows: { ledgers, archives, beforeLedgers: structuredClone(ledgers), beforeArchives: structuredClone(archives), unloadedArchiveKeys } };
  } catch (error) {
    if (!(error instanceof LedgerError) && !(error instanceof WorksetAdmissionError)) throw error;
    plan = { kind: "rejected", error };
  }
  return { plan, exactReplay: false, locks: orderedPostgresRowLocks(targets.map((target): PostgresRowLock => {
    const writes = target.table === "ledgers" || target.table === "archive_pointers" || target.table === "archived_items" ||
      (target.table === "workset_roots" && scope.operation === "create-ledger") ||
      (target.table === "items" && (writable.has(`${target.ledgerId}:${target.id}`) || (target.ledgerId === MILESTONES_LEDGER && archiveParents.has(target.id))));
    return { target, mode: writes ? "update" : "share" };
  })) };
}

export const POSTGRES_ARCHIVE_POINTER_MEMBERS_SQL = "SELECT ledger, id FROM archive_pointers WHERE project_key = $1 AND id = $2 ORDER BY ledger";
