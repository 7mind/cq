import { describe, expect, test } from "bun:test";
import type { DispatchPrepared } from "@cq/config";
import {
  ImplementationEvidenceService,
  createInMemoryImplementationEvidenceStore,
  implementationAuditManifestDigest,
  type ImplementationEvidenceServiceDependencies,
  type ImplementationAuditObservation,
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

function fixture(
  stdout: () => string,
  options: {
    readonly auditRoster: readonly ImplementationReviewerIdentity[];
    readonly fetchNativeAudit: (
      dispatch: DispatchPrepared,
    ) => Promise<ImplementationAuditObservation>;
    readonly executeExternalAudit?: NonNullable<
      ImplementationEvidenceServiceDependencies["executeExternalAudit"]
    >;
  } = {
    auditRoster: [adapter],
    fetchNativeAudit: async () => ({ state: "missing" }),
  },
) {
  const store = createInMemoryImplementationEvidenceStore();
  let launches = 0;
  const dependencies: ImplementationEvidenceServiceDependencies = {
    store,
    resolveReviewerRoster: () => [adapter],
    resolveAuditRoster: () => options.auditRoster,
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
    fetchNativeAudit: options.fetchNativeAudit,
    executeExternalAudit: async (input) => {
      launches += 1;
      if (options.executeExternalAudit !== undefined)
        return await options.executeExternalAudit(input);
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

  test("rejects a native approval retained under a different attestation", async () => {
    let manifestDigest = "";
    const f = fixture(() => "", {
      auditRoster: [native],
      fetchNativeAudit: async () => ({
        state: "consumed",
        output: adapterVerdict(manifestDigest),
        retainedAttestation: "att_substituted_dispatch",
      }),
    });
    const prepared = await preparedAttempt(f);
    manifestDigest = prepared.manifestDigest;

    expect(
      await f.service.finalizeAuditAttempt({
        attemptRef: prepared.attemptRef,
        operationId: "finalize-substituted-native-attestation",
        author: "parent",
      }),
    ).toMatchObject({ terminalState: "operational-abstention" });
    expect((await f.store.snapshot()).auditAttempts[prepared.attemptRef]).toMatchObject({
      retainedAttestation: null,
      verdict: null,
    });
  });

  test("rejects a fresh finalization operation after an audit attempt becomes terminal", async () => {
    let manifestDigest = "";
    let auditAvailable = true;
    let fetchCount = 0;
    const f = fixture(() => "", {
      auditRoster: [native],
      fetchNativeAudit: async (preparedDispatch) => {
        fetchCount += 1;
        return auditAvailable
          ? {
              state: "consumed",
              output: adapterVerdict(manifestDigest),
              retainedAttestation: preparedDispatch.attestationId,
            }
          : { state: "missing" };
      },
    });
    const prepared = await preparedAttempt(f);
    manifestDigest = prepared.manifestDigest;

    expect(
      await f.service.finalizeAuditAttempt({
        attemptRef: prepared.attemptRef,
        operationId: "finalize-approved-native-audit",
        author: "parent",
      }),
    ).toMatchObject({ terminalState: "approved" });
    await f.service.applyAuditManifest({
      manifestId: manifest.manifestId,
      manifestDigest,
      expectedRepositoryHead: HEAD,
      auditAttemptRefs: [prepared.attemptRef],
      operationId: "apply-approved-native-audit",
      author: "parent",
    });
    const terminalFetchCount = fetchCount;
    auditAvailable = false;

    await expect(
      f.service.finalizeAuditAttempt({
        attemptRef: prepared.attemptRef,
        operationId: "finalize-terminal-native-audit-again",
        author: "parent",
      }),
    ).rejects.toThrow("audit attempt is already terminal");
    expect(fetchCount).toBe(terminalFetchCount);
    expect((await f.store.snapshot()).auditAttempts[prepared.attemptRef]).toMatchObject({
      terminalState: "approved",
      verdict: adapterVerdict(manifestDigest),
    });
  });

  test("rejects fresh preparation after terminal while preserving exact replay", async () => {
    let manifestDigest = "";
    const f = fixture(() => JSON.stringify(adapterVerdict(manifestDigest)));
    const prepared = await preparedAttempt(f);
    manifestDigest = prepared.manifestDigest;
    await f.service.executeExternalAuditAttempt({
      attemptRef: prepared.attemptRef,
      operationId: "execute-before-terminal-prepare",
      author: "parent",
    });
    await f.service.finalizeAuditAttempt({
      attemptRef: prepared.attemptRef,
      operationId: "finalize-before-terminal-prepare",
      author: "parent",
    });
    const terminalAttempt = (await f.store.snapshot()).auditAttempts[prepared.attemptRef];

    expect(
      await f.service.prepareAuditAttempt({
        panelRef: prepared.panel.panelRef,
        attemptRef: prepared.attemptRef,
        operationId: "prepare",
        author: "parent",
      }),
    ).toMatchObject({ status: "existing", attemptRef: prepared.attemptRef });
    expect((await f.store.snapshot()).auditAttempts[prepared.attemptRef]).toEqual(terminalAttempt);
    await expect(
      f.service.prepareAuditAttempt({
        panelRef: prepared.panel.panelRef,
        attemptRef: prepared.attemptRef,
        operationId: "prepare-terminal-attempt-again",
        author: "parent",
      }),
    ).rejects.toThrow("audit attempt is already terminal");
    expect((await f.store.snapshot()).auditAttempts[prepared.attemptRef]).toEqual(terminalAttempt);
  });

  test("does not record external execution after concurrent finalization wins", async () => {
    let manifestDigest = "";
    let markExecutionStarted!: () => void;
    let releaseExecution!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      markExecutionStarted = resolve;
    });
    const executionReleased = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const f = fixture(() => "", {
      auditRoster: [adapter],
      fetchNativeAudit: async () => ({ state: "missing" }),
      executeExternalAudit: async () => {
        markExecutionStarted();
        await executionReleased;
        return {
          adapterIdentity: adapter.adapterId,
          stdout: JSON.stringify(adapterVerdict(manifestDigest)),
          stderr: "",
          exitCode: 0,
        };
      },
    });
    const prepared = await preparedAttempt(f);
    manifestDigest = prepared.manifestDigest;

    const executing = f.service.executeExternalAuditAttempt({
      attemptRef: prepared.attemptRef,
      operationId: "execute-finalization-race",
      author: "parent",
    });
    await executionStarted;
    await expect(
      f.service.finalizeAuditAttempt({
        attemptRef: prepared.attemptRef,
        operationId: "finalize-before-execution-settlement",
        author: "parent",
      }),
    ).resolves.toMatchObject({ terminalState: "operational-abstention" });
    const terminalAttempt = (await f.store.snapshot()).auditAttempts[prepared.attemptRef];
    releaseExecution();

    await expect(executing).rejects.toThrow("audit attempt is already terminal");
    expect((await f.store.snapshot()).auditAttempts[prepared.attemptRef]).toEqual(terminalAttempt);
    expect(
      await f.service.finalizeAuditAttempt({
        attemptRef: prepared.attemptRef,
        operationId: "finalize-before-execution-settlement",
        author: "parent",
      }),
    ).toMatchObject({ status: "existing", terminalState: "operational-abstention" });
  });

  test("finalizes the external verdict when execution settlement wins", async () => {
    let manifestDigest = "";
    let markExecutionStarted!: () => void;
    let releaseExecution!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      markExecutionStarted = resolve;
    });
    const executionReleased = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const f = fixture(() => "", {
      auditRoster: [adapter],
      fetchNativeAudit: async () => ({ state: "missing" }),
      executeExternalAudit: async () => {
        markExecutionStarted();
        await executionReleased;
        return {
          adapterIdentity: adapter.adapterId,
          stdout: JSON.stringify(adapterVerdict(manifestDigest)),
          stderr: "",
          exitCode: 0,
        };
      },
    });
    const prepared = await preparedAttempt(f);
    manifestDigest = prepared.manifestDigest;

    const executing = f.service.executeExternalAuditAttempt({
      attemptRef: prepared.attemptRef,
      operationId: "execute-before-finalization",
      author: "parent",
    });
    await executionStarted;
    releaseExecution();
    await expect(executing).resolves.toMatchObject({ status: "executed" });
    await expect(
      f.service.finalizeAuditAttempt({
        attemptRef: prepared.attemptRef,
        operationId: "finalize-after-execution-settlement",
        author: "parent",
      }),
    ).resolves.toMatchObject({ terminalState: "approved" });
  });

  test("rechecks terminal state when concurrent finalizations reach the write boundary", async () => {
    let manifestDigest = "";
    let fetchCount = 0;
    let markFirstFetchStarted!: () => void;
    let releaseFirstFetch!: () => void;
    const firstFetchStarted = new Promise<void>((resolve) => {
      markFirstFetchStarted = resolve;
    });
    const firstFetchReleased = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    const f = fixture(() => "", {
      auditRoster: [native],
      fetchNativeAudit: async (preparedDispatch) => {
        fetchCount += 1;
        if (fetchCount === 1) {
          markFirstFetchStarted();
          await firstFetchReleased;
          return { state: "missing" };
        }
        return {
          state: "consumed",
          output: adapterVerdict(manifestDigest),
          retainedAttestation: preparedDispatch.attestationId,
        };
      },
    });
    const prepared = await preparedAttempt(f);
    manifestDigest = prepared.manifestDigest;

    const staleFinalization = f.service.finalizeAuditAttempt({
      attemptRef: prepared.attemptRef,
      operationId: "finalize-from-stale-snapshot",
      author: "parent",
    });
    await firstFetchStarted;
    expect(
      await f.service.finalizeAuditAttempt({
        attemptRef: prepared.attemptRef,
        operationId: "finalize-at-write-boundary",
        author: "parent",
      }),
    ).toMatchObject({ terminalState: "approved" });
    releaseFirstFetch();

    await expect(staleFinalization).rejects.toThrow("audit attempt is already terminal");
    expect((await f.store.snapshot()).auditAttempts[prepared.attemptRef]).toMatchObject({
      terminalState: "approved",
      verdict: adapterVerdict(manifestDigest),
    });
  });

  test("revalidates the native dispatch binding before applying an audit", async () => {
    let manifestDigest = "";
    let substituteAttestation = false;
    const f = fixture(() => "", {
      auditRoster: [native],
      fetchNativeAudit: async (preparedDispatch) => ({
        state: "consumed",
        input: {
          manifestId: manifest.manifestId,
        },
        output: adapterVerdict(manifestDigest),
        retainedAttestation: substituteAttestation
          ? "att_substituted_after_finalization"
          : preparedDispatch.attestationId,
      }),
    });
    const prepared = await preparedAttempt(f);
    manifestDigest = prepared.manifestDigest;
    expect(
      await f.service.finalizeAuditAttempt({
        attemptRef: prepared.attemptRef,
        operationId: "finalize-before-substitution",
        author: "parent",
      }),
    ).toMatchObject({ terminalState: "approved" });
    substituteAttestation = true;

    await expect(
      f.service.applyAuditManifest({
        manifestId: manifest.manifestId,
        manifestDigest,
        expectedRepositoryHead: HEAD,
        auditAttemptRefs: [prepared.attemptRef],
        operationId: "apply-after-substitution",
        author: "parent",
      }),
    ).rejects.toThrow("dispatch-bound");
    expect(Object.keys((await f.store.snapshot()).implementationAudits)).toHaveLength(0);
  });
});
