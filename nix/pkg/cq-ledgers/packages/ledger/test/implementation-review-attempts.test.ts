import { describe, expect, test } from "bun:test";
import type { DispatchHandle, DispatchPrepared } from "@cq/config";
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
) {
  const nativeResults = new Map<string, unknown>();
  const dependencies: ImplementationEvidenceServiceDependencies = {
    store: createInMemoryImplementationEvidenceStore(),
    resolveReviewerRoster: () => roster,
    nativeFallback: native,
    now: () => "2026-08-24T00:00:00.000Z",
    prepareNativeReview: async ({ attemptRef }) => prepared(attemptRef),
    fetchNativeReview: async (dispatch) => ({
      state: "consumed",
      output: nativeResults.get(dispatch.attestationId) as never,
    }),
    executeExternalReview: async ({ identity }) => await execute(identity),
    fetchWorker: async () => ({
      state: "consumed",
      output: { status: "pass", resultCommit: RESULT },
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
  return { service: new ImplementationEvidenceService(dependencies), nativeResults };
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
