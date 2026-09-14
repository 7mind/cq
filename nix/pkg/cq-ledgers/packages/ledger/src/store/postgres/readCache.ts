import { LedgerError, LedgerNotFoundError, ItemNotFoundError, type Item, type Ledger, type LedgerSchema } from "../../types.js";
import type { ArchiveContent } from "../LedgerStore.js";
import type { PostgresProjectionRows, PostgresProjectionLedger, PostgresProjectionGroup, PostgresProjectionPointer,
  PostgresProjectionItem, PostgresProjectionArchiveItem } from "./projectionRows.js";

/** SQL sequence orders materialized reads; mutation applies are keyed Map updates. */
export class PostgresReadCache {
  private readonly ledgers = new Map<string, PostgresProjectionLedger>();
  private readonly groups = new Map<string, Map<string, PostgresProjectionGroup>>();
  private readonly pointers = new Map<string, Map<string, PostgresProjectionPointer>>();
  private readonly active = new Map<string, Map<string, PostgresProjectionItem>>();
  private readonly membership = new Map<string, Map<string, Map<string, PostgresProjectionItem>>>();
  private readonly archived = new Map<string, Map<string, Map<string, PostgresProjectionArchiveItem>>>();
  private readonly archivedById = new Map<string, Map<string, Map<string, PostgresProjectionArchiveItem>>>();

  clear(): void {
    this.ledgers.clear(); this.groups.clear(); this.pointers.clear(); this.active.clear(); this.membership.clear(); this.archived.clear(); this.archivedById.clear();
  }

  apply(rows: PostgresProjectionRows): void {
    for (const ledgerId of rows.ledgerDeletes) {
      this.ledgers.delete(ledgerId); this.groups.delete(ledgerId); this.pointers.delete(ledgerId);
      this.active.delete(ledgerId); this.membership.delete(ledgerId); this.archived.delete(ledgerId); this.archivedById.delete(ledgerId);
    }
    for (const row of rows.ledgers) this.ledgers.set(row.ledgerId, structuredClone(row));
    for (const row of rows.groups) this.map(this.groups, row.ledgerId).set(row.id, { ...row });
    for (const row of rows.pointers) this.map(this.pointers, row.ledgerId).set(row.pointer.id, structuredClone(row));
    for (const { ledgerId, itemId } of rows.activeDeletes) this.removeActive(ledgerId, itemId);
    for (const row of rows.active) {
      this.removeActive(row.ledgerId, row.item.id);
      const owned = structuredClone(row);
      this.map(this.active, row.ledgerId).set(row.item.id, owned);
      this.map(this.map(this.membership, row.ledgerId), row.item.milestoneId).set(row.item.id, owned);
    }
    for (const { ledgerId, pointerId, itemId } of rows.archivedDeletes) {
      this.archived.get(ledgerId)?.get(pointerId)?.delete(itemId);
      this.archivedById.get(ledgerId)?.get(itemId)?.delete(pointerId);
    }
    for (const row of rows.archived) {
      const owned = structuredClone(row);
      this.map(this.map(this.archived, row.ledgerId), row.pointerId).set(row.item.id, owned);
      this.map(this.map(this.archivedById, row.ledgerId), row.item.id).set(row.pointerId, owned);
    }
    for (const { ledgerId, id } of rows.groupDeletes) {
      if ((this.membership.get(ledgerId)?.get(id)?.size ?? 0) !== 0) throw new LedgerError(`coherence removed nonempty group ${ledgerId}:${id}`);
      this.groups.get(ledgerId)?.delete(id);
      this.membership.get(ledgerId)?.delete(id);
    }
    for (const { ledgerId, id } of rows.pointerDeletes) {
      if ((this.archived.get(ledgerId)?.get(id)?.size ?? 0) !== 0) throw new LedgerError(`coherence removed nonempty archive pointer ${ledgerId}:${id}`);
      this.pointers.get(ledgerId)?.delete(id);
      this.archived.get(ledgerId)?.delete(id);
    }
  }

  enumerate(): string[] { return [...this.ledgers.keys()].sort(); }

  hasLedger(ledgerId: string): boolean { return this.ledgers.has(ledgerId); }
  hasGroup(ledgerId: string, groupId: string): boolean { return this.groups.get(ledgerId)?.has(groupId) === true; }

  registry(): { name: string; schema: LedgerSchema }[] { return [...this.ledgers.values()].map(({ ledgerId, schema }) => ({ name: ledgerId, schema: structuredClone(schema) })); }
  schema(ledgerId: string): LedgerSchema | undefined { const row = this.ledgers.get(ledgerId); return row === undefined ? undefined : structuredClone(row.schema); }
  hasItem(ledgerId: string, itemId: string): boolean { return this.active.get(ledgerId)?.has(itemId) === true; }
  archivedItemsById(ledgerId: string, itemId: string): Item[] { return [...(this.archivedById.get(ledgerId)?.get(itemId)?.values() ?? [])].map(({ item }) => structuredClone(item)); }

  item(ledgerId: string, itemId: string): Item {
    if (!this.ledgers.has(ledgerId)) throw new LedgerNotFoundError(ledgerId);
    const row = this.active.get(ledgerId)?.get(itemId);
    if (row === undefined) throw new ItemNotFoundError(ledgerId, itemId);
    return structuredClone(row.item);
  }

  ledger(ledgerId: string): Ledger {
    const metadata = this.ledgers.get(ledgerId);
    if (metadata === undefined) throw new LedgerNotFoundError(ledgerId);
    return { id: ledgerId, schema: structuredClone(metadata.schema), counters: { ...metadata.counters },
      milestones: [...(this.groups.get(ledgerId)?.values() ?? [])].sort(bySequence).map((group) => ({
        id: group.id, title: group.title, description: group.description,
        items: [...(this.membership.get(ledgerId)?.get(group.id)?.values() ?? [])].sort(bySequence).map(({ item }) => structuredClone(item)),
      })),
      archivePointers: [...(this.pointers.get(ledgerId)?.values() ?? [])].sort(bySequence).map(({ pointer }) => ({ ...pointer })),
    };
  }

  milestoneItems(milestoneId: string): Record<string, Item[]> {
    const result: Record<string, Item[]> = {};
    for (const ledgerId of this.ledgers.keys()) {
      if (ledgerId === "milestones") continue;
      const items = this.membership.get(ledgerId)?.get(milestoneId);
      if (items === undefined || items.size === 0) continue;
      result[ledgerId] = [...items.values()].sort(bySequence).map(({ item }) => structuredClone(item));
    }
    return result;
  }

  archive(ledgerId: string, pointerId: string): ArchiveContent {
    const pointer = this.pointers.get(ledgerId)?.get(pointerId);
    if (pointer === undefined) throw new LedgerError(`archive ${pointerId} not found in ledger ${ledgerId}`);
    const items = [...(this.archived.get(ledgerId)?.get(pointerId)?.values() ?? [])].sort(bySequence).map(({ item }) => structuredClone(item));
    if (ledgerId === "milestones") {
      const item = items[0];
      if (items.length !== 1 || item === undefined) throw new LedgerError(`milestone archive ${pointerId} does not contain exactly one item`);
      return { kind: "item", item };
    }
    return { kind: "group", milestone: { id: pointerId, title: "", description: "", items } };
  }

  private removeActive(ledgerId: string, itemId: string): void {
    const previous = this.active.get(ledgerId)?.get(itemId);
    if (previous === undefined) return;
    this.active.get(ledgerId)!.delete(itemId);
    this.membership.get(ledgerId)?.get(previous.item.milestoneId)?.delete(itemId);
  }

  private map<Value>(map: Map<string, Map<string, Value>>, key: string): Map<string, Value> {
    let value = map.get(key);
    if (value === undefined) { value = new Map(); map.set(key, value); }
    return value;
  }
}

function bySequence(left: { sequence: number }, right: { sequence: number }): number { return left.sequence - right.sequence; }
