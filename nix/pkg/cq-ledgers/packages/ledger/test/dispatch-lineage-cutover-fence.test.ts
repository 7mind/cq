import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FsCurrentRecoverySealJournalStore,
  InMemoryCurrentRecoverySealJournalStore,
  dispatchLineageFenceAuthorizes,
  dispatchLineageFenceFromRecoveryJournal,
  journalRecoveryRequiredForFence,
  createDispatchLineageCutoverFence,
} from "../src/index.js";
import {
  RECOVERY_BINDING,
  RECOVERY_LATER,
  RECOVERY_NOW,
  RECOVERY_TASK,
  recoverySeal,
} from "./recoverySealTestSupport.js";

async function sealedJournal(store: InMemoryCurrentRecoverySealJournalStore) {
  const seal = recoverySeal();
  const fence = createDispatchLineageCutoverFence({
    namespace: seal.seed.namespace,
    taskId: RECOVERY_TASK,
    managedFingerprint: RECOVERY_BINDING.handleFingerprint,
    sourceAttestationId: seal.seed.selectedSourceHandle.attestationId,
    selectedSourceGeneration: seal.seed.selectedSourceHandle.generation,
    lineageMaximumGeneration: seal.seed.lineageMaximumGeneration,
    recoverySeedRef: seal.sealReference,
    fenceCapability: {
      scope: "dispatch-lineage-fence",
      token: RECOVERY_BINDING.handleToken,
    },
    installedAt: RECOVERY_LATER,
  });
  const journal = {
    kind: "cq-current-recovery-seal-journal",
    version: 1,
    state: "committed",
    taskId: RECOVERY_TASK,
    snapshotDigest: seal.seed.snapshotDigest,
    seal,
    writtenAt: RECOVERY_NOW,
    committedAt: RECOVERY_LATER,
    fence,
  } as const;
  await store.put(journal);
  return { journal, fence };
}

describe("dispatch lineage cutover fence", () => {
  test("commits journal-only authority with independent source and maximum generations", async () => {
    const { journal } = await sealedJournal(new InMemoryCurrentRecoverySealJournalStore());
    const fence = dispatchLineageFenceFromRecoveryJournal(journal);
    expect(fence).not.toBeNull();
    expect(fence).toMatchObject({
      state: "journal-only",
      taskRef: `tasks:${RECOVERY_TASK}`,
      selectedSourceGeneration: 17,
      lineageMaximumGeneration: 19,
      managedFingerprint: RECOVERY_BINDING.handleFingerprint,
      sourceAttestationId: `att_${"a".repeat(32)}`,
    });
    expect(fence!.recoverySeedRef).toBe(journal!.seal.sealReference);
    expect(fence!.fenceRef).toMatch(/^cq-dispatch-lineage-cutover-fence:v1:[0-9a-f]{64}$/u);
  });

  test("refusal exposes only public fence and task references", async () => {
    const { journal } = await sealedJournal(new InMemoryCurrentRecoverySealJournalStore());
    const fence = dispatchLineageFenceFromRecoveryJournal(journal)!;
    const refusal = journalRecoveryRequiredForFence(fence);
    expect(refusal).toEqual({
      accepted: false,
      outcome: "pre-launch-rejection",
      reason: "journal-recovery-required",
      path: "dispatchLineage",
      detail: "the managed task lineage is sealed for journal recovery",
      allocated: false,
      fenceRef: fence.fenceRef,
      taskRef: `tasks:${RECOVERY_TASK}`,
    });
    const encoded = JSON.stringify(refusal);
    expect(encoded).not.toContain(fence.sourceAttestationId);
    expect(encoded).not.toContain(fence.recoverySeedRef);
    expect(encoded).not.toContain(fence.fenceCapabilityHash);
  });

  test("only the exact recovery seed and fence capability authorize reservation", async () => {
    const { journal } = await sealedJournal(new InMemoryCurrentRecoverySealJournalStore());
    const fence = dispatchLineageFenceFromRecoveryJournal(journal)!;
    expect(
      dispatchLineageFenceAuthorizes(fence, {
        recoverySeedRef: fence.recoverySeedRef,
        fenceCapability: {
          scope: "dispatch-lineage-fence",
          token: RECOVERY_BINDING.handleToken,
        },
      }),
    ).toBe(true);
    expect(
      dispatchLineageFenceAuthorizes(fence, {
        recoverySeedRef: fence.recoverySeedRef,
        fenceCapability: { scope: "dispatch-lineage-fence", token: "wrong-capability-token" },
      }),
    ).toBe(false);
    expect(
      dispatchLineageFenceAuthorizes(fence, {
        recoverySeedRef: `cq-current-recovery-seal:v1:${"0".repeat(64)}`,
        fenceCapability: {
          scope: "dispatch-lineage-fence",
          token: RECOVERY_BINDING.handleToken,
        },
      }),
    ).toBe(false);
  });

  test("rejects a valid fence that does not authenticate the committed seed", async () => {
    const { journal, fence } = await sealedJournal(new InMemoryCurrentRecoverySealJournalStore());
    const mismatchedFence = createDispatchLineageCutoverFence({
      namespace: fence.namespace,
      taskId: fence.taskId,
      managedFingerprint: fence.managedFingerprint,
      sourceAttestationId: fence.sourceAttestationId,
      selectedSourceGeneration: fence.selectedSourceGeneration + 1,
      lineageMaximumGeneration: fence.lineageMaximumGeneration,
      recoverySeedRef: fence.recoverySeedRef,
      fenceCapability: {
        scope: "dispatch-lineage-fence",
        token: RECOVERY_BINDING.handleToken,
      },
      installedAt: fence.installedAt,
    });
    const store = new InMemoryCurrentRecoverySealJournalStore();
    await expect(store.put({ ...journal, fence: mismatchedFence })).rejects.toThrow(
      "does not match its authenticated seed",
    );
  });

  test("persists after source deletion and is removed only by the store's release operation", async () => {
    const memory = new InMemoryCurrentRecoverySealJournalStore();
    const { journal } = await sealedJournal(memory);
    expect(
      dispatchLineageFenceFromRecoveryJournal(await memory.read(RECOVERY_TASK)),
    ).not.toBeNull();

    const root = await fs.mkdtemp(join(tmpdir(), "t2816-fence-"));
    try {
      const first = new FsCurrentRecoverySealJournalStore(root);
      await first.put(journal!);
      const reopened = new FsCurrentRecoverySealJournalStore(root);
      const durableFence = dispatchLineageFenceFromRecoveryJournal(journal);
      expect(dispatchLineageFenceFromRecoveryJournal(await reopened.read(RECOVERY_TASK))).toEqual(
        durableFence,
      );
      await reopened.remove(RECOVERY_TASK);
      expect(await reopened.read(RECOVERY_TASK)).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
