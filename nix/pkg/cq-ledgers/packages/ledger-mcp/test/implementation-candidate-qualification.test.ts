import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPATCH_OVERLAY_REGISTRY,
  FakeDispatchClock,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  fetchDispatchInputOn,
  prepareDispatchOn,
  sequentialDispatchRandomBytes,
  storeDispatchResultOn,
  type AttestationNamespace,
  type DispatchGitEffectBinding,
  type DispatchJSONValue,
} from "@cq/config";
import { PLAN_FINALIZED_MANIFEST_FIELD, type LedgerStore } from "@cq/ledger";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function finalizedTaskStore(): LedgerStore {
  const task = {
    id: "T6519",
    milestoneId: "M211",
    status: "wip",
    fields: {
      headline: "Queue native completion",
      description: "Qualify one staged result.",
      acceptance: "The exact process observation is durable.",
      ledgerRefs: ["goals:G211"],
      worksetOwnerRef: "goals:G211",
      worksetOwnerEdgeKind: "active-current-draft",
    },
    createdAt: "2026-09-16T09:00:00.000Z",
    updatedAt: "2026-09-16T09:00:00.000Z",
    author: "planner",
    session: "plan",
  };
  return {
    fetchItem: (ledgerId: string) =>
      ledgerId === "tasks"
        ? task
        : {
            fields: {
              [PLAN_FINALIZED_MANIFEST_FIELD]: JSON.stringify({
                revision: 1,
                milestones: [{ key: "queue", id: "M211" }],
                tasks: [{ key: "qualify", id: "T6519" }],
              }),
            },
          },
  } as unknown as LedgerStore;
}

describe("implementation candidate qualification [Behavioral-Active, Effectual-Group]", () => {
  test("installed-process observation durably qualifies staged bytes without claiming a gate", async () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "cq-T6519-qualification-"));
    roots.push(repositoryRoot);
    git(repositoryRoot, "init", "-b", "main");
    git(repositoryRoot, "config", "user.name", "CQ Test");
    git(repositoryRoot, "config", "user.email", "cq@example.invalid");
    writeFileSync(join(repositoryRoot, "candidate.ts"), "export const candidate = true;\n");
    git(repositoryRoot, "add", "candidate.ts");
    git(repositoryRoot, "commit", "-m", "candidate");
    const resultCommit = git(repositoryRoot, "rev-parse", "HEAD");
    const namespace: AttestationNamespace = { backend: "xdg", projectKey: "qualification" };
    const clock = new FakeDispatchClock("2026-09-16T09:00:00.000Z");
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace));
    const correlationId = "candidate-correlation-0123456789abcdef";
    const expectedChild = {
      childId: `implement-worker#${correlationId}`,
      runId: "parent-run-T6519",
    };
    const binding: DispatchGitEffectBinding = {
      taskId: "T6519",
      handleToken: "managed-handle-T6519",
      handleFingerprint: "3".repeat(64),
      repositoryRoot,
      repositoryId: "4".repeat(64),
      commonDir: join(repositoryRoot, ".git"),
      worktreePath: repositoryRoot,
      branch: "implement/T6519",
      ref: "refs/heads/implement/T6519",
      baseCommit: resultCommit,
    };
    const prepared = await prepareDispatchOn(
      backend,
      {
        namespace,
        roleId: "implement-worker",
        surface: "codex",
        input: {
          taskId: "T6519",
          headline: "Queue native completion",
          description: "Qualify one staged result.",
          acceptance: "The exact process observation is durable.",
          worktreePath: repositoryRoot,
          branch: binding.branch,
          baseCommit: resultCommit,
          round: 0,
          startingCommit: resultCommit,
        },
        idempotencyKey: "T6519-installed-qualification",
        timeoutMs: 600_000,
        registry: DISPATCH_OVERLAY_REGISTRY,
        promptDigest: "5".repeat(64),
        catalogHash: "6".repeat(64),
        expectedChild,
        gitEffectBinding: binding,
      },
      {
        mode: "manager-bound",
        now: clock.now,
        randomBytes: sequentialDispatchRandomBytes(6519),
        lineageFenceGuard: async () => null,
        withLineageLock: async (operation) => await operation(),
      },
    );
    if (!prepared.accepted) throw new Error(prepared.detail);
    await fetchDispatchInputOn(
      backend,
      { ...prepared.prepared, namespace, inputCapability: prepared.prepared.inputCapability },
      { now: clock.now },
    );
    const output: DispatchJSONValue = {
      taskId: "T6519",
      status: "pass",
      resultCommit,
      branch: binding.branch,
      actualWorktreePath: repositoryRoot,
      filesTouched: ["candidate.ts"],
      gitReceipts: [],
      checkSummary: "focused check passed",
      baseVerification: {
        status: "verified",
        relation: "equal",
        baseCommit: resultCommit,
        headCommit: resultCommit,
      },
      summary: "candidate staged",
    };
    const staged = await storeDispatchResultOn(
      backend,
      { resultCapability: prepared.prepared.resultCapability, output },
      { now: clock.now },
    );
    expect(staged.state).toBe("gate-pending");
    const capability = createDispatchCapability({
      backend,
      promptArtifactStore: {} as PromptArtifactStore,
      ledgerStore: finalizedTaskStore(),
      now: clock.now,
    });

    const qualified = await capability.qualifyImplementationCandidate!({
      attestationId: prepared.prepared.attestationId,
      generation: prepared.prepared.generation,
      roleId: "implement-worker",
      correlationId,
      childThreadId: "child-thread-T6519",
      outcome: "completed",
      exitStatus: 0,
      observedAt: clock.now(),
      promptDigest: "5".repeat(64),
    });

    expect(qualified).toMatchObject({
      state: "queued",
      attestationId: prepared.prepared.attestationId,
      generation: prepared.prepared.generation,
      outputDigest: staged.state === "gate-pending" ? staged.result.outputDigest : "",
      qualificationDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    const row = backend.storedRows()[0];
    expect(row).toMatchObject({
      state: "gate-pending",
      implementationQueue: { state: "qualified" },
      stagedCompletionQualification: {
        nativeCompletion: {
          actor: "trusted-extension",
          childId: expectedChild.childId,
          runId: expectedChild.runId,
        },
      },
    });
  });
});
