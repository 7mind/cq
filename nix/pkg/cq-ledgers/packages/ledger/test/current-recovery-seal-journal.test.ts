import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchPayloadDigest, type DispatchJSONValue } from "@cq/config";
import {
  CURRENT_RECOVERY_TASK_IDENTITY_SCHEME,
  CurrentRecoveryStatusSchema,
  FsCurrentRecoverySealJournalStore,
  InMemoryCurrentRecoverySealJournalStore,
  createCurrentRecoverySeal,
  createCurrentRecoverySeed,
  createDispatchLineageCutoverFence,
  currentRecoveryReceiptClosureDigest,
  currentRecoveryStatus,
  parseCurrentRecoveryStatus,
  parseCurrentRecoverySeal,
  readCommittedCurrentRecoverySeal,
  type CurrentRecoverySealJournalStore,
} from "../src/index.js";
import {
  RECOVERY_BINDING,
  RECOVERY_ATTESTATION,
  RECOVERY_LATER,
  RECOVERY_TASK,
  RECOVERY_TIP,
  committedJournal,
  provisionalJournal,
  receipt,
  recoverySeal,
} from "./recoverySealTestSupport.js";

const roots: string[] = [];

function cancelledRecoverySeal() {
  const template = recoverySeal().seed;
  const {
    kind: _kind,
    version: _version,
    sourceAbortReason: _sourceAbortReason,
    gitReceiptsDigest: _gitReceiptsDigest,
    managedFingerprint,
    guardedTipTransition,
    ...input
  } = template;
  return createCurrentRecoverySeal(
    createCurrentRecoverySeed({
      ...input,
      source: { kind: "aborted", version: 1, abortReason: "cancelled" },
      gitBinding: { ...input.gitBinding, handleFingerprint: managedFingerprint },
      guardedTipTransition: guardedTipTransition ?? null,
    }),
  );
}

function retainedRecoveryJournal(
  version: 1 | 2,
  guardedTipTransition: "absent" | "explicit-null",
) {
  const template = recoverySeal().seed;
  const {
    kind: _kind,
    version: _version,
    sourceAbortReason: _sourceAbortReason,
    promptProvenance: _promptProvenance,
    prepareRequestDigest: _prepareRequestDigest,
    inputRecipe: _inputRecipe,
    overlays: _overlays,
    gitReceiptsDigest: _gitReceiptsDigest,
    managedFingerprint,
    guardedTipTransition: templateGuardedTipTransition,
    ...input
  } = template;
  const seal =
    version === 1
      ? recoverySeal()
      : createCurrentRecoverySeal(
          createCurrentRecoverySeed({
            ...input,
            source: { kind: "consumed-fail", version: 1, status: "fail" },
            gitBinding: { ...input.gitBinding, handleFingerprint: managedFingerprint },
            guardedTipTransition: templateGuardedTipTransition ?? null,
          }),
        );
  const journal = structuredClone({
    ...committedJournal(),
    version,
    seal,
  }) as unknown as {
    version: 1 | 2;
    seal: {
      version: 1 | 2;
      sealDigest: string;
      sealReference: string;
      seed: Record<string, unknown>;
    };
  };
  if (guardedTipTransition === "absent") {
    delete journal.seal.seed["guardedTipTransition"];
  } else {
    journal.seal.seed["guardedTipTransition"] = null;
  }
  journal.seal.sealDigest = dispatchPayloadDigest(
    journal.seal.seed as unknown as DispatchJSONValue,
  );
  journal.seal.sealReference =
    `cq-current-recovery-seal:v${String(version)}:${journal.seal.sealDigest}`;
  return journal;
}

function guardedTransitionJournal(version: 1 | 2) {
  const journal = retainedRecoveryJournal(version, "explicit-null");
  const requestDigest = "7".repeat(64);
  const rebasedStartCommit = "8".repeat(40);
  journal.seal.seed["selectedSourceHandle"] = {
    attestationId: RECOVERY_ATTESTATION,
    generation: 20,
  };
  journal.seal.seed["lineageMaximumGeneration"] = 20;
  journal.seal.seed["liveTip"] = rebasedStartCommit;
  journal.seal.seed["guardedTipTransition"] = {
    kind: "cq-current-recovery-guarded-tip-transition",
    version: 1,
    source: { attestationId: RECOVERY_ATTESTATION, generation: 19 },
    successor: { attestationId: RECOVERY_ATTESTATION, generation: 20 },
    guardedRebase: `cq-guarded-rebase:v1:${requestDigest}`,
    requestDigest,
    oldResultCommit: RECOVERY_TIP,
    ontoCommit: "9".repeat(40),
    rebasedStartCommit,
    receiptPrefixLength: 2,
  };
  journal.seal.sealDigest = dispatchPayloadDigest(
    journal.seal.seed as unknown as DispatchJSONValue,
  );
  journal.seal.sealReference =
    `cq-current-recovery-seal:v${String(version)}:${journal.seal.sealDigest}`;
  return journal;
}

function repeatedGuardedTransitionJournal(version: 1 | 2, freshBetween: boolean) {
  const journal = guardedTransitionJournal(version);
  const firstTransition = journal.seal.seed["guardedTipTransition"] as Record<string, unknown>;
  const firstTip = String(firstTransition["rebasedStartCommit"]);
  const intermediateTip = freshBetween ? "a".repeat(40) : firstTip;
  const finalTip = "b".repeat(40);
  const receipts = [
    ...(journal.seal.seed["gitReceipts"] as ReturnType<typeof receipt>[]),
    ...(freshBetween ? [receipt(20, firstTip, intermediateTip, "post-first-bridge")] : []),
  ];
  const requestDigest = "c".repeat(64);
  const secondTransition = {
    kind: "cq-current-recovery-guarded-tip-transition",
    version: 1,
    source: { attestationId: RECOVERY_ATTESTATION, generation: 20 },
    successor: { attestationId: RECOVERY_ATTESTATION, generation: 21 },
    guardedRebase: `cq-guarded-rebase:v1:${requestDigest}`,
    requestDigest,
    oldResultCommit: intermediateTip,
    ontoCommit: "d".repeat(40),
    rebasedStartCommit: finalTip,
    receiptPrefixLength: receipts.length,
  };
  journal.seal.seed["selectedSourceHandle"] = {
    attestationId: RECOVERY_ATTESTATION,
    generation: 21,
  };
  journal.seal.seed["lineageMaximumGeneration"] = 21;
  journal.seal.seed["gitReceipts"] = receipts;
  journal.seal.seed["gitReceiptsDigest"] = currentRecoveryReceiptClosureDigest(receipts);
  journal.seal.seed["liveTip"] = finalTip;
  journal.seal.seed["guardedTipTransition"] = secondTransition;
  journal.seal.seed["guardedTipTransitions"] = [firstTransition, secondTransition];
  journal.seal.sealDigest = dispatchPayloadDigest(
    journal.seal.seed as unknown as DispatchJSONValue,
  );
  journal.seal.sealReference =
    `cq-current-recovery-seal:v${String(version)}:${journal.seal.sealDigest}`;
  return journal;
}

function authenticateMutatedSeal(seal: {
  version: 1 | 2;
  sealDigest: string;
  sealReference: string;
  seed: Record<string, unknown>;
}): void {
  seal.sealDigest = dispatchPayloadDigest(seal.seed as unknown as DispatchJSONValue);
  seal.sealReference = `cq-current-recovery-seal:v${String(seal.version)}:${seal.sealDigest}`;
}

for (const backend of ["fs", "git-object"]) {
  test(`T6419 refuses recovery seal namespace ${backend} [Blackbox-Atomic]`, () => {
    const seed = recoverySeal().seed;
    expect(() => createCurrentRecoverySeal({
      ...seed,
      namespace: { ...seed.namespace, backend: backend as never },
    })).toThrow(/namespace/);
  });
}

function taskIdentityMigrationJournals() {
  const current = committedJournal();
  const next = {
    ...current,
    fence: createDispatchLineageCutoverFence({
      namespace: current.seal.seed.namespace,
      taskId: RECOVERY_TASK,
      managedFingerprint: current.seal.seed.managedFingerprint,
      sourceAttestationId: current.seal.seed.selectedSourceHandle.attestationId,
      selectedSourceGeneration: current.seal.seed.selectedSourceHandle.generation,
      lineageMaximumGeneration: current.seal.seed.lineageMaximumGeneration,
      recoverySeedRef: current.seal.sealReference,
      fenceCapability: {
        scope: "dispatch-lineage-fence" as const,
        token: RECOVERY_BINDING.handleToken,
      },
      installedAt: current.committedAt,
    }),
  };
  const legacy = structuredClone(next) as typeof next & {
    seal: typeof next.seal & {
      seed: typeof next.seal.seed & { taskIdentityScheme?: string };
    };
  };
  delete legacy.seal.seed.taskIdentityScheme;
  legacy.seal.seed.taskDigest = "0".repeat(64);
  legacy.seal.sealDigest = dispatchPayloadDigest(
    legacy.seal.seed as unknown as DispatchJSONValue,
  );
  legacy.seal.sealReference = `cq-current-recovery-seal:v1:${legacy.seal.sealDigest}`;
  legacy.fence = createDispatchLineageCutoverFence({
    namespace: legacy.seal.seed.namespace,
    taskId: RECOVERY_TASK,
    managedFingerprint: legacy.seal.seed.managedFingerprint,
    sourceAttestationId: legacy.seal.seed.selectedSourceHandle.attestationId,
    selectedSourceGeneration: legacy.seal.seed.selectedSourceHandle.generation,
    lineageMaximumGeneration: legacy.seal.seed.lineageMaximumGeneration,
    recoverySeedRef: legacy.seal.sealReference,
    fenceCapability: {
      scope: "dispatch-lineage-fence" as const,
      token: RECOVERY_BINDING.handleToken,
    },
    installedAt: legacy.committedAt,
  });
  return { legacy, next };
}

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

    test("operator-cancelled authority round-trips with its terminal cause", async () => {
      const store = await factory.make();
      const seal = cancelledRecoverySeal();
      if (seal.version !== 1) throw new Error("cancelled source did not create a v1 seal");
      const journal = {
        ...committedJournal(),
        snapshotDigest: seal.seed.snapshotDigest,
        seal,
      } as const;
      await store.put(journal);

      expect(await store.read(RECOVERY_TASK)).toEqual(journal);
      expect(await currentRecoveryStatus(store, RECOVERY_TASK)).toMatchObject({
        state: "committed",
        seal: { seed: { sourceAbortReason: "cancelled" } },
      });
    });

    test("retained v1 and v2 recovery journals preserve absent and explicit-null guarded transitions", async () => {
      for (const version of [1, 2] as const) {
        const absent = retainedRecoveryJournal(version, "absent");
        const explicitNull = retainedRecoveryJournal(version, "explicit-null");
        expect(absent.seal.sealDigest).not.toBe(explicitNull.seal.sealDigest);

        for (const journal of [absent, explicitNull]) {
          const hasGuardedTipTransition = Object.hasOwn(
            journal.seal.seed,
            "guardedTipTransition",
          );
          const parsedSeal = parseCurrentRecoverySeal(journal.seal);
          expect(parsedSeal).toEqual(journal.seal as never);
          expect(Object.hasOwn(parsedSeal.seed, "guardedTipTransition")).toBe(
            hasGuardedTipTransition,
          );
          const changedSeed = structuredClone(journal.seal);
          changedSeed.seed["capturedAt"] = RECOVERY_LATER;
          expect(() => parseCurrentRecoverySeal(changedSeed)).toThrow(
            "recovery seal digest is not self-authenticating",
          );
          const changedReference = structuredClone(journal.seal);
          changedReference.sealReference =
            `cq-current-recovery-seal:v${String(version)}:${"0".repeat(64)}`;
          expect(() => parseCurrentRecoverySeal(changedReference)).toThrow(
            "recovery seal digest is not self-authenticating",
          );
          const store = await factory.make();
          await store.put(journal as never);
          const stored = await store.read(RECOVERY_TASK);
          expect(stored).toEqual(journal as never);
          expect(Object.hasOwn(stored!.seal.seed, "guardedTipTransition")).toBe(
            hasGuardedTipTransition,
          );
        }
      }
    });

    test("new guarded recovery transitions round-trip", async () => {
      for (const version of [1, 2] as const) {
        const journal = guardedTransitionJournal(version);
        const store = await factory.make();
        await store.put(journal as never);
        expect(await store.read(RECOVERY_TASK)).toEqual(journal as never);
      }
    });

    test("repeated guarded transitions authenticate fresh and empty receipt components [Blackbox-Atomic]", async () => {
      for (const version of [1, 2] as const) {
        for (const freshBetween of [false, true]) {
          const journal = repeatedGuardedTransitionJournal(version, freshBetween);
          expect(parseCurrentRecoverySeal(journal.seal)).toEqual(journal.seal as never);
          const store = await factory.make();
          await store.put(journal as never);
          expect(await store.read(RECOVERY_TASK)).toEqual(journal as never);

          const changedOldResult = structuredClone(journal.seal);
          const changedTransitions = changedOldResult.seed[
            "guardedTipTransitions"
          ] as Record<string, unknown>[];
          changedTransitions[1] = {
            ...changedTransitions[1],
            oldResultCommit: "e".repeat(40),
          };
          changedOldResult.seed["guardedTipTransition"] = changedTransitions[1];
          authenticateMutatedSeal(changedOldResult);
          expect(() => parseCurrentRecoverySeal(changedOldResult)).toThrow(
            "recovery guarded-tip transition 1 does not start at the preceding authenticated tip",
          );

          const reordered = structuredClone(journal.seal);
          const reorderedTransitions = [
            ...(reordered.seed["guardedTipTransitions"] as Record<string, unknown>[]),
          ].reverse();
          reordered.seed["guardedTipTransitions"] = reorderedTransitions;
          authenticateMutatedSeal(reordered);
          expect(() => parseCurrentRecoverySeal(reordered)).toThrow(
            "recovery guarded-tip transition chain does not end at its current transition",
          );

          const gapped = structuredClone(journal.seal);
          const gappedTransitions = gapped.seed[
            "guardedTipTransitions"
          ] as Record<string, unknown>[];
          gappedTransitions[1] = {
            ...gappedTransitions[1],
            receiptPrefixLength:
              (gapped.seed["gitReceipts"] as readonly unknown[]).length + 1,
          };
          gapped.seed["guardedTipTransition"] = gappedTransitions[1];
          authenticateMutatedSeal(gapped);
          expect(() => parseCurrentRecoverySeal(gapped)).toThrow(
            "recovery guarded-tip transition 1 exceeds the receipt closure",
          );

          const substitutedCurrent = structuredClone(journal.seal);
          substitutedCurrent.seed["guardedTipTransition"] = {
            ...(substitutedCurrent.seed["guardedTipTransition"] as Record<string, unknown>),
            requestDigest: "f".repeat(64),
            guardedRebase: `cq-guarded-rebase:v1:${"f".repeat(64)}`,
          };
          authenticateMutatedSeal(substitutedCurrent);
          expect(() => parseCurrentRecoverySeal(substitutedCurrent)).toThrow(
            "recovery guarded-tip transition chain does not end at its current transition",
          );
        }
      }
    });

    test("strict parsing rejects unknown journal members", async () => {
      const store = await factory.make();
      await expect(
        store.put({ ...provisionalJournal(), capability: "must-not-land" } as never),
      ).rejects.toThrow();
      expect(await store.read(RECOVERY_TASK)).toBeNull();
    });

    test("pre-scheme committed identity migration is atomic and replay-idempotent", async () => {
      const store = await factory.make();
      const { legacy, next } = taskIdentityMigrationJournals();
      await store.put(legacy);
      await expect(store.put(next)).rejects.toThrow("cannot replace committed authority");
      expect(await store.read(RECOVERY_TASK)).toEqual(legacy);
      if (store.migrateCommittedTaskIdentity === undefined) {
        throw new Error("journal adapter omitted committed identity migration");
      }
      await store.migrateCommittedTaskIdentity(legacy, next);
      await store.migrateCommittedTaskIdentity(legacy, next);
      expect(await store.read(RECOVERY_TASK)).toEqual(next);
      expect(next.seal.seed.taskIdentityScheme).toBe(CURRENT_RECOVERY_TASK_IDENTITY_SCHEME);
    });

    test("committed promotion accepts an intermediate generation's appended receipt", async () => {
      const store = await factory.make();
      const current = taskIdentityMigrationJournals().next;
      await store.put(current);
      const nextTip = "4".repeat(40);
      const nextSnapshotDigest = "e".repeat(64);
      const seal = createCurrentRecoverySeal(
        createCurrentRecoverySeed({
          selectedSourceHandle: {
            attestationId: current.seal.seed.selectedSourceHandle.attestationId,
            generation: 21,
          },
          lineageMaximumGeneration: 21,
          snapshotDigest: nextSnapshotDigest,
          source: { kind: "aborted", version: 1, abortReason: "parent-lost" },
          sourceTerminalDigest: "f".repeat(64),
          namespace: current.seal.seed.namespace,
          taskId: current.taskId,
          taskDigest: current.seal.seed.taskDigest,
          finalizedManifestDigest: current.seal.seed.finalizedManifestDigest,
          promptProvenance: current.seal.seed.promptProvenance,
          prepareRequestDigest: current.seal.seed.prepareRequestDigest,
          inputRecipe: current.seal.seed.inputRecipe,
          overlays: current.seal.seed.overlays,
          gitBinding: {
            ...current.seal.seed.gitBinding,
            handleFingerprint: current.seal.seed.managedFingerprint,
          },
          gitReceipts: [
            ...current.seal.seed.gitReceipts,
            receipt(20, RECOVERY_TIP, nextTip),
          ],
          liveTip: nextTip,
          capturedAt: RECOVERY_LATER,
        }),
      );
      if (seal.version !== 1) throw new Error("aborted promotion did not create a v1 seal");
      const next = {
        ...current,
        snapshotDigest: nextSnapshotDigest,
        seal,
        writtenAt: RECOVERY_LATER,
        committedAt: RECOVERY_LATER,
        fence: createDispatchLineageCutoverFence({
          namespace: seal.seed.namespace,
          taskId: current.taskId,
          managedFingerprint: seal.seed.managedFingerprint,
          sourceAttestationId: seal.seed.selectedSourceHandle.attestationId,
          selectedSourceGeneration: seal.seed.selectedSourceHandle.generation,
          lineageMaximumGeneration: seal.seed.lineageMaximumGeneration,
          recoverySeedRef: seal.sealReference,
          fenceCapability: {
            scope: "dispatch-lineage-fence",
            token: RECOVERY_BINDING.handleToken,
          },
          installedAt: RECOVERY_LATER,
        }),
      } as const;

      await store.put(next);
      expect(await store.read(RECOVERY_TASK)).toEqual(next);
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
