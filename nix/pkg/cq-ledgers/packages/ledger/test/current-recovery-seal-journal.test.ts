import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CurrentRecoveryStatusSchema,
  FsCurrentRecoverySealJournalStore,
  InMemoryCurrentRecoverySealJournalStore,
  createCurrentRecoverySeed,
  currentRecoveryStatus,
  parseCurrentRecoveryStatus,
  parseCurrentRecoverySeal,
  readCommittedCurrentRecoverySeal,
  type CurrentRecoverySealJournalStore,
} from "../src/index.js";
import {
  RECOVERY_TASK,
  committedJournal,
  provisionalJournal,
  recoverySeal,
} from "./recoverySealTestSupport.js";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

interface JournalFactory {
  readonly name: string;
  make(): Promise<CurrentRecoverySealJournalStore>;
}

const factories: readonly JournalFactory[] = [
  {
    name: "in-memory dummy",
    make: async () => new InMemoryCurrentRecoverySealJournalStore(),
  },
  {
    name: "filesystem adapter",
    make: async () => {
      const root = await mkdtemp(join(tmpdir(), "cq-current-recovery-seal-"));
      roots.push(root);
      return new FsCurrentRecoverySealJournalStore(root);
    },
  },
];

for (const factory of factories) {
  describe(`current recovery seal journal (${factory.name})`, () => {
    test("provisional is observable but never readable as recovery authority", async () => {
      const store = await factory.make();
      await store.put(provisionalJournal());

      expect(await readCommittedCurrentRecoverySeal(store, RECOVERY_TASK)).toBeNull();
      expect(await currentRecoveryStatus(store, RECOVERY_TASK)).toMatchObject({
        state: "provisional",
        taskId: RECOVERY_TASK,
        lineageMaximumGeneration: 19,
      });
    });

    test("the identical provisional transitions once to replay-stable committed authority", async () => {
      const store = await factory.make();
      const committed = committedJournal();
      await store.put(provisionalJournal());
      await store.put(committed);
      await store.put(committed);

      expect(await readCommittedCurrentRecoverySeal(store, RECOVERY_TASK)).toEqual(committed.seal);
      expect(await currentRecoveryStatus(store, RECOVERY_TASK)).toEqual({
        kind: "cq-current-recovery-status",
        version: 1,
        taskId: RECOVERY_TASK,
        state: "committed",
        selectedSourceHandle: committed.seal.seed.selectedSourceHandle,
        lineageMaximumGeneration: 19,
        snapshotDigest: committed.snapshotDigest,
        liveTip: committed.seal.seed.liveTip,
        updatedAt: committed.committedAt,
        sealReference: committed.seal.sealReference,
        sealDigest: committed.seal.sealDigest,
      });
    });

    test("strict parsing rejects unknown journal members", async () => {
      const store = await factory.make();
      await expect(
        store.put({ ...provisionalJournal(), capability: "must-not-land" } as never),
      ).rejects.toThrow();
      expect(await store.read(RECOVERY_TASK)).toBeNull();
    });
  });
}

test("every role, input, Git and generation coordinate is authenticated by the seal", () => {
  const mutations: Array<(seal: ReturnType<typeof recoverySeal>) => void> = [
    (seal) => {
      seal.seed.selectedSourceHandle.generation += 1;
    },
    (seal) => {
      seal.seed.lineageMaximumGeneration += 1;
    },
    (seal) => {
      seal.seed.promptProvenance.version += 1;
    },
    (seal) => {
      seal.seed.promptProvenance.surface = "pi";
    },
    (seal) => {
      seal.seed.inputRecipe = { round: 18 };
    },
    (seal) => {
      seal.seed.gitBinding.branch = "implement/T9999";
    },
    (seal) => {
      seal.seed.gitBinding.handleFingerprint = "0".repeat(64);
    },
    (seal) => {
      seal.seed.liveTip = "0".repeat(40);
    },
    (seal) => {
      seal.seed.sourceAbortReason = "parent-lost";
    },
    (seal) => {
      seal.seed.overlays = [{ overlayId: "changed", data: {} }];
    },
  ];

  for (const mutate of mutations) {
    const changed = structuredClone(recoverySeal());
    mutate(changed);
    expect(() => parseCurrentRecoverySeal(changed)).toThrow();
  }
});

test("seal and status schemas are closed and capture no dispatch capability", () => {
  const encoded = JSON.stringify(recoverySeal());
  expect(encoded).not.toContain("Capability");
  expect(encoded).not.toContain("cq_input_");
  expect(encoded).not.toContain("cq_result_");
  expect(encoded).not.toContain("cq_git_");
  expect(() =>
    CurrentRecoveryStatusSchema.parse({
      kind: "cq-current-recovery-status",
      version: 1,
      taskId: RECOVERY_TASK,
      state: "absent",
      extra: true,
    }),
  ).toThrow();
});

test("the recovery seed accepts only strict normalized overlay applications", () => {
  const seed = recoverySeal().seed;
  const {
    kind: _kind,
    version: _version,
    gitReceiptsDigest: _receipts,
    managedFingerprint: _managed,
    ...input
  } = seed;
  for (const overlays of [
    [{ overlayId: "fixture-focus" }],
    [{ overlayId: "Fixture", data: {} }],
    [{ overlayId: "fixture-focus", data: {}, capability: "cq_git_forbidden" }],
  ]) {
    expect(() => createCurrentRecoverySeed({ ...input, overlays } as never)).toThrow();
  }
});

test("committed status reference authenticates its declared seal digest", () => {
  const journal = committedJournal();
  expect(() =>
    parseCurrentRecoveryStatus({
      kind: "cq-current-recovery-status",
      version: 1,
      taskId: RECOVERY_TASK,
      state: "committed",
      selectedSourceHandle: journal.seal.seed.selectedSourceHandle,
      lineageMaximumGeneration: journal.seal.seed.lineageMaximumGeneration,
      snapshotDigest: journal.snapshotDigest,
      liveTip: journal.seal.seed.liveTip,
      updatedAt: journal.committedAt,
      sealReference: journal.seal.sealReference,
      sealDigest: "0".repeat(64),
    }),
  ).toThrow("authenticate its digest");
});
