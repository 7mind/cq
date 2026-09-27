/**
 * G192/T6627 — shared assembly of {@link PhysicalLedgerState} from an
 * adapter's native (unmaterialized) ledger views and archive contents.
 */

import type { FetchedLedger } from "../types.js";
import type { ArchiveContent, PhysicalLedgerExport, PhysicalLedgerState } from "./LedgerStore.js";
import { assertMemoryKindPayload } from "../memoryKind.js";

export interface PhysicalLedgerSource {
  readonly names: readonly string[];
  readonly view: (ledgerId: string) => FetchedLedger;
  readonly archive: (ledgerId: string, pointerId: string) => ArchiveContent;
}

/**
 * Collect and validate every complete active and archived payload. Synchronous
 * so a durable adapter can run it inside one read snapshot.
 */
export function collectPhysicalLedgerState(source: PhysicalLedgerSource): PhysicalLedgerState {
  const ledgers: PhysicalLedgerExport[] = [];
  for (const name of source.names) {
    const ledger = source.view(name);
    for (const group of ledger.milestones) {
      for (const item of group.items) assertMemoryKindPayload(name, item);
    }
    const archives = new Map<string, ArchiveContent>();
    for (const pointer of ledger.archivePointers) {
      const content = source.archive(name, pointer.id);
      const items = content.kind === "item" ? [content.item] : content.milestone.items;
      for (const item of items) assertMemoryKindPayload(name, item);
      archives.set(pointer.id, content);
    }
    ledgers.push({ ledger, archives });
  }
  return { ledgers };
}
