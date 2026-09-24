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
import type { AsyncGenericMutationDataSource } from "./asyncRowRepository.js";
import { repositoryRead, runRepositoryReads, runAsyncRepositoryReads, type RepositoryReadProgram } from "./readProgram.js";

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
  /**
   * ADVISORY candidates. These include refs copied straight out of item
   * fields (`ledgerRefs`, `dependsOn`, `blockedBy`, `worksetOwnerRef`), where
   * an unknown ledger or unregistered alpha prefix is legal free text — so an
   * unresolvable entry here is skipped, not an error.
   */
  readonly candidateRefs: readonly string[];
  /**
   * AUTHORITATIVE subset of {@link candidateRefs}: server-derived membership
   * the mutation is about to act on (a milestone's members, a ledger's
   * terminal items). These are built from registered ledger ids and stored
   * item ids, so one that fails to canonicalize is a violated internal
   * invariant, not free text. Dropping it silently is what let an archive
   * sweep report success while leaving a terminal record active (D484), so it
   * fails observably instead.
   *
   * This list drives VALIDATION ONLY. Callers must still pass these refs in
   * `candidateRefs` at their natural position, because traversal order is
   * governed there and closure output is insertion-ordered.
   */
  readonly requiredRefs?: readonly string[];
  readonly incidentReferenceFields: readonly string[];
}

export function resolveGenericMutationClosure(
  source: GenericMutationDataSource,
  roots: readonly string[],
  options: ResolveGenericMutationClosureOptions,
): GenericMutationResolvedClosure {
  return runRepositoryReads(source, genericMutationClosureReads(roots, options));
}

export function resolveAsyncGenericMutationClosure(source: AsyncGenericMutationDataSource, roots: readonly string[],
  options: ResolveGenericMutationClosureOptions): Promise<GenericMutationResolvedClosure> {
  return runAsyncRepositoryReads(source, genericMutationClosureReads(roots, options));
}

type GenericReadSource = GenericMutationDataSource | AsyncGenericMutationDataSource;

function* genericMutationClosureReads(roots: readonly string[], options: ResolveGenericMutationClosureOptions): RepositoryReadProgram<GenericReadSource, GenericMutationResolvedClosure> {
  const source = {
    listLedgers: () => repositoryRead((rows: GenericReadSource) => rows.listLedgers()),
    fetchActiveItem: (ref: string) => repositoryRead((rows: GenericReadSource) => rows.fetchActiveItem(ref)),
    fetchArchivedItem: (ref: string) => repositoryRead((rows: GenericReadSource) => rows.fetchArchivedItem(ref)),
    referenceTargets: (ref: string, fields: readonly string[]) => repositoryRead((rows: GenericReadSource) => rows.referenceTargets(ref, fields)),
    referenceSources: (ref: string, fields: readonly string[]) => repositoryRead((rows: GenericReadSource) => rows.referenceSources(ref, fields)),
    liveTaskRefsByMilestone: (id: string) => repositoryRead((rows: GenericReadSource) => rows.liveTaskRefsByMilestone(id)),
  };
  const ledgers = yield* source.listLedgers();
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
  // Validate the authoritative refs BEFORE enqueueing anything. Doing it here
  // rather than inside `enqueue` keeps the check independent of traversal
  // order and still runs for a ref that also arrives through `candidateRefs`
  // (where `seen` would otherwise short-circuit past it).
  for (const ref of options.requiredRefs ?? []) canonicalizeRef(ref, prefixRegistry);

  // Traversal order is unchanged from before `requiredRefs` existed: roots,
  // then candidates in caller order. Closure output is insertion-ordered, so
  // enqueueing the authoritative refs separately here would perturb it.
  for (const ref of canonicalRoots) enqueue(ref);
  for (const ref of options.candidateRefs) enqueue(ref);

  while (queued.length > 0) {
    const ref = queued.shift();
    if (ref === undefined) break;
    const item = yield* source.fetchActiveItem(ref);
    if (item === undefined) {
      const archived = yield* source.fetchArchivedItem(ref);
      if (archived !== undefined) archivedTargets.set(ref, archived);
      continue;
    }
    activeItems.set(ref, item);

    for (const target of yield* source.referenceTargets(ref, ["dependsOn", "blockedBy"])) {
      enqueue(target);
    }
    for (const child of yield* source.referenceSources(ref, [
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
      for (const task of yield* source.liveTaskRefsByMilestone(itemId)) enqueue(task);
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
