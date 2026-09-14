import { InMemoryLedgerStore, createTrustedWorksetManagementAuthority, createWorksetOwnedGuardedLedger, type ImplementationAdoptionRecord, type PostgresLedgerStore, type SqliteLedgerStore } from "../src/index.js";
import { LIFECYCLE_CLAIM_INPUT, LIFECYCLE_PROVENANCE } from "./sqlitePlanLifecycleFixture.js";
import { implementationAdoptionTaskDigest } from "../src/index.js";

export type AdoptionStore = InMemoryLedgerStore | SqliteLedgerStore | PostgresLedgerStore;
const HEAD = "c".repeat(40);

export async function publishAdoptionTask(store: AdoptionStore) {
  const claim = await store.claimPlan(LIFECYCLE_CLAIM_INPUT);
  if (!claim.ok) throw new Error("adoption fixture claim refused");
  const identity = { goalId: "G1", claimId: claim.acknowledgement.claimId, generation: 1,
    ownerFenceToken: LIFECYCLE_CLAIM_INPUT.ownerFenceToken, ...LIFECYCLE_PROVENANCE };
  const published = await store.publishPlanDraft({ ...identity, operationId: "publish-adoption",
    manifest: { milestones: [{ key: "m", title: "adoption" }], tasks: [{ key: "t", milestoneKey: "m", headline: "adopted implementation" }] } });
  if (!published.ok) throw new Error("adoption fixture publication refused");
  const owned = createWorksetOwnedGuardedLedger({ rawStore: store, worksetStore: store.worksetStore(),
    invocationAuthority: createTrustedWorksetManagementAuthority(),
    runOwnedTransaction: (mutate, context) => store.runAtomicOwnedMutation(mutate, context) });
  await owned.owned.createOwned({ owner: { ledgerId: "goals", itemId: "G1" }, creationKind: "review",
    child: { ledgerId: "reviews", id: "R1", status: "go-ahead",
      fields: { planDraft: JSON.stringify({ goalId: "G1", claimId: identity.claimId, generation: 1, revision: 1 }) } } });
  const finalized = await store.finalizePlan({ ...identity, operationId: "finalize-adoption", reviewId: "R1", draftRevision: 1,
    decision: { headline: "accept adoption task plan" } });
  if (!finalized.ok) throw new Error("adoption fixture finalization refused");
  const task = store.fetchItem("tasks", "T1");
  const finalizedManifest = store.fetchItem("goals", "G1").fields["planFinalizedManifest"];
  if (typeof finalizedManifest !== "string") throw new Error("adoption fixture omitted final manifest");
  const authority = { taskRef: "tasks:T1", ownerGoalRef: "goals:G1", status: task.status, finalizedManifest };
  const record: ImplementationAdoptionRecord = {
    kind: "operator-adoption", version: 1, adoptionRef: `cq-implementation-adoption:v1:${"a".repeat(64)}`,
    taskRef: authority.taskRef, ownerGoalRef: authority.ownerGoalRef, finalizedManifest,
    expectedTaskUpdatedAt: task.updatedAt, expectedRepositoryHead: HEAD, resultCommit: HEAD,
    expectedTaskDigest: implementationAdoptionTaskDigest(task),
    supersedesCompletionRefs: [],
    approval: { kind: "explicit-operator-approval", questionRef: "questions:Q405", answer: "Allow explicit operator adoption" },
    authorityLossReason: "Original dispatch unavailable", completion: "Adopted validated work",
    validation: { kind: "operator-reported-validation", validatedCommit: HEAD, command: "bun run check", exitCode: 0,
      logPath: "raw/adoption-validation.md", logSha256: "d".repeat(64) },
    operationId: "record-adoption", requestDigest: "e".repeat(64), author: "parent", session: "D461",
    state: "recording", preparedAt: task.updatedAt, recordedAt: null,
  };
  await store.createItem("questions", "M-AMBIENT", { id: "Q405", status: "answered", fields: {
    question: "Permit explicitly approved operator adoption?", answer: record.approval.answer,
  } });
  return { authority, record };
}
