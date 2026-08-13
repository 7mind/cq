/** Adapter-owned stable workset capability and graph derivation. */

import { buildPrefixRegistry } from "./refs.js";
import type { LedgerStore } from "./store/LedgerStore.js";
import { LedgerError } from "./types.js";
import {
  buildWorksetActiveState,
  closeWorkset,
  type WorksetActiveState,
} from "./worksetGraph.js";
import type { WorksetRootsEpoch } from "./worksetEffectAdmission.js";
import type { WorksetStore } from "./worksetStore.js";

export function requireWorksetStore(store: LedgerStore): WorksetStore {
  if (store.worksetStore === undefined) {
    throw new LedgerError("ledger store does not expose a workset capability");
  }
  return store.worksetStore();
}

export function requireWorksetRootReplacement(
  store: LedgerStore,
): (roots: readonly string[]) => Promise<WorksetRootsEpoch> {
  if (store.replaceWorksetRoots === undefined) {
    throw new LedgerError("ledger store does not expose validated workset replacement");
  }
  return (roots) => store.replaceWorksetRoots!(roots);
}

export function buildActiveStateFromLedgerStore(
  store: Pick<LedgerStore, "enumerate" | "fetch">,
): WorksetActiveState {
  const fetched = store.enumerate().map((name) => store.fetch(name));
  return buildWorksetActiveState(
    fetched.map((ledger) => ({
      ledger: ledger.id,
      items: ledger.milestones.flatMap((milestone) => milestone.items),
    })),
    buildPrefixRegistry(fetched.map((ledger) => ({ name: ledger.id, schema: ledger.schema }))),
  );
}

export function closedGraphIsTargetAdmitted(
  store: Pick<LedgerStore, "enumerate" | "fetch">,
): (target: string, roots: readonly string[]) => boolean {
  return (target, roots) => {
    if (roots.length === 0) return true;
    try {
      const graph = closeWorkset(roots, buildActiveStateFromLedgerStore(store));
      return graph.nodes.some((node) => node.ref === target) || graph.inactiveRoots.includes(target);
    } catch {
      return false;
    }
  };
}
