import type { DispatchNarrativeSource } from "@cq/config";
import { ItemNotFoundError, LedgerNotFoundError } from "../types.js";
import type { LedgerStore } from "../store/LedgerStore.js";

/**
 * Bind T978's synchronous narrative port to one initialized ledger store and
 * one trusted project. Missing refs become `undefined`, which the assembler
 * converts into a typed pre-launch rejection.
 */
export function createDispatchNarrativeSource(
  store: LedgerStore,
  projectKey: string,
): DispatchNarrativeSource {
  return Object.freeze({
    projectKey,
    readItem: (ledger: string, id: string) => {
      try {
        const item = store.fetchItem(ledger, id);
        return Object.freeze({
          id: item.id,
          status: item.status,
          fields: item.fields,
        });
      } catch (error) {
        if (error instanceof ItemNotFoundError || error instanceof LedgerNotFoundError) {
          return undefined;
        }
        throw error;
      }
    },
  });
}
