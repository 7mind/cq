import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CurrentRecoveryStatusSchema,
  InMemoryLedgerStore,
  LINEAGE_CUTOVER_FENCE_ACTION_KEY,
  acknowledgeOperatorAction,
  materializeOperatorAction,
  prepareManagedWorktree,
  recordOperatorActionEvidence,
  releaseManagedWorktree,
  type ManagedWorktreeInstallRunner,
} from "../src/index.js";
import { inMemoryPlanLifecycleFactory } from "./planLifecycleInMemoryAdapter.js";
import {
  RECOVERY_NOW,
  RECOVERY_TASK,
  committedJournal,
  provisionalJournal,
} from "./recoverySealTestSupport.js";

const COMMAND = `cq dispatch-recovery status --task-id ${RECOVERY_TASK}`;
const exec = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "D360 fixture",
      GIT_AUTHOR_EMAIL: "d360@example.invalid",
      GIT_COMMITTER_NAME: "D360 fixture",
      GIT_COMMITTER_EMAIL: "d360@example.invalid",
    },
  });
  return stdout.trim();
}

async function seedManagedRepository(): Promise<{
  readonly root: string;
  readonly baseCommit: string;
  readonly stateDir: string;
  readonly cacheRoot: string;
  readonly workspaceRoot: string;
}> {
  const root = await fs.mkdtemp(join(tmpdir(), "d360-managed-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  const workspaceRoot = join(root, "nix", "pkg", "cq-ledgers");
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(
    join(workspaceRoot, "package.json"),
    `${JSON.stringify({ name: "d360-workspace", private: true, workspaces: [] })}\n`,
  );
  await fs.writeFile(join(workspaceRoot, "bun.lock"), "{}\n");
  await fs.writeFile(
    join(root, ".gitignore"),
    "node_modules/\n.test-cache/\n.test-managed-state/\n",
  );
  await fs.writeFile(join(root, "README.md"), "D360 managed completion fixture\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "seed D360 fixture"]);
  return {
    root,
    baseCommit: await git(root, ["rev-parse", "HEAD"]),
    stateDir: join(root, ".test-managed-state"),
    cacheRoot: join(root, ".test-cache"),
    workspaceRoot,
  };
}

async function completeAuthenticatedManagedTask(
  store: InMemoryLedgerStore,
  taskId: string,
  repository: Awaited<ReturnType<typeof seedManagedRepository>>,
  provenance: { readonly author: string; readonly session: string },
): Promise<string> {
  const install: ManagedWorktreeInstallRunner = async (plan) => {
    await fs.mkdir(join(plan.cwd, "node_modules"), { recursive: true });
    await fs.writeFile(join(plan.cwd, "node_modules", ".d360"), "installed\n");
    return { code: 0, stdout: "install-ok\n", stderr: "" };
  };
  const deps = {
    stateDir: repository.stateDir,
    cacheRoot: repository.cacheRoot,
    bunWorkspaceRoot: repository.workspaceRoot,
    install,
  };
  const prepared = await prepareManagedWorktree(
    {
      repositoryRoot: repository.root,
      taskId,
      baseCommit: repository.baseCommit,
    },
    deps,
  );
  if (prepared.status !== "prepared") {
    throw new Error(`D360 managed prepare failed: ${prepared.reason}`);
  }
  await fs.writeFile(
    join(prepared.evidence.absolutePath, "capture-current.txt"),
    "captured current recovery authority\n",
  );
  await git(prepared.evidence.absolutePath, ["add", "capture-current.txt"]);
  await git(prepared.evidence.absolutePath, ["commit", "-q", "-m", "capture current authority"]);
  const resultCommit = await git(prepared.evidence.absolutePath, ["rev-parse", "HEAD"]);
  if ((await git(prepared.evidence.absolutePath, ["cat-file", "-t", resultCommit])) !== "commit") {
    throw new Error("D360 resultCommit is not a commit object");
  }
  const released = await releaseManagedWorktree(
    { handle: prepared.handle, terminalDisposition: "done", resultCommit },
    deps,
  );
  if (released.status !== "released") {
    throw new Error(`D360 managed release failed: ${released.reason}`);
  }
  await store.updateItem("tasks", taskId, {
    status: "done",
    fields: { resultCommit },
    ...provenance,
  });
  return resultCommit;
}

function statusOutput(state: "provisional" | "committed"): string {
  const journal = state === "committed" ? committedJournal() : provisionalJournal();
  const common = {
    kind: "cq-current-recovery-status" as const,
    version: 1 as const,
    taskId: RECOVERY_TASK,
    selectedSourceHandle: journal.seal.seed.selectedSourceHandle,
    lineageMaximumGeneration: journal.seal.seed.lineageMaximumGeneration,
    snapshotDigest: journal.snapshotDigest,
    liveTip: journal.seal.seed.liveTip,
    updatedAt: state === "committed" ? committedJournal().committedAt : journal.writtenAt,
  };
  return JSON.stringify(
    CurrentRecoveryStatusSchema.parse(
      state === "committed"
        ? {
            ...common,
            state,
            sealReference: journal.seal.sealReference,
            sealDigest: journal.seal.sealDigest,
          }
        : { ...common, state },
    ),
  );
}

test("lineage-cutover-fence verifies only semantic committed recovery status", async () => {
  const store = new InMemoryLedgerStore({ now: () => RECOVERY_NOW });
  await store.init();
  try {
    const milestone = await store.createMilestone({ title: "recovery deployment" });
    const goal = await store.createItem("goals", milestone.id, {
      status: "planned",
      fields: { title: "recovery", description: "recovery" },
    });
    const task = await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: {
        headline: "deploy recovery fence",
        description: `CQ-OPERATOR-ACTION v1 ${LINEAGE_CUTOVER_FENCE_ACTION_KEY}. Deploy only after committed capture.`,
        ledgerRefs: [`goals:${goal.id}`],
      },
    });
    const sealReference = committedJournal().seal.sealReference;
    const materialized = await materializeOperatorAction(store, {
      taskId: task.id,
      expectedOutputIdentity: sealReference,
      expectedEvidence: [COMMAND],
    });

    const record = async (stdout: string) => {
      await acknowledgeOperatorAction(store, {
        actionId: materialized.action.id,
        expectedRevision: 1,
        outputIdentity: sealReference,
        acknowledgedAt: RECOVERY_NOW,
      });
      return await recordOperatorActionEvidence(
        store,
        materialized.action.id,
        1,
        {
          command: COMMAND,
          stdout,
          stderr: "",
          exitCode: 0,
          outputIdentity: sealReference,
          observedAt: RECOVERY_NOW,
        },
        { author: "parent" },
      );
    };

    expect((await record("not-json")).state).toBe("pending");
    expect((await record(statusOutput("provisional"))).state).toBe("pending");
    const substituted = JSON.parse(statusOutput("committed")) as Record<string, unknown>;
    substituted["sealReference"] = `cq-current-recovery-seal:v1:${"0".repeat(64)}`;
    expect((await record(JSON.stringify(substituted))).state).toBe("pending");
    const substitutedGeneration = JSON.parse(statusOutput("committed")) as {
      selectedSourceHandle: { generation: number };
    };
    substitutedGeneration.selectedSourceHandle.generation += 1;
    expect((await record(JSON.stringify(substitutedGeneration))).state).toBe("pending");
    expect((await record(statusOutput("committed"))).state).toBe("verified");
  } finally {
    await store.dispose();
  }
});

test("D360 corrected finalized manifest keeps capture-current executable and preserves its defect ref", async () => {
  const fixture = await inMemoryPlanLifecycleFactory.build();
  const repository = await seedManagedRepository();
  const store = (fixture as unknown as { readonly store: InMemoryLedgerStore }).store;
  const provenance = { author: "d360-fixture", session: "d360-fixture" } as const;
  try {
    await fixture.seedGoal({ goalId: "G360", phase: "clarifying", generation: null });
    const claimed = await fixture.lifecycle.claimPlan({
      goalId: "G360",
      purpose: "initial",
      claimRequestId: "d360-claim",
      ownerFenceToken: "d360-owner-fence-token",
      expectedGeneration: null,
      ...provenance,
    });
    if (!claimed.ok) throw new Error(`D360 claim failed: ${claimed.conflict.code}`);
    const published = await fixture.lifecycle.publishPlanDraft({
      goalId: "G360",
      claimId: claimed.acknowledgement.claimId,
      generation: claimed.acknowledgement.generation,
      operationId: "d360-publish",
      ownerFenceToken: claimed.acknowledgement.ownerFenceToken,
      ...provenance,
      manifest: {
        milestones: [{ key: "recovery", title: "Recovery" }],
        tasks: [
          {
            key: "capture-current",
            milestoneKey: "recovery",
            headline: "Capture current recovery authority",
            ledgerRefs: ["defects:D360"],
          },
        ],
      },
    });
    if (!published.ok) throw new Error(`D360 publication failed: ${published.conflict.code}`);
    const draft = {
      goalId: "G360",
      claimId: claimed.acknowledgement.claimId,
      generation: claimed.acknowledgement.generation,
      revision: published.acknowledgement.manifest.revision,
    };
    await fixture.seedReview({
      reviewId: "R360",
      goalId: "G360",
      status: "go-ahead",
      draft,
      provenance,
    });
    const finalized = await fixture.lifecycle.finalizePlan({
      goalId: "G360",
      claimId: claimed.acknowledgement.claimId,
      generation: claimed.acknowledgement.generation,
      operationId: "d360-finalize",
      ownerFenceToken: claimed.acknowledgement.ownerFenceToken,
      ...provenance,
      reviewId: "R360",
      draftRevision: draft.revision,
      decision: { headline: "Use the corrected recovery manifest" },
    });
    if (!finalized.ok) throw new Error(`D360 finalization failed: ${finalized.conflict.code}`);

    const planned = await fixture.observe("G360");
    const task = planned.tasks.find(({ headline }) => headline.includes("Capture current"));
    if (task === undefined) throw new Error("D360 capture-current task missing");
    expect(task.status).toBe("planned");
    expect(task.ledgerRefs).toEqual(["goals:G360", "defects:D360"]);

    await fixture.startTask(task.id, provenance);
    expect((await fixture.observe("G360")).tasks.find(({ id }) => id === task.id)?.status).toBe(
      "wip",
    );
    const resultCommit = await completeAuthenticatedManagedTask(
      store,
      task.id,
      repository,
      provenance,
    );
    const completed = store.fetchItem("tasks", task.id);
    expect(completed).toMatchObject({
      status: "done",
      fields: {
        resultCommit,
        ledgerRefs: ["goals:G360", "defects:D360"],
      },
    });
  } finally {
    await fixture.dispose();
    await fs.rm(repository.root, { recursive: true, force: true });
  }
});
