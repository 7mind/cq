import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { attestationRowDigest, rehydrateAttestationRow, type AttestationRow } from "@cq/config";
import {
  InMemoryCurrentRecoverySealJournalStore,
  PLAN_FINALIZED_MANIFEST_FIELD,
  currentRecoveryStatus,
  dispatchLineageFenceFromRecoveryJournal,
  type LedgerStore,
} from "@cq/ledger";
import {
  captureCurrentRecoverySeal,
  currentRecoveryTaskEvidence,
  readCurrentDispatchRecoveryStatusForLineage,
} from "../src/dispatchRecoverySeal.js";
import {
  RECOVERY_BINDING,
  RECOVERY_LATER,
  RECOVERY_NOW,
  RECOVERY_RECEIPTS,
  RECOVERY_TASK,
  RECOVERY_TIP,
  abortedEnvelope,
} from "../../ledger/test/recoverySealTestSupport.js";

const coordinates = {
  taskId: RECOVERY_TASK,
  binding: RECOVERY_BINDING,
  liveTip: RECOVERY_TIP,
  taskDigest: "b".repeat(64),
  finalizedManifestDigest: "c".repeat(64),
} as const;

describe("protected current dispatch-recovery capture", () => {
  test("task evidence requires membership in the exact finalized manifest", () => {
    let manifestTaskId = RECOVERY_TASK;
    const store = {
      fetchItem: (ledgerId: string) =>
        ledgerId === "tasks"
          ? { fields: { ledgerRefs: ["goals:G1", "defects:D360"] } }
          : {
              fields: {
                [PLAN_FINALIZED_MANIFEST_FIELD]: JSON.stringify({
                  revision: 1,
                  milestones: [{ key: "recovery", id: "M1" }],
                  tasks: [{ key: "capture-current", id: manifestTaskId }],
                }),
              },
            },
    } as unknown as LedgerStore;

    expect(currentRecoveryTaskEvidence(store, RECOVERY_TASK)).toMatchObject({
      taskDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      finalizedManifestDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    manifestTaskId = "T9999";
    expect(() => currentRecoveryTaskEvidence(store, RECOVERY_TASK)).toThrow(
      "does not belong to the finalized manifest",
    );
  });

  test("records an older maximal source separately from a later ineligible lineage maximum", async () => {
    const journal = new InMemoryCurrentRecoverySealJournalStore();
    const rows = [
      abortedEnvelope({ generation: 2 }),
      abortedEnvelope({
        attestationId: `att_${"b".repeat(32)}`,
        generation: 9,
        reason: "cancelled",
      }),
    ];

    const seal = await captureCurrentRecoverySeal(coordinates, {
      journal,
      snapshot: async () => rows,
      resolveReceipts: async () => RECOVERY_RECEIPTS,
      revalidateBinding: async () => {},
      observeLiveTip: async () => RECOVERY_TIP,
      now: () => RECOVERY_NOW,
    });

    expect(seal.seed.selectedSourceHandle.generation).toBe(2);
    expect(seal.seed.lineageMaximumGeneration).toBe(9);
    expect((await currentRecoveryStatus(journal, RECOVERY_TASK)).state).toBe("committed");
    expect(dispatchLineageFenceFromRecoveryJournal(await journal.read(RECOVERY_TASK))).toMatchObject(
      {
        state: "journal-only",
        recoverySeedRef: seal.sealReference,
        selectedSourceGeneration: 2,
        lineageMaximumGeneration: 9,
      },
    );
  });

  test("a concurrent terminal generation restarts from a fresh snapshot and converges", async () => {
    const journal = new InMemoryCurrentRecoverySealJournalStore();
    const rows = [abortedEnvelope({ generation: 2 })];
    let snapshots = 0;
    let now = RECOVERY_NOW;

    const seal = await captureCurrentRecoverySeal(coordinates, {
      journal,
      snapshot: async () => {
        snapshots += 1;
        return rows;
      },
      resolveReceipts: async () => RECOVERY_RECEIPTS,
      revalidateBinding: async () => {},
      observeLiveTip: async () => RECOVERY_TIP,
      now: () => now,
      afterProvisional: async () => {
        rows.push(abortedEnvelope({ generation: 10 }));
        now = RECOVERY_LATER;
      },
    });

    expect(seal.seed.selectedSourceHandle.generation).toBe(10);
    expect(seal.seed.lineageMaximumGeneration).toBe(10);
    expect(snapshots).toBe(5);
  });

  test("a generation allocated after the final reread forces a fresh capture", async () => {
    const journal = new InMemoryCurrentRecoverySealJournalStore();
    const rows = [abortedEnvelope({ generation: 2 })];
    let snapshots = 0;
    let afterRereadRan = false;

    const seal = await captureCurrentRecoverySeal(coordinates, {
      journal,
      snapshot: async () => {
        snapshots += 1;
        return rows;
      },
      resolveReceipts: async () => RECOVERY_RECEIPTS,
      revalidateBinding: async () => {},
      observeLiveTip: async () => RECOVERY_TIP,
      now: () => RECOVERY_NOW,
      beforeCommit: async () => {
        if (!afterRereadRan) {
          afterRereadRan = true;
          rows.push(abortedEnvelope({ generation: 10 }));
        }
      },
    });

    expect(seal.seed.selectedSourceHandle.generation).toBe(10);
    expect(seal.seed.lineageMaximumGeneration).toBe(10);
    expect(snapshots).toBeGreaterThanOrEqual(5);
  });

  test("preserves normalized non-empty overlay applications from the selected source", async () => {
    const journal = new InMemoryCurrentRecoverySealJournalStore();
    const overlays = [
      { overlayId: "fixture-focus", data: { note: "preserve recovery provenance" } },
    ] as const;
    const row = abortedEnvelope({ generation: 2, overlays });

    const seal = await captureCurrentRecoverySeal(coordinates, {
      journal,
      snapshot: async () => [row],
      resolveReceipts: async () => RECOVERY_RECEIPTS,
      revalidateBinding: async () => {},
      observeLiveTip: async () => RECOVERY_TIP,
      now: () => RECOVERY_NOW,
    });

    expect(seal.seed.overlays).toEqual(overlays.map((overlay) => ({ ...overlay })));
  });

  test("captures a digest-verified legacy persisted envelope that predates overlays", async () => {
    const body = await readFile(
      new URL("./fixtures/legacy-aborted-attestation-no-overlays.json", import.meta.url),
      "utf8",
    );
    const legacy = JSON.parse(body) as AttestationRow;
    const digest = attestationRowDigest(legacy);
    const row = rehydrateAttestationRow(legacy.namespace, body, digest);
    if (row.kind !== "envelope") throw new Error("legacy recovery fixture is not an envelope");
    expect(row.overlays).toEqual([]);
    expect(() => rehydrateAttestationRow(legacy.namespace, body, "0".repeat(64))).toThrow(
      "digests to",
    );

    const seal = await captureCurrentRecoverySeal(coordinates, {
      journal: new InMemoryCurrentRecoverySealJournalStore(),
      snapshot: async () => [row],
      resolveReceipts: async () => RECOVERY_RECEIPTS,
      revalidateBinding: async () => {},
      observeLiveTip: async () => RECOVERY_TIP,
      now: () => RECOVERY_NOW,
    });
    expect(seal.seed.overlays).toEqual([]);
  });

  test("unchanged lineage replays committed authority without provisional demotion", async () => {
    const backing = new InMemoryCurrentRecoverySealJournalStore();
    let writes = 0;
    const journal = {
      read: async (taskId: string) => await backing.read(taskId),
      put: async (value: Parameters<typeof backing.put>[0]) => {
        writes += 1;
        await backing.put(value);
      },
    };
    const rows = [abortedEnvelope({ generation: 2 })];
    let now = RECOVERY_NOW;
    const deps = {
      journal,
      snapshot: async () => rows,
      resolveReceipts: async () => RECOVERY_RECEIPTS,
      revalidateBinding: async () => {},
      observeLiveTip: async () => RECOVERY_TIP,
      now: () => now,
    };

    const first = await captureCurrentRecoverySeal(coordinates, deps);
    const firstWrites = writes;
    now = RECOVERY_LATER;
    const replay = await captureCurrentRecoverySeal(coordinates, deps);

    expect(replay).toEqual(first);
    expect(writes).toBe(firstWrites);
    expect((await journal.read(RECOVERY_TASK))?.state).toBe("committed");
  });

  // Regression: T2816 successor recapture could demote a committed fence before resealing.
  test("failed successor recapture preserves committed fence authority [Behavioral-Active Blackbox-Group]", async () => {
    const journal = new InMemoryCurrentRecoverySealJournalStore();
    const rows = [abortedEnvelope({ generation: 2 })];
    await captureCurrentRecoverySeal(coordinates, {
      journal,
      snapshot: async () => rows,
      resolveReceipts: async () => RECOVERY_RECEIPTS,
      revalidateBinding: async () => {},
      observeLiveTip: async () => RECOVERY_TIP,
      now: () => RECOVERY_NOW,
    });
    const committed = await journal.read(RECOVERY_TASK);
    const fence = dispatchLineageFenceFromRecoveryJournal(committed);
    if (fence === null) throw new Error("initial capture did not install a fence");
    rows.push(abortedEnvelope({ generation: 3 }));
    let provisionalHookRan = false;

    await expect(
      captureCurrentRecoverySeal(coordinates, {
        journal,
        snapshot: async () => rows,
        resolveReceipts: async () => RECOVERY_RECEIPTS,
        revalidateBinding: async () => {},
        observeLiveTip: async () => RECOVERY_TIP,
        now: () => RECOVERY_LATER,
        afterProvisional: async () => {
          provisionalHookRan = true;
          throw new Error("simulated recapture crash");
        },
      }),
    ).rejects.toMatchObject({ reason: "journal-conflict" });
    expect(provisionalHookRan).toBeFalse();
    expect(await journal.read(RECOVERY_TASK)).toEqual(committed);
    expect(dispatchLineageFenceFromRecoveryJournal(await journal.read(RECOVERY_TASK))).toEqual(
      fence,
    );
  });

  test("an active generation refuses before journal mutation", async () => {
    const journal = new InMemoryCurrentRecoverySealJournalStore();

    await expect(
      captureCurrentRecoverySeal(coordinates, {
        journal,
        snapshot: async () => [abortedEnvelope({ generation: 3, state: "prepared" })],
        resolveReceipts: async () => RECOVERY_RECEIPTS,
        revalidateBinding: async () => {},
        observeLiveTip: async () => RECOVERY_TIP,
        now: () => RECOVERY_NOW,
      }),
    ).rejects.toMatchObject({ reason: "lineage-active" });
    expect(await journal.read(RECOVERY_TASK)).toBeNull();
  });

  test("committed status rejects a successor allocated after capture", async () => {
    const journal = new InMemoryCurrentRecoverySealJournalStore();
    const rows = [abortedEnvelope({ generation: 2 })];
    await captureCurrentRecoverySeal(coordinates, {
      journal,
      snapshot: async () => rows,
      resolveReceipts: async () => RECOVERY_RECEIPTS,
      revalidateBinding: async () => {},
      observeLiveTip: async () => RECOVERY_TIP,
      now: () => RECOVERY_NOW,
    });
    rows.push(abortedEnvelope({ generation: 3, state: "prepared" }));

    await expect(
      readCurrentDispatchRecoveryStatusForLineage({
        journal,
        taskId: RECOVERY_TASK,
        binding: RECOVERY_BINDING,
        liveTip: RECOVERY_TIP,
        rows,
      }),
    ).rejects.toMatchObject({ reason: "lineage-active" });
  });

  test("invalid broker journals and excluded terminal reasons never become sources", async () => {
    const journal = new InMemoryCurrentRecoverySealJournalStore();
    const rows = [
      abortedEnvelope({ generation: 2 }),
      abortedEnvelope({ generation: 3, reason: "protocol-violation" }),
    ];

    await expect(
      captureCurrentRecoverySeal(coordinates, {
        journal,
        snapshot: async () => rows,
        resolveReceipts: async () => {
          throw new Error("invalid durable broker journal");
        },
        revalidateBinding: async () => {},
        observeLiveTip: async () => RECOVERY_TIP,
        now: () => RECOVERY_NOW,
      }),
    ).rejects.toMatchObject({ reason: "source-not-found" });
    expect(await journal.read(RECOVERY_TASK)).toBeNull();
  });
});
