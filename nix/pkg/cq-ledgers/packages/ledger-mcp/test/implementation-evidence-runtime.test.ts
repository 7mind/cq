import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  InMemoryLedgerStore,
  createInMemoryImplementationEvidenceStore,
  type DispatchCapability,
  type ResolvedLedgerStore,
} from "@cq/ledger";
import {
  createProductionImplementationEvidenceService,
  verifyProductionImplementation,
} from "../src/implementationEvidenceRuntime.js";
import { runProductionBootstrapFixture } from "./fixtures/t2895/productionBootstrapFixture.js";

const RESULT = "b".repeat(40);
const WORKER = { attestationId: "att_runtime_worker", generation: 1 } as const;
const previousHarness = process.env["CQ_HARNESS"];
const roots: string[] = [];

beforeEach(() => {
  process.env["CQ_HARNESS"] = "codex";
});

afterEach(() => {
  if (previousHarness === undefined) delete process.env["CQ_HARNESS"];
  else process.env["CQ_HARNESS"] = previousHarness;
});

async function git(root: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

describe("production implementation evidence runtime [Behavioral-Active Blackbox-Atomic]", () => {
  test("wires the default external reviewer to a trusted process seam", async () => {
    const ledger = new InMemoryLedgerStore();
    await ledger.init();
    const resolved = {
      store: ledger,
      implementationEvidenceStore: createInMemoryImplementationEvidenceStore(),
    } as unknown as ResolvedLedgerStore;
    const observed: Array<{ adapterIdentity: string; prompt: string }> = [];
    const dispatchCapability = {
      prepare: async () => {
        throw new Error("native fallback is not exercised by this adapter test");
      },
      observeEvidence: async () => ({
        state: "consumed" as const,
        roleId: "implement-worker",
        input: {
          acceptance: "the protected runtime executes the configured reviewer",
          startingCommit: "a".repeat(40),
        },
        output: { status: "pass", resultCommit: RESULT },
        retainedAttestation: WORKER.attestationId,
      }),
    } as unknown as DispatchCapability;
    const service = createProductionImplementationEvidenceService({
      resolved,
      dispatchCapability,
      repositoryRoot: process.cwd(),
      environment: { CQ_HARNESS: "codex" },
      externalReviewRunner: async ({ identity, prompt }) => {
        observed.push({ adapterIdentity: identity.adapterId, prompt });
        return {
          adapterIdentity: identity.adapterId,
          stdout: "{}",
          stderr: "",
          exitCode: 0,
        };
      },
    });
    const panel = await service.prepareReviewPanel({
      taskRef: "tasks:T2345",
      resultCommit: RESULT,
      workerDispatch: WORKER,
      operationId: "runtime-panel",
      author: "parent",
    });
    const attemptRef = panel.attemptRefs[0]!;
    const attempt = await service.prepareReviewAttempt({
      panelRef: panel.panelRef,
      attemptRef,
      operationId: "runtime-attempt",
      author: "parent",
    });
    expect(attempt.launch).toBe("adapter");
    await service.executeExternalReviewAttempt({
      attemptRef,
      operationId: "runtime-execute",
      author: "parent",
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]!.adapterIdentity).toBe("pi:process");
    expect(observed[0]!.prompt).toContain("Output JSON Schema");
    expect(observed[0]!.prompt).toContain("protected runtime executes the configured reviewer");
    expect(observed[0]!.prompt).toContain(
      "validate exact runner-owned supervised gate evidence when present",
    );
    expect(observed[0]!.prompt).not.toContain("rerun the canonical full gate");
  });

  test("constructs one production service and passes it to both standalone transports", async () => {
    const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(source.match(/createProductionImplementationEvidenceService\(/gu)).toHaveLength(1);
    expect(source).toContain("implementationEvidence,\n    );");
    expect(source).toContain("{ implementationEvidence }");
  });

  test("wires the trusted packaged audit registry without a caller-supplied seam", async () => {
    const source = await readFile(
      new URL("../src/implementationEvidenceRuntime.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("readPackagedImplementationAuditManifest");
    expect(source).toContain("options.readAuditManifest ??");
  });

  test("recognizes the finalized activation task action key", async () => {
    const source = await readFile(
      new URL("../src/implementationEvidenceRuntime.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('actionKey !== "activate-implementation-evidence"');
    expect(source).not.toContain('actionKey !== "implementation-evidence-activation"');
  });

  test("resolves finalized activation cohort tasks across active and archived state", async () => {
    const source = await readFile(
      new URL("../src/implementationEvidenceRuntime.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("const task = await resolveUniqueTaskState(store, id);");
    expect(source).not.toContain("const task = store.fetchItem(TASKS_LEDGER, id);");
  });

  test("resolves bootstrap authority tasks across active and archived state", async () => {
    const source = await readFile(
      new URL("../src/implementationEvidenceRuntime.ts", import.meta.url),
      "utf8",
    );
    expect(source.match(/await resolveUniqueTaskState\(/gu)).toHaveLength(4);
    expect(source).not.toContain("store.fetchItem(TASKS_LEDGER");
  });

  test("resolves owning goals across active and archived state", async () => {
    const source = await readFile(
      new URL("../src/implementationEvidenceRuntime.ts", import.meta.url),
      "utf8",
    );
    expect(source.match(/await resolveUniqueGoalState\(/gu)).toHaveLength(3);
    expect(source).not.toContain("store.fetchItem(GOALS_LEDGER");
  });

  test("reserves production reviewer time for the canonical gate [WA]", async () => {
    const source = await readFile(
      new URL("../src/implementationEvidenceRuntime.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("const PRODUCTION_IMPLEMENTATION_REVIEWER_TIMEOUT_MS =");
    expect(source).toContain("SUPERVISED_WORKER_GATE_EXECUTION_TIMEOUT_MS");
    expect(source).toContain("IMPLEMENT_REVIEWER_SYNTHESIS_STORE_RESERVE_MS");
    expect(source.match(/PRODUCTION_IMPLEMENTATION_REVIEWER_TIMEOUT_MS/gu)).toHaveLength(5);
  });

  test("defers fail-closed reviewer-panel resolution until an evidence operation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "implementation-evidence-runtime-config-"));
    roots.push(root);
    await writeFile(
      path.join(root, "cq.toml"),
      '[ledger]\nbackend = "xdg"\nprojectId = "runtime-config"\n',
    );
    const ledger = new InMemoryLedgerStore();
    await ledger.init();
    const resolved = {
      store: ledger,
      implementationEvidenceStore: createInMemoryImplementationEvidenceStore(),
    } as unknown as ResolvedLedgerStore;
    const dispatchCapability = {
      observeEvidence: async () => ({ state: "missing" as const }),
    } as unknown as DispatchCapability;

    let service: ReturnType<typeof createProductionImplementationEvidenceService> | undefined;
    expect(() => {
      service = createProductionImplementationEvidenceService({
        resolved,
        dispatchCapability,
        repositoryRoot: root,
        environment: { CQ_HARNESS: "codex" },
      });
    }).not.toThrow();
    if (service === undefined) throw new Error("production evidence service was not constructed");
    await expect(
      service.prepareReviewPanel({
        taskRef: "tasks:T2345",
        resultCommit: RESULT,
        workerDispatch: WORKER,
        operationId: "runtime-invalid-panel",
        author: "parent",
      }),
    ).rejects.toThrow('active harness "codex" requires a [harness.codex] block');
  });

  test("revalidates the exact Git receipt chain against repository objects and paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "implementation-evidence-runtime-git-"));
    roots.push(root);
    await git(root, ["init", "-q", "-b", "implement/T2345"]);
    await git(root, ["config", "user.name", "runtime-test"]);
    await git(root, ["config", "user.email", "runtime-test@example.invalid"]);
    await writeFile(path.join(root, "base.txt"), "base\n");
    await git(root, ["add", "base.txt"]);
    await git(root, ["commit", "-q", "-m", "base"]);
    const baseCommit = await git(root, ["rev-parse", "HEAD"]);
    await writeFile(path.join(root, "feature.ts"), "export const protectedEvidence = true;\n");
    await git(root, ["add", "feature.ts"]);
    await git(root, ["commit", "-q", "-m", "result"]);
    const resultCommit = await git(root, ["rev-parse", "HEAD"]);
    const tree = await git(root, ["rev-parse", "HEAD^{tree}"]);
    const workerInput = {
      taskId: "T2345",
      acceptance: "verify the exact receipt chain",
      branch: "implement/T2345",
      baseCommit,
      round: 0,
      startingCommit: baseCommit,
    } as const;
    const receipt = {
      kind: "cq-git-change-receipt",
      version: 1,
      attestationId: "att_runtime_receipt",
      generation: 1,
      taskId: "T2345",
      operationId: "runtime-receipt",
      requestDigest: "d".repeat(64),
      oldHead: baseCommit,
      newHead: resultCommit,
      tree,
      objectOids: [resultCommit, tree],
      paths: ["feature.ts"],
      committedAt: "2026-08-24T00:00:00.000Z",
    } as const;
    const workerOutput = {
      taskId: "T2345",
      status: "pass",
      resultCommit,
      branch: "implement/T2345",
      actualWorktreePath: root,
      filesTouched: ["feature.ts"],
      gitReceipts: [receipt],
      checkSummary: "REAL_CHECK_EXIT=0; 1 pass; 0 fail",
      gateDurationMs: 100,
      baseVerification: {
        status: "verified",
        relation: "descendant",
        baseCommit,
        headCommit: resultCommit,
      },
      summary: "verified",
    } as const;
    expect(
      (await verifyProductionImplementation(root, resultCommit, workerInput, workerOutput))
        .receiptsVerified,
    ).toBe(true);
    expect(
      (
        await verifyProductionImplementation(root, resultCommit, workerInput, {
          ...workerOutput,
          gitReceipts: [{ ...receipt, tree: baseCommit }],
        })
      ).receiptsVerified,
    ).toBe(false);
  });

  test("accepts a guarded-rebase receipt suffix independently of the full result diff [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "implementation-evidence-runtime-guarded-"));
    roots.push(root);
    await git(root, ["init", "-q", "-b", "implement/T453"]);
    await git(root, ["config", "user.name", "runtime-test"]);
    await git(root, ["config", "user.email", "runtime-test@example.invalid"]);
    await writeFile(path.join(root, "base.txt"), "base\n");
    await git(root, ["add", "base.txt"]);
    await git(root, ["commit", "-q", "-m", "base"]);
    const ontoCommit = await git(root, ["rev-parse", "HEAD"]);
    await writeFile(path.join(root, "prefix.ts"), "export const prefix = true;\n");
    await git(root, ["add", "prefix.ts"]);
    await git(root, ["commit", "-q", "-m", "rebased prefix"]);
    const rebasedStartCommit = await git(root, ["rev-parse", "HEAD"]);
    await writeFile(path.join(root, "correction.ts"), "export const correction = true;\n");
    await git(root, ["add", "correction.ts"]);
    await git(root, ["commit", "-q", "-m", "guarded correction"]);
    const resultCommit = await git(root, ["rev-parse", "HEAD"]);
    const tree = await git(root, ["rev-parse", "HEAD^{tree}"]);
    const workerInput = {
      taskId: "T453",
      acceptance: "verify only the fresh guarded-rebase receipt suffix",
      branch: "implement/T453",
      baseCommit: ontoCommit,
      round: 1,
      startingCommit: rebasedStartCommit,
    } as const;
    const receipt = {
      kind: "cq-git-change-receipt",
      version: 1,
      attestationId: "att_runtime_guarded_receipt",
      generation: 1,
      taskId: "T453",
      operationId: "runtime-guarded-receipt",
      requestDigest: "e".repeat(64),
      oldHead: rebasedStartCommit,
      newHead: resultCommit,
      tree,
      objectOids: [resultCommit, tree],
      paths: ["correction.ts"],
      committedAt: "2026-09-04T00:00:00.000Z",
    } as const;
    const workerOutput = {
      taskId: "T453",
      status: "pass",
      resultCommit,
      branch: "implement/T453",
      actualWorktreePath: root,
      filesTouched: ["correction.ts", "prefix.ts"],
      gitReceipts: [receipt],
      gitLineage: {
        kind: "guarded-rebase",
        guardedRebase: `cq-guarded-rebase:v1:${"f".repeat(64)}`,
        ontoCommit,
        rebasedStartCommit,
        exactTip: false,
      },
      checkSummary: "REAL_CHECK_EXIT=0; 1 pass; 0 fail",
      gateDurationMs: 100,
      baseVerification: {
        status: "verified",
        relation: "descendant",
        baseCommit: ontoCommit,
        headCommit: resultCommit,
      },
      summary: "verified guarded correction",
    } as const;

    expect(
      (await verifyProductionImplementation(root, resultCommit, workerInput, workerOutput))
        .receiptsVerified,
    ).toBe(true);
  });
});

describe("versioned production evidence bootstrap [Behavioral-Active Effectual-GoodCommunication]", () => {
  test("runs the versioned G176 replacement bootstrap from the exact production baseline", async () => {
    expect(await runProductionBootstrapFixture()).toEqual({
      baselineCommit: "5342f4050891231a4b41e6d0278c62c87568d16b",
      exactBaselineArtifacts: true,
      baselineSourceSelectedOnlyEvidence: true,
      baselineManagementProfileUsed: true,
      ledgerBackend: "xdg",
      attestationBackend: "fs",
      workerDispatches: 2,
      workerTaskIdsMatchFreshMapping: true,
      workerGenerations: [1, 2],
      firstReviewState: "disapproved",
      firstReviewCriticism: [
        "The replacement must retain the production bootstrap authority across correction redispatch.",
      ],
      firstReviewExcludedRawDiagnostics: true,
      correctionConsumedFinalizedOutcome: true,
      supervisedGateRuns: 2,
      secondReviewState: "approved",
      mergeAcknowledged: true,
      recordedStatus: "recorded",
      releaseStatus: "released",
      worktreesAfterRelease: 0,
      deploymentHandoffStatus: "user-action-required",
      bootstrapStatus: "admitted",
      bootstrapReplayStatus: "existing",
      bootstrapTaskRefsMatchFreshMapping: true,
      bootstrapRefValid: true,
      bootstrapExpectedServiceCommitMatches: true,
      wrongHeadRejected: true,
      wrongManifestRejected: true,
      resultCommitIsFullSha: true,
      resultDescendsBaseline: true,
      historicalTaskDispatches: 0,
      operatorActions: 0,
    });
  }, 240_000);
});

afterEach(async () => {
  const root = roots.pop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});
