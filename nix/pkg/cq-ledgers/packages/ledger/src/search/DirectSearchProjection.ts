import { LedgerSearchIndex } from "./LedgerSearchIndex.js";
import { SearchProjectionCoordinator } from "./SearchProjection.js";
import type {
  SearchProjection,
  SearchProjectionRequest,
  SearchProjectionAcknowledgement,
  SearchProjectionBucket,
} from "./SearchProjection.js";

export class SearchProjectionEngine {
  private index = new LedgerSearchIndex();

  execute(request: SearchProjectionRequest): SearchProjectionAcknowledgement {
    const command = request.command;
    switch (command.kind) {
      case "snapshot": {
        const previous = this.index;
        this.index = new LedgerSearchIndex();
        try {
          for (const bucket of command.buckets) this.replaceBucket(bucket);
        } catch (error) {
          this.index = previous;
          throw error;
        }
        break;
      }
      case "delta":
        for (const change of command.changes) {
          switch (change.kind) {
            case "replace-bucket":
              this.replaceBucket(change.bucket);
              break;
            case "remove-ledger":
              this.index.removeLedger(change.ledgerId);
              break;
            case "upsert":
              if (change.archived) this.index.upsertArchivedDoc(change.ledgerId, change.item);
              else this.index.upsertActiveDoc(change.ledgerId, change.item);
              break;
            case "remove":
              if (change.archived) this.index.removeArchivedDoc(change.ledgerId, change.itemId);
              else this.index.removeActiveDoc(change.ledgerId, change.itemId);
              break;
          }
        }
        break;
      case "search":
        return {
          generation: request.generation,
          commandId: request.commandId,
          result: { kind: "search", hits: this.index.searchQuery(command.query, command.options) },
        };
      case "health":
        return {
          generation: request.generation,
          commandId: request.commandId,
          result: {
            kind: "health",
            health: {
              state: "current",
              generation: request.generation,
              acknowledgedCommandId: request.commandId,
              pendingCommands: 0,
              failure: null,
            },
          },
        };
      case "close":
        break;
    }
    return {
      generation: request.generation,
      commandId: request.commandId,
      result: { kind: command.kind },
    };
  }

  private replaceBucket(bucket: SearchProjectionBucket): void {
    if (bucket.archived) this.index.setLedgerArchived(bucket.ledgerId, [...bucket.items]);
    else this.index.rebuildLedgerActive(bucket.ledgerId, [...bucket.items]);
  }
}

export function createDirectSearchProjection(deadlineMs: number): SearchProjection {
  return new SearchProjectionCoordinator((receiver) => {
    const engine = new SearchProjectionEngine();
    let closed = false;
    return {
      send: (request) => {
        const owned = structuredClone(request);
        queueMicrotask(() => {
          if (closed) return;
          try {
            receiver.acknowledge(structuredClone(engine.execute(owned)));
          } catch (error) {
            receiver.fail(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
      close: () => {
        closed = true;
      },
    };
  }, deadlineMs);
}
