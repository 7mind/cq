import { describe, expect, test } from "bun:test";
import {
  ImplementationEvidenceService,
  createInMemoryImplementationEvidenceStore,
} from "../src/index.js";

const EVIDENCE_COMMIT = "1".repeat(40);
const HISTORICAL_COMMIT = "2".repeat(40);
const MANIFEST_DIGEST = "3".repeat(64);

function authority(
  historicalStatus: "planned" | "done",
  actionKey = "activate-implementation-evidence",
) {
  return {
    goalRef: "goals:G176",
    finalizedManifestDigest: MANIFEST_DIGEST,
    mappings: {
      evidenceTaskRef: "tasks:T3000",
      historicalTaskRef: "tasks:T3001",
      activationTaskRef: "tasks:T3002",
    },
    evidenceTask: {
      taskRef: "tasks:T3000",
      status: "done",
      resultCommit: EVIDENCE_COMMIT,
      ready: false,
    },
    historicalTask: {
      taskRef: "tasks:T3001",
      status: historicalStatus,
      resultCommit: historicalStatus === "done" ? HISTORICAL_COMMIT : null,
      ready: historicalStatus === "planned",
    },
    activationTask: {
      taskRef: "tasks:T3002",
      status: "planned",
      resultCommit: null,
      ready: historicalStatus === "done",
      actionKey,
    },
  };
}

function fixture(initialAuthority = authority("planned")) {
  let repositoryHead = EVIDENCE_COMMIT;
  let currentAuthority = initialAuthority;
  let materializations = 0;
  const dependencies = {
    store: createInMemoryImplementationEvidenceStore(),
    resolveReviewerRoster: () => [],
    nativeFallback: {
      alias: "native",
      harness: "codex",
      model: "frontier",
      provider: null,
      launch: "native",
      adapterId: "codex:native",
    },
    prepareNativeReview: async () => {
      throw new Error("unused");
    },
    fetchNativeReview: async () => ({ state: "missing" }),
    executeExternalReview: async () => {
      throw new Error("unused");
    },
    fetchWorker: async () => ({ state: "missing" }),
    readTaskAuthority: async () => {
      throw new Error("unused");
    },
    repositoryHead: async () => repositoryHead,
    verifyImplementation: async () => {
      throw new Error("unused");
    },
    recordLedgerCompletion: async () => {
      throw new Error("unused");
    },
    startupBuildCommit: EVIDENCE_COMMIT,
    implementationEvidenceProtocolVersion: 2,
    packagedManifestInventory: ["d347-implementation-evidence-activation-v1"],
    readBootstrapAuthority: async () => currentAuthority,
    materializeBootstrapActivationHandoff: async () => {
      materializations += 1;
      return {
        state: "created",
        actionRef: "operatorActions:OA3002",
        handoffRef: "handoffs:H3002",
      };
    },
  } as never;
  const service = new ImplementationEvidenceService(dependencies);
  return {
    service,
    setRepositoryHead(value: string) {
      repositoryHead = value;
    },
    setAuthority(value: ReturnType<typeof authority>) {
      currentAuthority = value;
    },
    materializations: () => materializations,
  };
}

describe("implementation evidence bootstrap [BG]", () => {
  test("admits only the fresh historical task and exact-replays one opaque reference", async () => {
    const { service } = fixture();
    const input = {
      goalRef: "goals:G176",
      finalizedManifestDigest: MANIFEST_DIGEST,
      expectedRepositoryHead: EVIDENCE_COMMIT,
      expectedPhase: "historical-dispatch" as const,
      operationId: "bootstrap-historical",
      author: "parent",
    };
    const first = await service.advanceEvidenceBootstrap(input);
    expect(first).toMatchObject({
      status: "admitted",
      taskRefs: ["tasks:T3001"],
      expectedServiceCommit: EVIDENCE_COMMIT,
    });
    expect(first.bootstrapRef).toMatch(/^cq-implementation-evidence-bootstrap:v1:[0-9a-f]{64}$/);
    expect(await service.advanceEvidenceBootstrap(input)).toEqual({ ...first, status: "existing" });
    await expect(
      service.advanceEvidenceBootstrap({ ...input, expectedRepositoryHead: HISTORICAL_COMMIT }),
    ).rejects.toThrow("operation_id");
  });

  test("activation handoff uses protected task authority without loading a packaged registry", async () => {
    const state = fixture(authority("done"));
    state.setRepositoryHead(HISTORICAL_COMMIT);
    const input = {
      goalRef: "goals:G176",
      finalizedManifestDigest: MANIFEST_DIGEST,
      expectedRepositoryHead: HISTORICAL_COMMIT,
      expectedPhase: "activation-handoff" as const,
      operationId: "bootstrap-activation",
      author: "parent",
    };
    const first = await state.service.advanceEvidenceBootstrap(input);
    expect(first).toMatchObject({
      status: "operator-action-required",
      actionRef: "operatorActions:OA3002",
      handoffRef: "handoffs:H3002",
      activationTaskRef: "tasks:T3002",
      expectedServiceCommit: HISTORICAL_COMMIT,
    });
    expect(state.materializations()).toBe(1);
    expect(await state.service.advanceEvidenceBootstrap(input)).toEqual({
      ...first,
      status: "existing",
    });
    expect(state.materializations()).toBe(1);
  });

  test("rejects premature and obsolete activation envelopes before materialization", async () => {
    const premature = fixture();
    premature.setRepositoryHead(HISTORICAL_COMMIT);
    const input = {
      goalRef: "goals:G176",
      finalizedManifestDigest: MANIFEST_DIGEST,
      expectedRepositoryHead: HISTORICAL_COMMIT,
      expectedPhase: "activation-handoff" as const,
      operationId: "premature",
      author: "parent",
    };
    await expect(premature.service.advanceEvidenceBootstrap(input)).rejects.toThrow("historical");
    expect(premature.materializations()).toBe(0);

    const obsolete = fixture(authority("done", "activate-evidence-implementation"));
    obsolete.setRepositoryHead(HISTORICAL_COMMIT);
    await expect(
      obsolete.service.advanceEvidenceBootstrap({ ...input, operationId: "obsolete" }),
    ).rejects.toThrow("activate-implementation-evidence");
    expect(obsolete.materializations()).toBe(0);
  });
});
