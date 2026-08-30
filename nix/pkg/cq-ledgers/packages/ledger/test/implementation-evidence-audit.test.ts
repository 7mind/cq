import { describe, expect, test } from "bun:test";
import type { DispatchJSONValue, DispatchPrepared } from "@cq/config";
import {
  ImplementationEvidenceService,
  createInMemoryImplementationEvidenceStore,
  implementationAuditManifestDigest,
  type ImplementationAuditPanelRecord,
  type ImplementationEvidenceFaultInjector,
  type ImplementationEvidenceServiceDependencies,
  type ImplementationReviewerIdentity,
  type PackagedImplementationAuditManifest,
} from "../src/index.js";

const BASE = "a".repeat(40);
const RESULT_ONE = "b".repeat(40);
const RESULT_TWO = "c".repeat(40);
const HEAD = "d".repeat(40);
const NEXT_HEAD = "1".repeat(40);
const THIRD_HEAD = "2".repeat(40);
const FINALIZED_MANIFEST_DIGEST = "e".repeat(64);

const auditor: ImplementationReviewerIdentity = {
  alias: "historical-auditor",
  harness: "codex",
  model: "frontier",
  provider: null,
  effort: null,
  launch: "native",
  adapterId: "codex:native",
};

function record(taskRef: string, resultCommit: string) {
  return {
    recordKey: `record-${taskRef.slice("tasks:".length)}`,
    taskRef,
    ownerGoalRef: "goals:G176",
    finalizedManifest: `finalized manifest for ${taskRef}`,
    historicalReview: null,
    baseCommit: BASE,
    resultCommit,
    repositoryHead: HEAD,
    diff: `diff for ${taskRef}`,
    acceptance: { clauses: ["exact historical evidence"] },
    gateObservations: { exitCode: 0, passCount: 7, failCount: 0 },
    requiredObservations: ["commit-retained", "gate-green"],
  } as const;
}

function manifest(): PackagedImplementationAuditManifest {
  return {
    version: 1,
    manifestId: "d347-implementation-evidence-activation-v1",
    sourceDigest: "f".repeat(64),
    records: [record("tasks:T10", RESULT_ONE), record("tasks:T11", RESULT_TWO)],
    activation: {
      goalRef: "goals:G176",
      finalizedManifestDigest: FINALIZED_MANIFEST_DIGEST,
      evidenceTaskKey: "t-evidence",
      auditTaskKey: "t-historical-evidence",
      activationTaskKey: "t-activate-evidence",
    },
  };
}

function prepared(attemptRef: string): DispatchPrepared {
  return {
    attestationId: `att_${attemptRef.slice(-12)}`,
    generation: 1,
    responseStoreNow: "2099-01-01T00:00:00.000Z",
    childCancelAt: "2099-01-01T00:01:00.000Z",
    launchDeadline: "2098-12-31T23:59:00.000Z",
    promptProvenance: {
      roleId: "implementation-auditor",
      version: 1,
      surface: "codex",
      promptDigest: "1".repeat(64),
      catalogHash: "2".repeat(64),
      inputDigest: "3".repeat(64),
    },
    inputCapability: { scope: "fetch-input", token: "input" },
    resultCapability: { scope: "store-result", token: "result" },
  };
}

function auditVerdict(panel: ImplementationAuditPanelRecord): DispatchJSONValue {
  const input = panel.auditInput as Record<string, DispatchJSONValue>;
  const required = input["requiredObservations"] as readonly string[];
  return {
    taskId: panel.taskRef.slice("tasks:".length),
    verdict: "approve",
    criticism: [],
    questions: [],
    observations: required.map((name) => ({ name, status: "verified", detail: `${name} checked` })),
    rationale: "Every packaged observation was independently verified.",
    manifestDigest: panel.manifestDigest,
    baseCommit: input["baseCommit"]!,
    resultCommit: input["resultCommit"]!,
    repositoryHead: panel.repositoryHead,
  };
}

function historicalReview(
  taskRef: string,
  baseCommit: string,
  resultCommit: string,
): DispatchJSONValue {
  return {
    taskId: taskRef.slice("tasks:".length),
    verdict: "approve",
    criticism: [],
    questions: [],
    defects: [],
    rationale: "historical implementation review",
    gateReRan: true,
    gateDurationMs: 100,
    resultCommitVerified: true,
    resultCommitEvidence: { status: "verified", resultCommit, branchTip: resultCommit },
    baseAncestry: {
      status: "verified",
      relation: "descendant",
      baseCommit,
      resultCommit,
      mergeBase: baseCommit,
    },
  };
}

function fixture(
  packaged: PackagedImplementationAuditManifest = manifest(),
  activationTaskRefs: readonly string[] = ["tasks:T10", "tasks:T11"],
) {
  let currentPackaged = structuredClone(packaged);
  let currentHead = HEAD;
  const taskStatuses = new Map<string, string>([["tasks:T12", "planned"]]);
  let faultInjector: ImplementationEvidenceFaultInjector | undefined;
  let commitRetained: (repositoryHead: string, resultCommit: string) => Promise<boolean> =
    async () => true;
  const store = createInMemoryImplementationEvidenceStore();
  const panels = new Map<string, ImplementationAuditPanelRecord>();
  const dependencies: ImplementationEvidenceServiceDependencies = {
    store,
    resolveReviewerRoster: () => [auditor],
    resolveAuditRoster: () => [auditor],
    nativeFallback: auditor,
    now: () => "2026-08-27T00:00:00.000Z",
    prepareNativeReview: async () => {
      throw new Error("live review not configured");
    },
    fetchNativeReview: async () => ({ state: "missing" }),
    executeExternalReview: async () => {
      throw new Error("live review not configured");
    },
    fetchWorker: async () => ({ state: "missing" }),
    readTaskAuthority: async (taskRef) => ({
      taskRef,
      ownerGoalRef: "goals:G176",
      status: taskStatuses.get(taskRef) ?? "done",
      finalizedManifest: "trusted finalized manifest",
    }),
    repositoryHead: async () => currentHead,
    verifyImplementation: async () => {
      throw new Error("live completion not configured");
    },
    recordLedgerCompletion: async () => {
      throw new Error("live completion not configured");
    },
    readAuditManifest: async (manifestId) => {
      if (manifestId !== currentPackaged.manifestId) throw new Error("missing packaged manifest");
      return structuredClone(currentPackaged);
    },
    prepareNativeAudit: async ({ attemptRef, panel }) => {
      const dispatch = prepared(attemptRef);
      panels.set(dispatch.attestationId, panel);
      return dispatch;
    },
    fetchNativeAudit: async (dispatch) => {
      const panel = panels.get(dispatch.attestationId);
      if (panel === undefined) return { state: "missing" as const };
      return {
        state: "consumed" as const,
        input: panel.auditInput,
        output: auditVerdict(panel),
        retainedAttestation: dispatch.attestationId,
      };
    },
    executeExternalAudit: async () => {
      throw new Error("adapter not configured");
    },
    resolveActivationCohort: async () => ({
      finalizedManifestDigest:
        currentPackaged.activation?.finalizedManifestDigest ?? FINALIZED_MANIFEST_DIGEST,
      evidenceTaskRef: "tasks:T10",
      auditTaskRef: "tasks:T11",
      activationTaskRef: "tasks:T12",
      boundaryCommit: currentHead,
      taskRefs: activationTaskRefs,
    }),
    isCommitRetained: async (input) =>
      await commitRetained(input.repositoryHead, input.resultCommit),
    startupBuildCommit: NEXT_HEAD,
    implementationEvidenceProtocolVersion: 2,
    packagedManifestInventory: [currentPackaged.manifestId],
    readBootstrapAuthority: async () => ({
      goalRef: "goals:G176",
      finalizedManifestDigest: FINALIZED_MANIFEST_DIGEST,
      mappings: {
        evidenceTaskRef: "tasks:T10",
        historicalTaskRef: "tasks:T11",
        activationTaskRef: "tasks:T12",
      },
      evidenceTask: {
        taskRef: "tasks:T10",
        status: "done",
        resultCommit: NEXT_HEAD,
        ready: false,
      },
      historicalTask: {
        taskRef: "tasks:T11",
        status: "done",
        resultCommit: RESULT_TWO,
        ready: false,
      },
      activationTask: {
        taskRef: "tasks:T12",
        status: "planned",
        resultCommit: null,
        ready: true,
        actionKey: "activate-implementation-evidence",
      },
    }),
    faultInjector: async (boundary, context) => {
      if (faultInjector !== undefined) await faultInjector(boundary, context);
    },
  };
  return {
    service: new ImplementationEvidenceService(dependencies),
    store,
    packaged,
    replacePackaged(next: PackagedImplementationAuditManifest) {
      currentPackaged = structuredClone(next);
    },
    setFaultInjector(next: ImplementationEvidenceFaultInjector) {
      faultInjector = next;
    },
    setHead(next: string) {
      currentHead = next;
    },
    setCommitRetained(next: (repositoryHead: string, resultCommit: string) => Promise<boolean>) {
      commitRetained = next;
    },
    setTaskStatus(taskRef: string, status: string) {
      taskStatuses.set(taskRef, status);
    },
    serviceWithStore(nextStore: ReturnType<typeof createInMemoryImplementationEvidenceStore>) {
      return new ImplementationEvidenceService({ ...dependencies, store: nextStore });
    },
  };
}

describe("protected historical implementation evidence [BA]", () => {
  test("starts with distinct append-only audit and activation collections", async () => {
    const snapshot = await createInMemoryImplementationEvidenceStore().snapshot();

    expect(snapshot).toMatchObject({
      version: 1,
      auditPanels: {},
      auditAttempts: {},
      implementationAudits: {},
      activationRequirements: {},
      activations: {},
    });
  });

  test("prepares authenticated audits and atomically activates the exact frozen cohort", async () => {
    const f = fixture();
    const manifestDigest = implementationAuditManifestDigest(f.packaged);
    const attemptRefs: string[] = [];
    for (const record of f.packaged.records) {
      const panel = await f.service.prepareAuditPanel({
        manifestId: f.packaged.manifestId,
        manifestDigest,
        recordKey: record.recordKey,
        expectedRepositoryHead: HEAD,
        operationId: `panel-${record.recordKey}`,
        author: "parent",
      });
      expect(Object.keys(panel).sort()).toEqual([
        "attemptRefs",
        "manifestId",
        "panelRef",
        "recordKey",
        "rosterDigest",
        "status",
        "taskRef",
      ]);
      const attemptRef = panel.attemptRefs[0]!;
      attemptRefs.push(attemptRef);
      const preparedAttempt = await f.service.prepareAuditAttempt({
        panelRef: panel.panelRef,
        attemptRef,
        operationId: `prepare-${record.recordKey}`,
        author: "parent",
      });
      expect(preparedAttempt.launch).toBe("native");
      expect(
        Object.hasOwn(
          (await f.store.snapshot()).auditPanels[panel.panelRef]!.auditInput as object,
          "worktreePath",
        ),
      ).toBe(false);
      expect(
        await f.service.finalizeAuditAttempt({
          attemptRef,
          operationId: `finalize-${record.recordKey}`,
          author: "parent",
        }),
      ).toMatchObject({ terminalState: "approved" });
    }

    const requirement = await f.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: f.packaged.manifestId,
      expectedRepositoryHead: HEAD,
      operationId: "arm-d347",
      author: "parent",
    });
    expect(Object.keys(requirement).sort()).toEqual([
      "activationTaskRef",
      "auditTaskRef",
      "boundaryCommit",
      "evidenceTaskRef",
      "finalizedManifestDigest",
      "goalRef",
      "manifestDigest",
      "manifestId",
      "records",
      "requirementRef",
      "status",
      "supersededRequirementRef",
      "taskRefs",
    ]);
    expect(requirement.manifestDigest).toBe(manifestDigest);
    expect(requirement.records).toEqual(f.packaged.records.map(({ recordKey, taskRef }) => ({
      recordKey,
      taskRef,
    })));

    const applied = await f.service.applyAuditManifest({
      manifestId: f.packaged.manifestId,
      manifestDigest,
      expectedRepositoryHead: HEAD,
      auditAttemptRefs: attemptRefs,
      operationId: "apply-d347",
      author: "parent",
    });
    expect(applied).toMatchObject({
      status: "applied",
      activation: "activated",
      requirementRef: requirement.requirementRef,
      taskRefs: ["tasks:T10", "tasks:T11"],
    });
    expect(
      await f.service.evidenceActivationStatus({
        goalRef: "goals:G176",
        manifestId: f.packaged.manifestId,
        expectedRepositoryHead: HEAD,
      }),
    ).toMatchObject({ status: "active", activationRef: expect.any(String) });
    const snapshot = await f.store.snapshot();
    expect(Object.keys(snapshot.implementationAudits)).toHaveLength(2);
    expect(Object.keys(snapshot.activations)).toHaveLength(1);
    expect(snapshot.activationRequirements[requirement.requirementRef]!.state).toBe("fulfilled");
  });

  test("supersedes one empty stale arm at a retained descendant head", async () => {
    const f = fixture();
    const first = await f.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: f.packaged.manifestId,
      expectedRepositoryHead: HEAD,
      operationId: "arm-before-parent-correction",
      author: "parent",
    });
    f.setHead(NEXT_HEAD);
    f.replacePackaged({
      ...f.packaged,
      records: f.packaged.records.map((candidate) => ({
        ...candidate,
        repositoryHead: NEXT_HEAD,
      })),
    });

    const replacement = await f.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: f.packaged.manifestId,
      expectedRepositoryHead: NEXT_HEAD,
      operationId: "arm-after-parent-correction",
      author: "parent",
    });

    expect(replacement).toMatchObject({
      status: "armed",
      boundaryCommit: NEXT_HEAD,
      supersededRequirementRef: first.requirementRef,
    });
    const snapshot = await f.store.snapshot();
    expect(snapshot.activationRequirements[first.requirementRef]).toMatchObject({
      state: "superseded",
      supersededByRequirementRef: replacement.requirementRef,
    });
  });

  test("supersedes one fulfilled stale activation for a retained parent correction", async () => {
    const reviewed = manifest();
    const f = fixture({
      ...reviewed,
      records: reviewed.records.map((candidate) => ({
        ...candidate,
        historicalReview: historicalReview(
          candidate.taskRef,
          candidate.baseCommit,
          candidate.resultCommit,
        ),
      })),
    });
    const first = await f.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: f.packaged.manifestId,
      expectedRepositoryHead: HEAD,
      operationId: "arm-before-fulfilled-parent-correction",
      author: "parent",
    });
    await f.service.applyAuditManifest({
      manifestId: f.packaged.manifestId,
      manifestDigest: first.manifestDigest,
      expectedRepositoryHead: HEAD,
      auditAttemptRefs: [],
      operationId: "apply-before-fulfilled-parent-correction",
      author: "parent",
    });
    f.setHead(NEXT_HEAD);
    f.replacePackaged({
      ...f.packaged,
      records: f.packaged.records.map((candidate) => ({
        ...candidate,
        repositoryHead: NEXT_HEAD,
      })),
    });

    const replacement = await f.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: f.packaged.manifestId,
      expectedRepositoryHead: NEXT_HEAD,
      operationId: "arm-after-fulfilled-parent-correction",
      author: "parent",
    });

    expect(replacement).toMatchObject({
      status: "armed",
      boundaryCommit: NEXT_HEAD,
      supersededRequirementRef: first.requirementRef,
    });
    expect((await f.store.snapshot()).activationRequirements[first.requirementRef]).toMatchObject({
      state: "superseded",
      supersededByRequirementRef: replacement.requirementRef,
      activationRef: expect.any(String),
      fulfilledAt: expect.any(String),
    });
    expect(
      await f.service.applyAuditManifest({
        manifestId: f.packaged.manifestId,
        manifestDigest: replacement.manifestDigest,
        expectedRepositoryHead: NEXT_HEAD,
        auditAttemptRefs: [],
        operationId: "apply-after-fulfilled-parent-correction",
        author: "parent",
      }),
    ).toMatchObject({
      status: "applied",
      activation: "activated",
      requirementRef: replacement.requirementRef,
    });
    expect(
      await f.service.evidenceActivationStatus({
        goalRef: "goals:G176",
        manifestId: f.packaged.manifestId,
        expectedRepositoryHead: NEXT_HEAD,
      }),
    ).toMatchObject({ status: "active", requirementRef: replacement.requirementRef });
    expect(await f.service.evidenceServiceStatus()).toMatchObject({
      activationState: { status: "active", requirementRef: replacement.requirementRef },
    });
  });

  test("D389 regression: supersedes the unique ancestry-maximal fulfilled lineage tip", async () => {
    const reviewed = manifest();
    const f = fixture({
      ...reviewed,
      records: reviewed.records.map((candidate) => ({
        ...candidate,
        historicalReview: historicalReview(
          candidate.taskRef,
          candidate.baseCommit,
          candidate.resultCommit,
        ),
      })),
    });
    const first = await f.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: f.packaged.manifestId,
      expectedRepositoryHead: HEAD,
      operationId: "arm-first-retained-tip",
      author: "parent",
    });
    await f.service.applyAuditManifest({
      manifestId: f.packaged.manifestId,
      manifestDigest: first.manifestDigest,
      expectedRepositoryHead: HEAD,
      auditAttemptRefs: [],
      operationId: "apply-first-retained-tip",
      author: "parent",
    });
    f.setHead(NEXT_HEAD);
    f.replacePackaged({
      ...f.packaged,
      records: f.packaged.records.map((candidate) => ({
        ...candidate,
        repositoryHead: NEXT_HEAD,
      })),
    });
    const second = await f.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: f.packaged.manifestId,
      expectedRepositoryHead: NEXT_HEAD,
      operationId: "arm-second-retained-tip",
      author: "parent",
    });
    await f.service.applyAuditManifest({
      manifestId: f.packaged.manifestId,
      manifestDigest: second.manifestDigest,
      expectedRepositoryHead: NEXT_HEAD,
      auditAttemptRefs: [],
      operationId: "apply-second-retained-tip",
      author: "parent",
    });

    const snapshot = await f.store.snapshot();
    const firstRequirement = snapshot.activationRequirements[first.requirementRef]!;
    const secondRequirement = snapshot.activationRequirements[second.requirementRef]!;
    const {
      supersededByRequirementRef: _supersededBy,
      supersededAt: _supersededAt,
      ...detachedFirst
    } = firstRequirement;
    const { supersededRequirementRef: _superseded, ...detachedSecond } = secondRequirement;
    const branchedStore = createInMemoryImplementationEvidenceStore({
      ...snapshot,
      activationRequirements: {
        ...snapshot.activationRequirements,
        [first.requirementRef]: { ...detachedFirst, state: "fulfilled" },
        [second.requirementRef]: detachedSecond,
      },
    });
    f.setHead(THIRD_HEAD);
    f.replacePackaged({
      ...f.packaged,
      records: f.packaged.records.map((candidate) => ({
        ...candidate,
        repositoryHead: THIRD_HEAD,
      })),
    });
    const replacementService = f.serviceWithStore(branchedStore);
    f.setCommitRetained(async (repositoryHead, resultCommit) => repositoryHead === resultCommit);
    await expect(
      replacementService.armEvidenceActivation({
        goalRef: "goals:G176",
        manifestId: f.packaged.manifestId,
        expectedRepositoryHead: THIRD_HEAD,
        operationId: "refuse-incomparable-retained-tips",
        author: "parent",
      }),
    ).rejects.toThrow("multiple matching implementation evidence requirement lineages exist");

    const retainedOrder = [HEAD, NEXT_HEAD, THIRD_HEAD];
    f.setCommitRetained(async (repositoryHead, resultCommit) => {
      const repositoryIndex = retainedOrder.indexOf(repositoryHead);
      const resultIndex = retainedOrder.indexOf(resultCommit);
      return repositoryIndex >= 0 && resultIndex >= 0 && resultIndex <= repositoryIndex;
    });

    const replacement = await replacementService.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: f.packaged.manifestId,
      expectedRepositoryHead: THIRD_HEAD,
      operationId: "arm-after-branched-retained-tips",
      author: "parent",
    });

    expect(replacement).toMatchObject({
      status: "armed",
      boundaryCommit: THIRD_HEAD,
      supersededRequirementRef: second.requirementRef,
    });
  });

  test("reports the fulfilled lineage tip after an earlier empty arm was superseded", async () => {
    const reviewed = manifest();
    const f = fixture({
      ...reviewed,
      records: reviewed.records.map((candidate) => ({
        ...candidate,
        historicalReview: historicalReview(
          candidate.taskRef,
          candidate.baseCommit,
          candidate.resultCommit,
        ),
      })),
    });
    await f.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: f.packaged.manifestId,
      expectedRepositoryHead: HEAD,
      operationId: "arm-empty-lineage-root",
      author: "parent",
    });
    f.setHead(NEXT_HEAD);
    f.replacePackaged({
      ...f.packaged,
      records: f.packaged.records.map((candidate) => ({
        ...candidate,
        repositoryHead: NEXT_HEAD,
      })),
    });
    const fulfilledTip = await f.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: f.packaged.manifestId,
      expectedRepositoryHead: NEXT_HEAD,
      operationId: "arm-fulfilled-lineage-tip",
      author: "parent",
    });
    await f.service.applyAuditManifest({
      manifestId: f.packaged.manifestId,
      manifestDigest: fulfilledTip.manifestDigest,
      expectedRepositoryHead: NEXT_HEAD,
      auditAttemptRefs: [],
      operationId: "apply-fulfilled-lineage-tip",
      author: "parent",
    });
    f.setHead(THIRD_HEAD);
    f.replacePackaged({
      ...f.packaged,
      records: f.packaged.records.map((candidate) => ({
        ...candidate,
        repositoryHead: THIRD_HEAD,
      })),
    });

    expect(
      await f.service.evidenceActivationStatus({
        goalRef: "goals:G176",
        manifestId: f.packaged.manifestId,
        expectedRepositoryHead: THIRD_HEAD,
      }),
    ).toMatchObject({
      status: "stale",
      requirementRef: fulfilledTip.requirementRef,
      activationRef: expect.any(String),
    });
  });

  test("refuses fulfilled supersession without its authenticated activation and application", async () => {
    const reviewed = manifest();
    const f = fixture({
      ...reviewed,
      records: reviewed.records.map((candidate) => ({
        ...candidate,
        historicalReview: historicalReview(
          candidate.taskRef,
          candidate.baseCommit,
          candidate.resultCommit,
        ),
      })),
    });
    const first = await f.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: f.packaged.manifestId,
      expectedRepositoryHead: HEAD,
      operationId: "arm-before-corrupt-fulfilled-authority",
      author: "parent",
    });
    await f.service.applyAuditManifest({
      manifestId: f.packaged.manifestId,
      manifestDigest: first.manifestDigest,
      expectedRepositoryHead: HEAD,
      auditAttemptRefs: [],
      operationId: "apply-before-corrupt-fulfilled-authority",
      author: "parent",
    });
    const snapshot = await f.store.snapshot();
    f.setHead(NEXT_HEAD);
    f.replacePackaged({
      ...f.packaged,
      records: f.packaged.records.map((candidate) => ({
        ...candidate,
        repositoryHead: NEXT_HEAD,
      })),
    });

    const corruptions = [
      { ...snapshot, activations: {} },
      { ...snapshot, auditManifestApplications: {} },
    ];
    for (const [index, corrupted] of corruptions.entries()) {
      await expect(
        f.serviceWithStore(createInMemoryImplementationEvidenceStore(corrupted))
          .armEvidenceActivation({
            goalRef: "goals:G176",
            manifestId: f.packaged.manifestId,
            expectedRepositoryHead: NEXT_HEAD,
            operationId: `refuse-corrupt-fulfilled-authority-${String(index)}`,
            author: "parent",
          }),
      ).rejects.toThrow("a different implementation evidence activation requirement is pending");
    }
  });

  test("reports the fulfilled current requirement after persisted keys are reordered", async () => {
    const reviewed = manifest();
    const f = fixture({
      ...reviewed,
      records: reviewed.records.map((candidate) => ({
        ...candidate,
        historicalReview: historicalReview(
          candidate.taskRef,
          candidate.baseCommit,
          candidate.resultCommit,
        ),
      })),
    });
    const first = await f.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: f.packaged.manifestId,
      expectedRepositoryHead: HEAD,
      operationId: "arm-before-status-reorder",
      author: "parent",
    });
    f.setHead(NEXT_HEAD);
    f.replacePackaged({
      ...f.packaged,
      records: f.packaged.records.map((candidate) => ({
        ...candidate,
        repositoryHead: NEXT_HEAD,
      })),
    });
    const replacement = await f.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: f.packaged.manifestId,
      expectedRepositoryHead: NEXT_HEAD,
      operationId: "arm-after-status-reorder",
      author: "parent",
    });
    await f.service.applyAuditManifest({
      manifestId: f.packaged.manifestId,
      manifestDigest: replacement.manifestDigest,
      expectedRepositoryHead: NEXT_HEAD,
      auditAttemptRefs: [],
      operationId: "apply-after-status-reorder",
      author: "parent",
    });

    const snapshot = await f.store.snapshot();
    const reordered = createInMemoryImplementationEvidenceStore({
      ...snapshot,
      activationRequirements: {
        [replacement.requirementRef]: snapshot.activationRequirements[replacement.requirementRef]!,
        [first.requirementRef]: snapshot.activationRequirements[first.requirementRef]!,
      },
    });

    expect(await f.serviceWithStore(reordered).evidenceServiceStatus()).toMatchObject({
      repositoryHead: NEXT_HEAD,
      activationState: {
        status: "active",
        requirementRef: replacement.requirementRef,
        activationRef: expect.any(String),
      },
    });
  });

  test("aggregate status ignores an armed obsolete manifest lineage", async () => {
    const currentManifest = manifest();
    const obsoleteManifest: PackagedImplementationAuditManifest = {
      ...currentManifest,
      manifestId: "d347-implementation-evidence-activation-obsolete",
      activation: {
        ...currentManifest.activation!,
        finalizedManifestDigest: "0".repeat(64),
      },
    };
    const f = fixture(obsoleteManifest);
    await f.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: obsoleteManifest.manifestId,
      expectedRepositoryHead: HEAD,
      operationId: "arm-obsolete-manifest-lineage",
      author: "parent",
    });
    f.replacePackaged(currentManifest);
    const current = await f.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: currentManifest.manifestId,
      expectedRepositoryHead: HEAD,
      operationId: "arm-current-manifest-lineage",
      author: "parent",
    });

    expect(await f.service.evidenceServiceStatus()).toMatchObject({
      activationState: {
        status: "pending",
        requirementRef: current.requirementRef,
        activationRef: null,
      },
    });
  });

  test("refuses to supersede a stale arm after audit preparation", async () => {
    const f = fixture();
    const manifestDigest = implementationAuditManifestDigest(f.packaged);
    await f.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: f.packaged.manifestId,
      expectedRepositoryHead: HEAD,
      operationId: "arm-before-audit-preparation",
      author: "parent",
    });
    await f.service.prepareAuditPanel({
      manifestId: f.packaged.manifestId,
      manifestDigest,
      recordKey: f.packaged.records[0]!.recordKey,
      expectedRepositoryHead: HEAD,
      operationId: "prepare-before-parent-correction",
      author: "parent",
    });
    f.setHead(NEXT_HEAD);
    f.replacePackaged({
      ...f.packaged,
      records: f.packaged.records.map((candidate) => ({
        ...candidate,
        repositoryHead: NEXT_HEAD,
      })),
    });

    await expect(f.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: f.packaged.manifestId,
      expectedRepositoryHead: NEXT_HEAD,
      operationId: "refuse-arm-after-audit-preparation",
      author: "parent",
    })).rejects.toThrow("a different implementation evidence activation requirement is pending");
  });

  test("rejects authority changes at protected activation and audit write boundaries", async () => {
    const activationRace = fixture();
    activationRace.setFaultInjector(async (boundary) => {
      if (boundary === "before-activation-requirement-write") {
        activationRace.setTaskStatus("tasks:T10", "wip");
      }
    });
    await expect(
      activationRace.service.armEvidenceActivation({
        goalRef: "goals:G176",
        manifestId: activationRace.packaged.manifestId,
        expectedRepositoryHead: HEAD,
        operationId: "arm-authority-race",
        author: "parent",
      }),
    ).rejects.toThrow("bootstrap tasks must be done");
    expect(
      Object.keys((await activationRace.store.snapshot()).activationRequirements),
    ).toHaveLength(0);

    const packaged = manifest();
    const reviewed = {
      ...packaged,
      records: packaged.records.map((entry) => ({
        ...entry,
        historicalReview: historicalReview(entry.taskRef, entry.baseCommit, entry.resultCommit),
      })),
    };
    const auditRace = fixture(reviewed);
    const requirement = await auditRace.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: reviewed.manifestId,
      expectedRepositoryHead: HEAD,
      operationId: "arm-before-audit-race",
      author: "parent",
    });
    auditRace.setFaultInjector(async (boundary) => {
      if (boundary === "before-implementation-audit-write") {
        auditRace.setHead("9".repeat(40));
      }
    });
    await expect(
      auditRace.service.applyAuditManifest({
        manifestId: reviewed.manifestId,
        manifestDigest: implementationAuditManifestDigest(reviewed),
        expectedRepositoryHead: HEAD,
        auditAttemptRefs: [],
        operationId: "apply-authority-race",
        author: "parent",
      }),
    ).rejects.toThrow("repository head changed");
    const snapshot = await auditRace.store.snapshot();
    expect(Object.keys(snapshot.implementationAudits)).toHaveLength(0);
    expect(Object.keys(snapshot.activations)).toHaveLength(0);
    expect(Object.keys(snapshot.auditManifestApplications)).toHaveLength(0);
    expect(snapshot.activationRequirements[requirement.requirementRef]!.state).toBe("armed");
  });

  test("rejects incomplete, surplus, reordered, and foreign attempt sets without partial audits", async () => {
    const f = fixture();
    const manifestDigest = implementationAuditManifestDigest(f.packaged);
    const refs: string[] = [];
    for (const record of f.packaged.records) {
      const panel = await f.service.prepareAuditPanel({
        manifestId: f.packaged.manifestId,
        manifestDigest,
        recordKey: record.recordKey,
        expectedRepositoryHead: HEAD,
        operationId: `reject-panel-${record.recordKey}`,
        author: "parent",
      });
      const attemptRef = panel.attemptRefs[0]!;
      refs.push(attemptRef);
      await f.service.prepareAuditAttempt({
        panelRef: panel.panelRef,
        attemptRef,
        operationId: `reject-prepare-${record.recordKey}`,
        author: "parent",
      });
      await f.service.finalizeAuditAttempt({
        attemptRef,
        operationId: `reject-finalize-${record.recordKey}`,
        author: "parent",
      });
    }
    const candidates = [
      refs.slice(0, 1),
      [...refs].reverse(),
      [...refs, refs[0]!],
      [...refs, `cq-implementation-audit-attempt:v1:${"0".repeat(64)}`],
    ];
    for (const [index, auditAttemptRefs] of candidates.entries()) {
      await expect(
        f.service.applyAuditManifest({
          manifestId: f.packaged.manifestId,
          manifestDigest,
          expectedRepositoryHead: HEAD,
          auditAttemptRefs,
          operationId: `reject-apply-${String(index)}`,
          author: "parent",
        }),
      ).rejects.toThrow("complete ordered");
    }
    expect(Object.keys((await f.store.snapshot()).implementationAudits)).toHaveLength(0);
  });

  test("rejects an activation manifest when its requirement is absent without partial mutation", async () => {
    const packaged = manifest();
    const reviewed = {
      ...packaged,
      records: packaged.records.map((entry) => ({
        ...entry,
        historicalReview: historicalReview(entry.taskRef, entry.baseCommit, entry.resultCommit),
      })),
    };
    const f = fixture(reviewed);

    await expect(
      f.service.applyAuditManifest({
        manifestId: reviewed.manifestId,
        manifestDigest: implementationAuditManifestDigest(reviewed),
        expectedRepositoryHead: HEAD,
        auditAttemptRefs: [],
        operationId: "apply-without-requirement",
        author: "parent",
      }),
    ).rejects.toThrow("activation requirement is missing");
    const snapshot = await f.store.snapshot();
    expect(Object.keys(snapshot.implementationAudits)).toHaveLength(0);
    expect(Object.keys(snapshot.activationRequirements)).toHaveLength(0);
    expect(Object.keys(snapshot.activations)).toHaveLength(0);
    expect(Object.keys(snapshot.auditManifestApplications)).toHaveLength(0);
  });

  test("rejects finalized or source manifest changes after activation is armed", async () => {
    const base = manifest();
    const reviewed = {
      ...base,
      records: base.records.map((entry) => ({
        ...entry,
        historicalReview: historicalReview(entry.taskRef, entry.baseCommit, entry.resultCommit),
      })),
    };
    const changed = [
      { ...reviewed, sourceDigest: "1".repeat(64) },
      {
        ...reviewed,
        records: reviewed.records.map((entry) => ({
          ...entry,
          finalizedManifest: `${entry.finalizedManifest} changed`,
        })),
        activation: { ...reviewed.activation!, finalizedManifestDigest: "2".repeat(64) },
      },
    ];
    for (const [index, replacement] of changed.entries()) {
      const f = fixture(reviewed);
      await f.service.armEvidenceActivation({
        goalRef: "goals:G176",
        manifestId: reviewed.manifestId,
        expectedRepositoryHead: HEAD,
        operationId: `arm-manifest-binding-${String(index)}`,
        author: "parent",
      });
      f.replacePackaged(replacement);

      await expect(
        f.service.applyAuditManifest({
          manifestId: replacement.manifestId,
          manifestDigest: implementationAuditManifestDigest(replacement),
          expectedRepositoryHead: HEAD,
          auditAttemptRefs: [],
          operationId: `apply-manifest-binding-${String(index)}`,
          author: "parent",
        }),
      ).rejects.toThrow("armed activation requirement");
      const snapshot = await f.store.snapshot();
      expect(Object.keys(snapshot.implementationAudits)).toHaveLength(0);
      expect(Object.keys(snapshot.activations)).toHaveLength(0);
      expect(Object.values(snapshot.activationRequirements)).toMatchObject([{ state: "armed" }]);
    }
  });

  test("does not bypass a newer armed manifest through an older fulfilled requirement", async () => {
    const first = manifest();
    const reviewed = {
      ...first,
      records: first.records.map((entry) => ({
        ...entry,
        historicalReview: historicalReview(entry.taskRef, entry.baseCommit, entry.resultCommit),
      })),
    };
    const second = {
      ...reviewed,
      sourceDigest: "1".repeat(64),
      records: reviewed.records.map((entry) => ({
        ...entry,
        finalizedManifest: `${entry.finalizedManifest} replacement`,
      })),
      activation: { ...reviewed.activation!, finalizedManifestDigest: "2".repeat(64) },
    };
    const f = fixture(reviewed);
    await f.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: reviewed.manifestId,
      expectedRepositoryHead: HEAD,
      operationId: "arm-first-manifest",
      author: "parent",
    });
    await f.service.applyAuditManifest({
      manifestId: reviewed.manifestId,
      manifestDigest: implementationAuditManifestDigest(reviewed),
      expectedRepositoryHead: HEAD,
      auditAttemptRefs: [],
      operationId: "apply-first-manifest",
      author: "parent",
    });
    f.replacePackaged(second);
    const secondRequirement = await f.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: second.manifestId,
      expectedRepositoryHead: HEAD,
      operationId: "arm-second-manifest",
      author: "parent",
    });
    f.replacePackaged(reviewed);

    await expect(
      f.service.applyAuditManifest({
        manifestId: reviewed.manifestId,
        manifestDigest: implementationAuditManifestDigest(reviewed),
        expectedRepositoryHead: HEAD,
        auditAttemptRefs: [],
        operationId: "bypass-second-manifest",
        author: "parent",
      }),
    ).rejects.toThrow("armed activation requirement");
    const snapshot = await f.store.snapshot();
    expect(snapshot.activationRequirements[secondRequirement.requirementRef]!.state).toBe("armed");
    expect(Object.keys(snapshot.auditManifestApplications)).toHaveLength(1);
  });

  test("reports a newer armed requirement instead of an obsolete fulfilled requirement", async () => {
    const first = manifest();
    const reviewed = {
      ...first,
      records: first.records.map((entry) => ({
        ...entry,
        historicalReview: historicalReview(entry.taskRef, entry.baseCommit, entry.resultCommit),
      })),
    };
    const second = {
      ...reviewed,
      sourceDigest: "1".repeat(64),
      records: reviewed.records.map((entry) => ({
        ...entry,
        finalizedManifest: `${entry.finalizedManifest} replacement`,
      })),
      activation: { ...reviewed.activation!, finalizedManifestDigest: "2".repeat(64) },
    };
    const f = fixture(reviewed);
    await f.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: reviewed.manifestId,
      expectedRepositoryHead: HEAD,
      operationId: "arm-status-first-manifest",
      author: "parent",
    });
    await f.service.applyAuditManifest({
      manifestId: reviewed.manifestId,
      manifestDigest: implementationAuditManifestDigest(reviewed),
      expectedRepositoryHead: HEAD,
      auditAttemptRefs: [],
      operationId: "apply-status-first-manifest",
      author: "parent",
    });
    f.replacePackaged(second);
    const secondRequirement = await f.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: second.manifestId,
      expectedRepositoryHead: HEAD,
      operationId: "arm-status-second-manifest",
      author: "parent",
    });

    expect(
      await f.service.evidenceActivationStatus({
        goalRef: "goals:G176",
        manifestId: second.manifestId,
        expectedRepositoryHead: HEAD,
      }),
    ).toMatchObject({
      status: "pending",
      requirementRef: secondRequirement.requirementRef,
      activationRef: null,
    });
  });

  test("reports fulfilled requirements with obsolete packaged bindings as stale", async () => {
    const base = manifest();
    const reviewed = {
      ...base,
      records: base.records.map((entry) => ({
        ...entry,
        historicalReview: historicalReview(entry.taskRef, entry.baseCommit, entry.resultCommit),
      })),
    };
    const replacements: readonly PackagedImplementationAuditManifest[] = [
      {
        ...reviewed,
        records: reviewed.records.map((entry) => ({
          ...entry,
          acceptance: { clauses: ["replacement acceptance"] },
        })),
      },
      { ...reviewed, sourceDigest: "1".repeat(64) },
      {
        ...reviewed,
        activation: { ...reviewed.activation!, finalizedManifestDigest: "2".repeat(64) },
      },
    ];

    for (const [index, replacement] of replacements.entries()) {
      const f = fixture(reviewed);
      await f.service.armEvidenceActivation({
        goalRef: "goals:G176",
        manifestId: reviewed.manifestId,
        expectedRepositoryHead: HEAD,
        operationId: `arm-status-obsolete-binding-${String(index)}`,
        author: "parent",
      });
      await f.service.applyAuditManifest({
        manifestId: reviewed.manifestId,
        manifestDigest: implementationAuditManifestDigest(reviewed),
        expectedRepositoryHead: HEAD,
        auditAttemptRefs: [],
        operationId: `apply-status-obsolete-binding-${String(index)}`,
        author: "parent",
      });
      f.replacePackaged(replacement);

      expect(
        await f.service.evidenceActivationStatus({
          goalRef: "goals:G176",
          manifestId: replacement.manifestId,
          expectedRepositoryHead: HEAD,
        }),
      ).toMatchObject({ status: "stale" });
    }
  });

  test("does not reuse a historical review bound to a different commit or ancestry", async () => {
    for (const review of [
      historicalReview("tasks:T10", BASE, RESULT_TWO),
      historicalReview("tasks:T10", RESULT_TWO, RESULT_ONE),
    ]) {
      const packaged = manifest();
      const singleRecord = { ...packaged.records[0]!, historicalReview: review };
      const f = fixture({ ...packaged, records: [singleRecord] });
      await expect(
        f.service.applyAuditManifest({
          manifestId: packaged.manifestId,
          manifestDigest: implementationAuditManifestDigest(f.packaged),
          expectedRepositoryHead: HEAD,
          auditAttemptRefs: [],
          operationId: "reject-mismatched-historical-review",
          author: "parent",
        }),
      ).rejects.toThrow("finalized audit panel");
      expect(Object.keys((await f.store.snapshot()).implementationAudits)).toHaveLength(0);
    }
  });

  test("fences audit-manifest application replays by operation id and full request", async () => {
    const packaged = manifest();
    const reviewed = {
      ...packaged,
      records: packaged.records.map((entry) => ({
        ...entry,
        historicalReview: historicalReview(entry.taskRef, entry.baseCommit, entry.resultCommit),
      })),
    };
    const f = fixture(reviewed);
    await f.service.armEvidenceActivation({
      goalRef: "goals:G176",
      manifestId: reviewed.manifestId,
      expectedRepositoryHead: HEAD,
      operationId: "arm-replay-fence",
      author: "parent",
    });
    const request = {
      manifestId: reviewed.manifestId,
      manifestDigest: implementationAuditManifestDigest(reviewed),
      expectedRepositoryHead: HEAD,
      auditAttemptRefs: [],
      operationId: "apply-replay-fence",
      author: "parent",
    } as const;

    expect(await f.service.applyAuditManifest(request)).toMatchObject({ status: "applied" });
    expect(await f.service.applyAuditManifest(request)).toMatchObject({ status: "existing" });
    await expect(
      f.service.applyAuditManifest({ ...request, author: "different-parent" }),
    ).rejects.toThrow("reused with a different audit manifest application");
  });

  test("refuses incomplete and surplus activation cohorts without partial mutation", async () => {
    const base = manifest();
    const reviewed = {
      ...base,
      records: base.records.map((entry) => ({
        ...entry,
        historicalReview: historicalReview(entry.taskRef, entry.baseCommit, entry.resultCommit),
      })),
    };
    const surplusRecord = record("tasks:T13", "f".repeat(40));
    for (const [packaged, activationTaskRefs, operationId] of [
      [reviewed, ["tasks:T10", "tasks:T11", "tasks:T13"], "apply-incomplete-cohort"],
      [
        {
          ...reviewed,
          records: [
            ...reviewed.records,
            {
              ...surplusRecord,
              historicalReview: historicalReview(
                surplusRecord.taskRef,
                surplusRecord.baseCommit,
                surplusRecord.resultCommit,
              ),
            },
          ],
        },
        ["tasks:T10", "tasks:T11"],
        "apply-surplus-cohort",
      ],
    ] as const) {
      const f = fixture(packaged, activationTaskRefs);
      await f.service.armEvidenceActivation({
        goalRef: "goals:G176",
        manifestId: packaged.manifestId,
        expectedRepositoryHead: HEAD,
        operationId: `arm-${operationId}`,
        author: "parent",
      });
      await expect(
        f.service.applyAuditManifest({
          manifestId: packaged.manifestId,
          manifestDigest: implementationAuditManifestDigest(packaged),
          expectedRepositoryHead: HEAD,
          auditAttemptRefs: [],
          operationId,
          author: "parent",
        }),
      ).rejects.toThrow("does not exactly fulfill");
      const snapshot = await f.store.snapshot();
      expect(Object.keys(snapshot.implementationAudits)).toHaveLength(0);
      expect(Object.keys(snapshot.activations)).toHaveLength(0);
      expect(Object.values(snapshot.activationRequirements)).toMatchObject([{ state: "armed" }]);
    }
  });
});
