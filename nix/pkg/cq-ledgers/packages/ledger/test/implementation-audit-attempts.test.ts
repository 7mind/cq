import { describe, expect, test } from "bun:test";
import type { DispatchPrepared } from "@cq/config";
import {
  ImplementationEvidenceService,
  createInMemoryImplementationEvidenceStore,
  implementationAuditManifestDigest,
  type ImplementationEvidenceServiceDependencies,
  type ImplementationReviewerIdentity,
  type PackagedImplementationAuditManifest,
} from "../src/index.js";

const BASE = "a".repeat(40);
const RESULT = "b".repeat(40);
const HEAD = "c".repeat(40);

const adapter: ImplementationReviewerIdentity = {
  alias: "adapter",
  harness: "pi",
  model: "frontier",
  provider: "provider",
  effort: null,
  launch: "adapter",
  adapterId: "pi:adapter",
};
const native: ImplementationReviewerIdentity = {
  alias: "fallback",
  harness: "codex",
  model: "frontier",
  provider: null,
  effort: null,
  launch: "native",
  adapterId: "codex:native",
};

const manifest: PackagedImplementationAuditManifest = {
  version: 1,
  manifestId: "historical-attempts-v1",
  sourceDigest: "d".repeat(64),
  records: [
    {
      recordKey: "T20",
      taskRef: "tasks:T20",
      ownerGoalRef: "goals:G1",
      finalizedManifest: "manifest",
      historicalReview: null,
      baseCommit: BASE,
      resultCommit: RESULT,
      repositoryHead: HEAD,
      diff: "diff",
      acceptance: "acceptance",
      gateObservations: { exitCode: 0, passCount: 1, failCount: 0 },
      requiredObservations: ["commit-retained"],
    },
  ],
  activation: null,
};

function dispatch(attemptRef: string): DispatchPrepared {
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

function adapterVerdict(manifestDigest: string) {
  return {
    taskId: "T20",
    verdict: "approve",
    criticism: [],
    questions: [],
    observations: [
      { name: "commit-retained", status: "verified", detail: "commit retained" },
    ],
    rationale: "verified",
    manifestDigest,
    baseCommit: BASE,
    resultCommit: RESULT,
    repositoryHead: HEAD,
  };
}

function fixture(stdout: () => string) {
  const store = createInMemoryImplementationEvidenceStore();
  let launches = 0;
  const dependencies: ImplementationEvidenceServiceDependencies = {
    store,
    resolveReviewerRoster: () => [adapter],
    resolveAuditRoster: () => [adapter],
    nativeFallback: native,
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
    prepareNativeAudit: async ({ attemptRef }) => dispatch(attemptRef),
    fetchNativeAudit: async () => ({ state: "missing" }),
    executeExternalAudit: async () => {
      launches += 1;
      return {
        adapterIdentity: adapter.adapterId,
        stdout: stdout(),
        stderr: "adapter diagnostic",
        exitCode: 9,
      };
    },
    isCommitRetained: async () => true,
  };
  return { service: new ImplementationEvidenceService(dependencies), store, launches: () => launches };
}

async function preparedAttempt(f: ReturnType<typeof fixture>) {
  const manifestDigest = implementationAuditManifestDigest(manifest);
  const panel = await f.service.prepareAuditPanel({
    manifestId: manifest.manifestId,
    manifestDigest,
    recordKey: "T20",
    expectedRepositoryHead: HEAD,
    operationId: "panel",
    author: "parent",
  });
  const attemptRef = panel.attemptRefs[0]!;
  await f.service.prepareAuditAttempt({
    panelRef: panel.panelRef,
    attemptRef,
    operationId: "prepare",
    author: "parent",
  });
  return { panel, attemptRef, manifestDigest };
}

describe("protected implementation audit attempts [BG]", () => {
  test("retains a valid authenticated adapter verdict and never relaunches on replay", async () => {
    let digest = "";
    const f = fixture(() => JSON.stringify(adapterVerdict(digest)));
    const prepared = await preparedAttempt(f);
    digest = prepared.manifestDigest;
    const first = await f.service.executeExternalAuditAttempt({
      attemptRef: prepared.attemptRef,
      operationId: "execute",
      author: "parent",
    });
    const replay = await f.service.executeExternalAuditAttempt({
      attemptRef: prepared.attemptRef,
      operationId: "execute",
      author: "parent",
    });
    expect(replay).toEqual({ ...first, status: "existing" });
    expect(f.launches()).toBe(1);
    expect(
      await f.service.finalizeAuditAttempt({
        attemptRef: prepared.attemptRef,
        operationId: "finalize",
        author: "parent",
      }),
    ).toMatchObject({ terminalState: "approved" });
  });

  test("turns malformed transport output into terminal abstention and permits one native fallback", async () => {
    const f = fixture(() => "not-json");
    const prepared = await preparedAttempt(f);
    await f.service.executeExternalAuditAttempt({
      attemptRef: prepared.attemptRef,
      operationId: "execute",
      author: "parent",
    });
    expect(
      await f.service.finalizeAuditAttempt({
        attemptRef: prepared.attemptRef,
        operationId: "finalize",
        author: "parent",
      }),
    ).toMatchObject({ terminalState: "operational-abstention" });
    const fallback = await f.service.prepareAuditFallback({
      panelRef: prepared.panel.panelRef,
      operationId: "fallback",
      author: "parent",
    });
    expect(fallback).toMatchObject({ status: "prepared", dispatch: { promptProvenance: { roleId: "implementation-auditor" } } });
    expect(
      await f.service.prepareAuditFallback({
        panelRef: prepared.panel.panelRef,
        operationId: "fallback",
        author: "parent",
      }),
    ).toMatchObject({ status: "existing", attemptRef: fallback.attemptRef });
  });
});
