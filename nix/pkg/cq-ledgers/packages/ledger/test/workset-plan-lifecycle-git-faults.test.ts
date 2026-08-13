import { afterAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  buildActiveStateFromLedgerStore,
  closeWorkset,
  createGitObjectWorksetStore,
  createTrustedWorksetManagementAuthority,
  createWorksetGuardedPlanLifecycleStore,
  GitObjectLedgerBackend,
  GitPlumbing,
  GOALS_LEDGER,
  MILESTONES_AMBIENT_ID,
  nodeGitRunner,
  PLAN_CURRENT_DRAFT_FIELD,
  TASKS_LEDGER,
  worksetMemberRefSet,
  type GitRunner,
  type PlanPublishDraftInput,
  type WorksetGuardedPlanLifecycleStore,
} from "../src/index.js";

const exec = promisify(execFile);
const roots: string[] = [];
const stores: WorksetGuardedPlanLifecycleStore[] = [];
const provenance = { author: "T1969", session: "T1969-fault" } as const;

afterAll(async () => {
  for (const store of stores) await store.dispose().catch(() => undefined);
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function seedRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "workset-plan-git-fault-"));
  roots.push(root);
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "test"], { cwd: root });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  return root;
}

async function open(
  repoRoot: string,
  git = GitPlumbing.withCwd(repoRoot, path.join(repoRoot, ".git")),
  onMutation?: (ledgerId: string) => void,
): Promise<{ raw: GitObjectLedgerBackend; store: WorksetGuardedPlanLifecycleStore }> {
  const raw = new GitObjectLedgerBackend({
    repoRoot,
    git,
    ...(onMutation !== undefined ? { onMutation } : {}),
  });
  const worksetStore = await createGitObjectWorksetStore({
    repoRoot,
    git,
    isTargetAdmitted: (target, selectedRoots) => {
      if (selectedRoots.length === 0) return true;
      const graph = closeWorkset(
        selectedRoots,
        buildActiveStateFromLedgerStore(raw),
      );
      return worksetMemberRefSet(graph).has(target) || graph.inactiveRoots.includes(target);
    },
  });
  const store = createWorksetGuardedPlanLifecycleStore({
    rawStore: raw,
    worksetStore,
    invocationAuthority: createTrustedWorksetManagementAuthority(),
    runOwnedTransaction: (mutate) => raw.runAtomicOwnedMutation(mutate),
    runPlanLifecycleTransaction: (goalId, mutate) =>
      raw.runAtomicWorksetPlanLifecycleMutation(goalId, mutate),
  });
  await store.init();
  stores.push(store);
  return { raw, store };
}

async function refTip(repoRoot: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-parse", "refs/heads/cq-ledger"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return stdout.trim();
}

async function seedClaim(store: WorksetGuardedPlanLifecycleStore, requestId: string) {
  await store.owned.createOwnerless({
    ledgerId: GOALS_LEDGER,
    milestoneId: MILESTONES_AMBIENT_ID,
    id: "G1",
    status: "clarifying",
    fields: { title: "git lifecycle goal", description: "prestate" },
    ...provenance,
  });
  const claimed = await store.claimPlan({
    goalId: "G1",
    purpose: "initial",
    claimRequestId: requestId,
    ownerFenceToken: "g".repeat(22),
    expectedGeneration: null,
    ...provenance,
  });
  if (!claimed.ok) throw new Error(`claim failed: ${claimed.conflict.code}`);
  return claimed.acknowledgement;
}

function publishInput(
  claim: Awaited<ReturnType<typeof seedClaim>>,
  operationId: string,
  headline: string,
): PlanPublishDraftInput {
  return {
    goalId: "G1",
    claimId: claim.claimId,
    generation: claim.generation,
    operationId,
    ownerFenceToken: claim.ownerFenceToken,
    manifest: {
      milestones: [{ key: "delivery", title: headline }],
      tasks: [{ key: "task", milestoneKey: "delivery", headline }],
    },
    ...provenance,
  };
}

describe("workset plan lifecycle Git-object faults [T1969]", () => {
  it("failed ref CAS exposes no plan effects and restart retries the operation as new", async () => {
    const repoRoot = await seedRepo();
    const delegate = nodeGitRunner(repoRoot);
    let armed = false;
    let failed = false;
    const runner: GitRunner = async (args, options) => {
      if (armed && !failed && args[0] === "update-ref") {
        failed = true;
        return { stdout: "", stderr: "injected plan ref update failure", code: 1 };
      }
      return delegate(args, options);
    };
    const git = new GitPlumbing({ runner, scratchDir: path.join(repoRoot, ".git") });
    const mutations: string[] = [];
    const { store } = await open(repoRoot, git, (ledgerId) => mutations.push(ledgerId));
    const claim = await seedClaim(store, "git-fault-claim");
    const input = publishInput(claim, "git-fault-publish", "git-must-rollback");
    const beforeTip = await refTip(repoRoot);
    const beforeTasks = store.fetch(TASKS_LEDGER).counters.item;
    mutations.length = 0;

    armed = true;
    await expect(store.publishPlanDraft(input)).rejects.toThrow(
      "injected plan ref update failure",
    );
    expect(await refTip(repoRoot)).toBe(beforeTip);
    expect(mutations).toEqual([]);
    expect(store.fetch(TASKS_LEDGER).counters.item).toBe(beforeTasks);
    expect(store.fetchItem(GOALS_LEDGER, "G1").fields[PLAN_CURRENT_DRAFT_FIELD]).toBeUndefined();

    const restarted = await open(repoRoot);
    expect(restarted.store.search(TASKS_LEDGER, "git-must-rollback")).toEqual([]);
    const retried = await restarted.store.publishPlanDraft(input);
    expect(retried).toMatchObject({ ok: true, replayed: false });
    expect(restarted.store.search(TASKS_LEDGER, "git-must-rollback")).toHaveLength(1);
  });

  it("competing peers reload the ref and publish only complete replacement graphs", async () => {
    const repoRoot = await seedRepo();
    const first = await open(repoRoot);
    const claim = await seedClaim(first.store, "git-race-claim");
    const second = await open(repoRoot);
    const [left, right] = await Promise.all([
      first.store.publishPlanDraft(publishInput(claim, "git-race-left", "git-race-left")),
      second.store.publishPlanDraft(publishInput(claim, "git-race-right", "git-race-right")),
    ]);
    expect(left).toMatchObject({ ok: true, replayed: false });
    expect(right).toMatchObject({ ok: true, replayed: false });

    const restarted = await open(repoRoot);
    const tasks = restarted.store.fetch(TASKS_LEDGER).milestones.flatMap(({ items }) => items);
    expect(tasks.map(({ fields }) => fields.headline).sort()).toEqual([
      "git-race-left",
      "git-race-right",
    ]);
    expect(tasks.map(({ status }) => status).sort()).toEqual(["abandoned", "planned"]);
    const current = JSON.parse(
      restarted.store.fetchItem(GOALS_LEDGER, "G1").fields[
        PLAN_CURRENT_DRAFT_FIELD
      ] as string,
    ) as { manifest: { tasks: { id: string }[] } };
    expect(tasks.find(({ status }) => status === "planned")?.id).toBe(
      current.manifest.tasks[0]?.id,
    );
  });
});
