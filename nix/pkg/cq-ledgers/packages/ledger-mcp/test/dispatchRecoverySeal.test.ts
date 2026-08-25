import { describe, expect, test } from "bun:test";
import {
  InMemoryCurrentRecoverySealJournalStore,
  PLAN_FINALIZED_MANIFEST_FIELD,
  currentRecoveryStatus,
  type LedgerStore,
} from "@cq/ledger";
import {
  captureCurrentRecoverySeal,
  currentRecoveryTaskEvidence,
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
    expect(snapshots).toBe(4);
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
