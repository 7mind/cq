import { describe, expect, test } from "bun:test";
import type { DispatchPrepared } from "@cq/config";
import {
  ImplementationEvidenceService,
  InMemoryLedgerStore,
  createInMemoryImplementationEvidenceStore,
  createLedgerMcpTools,
  createManagementLedgerMcpTools,
  createObserveOnlyWorksetInvocationAuthority,
  implementationAuditManifestDigest,
  type ImplementationEvidenceServiceDependencies,
  type ImplementationReviewerIdentity,
  type PackagedImplementationAuditManifest,
} from "../src/index.js";

const HEAD = "a".repeat(40);
const identity: ImplementationReviewerIdentity = {
  alias: "adapter",
  harness: "pi",
  model: "frontier",
  provider: "provider",
  effort: null,
  launch: "adapter",
  adapterId: "pi:adapter",
};
const nativeIdentity: ImplementationReviewerIdentity = {
  alias: "native",
  harness: "codex",
  model: "frontier",
  provider: null,
  effort: null,
  launch: "native",
  adapterId: "codex:native",
};
const manifest: PackagedImplementationAuditManifest = {
  version: 1,
  manifestId: "transport-v1",
  sourceDigest: "b".repeat(64),
  records: [
    {
      recordKey: "T40",
      taskRef: "tasks:T40",
      ownerGoalRef: "goals:G1",
      finalizedManifest: "manifest",
      historicalReview: null,
      baseCommit: "c".repeat(40),
      resultCommit: "d".repeat(40),
      repositoryHead: HEAD,
      diff: "diff",
      acceptance: "acceptance",
      gateObservations: { exitCode: 0, passCount: 1 },
      requiredObservations: ["commit-retained"],
    },
  ],
  activation: null,
};

function auditVerdict() {
  return {
    taskId: "T40",
    verdict: "approve",
    criticism: [],
    questions: [],
    observations: [
      { name: "commit-retained", status: "verified", detail: "commit is retained" },
    ],
    rationale: "packaged observations verified",
    manifestDigest: implementationAuditManifestDigest(manifest),
    baseCommit: "c".repeat(40),
    resultCommit: "d".repeat(40),
    repositoryHead: HEAD,
  };
}

function nativeDispatch(): DispatchPrepared {
  return {
    attestationId: "att_transport_native",
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

function evidenceService(): ImplementationEvidenceService {
  const dependencies: ImplementationEvidenceServiceDependencies = {
    store: createInMemoryImplementationEvidenceStore(),
    resolveReviewerRoster: () => [identity],
    resolveAuditRoster: () => [identity, nativeIdentity],
    nativeFallback: nativeIdentity,
    prepareNativeReview: async () => {
      throw new Error("not configured");
    },
    fetchNativeReview: async () => ({ state: "missing" }),
    executeExternalReview: async () => {
      throw new Error("not configured");
    },
    fetchWorker: async () => ({ state: "missing" }),
    readTaskAuthority: async (taskRef) => ({
      taskRef,
      ownerGoalRef: "goals:G1",
      status: "done",
      finalizedManifest: "manifest",
    }),
    repositoryHead: async () => HEAD,
    verifyImplementation: async () => {
      throw new Error("not configured");
    },
    recordLedgerCompletion: async () => {
      throw new Error("not configured");
    },
    readAuditManifest: async () => structuredClone(manifest),
    prepareNativeAudit: async () => nativeDispatch(),
    fetchNativeAudit: async () => ({
      state: "consumed",
      output: auditVerdict(),
      retainedAttestation: "att_transport_native",
    }),
    executeExternalAudit: async () => ({
      adapterIdentity: identity.adapterId,
      stdout: JSON.stringify(auditVerdict()),
      stderr: "",
      exitCode: 0,
    }),
    isCommitRetained: async () => true,
  };
  return new ImplementationEvidenceService(dependencies);
}

function resultJson(result: unknown): unknown {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  const text = content.find((entry) => entry.type === "text")?.text;
  if (text === undefined) throw new Error("tool result has no JSON text");
  return JSON.parse(text);
}

describe("implementation audit transport and authorization surface [BG]", () => {
  test("keeps protected audit and activation operations off ordinary and child profiles", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const ordinary = createLedgerMcpTools(
      store,
      undefined,
      undefined,
      undefined,
      "",
      undefined,
      undefined,
      "full",
      undefined,
      createObserveOnlyWorksetInvocationAuthority(),
      evidenceService(),
    ).map(({ name }) => name);
    expect(ordinary).not.toContain("prepare_implementation_audit_panel");
    expect(ordinary).not.toContain("arm_implementation_evidence_activation");

    const child = createManagementLedgerMcpTools(
      store,
      undefined,
      undefined,
      undefined,
      "",
      undefined,
      undefined,
      "implementation-auditor",
      undefined,
      evidenceService(),
    ).map(({ name }) => name);
    expect(child).not.toContain("prepare_implementation_audit_panel");
    expect(child).not.toContain("apply_implementation_audit_manifest");
  });

  test("runs authenticated native and adapter audits through direct protected handlers", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    for (const profile of ["full", "implement/advance"]) {
      const tools = createManagementLedgerMcpTools(
        store,
        undefined,
        undefined,
        undefined,
        "",
        undefined,
        undefined,
        profile,
        undefined,
        evidenceService(),
      );
      const invoke = async (name: string, input: Record<string, unknown>) => {
        const tool = tools.find((candidate) => candidate.name === name);
        if (tool === undefined) throw new Error(`missing ${name} on ${profile}`);
        return resultJson(await tool.handler(input as never, null)) as Record<string, unknown>;
      };
      const suffix = profile.replace("/", "-");
      const panel = await invoke("prepare_implementation_audit_panel", {
        manifest_id: manifest.manifestId,
        manifest_digest: implementationAuditManifestDigest(manifest),
        record_key: "T40",
        expected_repository_head: HEAD,
        operation_id: `panel-${suffix}`,
        author: "parent",
      });
      expect(panel).toMatchObject({
        status: "prepared",
        manifestId: manifest.manifestId,
        taskRef: "tasks:T40",
      });
      const attemptRefs = panel["attemptRefs"] as string[];
      for (const [index, attemptRef] of attemptRefs.entries()) {
        const prepared = await invoke("prepare_implementation_audit_attempt", {
          panel_ref: panel["panelRef"],
          attempt_ref: attemptRef,
          operation_id: `prepare-${suffix}-${String(index)}`,
          author: "parent",
        });
        if (prepared["launch"] === "adapter") {
          await expect(
            invoke("execute_external_implementation_audit_attempt", {
              attempt_ref: attemptRef,
              operation_id: `execute-${suffix}-${String(index)}`,
              author: "parent",
            }),
          ).resolves.toMatchObject({ status: "executed", attemptRef });
        }
        await expect(
          invoke("finalize_implementation_audit_attempt", {
            attempt_ref: attemptRef,
            operation_id: `finalize-${suffix}-${String(index)}`,
            author: "parent",
          }),
        ).resolves.toMatchObject({ terminalState: "approved", attemptRef });
      }
      await expect(
        invoke("apply_implementation_audit_manifest", {
          manifest_id: manifest.manifestId,
          manifest_digest: implementationAuditManifestDigest(manifest),
          expected_repository_head: HEAD,
          audit_attempt_refs: attemptRefs,
          operation_id: `apply-${suffix}`,
          author: "parent",
        }),
      ).resolves.toMatchObject({ status: "applied", taskRefs: ["tasks:T40"] });
    }
  });
});
