import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  DISPATCH_OVERLAY_REGISTRY,
  FakeDispatchClock,
  InMemoryAttestationStore,
  attestationRowDigest,
  claimParentGate,
  collapseAttestationEnvelope,
  completeParentGate,
  confirmDispatchCompletion,
  dispatchPayloadDigest,
  prepareDispatch,
  provenanceBindingOf,
  rehydrateAttestationRow,
  sequentialDispatchRandomBytes,
  storeDispatchResult,
  type AttestationRow,
  type DispatchJSONValue,
} from "@cq/config";
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
  RECOVERY_ATTESTATION,
  RECOVERY_BASE,
  RECOVERY_INPUT,
  RECOVERY_LATER,
  RECOVERY_MIDDLE,
  RECOVERY_NOW,
  RECOVERY_RECEIPTS,
  RECOVERY_TASK,
  RECOVERY_TIP,
  abortedEnvelope,
  provisionalJournal,
} from "../../ledger/test/recoverySealTestSupport.js";

const coordinates = {
  taskId: RECOVERY_TASK,
  binding: RECOVERY_BINDING,
  liveTip: RECOVERY_TIP,
  taskDigest: "b".repeat(64),
  finalizedManifestDigest: "c".repeat(64),
} as const;

function authenticatedConsumedResult(
  status: "pass" | "fail",
  options: { readonly collapse?: boolean; readonly randomSeed?: number } = {},
) {
  const namespace = { backend: "xdg" as const, projectKey: "project" };
  const clock = new FakeDispatchClock(RECOVERY_NOW);
  const store = new InMemoryAttestationStore(namespace);
  const prepared = prepareDispatch(
    {
      namespace,
      roleId: "implement-worker",
      surface: "codex",
      input: RECOVERY_INPUT,
      idempotencyKey: "D361-collapsed-consumed-fail",
      timeoutMs: 600_000,
      registry: DISPATCH_OVERLAY_REGISTRY,
      promptDigest: "8".repeat(64),
      catalogHash: "9".repeat(64),
      expectedChild: { childId: "child", runId: "run" },
      gitEffectBinding: RECOVERY_BINDING,
    },
    {
      store,
      now: clock.now,
      randomBytes: sequentialDispatchRandomBytes(options.randomSeed ?? 17),
    },
  );
  if (!prepared.accepted) throw new Error(`fixture prepare rejected: ${prepared.detail}`);
  const handle = prepared.prepared;
  const receipts = RECOVERY_RECEIPTS.map((receipt) => ({
    ...receipt,
    attestationId: handle.attestationId,
    generation: handle.generation,
  }));
  const output = (status === "fail"
    ? {
        taskId: RECOVERY_TASK,
        status,
        resultCommit: null,
        branch: RECOVERY_BINDING.branch,
        actualWorktreePath: RECOVERY_BINDING.worktreePath,
        filesTouched: [],
        checkSummary: "controlled consumed failure",
        summary: "the trusted parent captured the failed output",
        blockedReason: "controlled D361 reproduction",
        baseVerification: {
          status: "unresolvable",
          reason: "base-missing",
          baseCommit: null,
          headCommit: null,
        },
      }
    : {
        taskId: RECOVERY_TASK,
        status,
        resultCommit: RECOVERY_TIP,
        branch: RECOVERY_BINDING.branch,
        actualWorktreePath: RECOVERY_BINDING.worktreePath,
        filesTouched: ["file.txt"],
        gitReceipts: receipts,
        checkSummary: "controlled consumed pass",
        summary: "the trusted parent captured the passing output",
        baseVerification: {
          status: "verified",
          relation: "descendant",
          baseCommit: RECOVERY_BASE,
          headCommit: RECOVERY_TIP,
        },
      }) as DispatchJSONValue;
  const stored = storeDispatchResult(
    {
      resultCapability: handle.resultCapability,
      output,
    },
    { store, now: clock.now },
  );
  if (stored.state === "aborted") {
    throw new Error(`fixture result rejected: ${JSON.stringify(stored.result)}`);
  }
  if (handle.parentGateCapability === undefined) {
    throw new Error("fixture did not receive parent-gate authority");
  }
  const claimed = claimParentGate(
    {
      attestationId: handle.attestationId,
      generation: handle.generation,
      parentGateCapability: handle.parentGateCapability,
    },
    { store, now: clock.now },
  );
  if (claimed.state !== "gate-running") throw new Error("fixture parent gate did not stage");
  completeParentGate(
    {
      attestationId: handle.attestationId,
      generation: handle.generation,
      parentGateCapability: handle.parentGateCapability,
      gateEpoch: claimed.gateEpoch,
      output:
        status === "pass"
          ? ({ ...(output as Record<string, DispatchJSONValue>), gateDurationMs: 1 } as DispatchJSONValue)
          : output,
    },
    { store, now: clock.now },
  );
  clock.set(RECOVERY_LATER);
  confirmDispatchCompletion(
    {
      namespace,
      attestationId: handle.attestationId,
      generation: handle.generation,
      nativeCompletion: {
        kind: "native-completion",
        actor: "trusted-parent",
        childId: "child",
        runId: "run",
        completedAt: RECOVERY_LATER,
      },
      expectedProvenance: provenanceBindingOf(handle),
      continuationContext: { liveTip: RECOVERY_TIP, gitReceipts: receipts },
    },
    { store, now: clock.now },
  );
  const consumed = store.rows()[0];
  if (consumed === undefined || consumed.kind !== "envelope") {
    throw new Error("fixture did not retain a consumed envelope");
  }
  const persisted = options.collapse === false ? consumed : collapseAttestationEnvelope(consumed);
  const body = JSON.stringify(persisted);
  return {
    receipts,
    row: rehydrateAttestationRow(namespace, body, attestationRowDigest(persisted)),
  };
}

function authenticatedCollapsedConsumedResult(status: "pass" | "fail") {
  return authenticatedConsumedResult(status);
}

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

  test("v1 committed status retains the legacy envelope-only lineage digest", async () => {
    const journal = new InMemoryCurrentRecoverySealJournalStore();
    const predecessor = abortedEnvelope({ generation: 2 });
    await captureCurrentRecoverySeal(coordinates, {
      journal,
      snapshot: async () => [predecessor],
      resolveReceipts: async () => RECOVERY_RECEIPTS,
      revalidateBinding: async () => {},
      observeLiveTip: async () => RECOVERY_TIP,
      now: () => RECOVERY_NOW,
    });
    const successor = authenticatedCollapsedConsumedResult("fail");

    await expect(
      readCurrentDispatchRecoveryStatusForLineage({
        journal,
        taskId: RECOVERY_TASK,
        binding: RECOVERY_BINDING,
        liveTip: RECOVERY_TIP,
        rows: [predecessor, successor.row],
      }),
    ).resolves.toMatchObject({ state: "committed", version: 1 });
  });

  test("first v1 capture excludes an ineligible consumed-pass tombstone from its durable digest", async () => {
    const journal = new InMemoryCurrentRecoverySealJournalStore();
    const predecessor = abortedEnvelope({ generation: 2 });
    const consumedPass = authenticatedCollapsedConsumedResult("pass");
    const rows = [predecessor, consumedPass.row];
    const deps = {
      journal,
      snapshot: async () => rows,
      resolveReceipts: async () => RECOVERY_RECEIPTS,
      revalidateBinding: async () => {},
      observeLiveTip: async () => RECOVERY_TIP,
      now: () => RECOVERY_NOW,
    };

    const seal = await captureCurrentRecoverySeal(coordinates, deps);
    expect(seal.version).toBe(1);
    await expect(
      readCurrentDispatchRecoveryStatusForLineage({
        journal,
        taskId: RECOVERY_TASK,
        binding: RECOVERY_BINDING,
        liveTip: RECOVERY_TIP,
        rows,
      }),
    ).resolves.toMatchObject({ state: "committed", version: 1 });
    await expect(captureCurrentRecoverySeal(coordinates, deps)).resolves.toEqual(seal);
  });

  test("a v1 provisional journal upgrades to v2 with tombstone-inclusive membership", async () => {
    const journal = new InMemoryCurrentRecoverySealJournalStore();
    await journal.put(provisionalJournal());
    const predecessor = abortedEnvelope({
      attestationId: `att_${"f".repeat(32)}`,
      generation: 1,
    });
    const consumedPass = authenticatedConsumedResult("pass", { randomSeed: 41 });
    const consumedFail = authenticatedConsumedResult("fail", {
      collapse: false,
      randomSeed: 73,
    });
    const rows = [predecessor, consumedPass.row, consumedFail.row];

    const seal = await captureCurrentRecoverySeal(coordinates, {
      journal,
      snapshot: async () => rows,
      resolveReceipts: async () => consumedFail.receipts,
      revalidateBinding: async () => {},
      observeLiveTip: async () => RECOVERY_TIP,
      now: () => RECOVERY_NOW,
    });

    expect(seal.version).toBe(2);
    await expect(
      readCurrentDispatchRecoveryStatusForLineage({
        journal,
        taskId: RECOVERY_TASK,
        binding: RECOVERY_BINDING,
        liveTip: RECOVERY_TIP,
        rows,
      }),
    ).resolves.toMatchObject({ state: "committed", version: 2 });
    await expect(
      captureCurrentRecoverySeal(coordinates, {
        journal,
        snapshot: async () => rows,
        resolveReceipts: async () => consumedFail.receipts,
        revalidateBinding: async () => {},
        observeLiveTip: async () => RECOVERY_TIP,
        now: () => RECOVERY_NOW,
      }),
    ).resolves.toEqual(seal);
  });

  test("a v2 provisional journal downgrades to v1 with envelope-only membership", async () => {
    const journal = new InMemoryCurrentRecoverySealJournalStore();
    const consumedFail = authenticatedConsumedResult("fail");
    const rows: AttestationRow[] = [consumedFail.row];
    const deps = {
      journal,
      snapshot: async () => rows,
      resolveReceipts: async () => consumedFail.receipts,
      revalidateBinding: async () => {},
      observeLiveTip: async () => RECOVERY_TIP,
      now: () => RECOVERY_NOW,
    };

    await expect(
      captureCurrentRecoverySeal(coordinates, {
        ...deps,
        afterProvisional: async () => {
          throw new Error("simulated v2 provisional crash");
        },
      }),
    ).rejects.toThrow("simulated v2 provisional crash");
    expect(await journal.read(RECOVERY_TASK)).toMatchObject({ state: "provisional", version: 2 });
    rows.push(
      abortedEnvelope({
        attestationId: `att_${"f".repeat(32)}`,
        generation: 2,
      }),
    );

    const seal = await captureCurrentRecoverySeal(coordinates, deps);
    expect(seal.version).toBe(1);
    await expect(
      readCurrentDispatchRecoveryStatusForLineage({
        journal,
        taskId: RECOVERY_TASK,
        binding: RECOVERY_BINDING,
        liveTip: RECOVERY_TIP,
        rows,
      }),
    ).resolves.toMatchObject({ state: "committed", version: 1 });
    await expect(captureCurrentRecoverySeal(coordinates, deps)).resolves.toEqual(seal);
  });

  // Regression: D361 consumed failures used to disappear from source enumeration,
  // allowing an older aborted closure to win after the live tip had advanced.
  test("selects the consumed-fail successor whose durable receipt closure owns the live tip [Behavioral-Active Blackbox-Group]", async () => {
    const journal = new InMemoryCurrentRecoverySealJournalStore();
    const predecessor = abortedEnvelope({
      attestationId: `att_${"b".repeat(32)}`,
      generation: 1,
    });
    const predecessorBody = JSON.stringify(predecessor);
    const persistedPredecessor = rehydrateAttestationRow(
      predecessor.namespace,
      predecessorBody,
      attestationRowDigest(predecessor),
    );
    const successor = authenticatedCollapsedConsumedResult("fail");
    const predecessorReceipts = [successor.receipts[0]!];

    const seal = await captureCurrentRecoverySeal(coordinates, {
      journal,
      snapshot: async () => [persistedPredecessor, successor.row],
      resolveReceipts: async (row) =>
        row.attestationId === predecessor.attestationId ? predecessorReceipts : successor.receipts,
      revalidateBinding: async () => {},
      observeLiveTip: async () => RECOVERY_TIP,
      now: () => RECOVERY_NOW,
    });

    if (seal.version !== 2) throw new Error("consumed-fail source did not create a v2 seal");
    expect(seal.seed.selectedSourceHandle).toEqual({
      attestationId: successor.row.attestationId,
      generation: successor.row.generation,
    });
    expect(seal.seed.source).toEqual({ kind: "consumed-fail", version: 1, status: "fail" });
    expect(await currentRecoveryStatus(journal, RECOVERY_TASK)).toMatchObject({
      state: "committed",
      source: { kind: "consumed-fail", version: 1, status: "fail" },
    });
  });

  test("rejects consumed pass, absent classification, and stale durable receipt closures", async () => {
    const consumed = (
      source: unknown,
      receipts: readonly (typeof RECOVERY_RECEIPTS)[number][] = RECOVERY_RECEIPTS,
    ) =>
      ({
        ...abortedEnvelope({ generation: 3 }),
        state: "consumed" as const,
        consumedAt: RECOVERY_LATER,
        output: { status: "fail" },
        dispatchContinuationBinding: {
          attestationId: RECOVERY_ATTESTATION,
          generation: 3,
          terminalDigest: String(3).padStart(64, "0"),
          terminalAt: RECOVERY_LATER,
          liveTip: RECOVERY_TIP,
          gitReceipts: receipts,
          ...(source === undefined ? {} : { currentRecoverySource: source }),
        },
      }) as never;
    for (const row of [
      consumed({ kind: "consumed-fail", version: 1, status: "pass" }),
      consumed(undefined),
      consumed({ kind: "consumed-fail", version: 1, status: "fail" }, [RECOVERY_RECEIPTS[0]!]),
    ]) {
      await expect(
        captureCurrentRecoverySeal(coordinates, {
          journal: new InMemoryCurrentRecoverySealJournalStore(),
          snapshot: async () => [row],
          resolveReceipts: async () => RECOVERY_RECEIPTS,
          revalidateBinding: async () => {},
          observeLiveTip: async () => RECOVERY_TIP,
          now: () => RECOVERY_NOW,
        }),
      ).rejects.toMatchObject({ reason: "source-not-found" });
    }
  });

  test("seals an authenticated consumed-fail source after collapse and storage rehydration", async () => {
    const fixture = authenticatedCollapsedConsumedResult("fail");
    expect(fixture.row.kind).toBe("tombstone");

    const seal = await captureCurrentRecoverySeal(coordinates, {
      journal: new InMemoryCurrentRecoverySealJournalStore(),
      snapshot: async () => [fixture.row],
      resolveReceipts: async () => fixture.receipts,
      revalidateBinding: async () => {},
      observeLiveTip: async () => RECOVERY_TIP,
      now: () => RECOVERY_NOW,
    });

    if (seal.version !== 2) throw new Error("collapsed consumed-fail source did not create v2");
    expect(seal.sealReference).toMatch(/^cq-current-recovery-seal:v2:[0-9a-f]{64}$/u);
    expect(seal.seed).not.toHaveProperty("inputRecipe");
    expect(seal.seed).not.toHaveProperty("promptProvenance");
    expect(seal.seed).not.toHaveProperty("overlays");
    expect(seal.seed.selectedSourceHandle).toEqual({
      attestationId: fixture.row.attestationId,
      generation: fixture.row.generation,
    });
    expect(seal.seed.source).toEqual({ kind: "consumed-fail", version: 1, status: "fail" });
  });

  test("a collapsed authenticated consumed pass grants no recovery source", async () => {
    const fixture = authenticatedCollapsedConsumedResult("pass");
    if (fixture.row.kind !== "tombstone") throw new Error("pass fixture did not collapse");
    expect(fixture.row.dispatchContinuationBinding?.currentRecoverySource).toBeUndefined();

    await expect(
      captureCurrentRecoverySeal(coordinates, {
        journal: new InMemoryCurrentRecoverySealJournalStore(),
        snapshot: async () => [fixture.row],
        resolveReceipts: async () => fixture.receipts,
        revalidateBinding: async () => {},
        observeLiveTip: async () => RECOVERY_TIP,
        now: () => RECOVERY_NOW,
      }),
    ).rejects.toMatchObject({ reason: "source-not-found" });
  });

  test("storage rejects a continuation whose receipt closure disagrees with its bound live tip", () => {
    const fixture = authenticatedCollapsedConsumedResult("fail");
    if (fixture.row.kind !== "tombstone" || fixture.row.dispatchContinuationBinding === undefined) {
      throw new Error("failure fixture has no collapsed continuation binding");
    }
    const { continuationReference: _reference, ...association } =
      fixture.row.dispatchContinuationBinding;
    const substitutedAssociation = { ...association, liveTip: RECOVERY_MIDDLE };
    const substituted = {
      ...fixture.row,
      dispatchContinuationBinding: {
        ...substitutedAssociation,
        continuationReference: `cq-dispatch-continuation:v1:${dispatchPayloadDigest(
          substitutedAssociation as unknown as DispatchJSONValue,
        )}`,
      },
    };
    const body = JSON.stringify(substituted);

    expect(() =>
      rehydrateAttestationRow(
        substituted.namespace,
        body,
        attestationRowDigest(substituted as AttestationRow),
      ),
    ).toThrow("does not end at its authenticated live tip");
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

    if (seal.version !== 1) throw new Error("aborted source did not preserve the v1 seal");
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
    if (seal.version !== 1) throw new Error("legacy aborted source did not preserve v1");
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
