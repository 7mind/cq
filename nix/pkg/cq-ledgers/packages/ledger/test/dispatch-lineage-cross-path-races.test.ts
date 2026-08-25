import { describe, expect, test } from "bun:test";
import {
  DISPATCH_OVERLAY_REGISTRY,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  prepareDispatchOn,
  sequentialDispatchRandomBytes,
  type PrepareDispatchRequest,
} from "@cq/config";
import {
  InMemoryCurrentRecoverySealJournalStore,
  createDispatchLineageCutoverFence,
  dispatchLineageFenceFromRecoveryJournal,
  journalRecoveryRequiredForFence,
} from "../src/index.js";
import {
  RECOVERY_BINDING,
  RECOVERY_INPUT,
  RECOVERY_LATER,
  RECOVERY_NOW,
  RECOVERY_TASK,
  abortedEnvelope,
  recoverySeal,
} from "./recoverySealTestSupport.js";

class LineageLock {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const preceding = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function request(idempotencyKey: string): PrepareDispatchRequest {
  return {
    namespace: { backend: "xdg", projectKey: "project" },
    roleId: "implement-worker",
    surface: "codex",
    input: RECOVERY_INPUT,
    idempotencyKey,
    timeoutMs: 600_000,
    registry: DISPATCH_OVERLAY_REGISTRY,
    promptDigest: "8".repeat(64),
    catalogHash: "9".repeat(64),
    expectedChild: { childId: "race-child", runId: idempotencyKey },
    gitEffectBinding: RECOVERY_BINDING,
  };
}

function fixture() {
  const journal = new InMemoryCurrentRecoverySealJournalStore();
  const store = InMemoryAttestationStore.rehydrate(
    { backend: "xdg", projectKey: "project" },
    [abortedEnvelope({ generation: 2 })],
  );
  const backend = new InMemoryAttestationBackend(store);
  const lock = new LineageLock();
  const seal = async () =>
    await lock.run(async () => {
      const active = backend
        .storedRows()
        .find(
          (row) =>
            row.kind === "envelope" && row.state !== "consumed" && row.state !== "aborted",
        );
      if (active !== undefined) {
        if (active.kind !== "envelope") throw new Error("unreachable tombstone");
        throw new Error(
          `dispatch lineage generation ${String(active.generation)} is ${active.state}`,
        );
      }
      const recovery = recoverySeal();
      const fence = createDispatchLineageCutoverFence({
        namespace: recovery.seed.namespace,
        taskId: RECOVERY_TASK,
        managedFingerprint: RECOVERY_BINDING.handleFingerprint,
        sourceAttestationId: recovery.seed.selectedSourceHandle.attestationId,
        selectedSourceGeneration: recovery.seed.selectedSourceHandle.generation,
        lineageMaximumGeneration: recovery.seed.lineageMaximumGeneration,
        recoverySeedRef: recovery.sealReference,
        fenceCapability: {
          scope: "dispatch-lineage-fence",
          token: RECOVERY_BINDING.handleToken,
        },
        installedAt: RECOVERY_LATER,
      });
      await journal.put({
        kind: "cq-current-recovery-seal-journal",
        version: 1,
        state: "committed",
        taskId: RECOVERY_TASK,
        snapshotDigest: recovery.seed.snapshotDigest,
        seal: recovery,
        writtenAt: RECOVERY_NOW,
        committedAt: RECOVERY_LATER,
        fence,
      });
      return recovery;
    });
  const legacyPrepare = async (idempotencyKey: string) =>
    await prepareDispatchOn(backend, request(idempotencyKey), {
      now: () => RECOVERY_NOW,
      randomBytes: sequentialDispatchRandomBytes(0),
      withLineageLock: async (operation) => await lock.run(operation),
      lineageFenceGuard: async () => {
        const fence = dispatchLineageFenceFromRecoveryJournal(
          await journal.read(RECOVERY_TASK),
        );
        return fence === null ? null : journalRecoveryRequiredForFence(fence);
      },
    });
  return { backend, journal, seal, legacyPrepare };
}

describe("seal and legacy prepare share one ordered lineage winner", () => {
  test("legacy allocation first leaves no fence and forces seal reselection", async () => {
    const run = fixture();
    const preparePromise = run.legacyPrepare("legacy-wins");
    const sealPromise = run.seal();
    const prepared = await preparePromise;
    expect(prepared.accepted).toBe(true);
    await expect(sealPromise).rejects.toThrow(/is prepared|lineage/u);
    expect(dispatchLineageFenceFromRecoveryJournal(await run.journal.read(RECOVERY_TASK))).toBeNull();
    expect(run.backend.storedRows()).toHaveLength(2);
  });

  test("seal first commits the fence and every following legacy allocation refuses", async () => {
    const run = fixture();
    const sealPromise = run.seal();
    const preparePromise = run.legacyPrepare("seal-wins");
    await sealPromise;
    const prepared = await preparePromise;
    expect(prepared.accepted).toBe(false);
    if (prepared.accepted) throw new Error("sealed prepare unexpectedly allocated");
    expect(prepared.reason).toBe("journal-recovery-required");
    expect(run.backend.storedRows()).toHaveLength(1);
    expect(dispatchLineageFenceFromRecoveryJournal(await run.journal.read(RECOVERY_TASK))).not.toBeNull();
  });
});
