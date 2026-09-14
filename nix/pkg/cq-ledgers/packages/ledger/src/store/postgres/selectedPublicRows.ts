import { LedgerError, type Item } from "../../types.js";
import type { LifecycleGroup } from "../lifecycleRowRepository.js";
import { createPostgresLifecycleRowRepository } from "./lifecycleRowRepository.js";
import { persistPostgresActiveItem } from "./keyedRows.js";
import type { PostgresOperationQueries } from "./operationAccess.js";

export interface PostgresSelectedPublicRow {
  readonly ledgerId: string;
  readonly item: Item;
  readonly group: LifecycleGroup;
  readonly before: string;
}

export function createPostgresSelectedPublicRows(queries: PostgresOperationQueries) {
  const repository = createPostgresLifecycleRowRepository(queries);
  const selected = new Map<string, PostgresSelectedPublicRow>();
  const missing = new Set<string>();
  return {
    selected,
    async fetchItem(ledgerId: string, itemId: string): Promise<Item | undefined> {
      const ref = `${ledgerId}:${itemId}`;
      const known = selected.get(ref);
      if (known !== undefined) return known.item;
      if (missing.has(ref)) return undefined;
      const item = await repository.publicRows.fetchActiveItem(ref);
      if (item === undefined) {
        const ledgers = await queries.execute<{ name: string }>({ table: "ledgers", phase: "transaction", mode: "read",
          predicate: { kind: "primary-key", keys: [ledgerId] }, lockMode: "none" }, {
          sql: "SELECT name FROM ledgers WHERE project_key = $1 AND name = $2", parameters: [queries.projectKey, ledgerId],
        }, ({ name }) => name);
        if (ledgers.length === 0) throw new LedgerError(`ledger not found: ${ledgerId}`);
        missing.add(ref);
        return undefined;
      }
      const group = await repository.fetchGroup(ledgerId, item.milestoneId);
      if (group === undefined) throw new LedgerError(`ledger ${ledgerId}: item ${item.id} references a milestone-group with no groups row`);
      selected.set(ref, { ledgerId, item, group, before: JSON.stringify(item) });
      return item;
    },
    async persist(dirtyLedgers: readonly string[]): Promise<readonly string[]> {
      const changed = new Set<string>();
      for (const { ledgerId, item, before } of selected.values()) {
        if (before === JSON.stringify(item)) continue;
        if (!dirtyLedgers.includes(ledgerId)) throw new LedgerError(`keyed mutation changed undeclared ledger ${ledgerId}`);
        await persistPostgresActiveItem(queries, ledgerId, item, "update");
        changed.add(ledgerId);
      }
      return [...changed];
    },
  };
}
