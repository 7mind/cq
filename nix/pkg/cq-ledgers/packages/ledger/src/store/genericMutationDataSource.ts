import { MILESTONES_LEDGER, TASKS_LEDGER } from "../constants.js";
import { buildPrefixRegistry, canonicalizeRef } from "../refs.js";
import {
  buildWorksetActiveState,
  canonicalizeWorksetRoots,
  closeWorkset,
  isLiveExplicitMilestoneTask,
  isLiveMilestone,
  phaseAllowedManifestRefs,
  type WorksetActiveState,
  type WorksetGraph,
} from "../worksetGraph.js";
import type { Item, LedgerSchema } from "../types.js";

export interface GenericMutationLedgerMetadata {
  readonly id: string;
  readonly schema: LedgerSchema;
  readonly counters: {
    readonly milestone: number;
    readonly item: number;
  };
}

export interface GenericMutationArchivedTarget {
  readonly ledgerId: string;
  readonly pointerId: string;
  readonly item: Item;
}

export interface GenericMutationDataSource {
  listLedgers(): readonly GenericMutationLedgerMetadata[];
  fetchActiveItem(ref: string): Item | undefined;
  fetchArchivedItem(ref: string): GenericMutationArchivedTarget | undefined;
  referenceTargets(sourceRef: string, fieldNames: readonly string[]): readonly string[];
  referenceSources(targetRef: string, fieldNames: readonly string[]): readonly string[];
  itemRefsByMilestone(milestoneId: string): readonly string[];
  itemRefsByLedgerStatuses(ledgerId: string, statuses: readonly string[]): readonly string[];
  liveTaskRefsByMilestone(milestoneId: string): readonly string[];
}

export interface GenericMutationResolvedClosure {
  readonly ledgers: readonly GenericMutationLedgerMetadata[];
  readonly activeState: WorksetActiveState;
  readonly archivedTargets: ReadonlyMap<string, GenericMutationArchivedTarget>;
  readonly graph: WorksetGraph;
}

export interface ResolveGenericMutationClosureOptions {
  readonly candidateRefs: readonly string[];
  readonly incidentReferenceFields: readonly string[];
}

export function resolveGenericMutationClosure(
  source: GenericMutationDataSource,
  roots: readonly string[],
  options: ResolveGenericMutationClosureOptions,
): GenericMutationResolvedClosure {
  const ledgers = source.listLedgers();
  const prefixRegistry = buildPrefixRegistry(
    ledgers.map(({ id, schema }) => ({ name: id, schema })),
  );
  const canonicalRoots = canonicalizeWorksetRoots(roots, prefixRegistry);
  const explicitRoots = new Set(canonicalRoots);
  const activeItems = new Map<string, Item>();
  const archivedTargets = new Map<string, GenericMutationArchivedTarget>();
  const queued: string[] = [];
  const seen = new Set<string>();
  const enqueue = (rawRef: string): void => {
    let ref: string;
    try {
      ref = canonicalizeRef(rawRef, prefixRegistry);
    } catch {
      return;
    }
    if (seen.has(ref)) return;
    seen.add(ref);
    queued.push(ref);
  };

  for (const ref of canonicalRoots) enqueue(ref);
  for (const ref of options.candidateRefs) enqueue(ref);

  while (queued.length > 0) {
    const ref = queued.shift();
    if (ref === undefined) break;
    const item = source.fetchActiveItem(ref);
    if (item === undefined) {
      const archived = source.fetchArchivedItem(ref);
      if (archived !== undefined) archivedTargets.set(ref, archived);
      continue;
    }
    activeItems.set(ref, item);

    for (const target of source.referenceTargets(ref, ["dependsOn", "blockedBy"])) {
      enqueue(target);
    }
    for (const child of source.referenceSources(ref, [
      "worksetOwnerRef",
      ...options.incidentReferenceFields,
    ])) {
      enqueue(child);
    }

    const colon = ref.indexOf(":");
    const ledgerId = ref.slice(0, colon);
    const itemId = ref.slice(colon + 1);
    if (ledgerId !== MILESTONES_LEDGER) enqueue(`${MILESTONES_LEDGER}:${item.milestoneId}`);
    for (const member of phaseAllowedManifestRefs(ledgerId, item) ?? []) enqueue(member);
    if (ledgerId === MILESTONES_LEDGER && explicitRoots.has(ref) && isLiveMilestone(item)) {
      for (const task of source.liveTaskRefsByMilestone(itemId)) enqueue(task);
    }
  }

  const activeState = buildWorksetActiveState(
    [...activeItems].map(([ref, item]) => ({
      ledger: ref.slice(0, ref.indexOf(":")),
      items: [item],
    })),
    prefixRegistry,
  );
  return {
    ledgers,
    activeState,
    archivedTargets,
    graph: closeWorkset(canonicalRoots, activeState),
  };
}

export interface InMemoryGenericMutationDataSourceInput {
  readonly ledgers: readonly GenericMutationLedgerMetadata[];
  readonly activeItems: readonly { readonly ledgerId: string; readonly item: Item }[];
  readonly archivedItems: readonly GenericMutationArchivedTarget[];
}

export function createInMemoryGenericMutationDataSource(
  input: InMemoryGenericMutationDataSourceInput,
): GenericMutationDataSource {
  const active = new Map<string, Item>(
    input.activeItems.map(({ ledgerId, item }) => [`${ledgerId}:${item.id}`, item] as const),
  );
  const archived = new Map<string, GenericMutationArchivedTarget>(
    input.archivedItems.map((target) => [`${target.ledgerId}:${target.item.id}`, target] as const),
  );
  const prefixRegistry = buildPrefixRegistry(
    input.ledgers.map(({ id, schema }) => ({ name: id, schema })),
  );
  const fieldRefs = (item: Item, fieldNames: readonly string[]): string[] => {
    const refs: string[] = [];
    for (const fieldName of fieldNames) {
      const value = item.fields[fieldName];
      if (typeof value === "string") refs.push(value);
      else if (Array.isArray(value)) {
        refs.push(...value.filter((entry): entry is string => typeof entry === "string"));
      }
    }
    return refs;
  };

  return {
    listLedgers: () => input.ledgers,
    fetchActiveItem: (ref) => active.get(ref),
    fetchArchivedItem: (ref) => archived.get(ref),
    referenceTargets: (sourceRef, fieldNames) => {
      const item = active.get(sourceRef);
      return item === undefined ? [] : fieldRefs(item, fieldNames);
    },
    referenceSources: (targetRef, fieldNames) => {
      const sources: string[] = [];
      for (const [sourceRef, item] of active) {
        for (const rawRef of fieldRefs(item, fieldNames)) {
          try {
            if (canonicalizeRef(rawRef, prefixRegistry) === targetRef) sources.push(sourceRef);
          } catch {
            continue;
          }
        }
      }
      return sources.sort();
    },
    itemRefsByMilestone: (milestoneId) =>
      [...active]
        .filter(([, item]) => item.milestoneId === milestoneId)
        .map(([ref]) => ref)
        .sort(),
    itemRefsByLedgerStatuses: (ledgerId, statuses) => {
      const selected = new Set(statuses);
      return [...active]
        .filter(([ref, item]) => ref.startsWith(`${ledgerId}:`) && selected.has(item.status))
        .map(([ref]) => ref)
        .sort();
    },
    liveTaskRefsByMilestone: (milestoneId) =>
      [...active]
        .filter(
          ([ref, item]) =>
            ref.startsWith(`${TASKS_LEDGER}:`) &&
            item.milestoneId === milestoneId &&
            isLiveExplicitMilestoneTask(item),
        )
        .map(([ref]) => ref)
        .sort(),
  };
}
