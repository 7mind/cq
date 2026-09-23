import { summarize } from "@cq/ledger/summarize";
import type { Item, LedgerClient } from "./types.js";
import type { ItemReference } from "./itemReferences.js";

export type ReferencePreviewResult =
  | {
      kind: "found";
      ledger: string;
      id: string;
      status: string;
      summary: string;
      /** D400 — present when the item was resolved out of the archive. */
      archivedUnder?: readonly string[];
    }
  | { kind: "not-found"; ledger: string; id: string }
  | { kind: "error"; ledger: string; id: string; message: string };

export interface LocalReferenceItem {
  ledger: string;
  item: Item;
}

function keyOf(reference: ItemReference): string {
  return `${reference.ledger}:${reference.id}`;
}

function found(
  ledger: string,
  item: Item,
  archivedUnder: readonly string[] = [],
): ReferencePreviewResult {
  return {
    kind: "found",
    ledger,
    id: item.id,
    status: item.status,
    summary: summarize(item),
    ...(archivedUnder.length === 0 ? {} : { archivedUnder }),
  };
}

export class ItemReferenceLookup {
  private readonly local = new Map<string, Item>();
  private readonly settled = new Map<string, ReferencePreviewResult>();
  private readonly inFlight = new Map<string, Promise<ReferencePreviewResult>>();

  constructor(
    private readonly client: Pick<LedgerClient, "fetchItem" | "fetchItemIncludingArchived">,
  ) {}

  replaceLocalItems(items: Iterable<LocalReferenceItem>): void {
    this.local.clear();
    for (const { ledger, item } of items) {
      this.local.set(keyOf({ ledger, id: item.id }), item);
    }
  }

  resolve(reference: ItemReference): Promise<ReferencePreviewResult> {
    const key = keyOf(reference);
    const local = this.local.get(key);
    if (local !== undefined) return Promise.resolve(found(reference.ledger, local));
    const settled = this.settled.get(key);
    if (settled !== undefined) return Promise.resolve(settled);
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;

    const request = this.fetch(reference).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return request;
  }

  private async fetch(reference: ItemReference): Promise<ReferencePreviewResult> {
    const key = keyOf(reference);
    try {
      // D400: an item selected while visible can be archived before its popup
      // is opened, and archival removes it from the ACTIVE store the ordinary
      // read resolves. Ask for the archived generations in the same call
      // rather than reporting a reference we know exists as not-found; the
      // server keeps the active read as its fast path and still fails an id
      // that was never there.
      const { item, archived } = await this.client.fetchItemIncludingArchived(
        reference.ledger,
        reference.id,
        "compact",
      );
      const result = found(
        reference.ledger,
        item,
        archived.map(({ pointerId }) => pointerId),
      );
      this.settled.set(key, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: ReferencePreviewResult = /not found/i.test(message)
        ? { kind: "not-found", ledger: reference.ledger, id: reference.id }
        : { kind: "error", ledger: reference.ledger, id: reference.id, message };
      if (result.kind === "not-found") this.settled.set(key, result);
      return result;
    }
  }
}
