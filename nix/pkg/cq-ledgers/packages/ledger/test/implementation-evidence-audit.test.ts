import { describe, expect, test } from "bun:test";
import type { DispatchJSONValue, DispatchPrepared } from "@cq/config";
import {
  ImplementationEvidenceService,
  createInMemoryImplementationEvidenceStore,
  implementationAuditManifestDigest,
  type ImplementationAuditPanelRecord,
  type ImplementationEvidenceServiceDependencies,
  type ImplementationReviewerIdentity,
  type PackagedImplementationAuditManifest,
} from "../src/index.js";

const BASE = "a".repeat(40);
const RESULT_ONE = "b".repeat(40);
const RESULT_TWO = "c".repeat(40);
const HEAD = "d".repeat(40);
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

function fixture() {
  const store = createInMemoryImplementationEvidenceStore();
  const packaged = manifest();
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
      status: taskRef === "tasks:T12" ? "planned" : "done",
      finalizedManifest: "trusted finalized manifest",
    }),
    repositoryHead: async () => HEAD,
    verifyImplementation: async () => {
      throw new Error("live completion not configured");
    },
    recordLedgerCompletion: async () => {
      throw new Error("live completion not configured");
    },
    readAuditManifest: async (manifestId) => {
      if (manifestId !== packaged.manifestId) throw new Error("missing packaged manifest");
      return structuredClone(packaged);
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
      finalizedManifestDigest: FINALIZED_MANIFEST_DIGEST,
      evidenceTaskRef: "tasks:T10",
      auditTaskRef: "tasks:T11",
      activationTaskRef: "tasks:T12",
      boundaryCommit: HEAD,
      taskRefs: ["tasks:T10", "tasks:T11"],
    }),
    isCommitRetained: async () => true,
  };
  return { service: new ImplementationEvidenceService(dependencies), store, packaged };
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
      "manifestId",
      "requirementRef",
      "status",
      "taskRefs",
    ]);

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
});
