import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  RECOVERY_BINDING,
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
        sealReference: committed.seal.sealReference,
        sealDigest: committed.seal.sealDigest,
        seal: committed.seal,
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
      seal.seed.managedFingerprint = "0".repeat(64);
    },
    (seal) => {
      seal.seed.snapshotDigest = "0".repeat(64);
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
  expect(encoded).not.toContain(RECOVERY_BINDING.handleToken);
  expect(encoded).not.toContain("Capability");
  expect(encoded).not.toContain("cq_input_");
  expect(encoded).not.toContain("cq_result_");
  expect(encoded).not.toContain("cq_git_");
  const injected = structuredClone(recoverySeal()) as unknown as {
    seed: { gitBinding: Record<string, unknown> };
  };
  injected.seed.gitBinding["handleToken"] = RECOVERY_BINDING.handleToken;
  expect(() => parseCurrentRecoverySeal(injected)).toThrow();
  expect(() =>
    CurrentRecoveryStatusSchema.parse({
      kind: "cq-current-recovery-status",
      version: 1,
      taskId: RECOVERY_TASK,
      state: "absent",
      extra: true,
    }),
  ).toThrow();
  const seed = recoverySeal().seed;
  expect(() =>
    CurrentRecoveryStatusSchema.parse({
      kind: "cq-current-recovery-status",
      version: 2,
      taskId: RECOVERY_TASK,
      state: "provisional",
      selectedSourceHandle: seed.selectedSourceHandle,
      lineageMaximumGeneration: seed.lineageMaximumGeneration,
      snapshotDigest: seed.snapshotDigest,
      liveTip: seed.liveTip,
      source: { kind: "aborted", version: 1, abortReason: "parent-lost" },
      updatedAt: seed.capturedAt,
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
    expect(() =>
      createCurrentRecoverySeed({
        ...input,
        gitBinding: {
          ...input.gitBinding,
          handleFingerprint: RECOVERY_BINDING.handleFingerprint,
        },
        overlays,
      } as never),
    ).toThrow();
  }
});

test("committed status rejects every projected-field and embedded-seal substitution", () => {
  const journal = committedJournal();
  const status = {
    kind: "cq-current-recovery-status" as const,
    version: 1 as const,
    taskId: RECOVERY_TASK,
    state: "committed" as const,
    selectedSourceHandle: structuredClone(journal.seal.seed.selectedSourceHandle),
    lineageMaximumGeneration: journal.seal.seed.lineageMaximumGeneration,
    snapshotDigest: journal.snapshotDigest,
    liveTip: journal.seal.seed.liveTip,
    sealReference: journal.seal.sealReference,
    sealDigest: journal.seal.sealDigest,
    seal: structuredClone(journal.seal),
  };
  const mutations: Array<(candidate: typeof status) => void> = [
    (candidate) => {
      candidate.taskId = "T9999";
    },
    (candidate) => {
      candidate.selectedSourceHandle.attestationId = `att_${"z".repeat(32)}`;
    },
    (candidate) => {
      candidate.selectedSourceHandle.generation += 1;
    },
    (candidate) => {
      candidate.lineageMaximumGeneration += 1;
    },
    (candidate) => {
      candidate.snapshotDigest = "0".repeat(64);
    },
    (candidate) => {
      candidate.liveTip = "0".repeat(40);
    },
    (candidate) => {
      candidate.sealReference = `cq-current-recovery-seal:v1:${"0".repeat(64)}`;
    },
    (candidate) => {
      candidate.sealDigest = "0".repeat(64);
    },
    (candidate) => {
      candidate.seal.seed.promptProvenance.version += 1;
    },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(status);
    mutate(candidate);
    expect(() => parseCurrentRecoveryStatus(candidate)).toThrow();
  }
});

test("the filesystem adapter reads an authenticated pre-source v1 journal and projects its v1 status", async () => {
  const root = await mkdtemp(join(tmpdir(), "cq-current-recovery-v1-"));
  roots.push(root);
  const legacy = committedJournal();
  const directory = join(root, "current-recovery-seals");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${RECOVERY_TASK}.json`), `${JSON.stringify(legacy)}\n`, "utf8");

  const store = new FsCurrentRecoverySealJournalStore(root);
  expect(await store.read(RECOVERY_TASK)).toEqual(legacy);
  expect(await currentRecoveryStatus(store, RECOVERY_TASK)).toEqual({
    kind: "cq-current-recovery-status",
    version: 1,
    taskId: RECOVERY_TASK,
    state: "committed",
    selectedSourceHandle: legacy.seal.seed.selectedSourceHandle,
    lineageMaximumGeneration: legacy.seal.seed.lineageMaximumGeneration,
    snapshotDigest: legacy.snapshotDigest,
    liveTip: legacy.seal.seed.liveTip,
    sealReference: legacy.seal.sealReference,
    sealDigest: legacy.seal.sealDigest,
    seal: legacy.seal,
  });
});
