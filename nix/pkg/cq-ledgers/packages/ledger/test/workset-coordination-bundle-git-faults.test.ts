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
  createWorksetOwnedGuardedLedger,
  GitObjectLedgerBackend,
  GitPlumbing,
  GOALS_LEDGER,
  IDEAS_LEDGER,
  MILESTONES_LEDGER,
  nodeGitRunner,
  PLAN_CURRENT_DRAFT_FIELD,
  TASKS_LEDGER,
  worksetMemberRefSet,
  type GitRunner,
  type WorksetOwnedGuardedLedger,
} from "../src/index.js";

const exec = promisify(execFile);
const roots: string[] = [];
const ledgers: WorksetOwnedGuardedLedger[] = [];

afterAll(async () => {
  for (const ledger of ledgers) await ledger.dispose().catch(() => undefined);
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function seedRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "owned-write-git-fault-"));
  roots.push(root);
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "test"], { cwd: root });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  return root;
}

async function open(
  repoRoot: string,
  git: GitPlumbing = GitPlumbing.withCwd(repoRoot, path.join(repoRoot, ".git")),
  onMutation?: (ledgerId: string) => void,
): Promise<{ raw: GitObjectLedgerBackend; ledger: WorksetOwnedGuardedLedger }> {
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
  const ledger = createWorksetOwnedGuardedLedger({
    rawStore: raw,
    worksetStore,
    invocationAuthority: createTrustedWorksetManagementAuthority(),
    runOwnedTransaction: (mutate) => raw.runAtomicOwnedMutation(mutate),
  });
  await ledger.init();
  ledgers.push(ledger);
  return { raw, ledger };
}

async function refTip(repoRoot: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-parse", "refs/heads/cq-ledger"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return stdout.trim();
}

describe("workset coordination-bundle Git-object faults [T1964]", () => {
  it("ref update failure exposes no partial graph and restart reads the prior tip", async () => {
    const repoRoot = await seedRepo();
    const delegate = nodeGitRunner(repoRoot);
    let armed = false;
    let failed = false;
    const runner: GitRunner = async (args, options) => {
      if (armed && !failed && args[0] === "update-ref") {
        failed = true;
        return { stdout: "", stderr: "injected ref update failure", code: 1 };
      }
      return delegate(args, options);
    };
    const git = new GitPlumbing({ runner, scratchDir: path.join(repoRoot, ".git") });
    const { ledger } = await open(repoRoot, git);
    const idea = await ledger.owned.createOwnerless({
      ledgerId: IDEAS_LEDGER,
      status: "open",
      fields: { title: "git-fault-idea" },
    });
    const { goal } = await ledger.bundles.bootstrapIdeaToGoal({
      ideaId: idea.id,
      goal: { title: "git-fault-goal", description: "pre-state" },
    });
    const beforeTip = await refTip(repoRoot);
    const beforeMilestones = ledger.fetch(MILESTONES_LEDGER).counters.item;
    const beforeTasks = ledger.fetch(TASKS_LEDGER).counters.item;

    armed = true;
    await expect(
      ledger.bundles.publishOwnedDraft({
        goalId: goal.id,
        creationKind: "active-current-draft",
        milestone: { title: "git-must-rollback" },
        tasks: [{ headline: "git-must-rollback" }],
      }),
    ).rejects.toThrow("injected ref update failure");
    expect(await refTip(repoRoot)).toBe(beforeTip);
    expect(ledger.fetch(MILESTONES_LEDGER).counters.item).toBe(beforeMilestones);
    expect(ledger.fetch(TASKS_LEDGER).counters.item).toBe(beforeTasks);
    expect(
      ledger.fetchItem(GOALS_LEDGER, goal.id).fields[PLAN_CURRENT_DRAFT_FIELD],
    ).toBeUndefined();

    const restarted = await open(repoRoot);
    expect(restarted.ledger.fetch(MILESTONES_LEDGER).counters.item).toBe(beforeMilestones);
    expect(restarted.ledger.search(TASKS_LEDGER, "git-must-rollback")).toEqual([]);
  });

  it("a committed ref becomes visible to a peer only after invalidation", async () => {
    const repoRoot = await seedRepo();
    const mutations: string[] = [];
    const writer = await open(repoRoot, undefined, (ledgerId) => mutations.push(ledgerId));
    const reader = await open(repoRoot);
    const idea = await writer.ledger.owned.createOwnerless({
      ledgerId: IDEAS_LEDGER,
      status: "open",
      fields: { title: "git-peer-visible" },
    });
    expect(() => reader.raw.fetchItem(IDEAS_LEDGER, idea.id)).toThrow();
    await reader.raw.invalidate(IDEAS_LEDGER);
    expect(reader.raw.fetchItem(IDEAS_LEDGER, idea.id).fields.title).toBe("git-peer-visible");
    expect(mutations).toEqual([IDEAS_LEDGER]);
  });

  it("competing object writers serialize without losing either ref update", async () => {
    const repoRoot = await seedRepo();
    const first = await open(repoRoot);
    const second = await open(repoRoot);
    const [left, right] = await Promise.all([
      first.ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "git-race-left" },
      }),
      second.ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "git-race-right" },
      }),
    ]);
    expect(left.id).not.toBe(right.id);

    const restarted = await open(repoRoot);
    expect(restarted.raw.fetchItem(IDEAS_LEDGER, left.id).fields.title).toBe(
      "git-race-left",
    );
    expect(restarted.raw.fetchItem(IDEAS_LEDGER, right.id).fields.title).toBe(
      "git-race-right",
    );
  });
});
