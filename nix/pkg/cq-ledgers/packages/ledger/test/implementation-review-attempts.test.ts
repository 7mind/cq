import { describe, expect, test } from "bun:test";
import type { DispatchHandle, DispatchJSONValue, DispatchPrepared } from "@cq/config";
import {
  ImplementationEvidenceService,
  createInMemoryImplementationEvidenceStore,
  type ExternalReviewProcessObservation,
  type ImplementationEvidenceServiceDependencies,
  type ImplementationReviewerIdentity,
} from "../src/index.js";

const RESULT = "b".repeat(40);
const BASE = "a".repeat(40);
const WORKER: DispatchHandle = { attestationId: "att_worker", generation: 1 };
const native: ImplementationReviewerIdentity = {
  alias: "native",
  harness: "codex",
  model: "frontier",
  provider: null,
  launch: "native",
  adapterId: "codex:native",
};
const adapter: ImplementationReviewerIdentity = {
  alias: "external",
  harness: "pi",
  model: "reviewer",
  provider: "test",
  launch: "adapter",
  adapterId: "pi:process:test/reviewer",
};

function prepared(attemptRef: string): DispatchPrepared {
  return {
    attestationId: `att_${attemptRef.slice(-12)}`,
    generation: 1,
    responseStoreNow: "2099-01-01T00:00:00.000Z",
    childCancelAt: "2099-01-01T00:01:00.000Z",
    launchDeadline: "2098-12-31T23:59:00.000Z",
    promptProvenance: {
      roleId: "implement-reviewer",
      version: 7,
      surface: "codex",
      promptDigest: "c".repeat(64),
      catalogHash: "d".repeat(64),
      inputDigest: "e".repeat(64),
    },
    inputCapability: { scope: "fetch-input", token: "input" },
    resultCapability: { scope: "store-result", token: "result" },
  };
}

function verdict(kind: "approve" | "disapprove" = "approve") {
  return {
    taskId: "T2345",
    verdict: kind,
    criticism: kind === "approve" ? [] : ["correction"],
    questions: [],
    defects: [],
    rationale: "measured",
    gateReRan: true,
    gateDurationMs: 100,
    resultCommitVerified: true,
    resultCommitEvidence: { status: "verified", resultCommit: RESULT, branchTip: RESULT },
    baseAncestry: {
      status: "verified",
      relation: "descendant",
      baseCommit: BASE,
      resultCommit: RESULT,
      mergeBase: BASE,
    },
  } as const;
}

function serviceWith(
  roster: readonly ImplementationReviewerIdentity[],
  execute: (identity: ImplementationReviewerIdentity) => Promise<ExternalReviewProcessObservation>,
  workerOutput: Record<string, DispatchJSONValue> = { status: "pass", resultCommit: RESULT },
  options: {
    readonly now?: () => string;
    readonly executionReservationTimeoutMs?: number;
  } = {},
) {
  const nativeResults = new Map<string, unknown>();
  const store = createInMemoryImplementationEvidenceStore();
  const dependencies: ImplementationEvidenceServiceDependencies = {
    store,
    resolveReviewerRoster: () => roster,
    nativeFallback: native,
    now: options.now ?? (() => "2026-08-24T00:00:00.000Z"),
    ...(options.executionReservationTimeoutMs === undefined
      ? {}
      : { executionReservationTimeoutMs: options.executionReservationTimeoutMs }),
    prepareNativeReview: async ({ attemptRef }) => prepared(attemptRef),
    fetchNativeReview: async (dispatch) => ({
      state: "consumed",
      output: nativeResults.get(dispatch.attestationId) as never,
      retainedAttestation: dispatch.attestationId,
    }),
    executeExternalReview: async ({ identity }) => await execute(identity),
    fetchWorker: async () => ({
      state: "consumed",
      input: { taskId: "T2345", baseCommit: BASE },
      output: workerOutput,
    }),
    readTaskAuthority: async () => ({
      taskRef: "tasks:T2345",
      ownerGoalRef: "goals:G1",
      status: "wip",
      finalizedManifest: "manifest-v1",
    }),
    repositoryHead: async () => BASE,
    verifyImplementation: async () => ({
      baseCommit: BASE,
      startingCommit: BASE,
      clean: true,
      ancestryVerified: true,
      receiptsVerified: true,
      acceptanceVerified: true,
      gateVerified: true,
      details: {},
    }),
    recordLedgerCompletion: async () => ({ reviewRef: "reviews:R1" }),
  };
  return { service: new ImplementationEvidenceService(dependencies), nativeResults, store };
}

describe("protected implementation review attempts [BG]", () => {
  test("resolves a non-empty roster at panel preparation", async () => {
    const { service } = serviceWith([], async () => {
      throw new Error("not called");
    });
    await expect(
      service.prepareReviewPanel({
        taskRef: "tasks:T2345",
        resultCommit: RESULT,
        workerDispatch: WORKER,
        operationId: "empty-panel",
        author: "parent",
      }),
    ).rejects.toThrow("implementation reviewer roster must not be empty");
  });

  test("snapshots the ordered roster and returns only opaque attempt references", async () => {
    const { service } = serviceWith([native, adapter], async () => {
      throw new Error("not called");
    });
    const panel = await service.prepareReviewPanel({
      taskRef: "tasks:T2345",
      resultCommit: RESULT,
      workerDispatch: WORKER,
      operationId: "panel-1",
      author: "parent",
    });
    expect(Object.keys(panel).sort()).toEqual([
      "attemptRefs",
      "panelRef",
      "resultCommit",
      "rosterDigest",
      "status",
      "taskRef",
    ]);
    expect(panel.attemptRefs).toHaveLength(2);
    expect(
      panel.attemptRefs.every((ref) => ref.startsWith("cq-implementation-review-attempt:v1:")),
    ).toBe(true);
    expect(
      (
        await service.prepareReviewPanel({
          taskRef: "tasks:T2345",
          resultCommit: RESULT,
          workerDispatch: WORKER,
          operationId: "panel-1",
          author: "parent",
        })
      ).status,
    ).toBe("existing");
  });

  test("retains a complete adapter verdict despite nonzero exit and finalizes it from trusted execution", async () => {
    const { service } = serviceWith([adapter], async () => ({
      adapterIdentity: adapter.adapterId,
      stdout: `\`\`\`json\n${JSON.stringify(verdict())}\n\`\`\``,
      stderr: "adapter warning",
      exitCode: 17,
    }));
    const panel = await service.prepareReviewPanel({
      taskRef: "tasks:T2345",
      resultCommit: RESULT,
      workerDispatch: WORKER,
      operationId: "panel-2",
      author: "parent",
    });
    expect(
      await service.prepareReviewAttempt({
        panelRef: panel.panelRef,
        attemptRef: panel.attemptRefs[0]!,
        operationId: "attempt-2",
        author: "parent",
      }),
    ).toEqual({
      status: "prepared",
      attemptRef: panel.attemptRefs[0]!,
      launch: "adapter",
    });
    const execution = await service.executeExternalReviewAttempt({
      attemptRef: panel.attemptRefs[0]!,
      operationId: "execute-2",
      author: "parent",
    });
    expect(execution.status).toBe("executed");
    expect(
      (
        await service.finalizeReviewAttempt({
          attemptRef: panel.attemptRefs[0]!,
          operationId: "finalize-2",
          author: "parent",
        })
    ).terminalState,
    ).toBe("approved");
  });

  test("executes an adapter attempt at most once and does not replace its finalized receipt", async () => {
    let executions = 0;
    const { service } = serviceWith([adapter], async () => {
      executions += 1;
      return {
        adapterIdentity: adapter.adapterId,
        stdout: JSON.stringify(verdict()),
        stderr: "",
        exitCode: 0,
      };
    });
    const panel = await service.prepareReviewPanel({
      taskRef: "tasks:T2345",
      resultCommit: RESULT,
      workerDispatch: WORKER,
      operationId: "panel-single-execution",
      author: "parent",
    });
    const attemptRef = panel.attemptRefs[0]!;
    await service.prepareReviewAttempt({
      panelRef: panel.panelRef,
      attemptRef,
      operationId: "prepare-single-execution",
      author: "parent",
    });
    await service.executeExternalReviewAttempt({
      attemptRef,
      operationId: "execute-single-execution",
      author: "parent",
    });
    await expect(
      service.executeExternalReviewAttempt({
        attemptRef,
        operationId: "execute-single-execution-replacement",
        author: "parent",
      }),
    ).rejects.toThrow("execution receipt");
    await service.finalizeReviewAttempt({
      attemptRef,
      operationId: "finalize-single-execution",
      author: "parent",
    });
    await expect(
      service.executeExternalReviewAttempt({
        attemptRef,
        operationId: "execute-after-finalization",
        author: "parent",
      }),
    ).rejects.toThrow("terminal");
    expect(executions).toBe(1);
  });

  test("reserves an adapter execution before launching the trusted shellout", async () => {
    let executions = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service } = serviceWith([adapter], async () => {
      executions += 1;
      await blocked;
      return {
        adapterIdentity: adapter.adapterId,
        stdout: JSON.stringify(verdict()),
        stderr: "",
        exitCode: 0,
      };
    });
    const panel = await service.prepareReviewPanel({
      taskRef: "tasks:T2345",
      resultCommit: RESULT,
      workerDispatch: WORKER,
      operationId: "panel-reservation",
      author: "parent",
    });
    const attemptRef = panel.attemptRefs[0]!;
    await service.prepareReviewAttempt({
      panelRef: panel.panelRef,
      attemptRef,
      operationId: "prepare-reservation",
      author: "parent",
    });
    const first = service.executeExternalReviewAttempt({
      attemptRef,
      operationId: "execute-reservation",
      author: "parent",
    });
    await Promise.resolve();
    const second = service.executeExternalReviewAttempt({
      attemptRef,
      operationId: "execute-reservation",
      author: "parent",
    });
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(executions).toBe(1);
  });

  test("records an expired adapter reservation as an abstention without relaunching", async () => {
    let executions = 0;
    let release!: () => void;
    let markStarted!: () => void;
    let now = "2026-08-24T00:00:00.000Z";
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const { service } = serviceWith(
      [adapter],
      async () => {
        executions += 1;
        markStarted();
        await blocked;
        return {
          adapterIdentity: adapter.adapterId,
          stdout: JSON.stringify(verdict()),
          stderr: "",
          exitCode: 0,
        };
      },
      undefined,
      { now: () => now, executionReservationTimeoutMs: 1 },
    );
    const panel = await service.prepareReviewPanel({
      taskRef: "tasks:T2345",
      resultCommit: RESULT,
      workerDispatch: WORKER,
      operationId: "panel-expired-reservation",
      author: "parent",
    });
    const attemptRef = panel.attemptRefs[0]!;
    await service.prepareReviewAttempt({
      panelRef: panel.panelRef,
      attemptRef,
      operationId: "prepare-expired-reservation",
      author: "parent",
    });
    const first = service.executeExternalReviewAttempt({
      attemptRef,
      operationId: "execute-expired-reservation",
      author: "parent",
    });
    await started;
    now = "2026-08-24T00:00:00.001Z";
    await expect(
      service.executeExternalReviewAttempt({
        attemptRef,
        operationId: "execute-expired-reservation",
        author: "parent",
      }),
    ).resolves.toMatchObject({ status: "existing", attemptRef });
    release();
    await first;
    await expect(
      service.finalizeReviewAttempt({
        attemptRef,
        operationId: "finalize-expired-reservation",
        author: "parent",
      }),
    ).resolves.toMatchObject({ terminalState: "operational-abstention" });
    expect(executions).toBe(1);
  });

  test("retains the consumed native dispatch attestation in its terminal receipt", async () => {
    const { service, nativeResults, store } = serviceWith([native], async () => {
      throw new Error("not called");
    });
    const panel = await service.prepareReviewPanel({
      taskRef: "tasks:T2345",
      resultCommit: RESULT,
      workerDispatch: WORKER,
      operationId: "panel-native-attestation",
      author: "parent",
    });
    const attemptRef = panel.attemptRefs[0]!;
    const preparedAttempt = await service.prepareReviewAttempt({
      panelRef: panel.panelRef,
      attemptRef,
      operationId: "prepare-native-attestation",
      author: "parent",
    });
    if (preparedAttempt.launch !== "native") throw new Error("expected native attempt");
    nativeResults.set(preparedAttempt.dispatch.attestationId, verdict());
    await service.finalizeReviewAttempt({
      attemptRef,
      operationId: "finalize-native-attestation",
      author: "parent",
    });
    expect(
      (await store.snapshot()).attempts[attemptRef]!.retainedAttestation,
    ).toBe(preparedAttempt.dispatch.attestationId);
  });

  test("treats an approval without a green gate or coherent merge base as an abstention", async () => {
    const malformed = {
      ...verdict(),
      gateReRan: false,
      gateDurationMs: undefined,
      baseAncestry: { ...verdict().baseAncestry, mergeBase: "c".repeat(40) },
    };
    const { service } = serviceWith([adapter], async () => ({
      adapterIdentity: adapter.adapterId,
      stdout: JSON.stringify(malformed),
      stderr: "",
      exitCode: 0,
    }));
    const panel = await service.prepareReviewPanel({
      taskRef: "tasks:T2345",
      resultCommit: RESULT,
      workerDispatch: WORKER,
      operationId: "panel-malformed-approval",
      author: "parent",
    });
    const attemptRef = panel.attemptRefs[0]!;
    await service.prepareReviewAttempt({
      panelRef: panel.panelRef,
      attemptRef,
      operationId: "prepare-malformed-approval",
      author: "parent",
    });
    await service.executeExternalReviewAttempt({
      attemptRef,
      operationId: "execute-malformed-approval",
      author: "parent",
    });
    await expect(
      service.finalizeReviewAttempt({
        attemptRef,
        operationId: "finalize-malformed-approval",
        author: "parent",
      }),
    ).resolves.toMatchObject({ terminalState: "operational-abstention" });
  });

  test("accepts a trusted supervised worker gate without a reviewer gate rerun", async () => {
    const trustedApproval = {
      ...verdict(),
      gateReRan: false,
      gateReRanReason: "trusted supervised worker gate",
    };
    delete (trustedApproval as { gateDurationMs?: number }).gateDurationMs;
    const { service } = serviceWith(
      [adapter],
      async () => ({
        adapterIdentity: adapter.adapterId,
        stdout: JSON.stringify(trustedApproval),
        stderr: "",
        exitCode: 0,
      }),
      {
        status: "pass",
        resultCommit: RESULT,
        branch: "implement/T2345",
        actualWorktreePath: "/repo/.claude/worktrees/T2345",
        supervisedGateEvidence: {
          taskId: "T2345",
          resultCommit: RESULT,
          branch: "implement/T2345",
          worktreePath: "/repo/.claude/worktrees/T2345",
          clean: true,
          gateExitCode: 0,
          passCount: 1,
          failCount: 0,
        },
      },
    );
    const panel = await service.prepareReviewPanel({
      taskRef: "tasks:T2345",
      resultCommit: RESULT,
      workerDispatch: WORKER,
      operationId: "panel-trusted-gate",
      author: "parent",
    });
    const attemptRef = panel.attemptRefs[0]!;
    await service.prepareReviewAttempt({
      panelRef: panel.panelRef,
      attemptRef,
      operationId: "prepare-trusted-gate",
      author: "parent",
    });
    await service.executeExternalReviewAttempt({
      attemptRef,
      operationId: "execute-trusted-gate",
      author: "parent",
    });
    await expect(
      service.finalizeReviewAttempt({
        attemptRef,
        operationId: "finalize-trusted-gate",
        author: "parent",
      }),
    ).resolves.toMatchObject({ terminalState: "approved" });
  });

  test("binds an approving reviewer's base ancestry to the dispatched base", async () => {
    const forgedBase = "c".repeat(40);
    const forgedApproval = {
      ...verdict(),
      baseAncestry: { ...verdict().baseAncestry, baseCommit: forgedBase, mergeBase: forgedBase },
    };
    const { service } = serviceWith([adapter], async () => ({
      adapterIdentity: adapter.adapterId,
      stdout: JSON.stringify(forgedApproval),
      stderr: "",
      exitCode: 0,
    }));
    const panel = await service.prepareReviewPanel({
      taskRef: "tasks:T2345",
      resultCommit: RESULT,
      workerDispatch: WORKER,
      operationId: "panel-forged-base",
      author: "parent",
    });
    const attemptRef = panel.attemptRefs[0]!;
    await service.prepareReviewAttempt({
      panelRef: panel.panelRef,
      attemptRef,
      operationId: "prepare-forged-base",
      author: "parent",
    });
    await service.executeExternalReviewAttempt({
      attemptRef,
      operationId: "execute-forged-base",
      author: "parent",
    });
    await expect(
      service.finalizeReviewAttempt({
        attemptRef,
        operationId: "finalize-forged-base",
        author: "parent",
      }),
    ).resolves.toMatchObject({ terminalState: "operational-abstention" });
  });

  test("requires adapter preparation and binds the observed adapter identity", async () => {
    const { service } = serviceWith([adapter], async () => ({
      adapterIdentity: "pi:process:substituted/reviewer",
      stdout: JSON.stringify(verdict()),
      stderr: "",
      exitCode: 0,
    }));
    const panel = await service.prepareReviewPanel({
      taskRef: "tasks:T2345",
      resultCommit: RESULT,
      workerDispatch: WORKER,
      operationId: "panel-adapter-binding",
      author: "parent",
    });
    const attemptRef = panel.attemptRefs[0]!;
    await expect(
      service.executeExternalReviewAttempt({
        attemptRef,
        operationId: "execute-before-prepare",
        author: "parent",
      }),
    ).rejects.toThrow("prepared");
    await service.prepareReviewAttempt({
      panelRef: panel.panelRef,
      attemptRef,
      operationId: "prepare-adapter-binding",
      author: "parent",
    });
    await service.executeExternalReviewAttempt({
      attemptRef,
      operationId: "execute-adapter-binding",
      author: "parent",
    });
    expect(
      (
        await service.finalizeReviewAttempt({
          attemptRef,
          operationId: "finalize-adapter-binding",
          author: "parent",
        })
      ).terminalState,
    ).toBe("operational-abstention");
  });

  test("rejects malformed verdict semantics instead of authenticating them", async () => {
    const malformed = [
      { ...verdict(), criticism: ["approval cannot carry criticism"] },
      {
        ...verdict("disapprove"),
        defects: [{ headline: "missing required defect fields" }],
      },
    ];
    for (const [index, output] of malformed.entries()) {
      const { service } = serviceWith([adapter], async () => ({
        adapterIdentity: adapter.adapterId,
        stdout: JSON.stringify(output),
        stderr: "",
        exitCode: 0,
      }));
      const panel = await service.prepareReviewPanel({
        taskRef: "tasks:T2345",
        resultCommit: RESULT,
        workerDispatch: WORKER,
        operationId: `panel-malformed-${String(index)}`,
        author: "parent",
      });
      const attemptRef = panel.attemptRefs[0]!;
      await service.prepareReviewAttempt({
        panelRef: panel.panelRef,
        attemptRef,
        operationId: `prepare-malformed-${String(index)}`,
        author: "parent",
      });
      await service.executeExternalReviewAttempt({
        attemptRef,
        operationId: `execute-malformed-${String(index)}`,
        author: "parent",
      });
      expect(
        (
          await service.finalizeReviewAttempt({
            attemptRef,
            operationId: `finalize-malformed-${String(index)}`,
            author: "parent",
          })
        ).terminalState,
      ).toBe("operational-abstention");
    }
  });

  test("allows exactly one native fallback only after all configured attempts terminally abstain", async () => {
    const { service } = serviceWith([adapter], async () => ({
      adapterIdentity: adapter.adapterId,
      stdout: "not-json",
      stderr: "",
      exitCode: 1,
    }));
    const panel = await service.prepareReviewPanel({
      taskRef: "tasks:T2345",
      resultCommit: RESULT,
      workerDispatch: WORKER,
      operationId: "panel-3",
      author: "parent",
    });
    await expect(
      service.prepareReviewFallback({
        panelRef: panel.panelRef,
        operationId: "fallback-early",
        author: "parent",
      }),
    ).rejects.toThrow("every configured attempt");
    await service.prepareReviewAttempt({
      panelRef: panel.panelRef,
      attemptRef: panel.attemptRefs[0]!,
      operationId: "attempt-3",
      author: "parent",
    });
    await service.executeExternalReviewAttempt({
      attemptRef: panel.attemptRefs[0]!,
      operationId: "execute-3",
      author: "parent",
    });
    expect(
      (
        await service.finalizeReviewAttempt({
          attemptRef: panel.attemptRefs[0]!,
          operationId: "finalize-3",
          author: "parent",
        })
      ).terminalState,
    ).toBe("operational-abstention");
    const fallback = await service.prepareReviewFallback({
      panelRef: panel.panelRef,
      operationId: "fallback-3",
      author: "parent",
    });
    expect(fallback.status).toBe("prepared");
    expect(
      (
        await service.prepareReviewFallback({
          panelRef: panel.panelRef,
          operationId: "fallback-3",
          author: "parent",
        })
      ).status,
    ).toBe("existing");
    await expect(
      service.prepareReviewFallback({
        panelRef: panel.panelRef,
        operationId: "fallback-other",
        author: "parent",
      }),
    ).rejects.toThrow("different fallback");
  });
});
