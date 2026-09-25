import type { LedgerStore } from "./store/LedgerStore.js";
import { derivePredicates } from "./store/predicates.js";
import { readCanonicalOwnership } from "./worksetOwnerEdges.js";
import { closeWorkset, parseGoalFinalizedManifest } from "./worksetGraph.js";
import { buildActiveStateFromLedgerStore, requireWorksetStore } from "./worksetAccess.js";
import { cohortAdmissionRootsV1, cohortValueDigestV1 as digest,
  type CohortAdmissionObservationV1, type CohortEffectEnvelopeV1 } from "./workCohort.js";

/** Run inside the primary publication transaction; no asynchronous gap precedes publication. */
export function assertCohortPrimaryObservationV1(store: LedgerStore, envelope: CohortEffectEnvelopeV1,
  observation: CohortAdmissionObservationV1): undefined {
  const workset = requireWorksetStore(store).snapshot();
  if (workset instanceof Promise) throw new Error("cohort publication requires synchronous local primary workset fencing");
  const activeState = buildActiveStateFromLedgerStore(store);
  // Same effective-roots rule as admission observation (D556): an empty
  // persisted workset closes over the whole active primary ledger, so an
  // unrestricted cohort publishes instead of failing this fence.
  const graph = closeWorkset(
    cohortAdmissionRootsV1(workset.roots, activeState.byRef),
    activeState,
    { validateLiveRoots: true },
  );
  const worksetRevision = digest({ roots: workset.roots, epoch: workset.epoch,
    nodes: graph.nodes.map(({ ref, item }) => ({ ref, revision: digest({ ref, item }) })), edges: graph.edges });
  if (!graph.restrictive || worksetRevision !== observation.workset.worksetRevision) {
    throw new Error("primary workset roots, epoch or member revisions changed before cohort publication");
  }
  const owners = new Set<string>();
  for (const member of observation.members) {
    if (member.phase !== "implementation") throw new Error("implementation publication contains another phase");
    const task = store.fetchItem("tasks", member.memberRef.slice("tasks:".length));
    const goal = store.fetchItem("goals", member.goalRef.slice("goals:".length));
    const manifest = parseGoalFinalizedManifest(goal);
    const manifestRevision = digest({ goalRef: member.goalRef, manifest });
    const ownership = readCanonicalOwnership(task);
    if (task.status !== "wip" || digest({ ref: member.memberRef, item: task }) !== member.taskRevision ||
        ownership?.ownerRef !== member.goalRef || ownership.edgeKind !== "finalized-manifest" || manifest === null ||
        manifestRevision !== member.finalizedManifestRevision ||
        digest({ goalRef: member.goalRef, goalRevision: digest({ ref: member.goalRef, item: goal }), manifestRevision,
          worksetRevision: observation.workset.worksetRevision }) !== member.authorityRevision) {
      throw new Error(`${member.memberRef} primary revision or finalized authority changed before cohort publication`);
    }
    owners.add(member.goalRef);
  }
  const ready = derivePredicates(store).pImplement.items.map((id) => store.fetchItem("tasks", id))
    .filter((item) => { const owner = readCanonicalOwnership(item); return owner !== undefined && owner !== null && owners.has(owner.ownerRef); })
    .map(({ id }) => `tasks:${id}`).sort();
  if (digest(ready) !== digest(observation.members.map(({ memberRef }) => memberRef).sort()) ||
      envelope.definition.members.some(({ memberRef, memberRevision }) =>
        !observation.members.some((member) => member.memberRef === memberRef && member.memberRevision === memberRevision))) {
    throw new Error("the complete ready boundary changed before cohort publication");
  }
}
