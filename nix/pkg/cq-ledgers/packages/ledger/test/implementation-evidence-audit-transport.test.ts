import { describe, expect, test } from "bun:test";
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

function evidenceService(): ImplementationEvidenceService {
  const dependencies: ImplementationEvidenceServiceDependencies = {
    store: createInMemoryImplementationEvidenceStore(),
    resolveReviewerRoster: () => [identity],
    resolveAuditRoster: () => [identity],
    nativeFallback: { ...identity, launch: "native", adapterId: "pi:native" },
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

  test("invokes the same protected handler on direct management and implement/advance profiles", async () => {
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
      const prepare = tools.find(({ name }) => name === "prepare_implementation_audit_panel");
      if (prepare === undefined) throw new Error(`missing audit preparation on ${profile}`);
      expect(
        resultJson(
          await prepare.handler(
            {
              manifest_id: manifest.manifestId,
              manifest_digest: implementationAuditManifestDigest(manifest),
              record_key: "T40",
              expected_repository_head: HEAD,
              operation_id: `panel-${profile.replace("/", "-")}`,
              author: "parent",
            } as never,
            null,
          ),
        ),
      ).toMatchObject({ status: "prepared", manifestId: manifest.manifestId, taskRef: "tasks:T40" });
    }
  });
});
