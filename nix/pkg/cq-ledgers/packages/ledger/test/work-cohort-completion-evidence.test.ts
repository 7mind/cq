import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryLedgerStore } from "../src/store/InMemoryLedgerStore.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { createInMemoryImplementationEvidenceStore, ProtectedCohortCompletionJournalV1, markImplementationCompletionMergeStarted, protectLedgerStoreWithImplementationEvidence } from "../src/implementationEvidence.js";
import { createCohortCompletionBatchV1 } from "../src/workCohortCompletion.js";
import type { CohortDeploymentPlanV1 } from "../src/workCohortCompletion.js";
import { materializeCohortOperatorAction, acknowledgeOperatorAction, operatorActionRevision, reviseOperatorAction } from "../src/operatorActions.js";
import { prepareCohortCompletionFixture } from "./workCohortCompletionContract.js";
import { cohortReviewFixture } from "./workCohortReviewFixture.js";
import { createImplementationEvidenceFixture, prepareImplementationCompletion, IMPLEMENTATION_BASE } from "./implementationEvidenceTestSupport.js";

test("cohort review rejects a schema-valid approval for a different result commit [Behavioral-Active Blackbox-Group]", async () => {
  const store = new InMemoryLedgerStore(); await store.init();
  try {
    const f = await prepareCohortCompletionFixture(store);
    const review = await cohortReviewFixture(f);
    expect(() => review.authenticate()).not.toThrow();
    review.replaceOutput({ ...review.output, resultCommitEvidence: { ...review.output.resultCommitEvidence, resultCommit: "f".repeat(40) } });
    expect(() => review.authenticate()).toThrow();
  } finally { await store.dispose(); }
});

test("cohort deployment plan rejects undeclared protocol fields [Behavioral-Active Blackbox-Group]", async () => {
  const store = new InMemoryLedgerStore(); await store.init();
  try {
    const { batch } = await prepareCohortCompletionFixture(store);
    const { batchDigest: _digest, ...input } = batch;
    expect(() => createCohortCompletionBatchV1({ ...input,
      deploymentPlan: { ...batch.deploymentPlan!, commandOverride: "undeclared" } as CohortDeploymentPlanV1 })).toThrow();
  } finally { await store.dispose(); }
});

for (const adapter of ["memory", "sqlite"] as const) {
  test(`cohort deployment action is idempotent and binds every member without a task anchor ${adapter} [Behavioral-Active Blackbox-GoodCommunication]`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cohort-operator-"));
    const store = adapter === "memory" ? new InMemoryLedgerStore() : new SqliteLedgerStore({ dbPath: join(directory, "ledger.db") });
    await store.init();
    try {
      const f = await prepareCohortCompletionFixture(store);
      const review = await cohortReviewFixture(f);
      const evidence = createInMemoryImplementationEvidenceStore();
      const journal = new ProtectedCohortCompletionJournalV1(evidence);
      const receipt = await journal.recordReview(review.authenticate());
      const protectedStore = protectLedgerStoreWithImplementationEvidence(store, evidence);
      await expect(protectedStore.updateItem("tasks", f.taskIds[0]!, { status: "done", fields: { completion: "unprotected subset" } })).rejects.toThrow("protected implementation evidence");
      const { batchDigest: _digest, ...input } = f.batch;
      const batch = createCohortCompletionBatchV1({ ...input, members: input.members.map((member) => ({ ...member, reviewAttemptRefs: [receipt.reviewRef] })) });
      await journal.prepare(batch, batch.envelope.definition.repository.headCommit);
      await journal.mergeStarted(batch, batch.envelope.definition.repository.headCommit);
      await journal.merged(batch, batch.resultCommit);
      const singleton = await createImplementationEvidenceFixture(evidence);
      const pending = await prepareImplementationCompletion(singleton);
      await expect(markImplementationCompletionMergeStarted(evidence, pending.completionRef, IMPLEMENTATION_BASE)).rejects.toThrow("cohort");
      const proof = await journal.authorizeDeployment(batch);
      const first = await materializeCohortOperatorAction(store, proof);
      const second = await materializeCohortOperatorAction(store, proof);
      expect(first.state).toBe("created"); expect(second.state).toBe("existing");
      expect(second.action.id).toBe(first.action.id);
      expect(first.action.fields["taskRef"]).toBeUndefined();
      expect(first.action.fields["goalRef"]).toBeUndefined();
      expect(first.action.fields["cohortMemberRefs"]).toEqual(batch.members.map(({ taskRef }) => taskRef));
      const acknowledged = await acknowledgeOperatorAction(store, { actionId: first.action.id,
        expectedRevision: operatorActionRevision(first.action), outputIdentity: String(first.action.fields["expectedOutputIdentity"]),
        acknowledgedAt: "2026-09-22T10:00:00.000Z" });
      expect(acknowledged.state).toBe("acknowledged");
      await expect(reviseOperatorAction(store, { actionId: first.action.id, expectedRevision: operatorActionRevision(acknowledged.action),
        expectedOutputIdentity: "different", expectedEvidence: ["different"], revisedAt: "2026-09-22T10:01:00.000Z", author: "contract" })).rejects.toThrow("cohort");
    } finally { await store.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
}
