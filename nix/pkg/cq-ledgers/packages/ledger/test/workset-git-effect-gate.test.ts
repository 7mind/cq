import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  readProcessIdentity,
  runWorksetGitEffectGate,
  type WorksetGitEffectBinding,
} from "@cq/process-control";
import {
  InMemoryLedgerStore,
  GOALS_LEDGER,
  TASKS_LEDGER,
  TASKS_SCHEMA,
  WorksetAdmissionError,
  createManagedWorktreeGitEffectRunner,
  createFsWorksetStore,
  requireWorksetStore,
  resolveUniqueGoalState,
  resolveUniqueTaskState,
  type Item,
  type TaskStateReader,
  worksetEffectAdmissionProviderFromStore,
} from "../src/index.js";
import { mintManagedTerminalReleaseBinding } from "../src/managedTerminalReleaseAdmission.js";

const exec = promisify(execFile);
const roots: string[] = [];
const BROKER_FIXTURE = fileURLToPath(new URL("./worksetGitEffectBrokerChild.ts", import.meta.url));

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await exec("git", [...args], { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(2);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function repository(): Promise<{ readonly root: string; readonly head: string }> {
  const root = await mkdtemp(join(tmpdir(), "cq-workset-git-order-"));
  roots.push(root);
  await git(root, ["init", "--quiet"]);
  await git(root, ["config", "user.email", "cq@example.invalid"]);
  await git(root, ["config", "user.name", "CQ Test"]);
  await Bun.write(join(root, "tracked.txt"), "base\n");
  await git(root, ["add", "tracked.txt"]);
  await git(root, ["commit", "--quiet", "-m", "base"]);
  return { root, head: await git(root, ["rev-parse", "HEAD"]) };
}

function taskItem(id: string, status: string, milestoneId: string): Item {
  return {
    id,
    milestoneId,
    status,
    fields: { headline: `${id} fixture` },
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}

function taskStateReader(input: {
  readonly active: readonly Item[];
  readonly archives: readonly { readonly id: string; readonly items: readonly Item[] }[];
}): { readonly reader: TaskStateReader; readonly archiveReads: string[] } {
  const archiveReads: string[] = [];
  const archives = new Map(input.archives.map((archive) => [archive.id, archive.items]));
  const reader: TaskStateReader = {
    fetch(ledgerId) {
      if (ledgerId !== TASKS_LEDGER) throw new Error(`unexpected ledger ${ledgerId}`);
      return {
        id: TASKS_LEDGER,
        schema: TASKS_SCHEMA,
        counters: { milestone: 1, item: 1 },
        milestones: [
          {
            id: "M-active",
            milestone: { id: "M-active", status: "open", title: "Active", description: "" },
            items: [...input.active],
          },
        ],
        archivePointers: input.archives.map((archive) => ({
          id: archive.id,
          path: `./archive/tasks/${archive.id}.md`,
          summary: "fixture",
          title: "Fixture",
          status: "done",
        })),
      };
    },
    async fetchArchive(ledgerId, archiveId) {
      if (ledgerId !== TASKS_LEDGER) throw new Error(`unexpected ledger ${ledgerId}`);
      archiveReads.push(archiveId);
      const items = archives.get(archiveId);
      if (items === undefined) throw new Error(`missing archive fixture ${archiveId}`);
      return {
        kind: "group",
        milestone: { id: archiveId, title: "", description: "", items: [...items] },
      };
    },
  };
  return { reader, archiveReads };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("T2322 unique active-or-archived task state", () => {
  test("reads every archive and rejects an active plus archived duplicate [Behavioral-Active Blackbox-Atomic]", async () => {
    const active = taskItem("T2322", "done", "M-active");
    const fixture = taskStateReader({
      active: [active],
      archives: [
        { id: "M-archived", items: [taskItem("T2322", "done", "M-archived")] },
        { id: "M-unrelated", items: [taskItem("T9999", "done", "M-unrelated")] },
      ],
    });
    await expect(resolveUniqueTaskState(fixture.reader, "T2322")).rejects.toThrow(
      "task T2322 resolves to 2 active-or-archived records",
    );
    expect(fixture.archiveReads).toEqual(["M-archived", "M-unrelated"]);
  });

  test("rejects zero and multiple archived records [Behavioral-Active Blackbox-Atomic]", async () => {
    const missing = taskStateReader({ active: [], archives: [{ id: "M-empty", items: [] }] });
    await expect(resolveUniqueTaskState(missing.reader, "T2322")).rejects.toThrow(
      "task T2322 resolves to 0 active-or-archived records",
    );
    const duplicated = taskStateReader({
      active: [],
      archives: [
        { id: "M-one", items: [taskItem("T2322", "done", "M-one")] },
        { id: "M-two", items: [taskItem("T2322", "done", "M-two")] },
      ],
    });
    await expect(resolveUniqueTaskState(duplicated.reader, "T2322")).rejects.toThrow(
      "task T2322 resolves to 2 active-or-archived records",
    );
  });

  test("returns one exact archived record after reading every archive [Behavioral-Active Blackbox-Atomic]", async () => {
    const archived = taskItem("T2322", "done", "M-two");
    const fixture = taskStateReader({
      active: [],
      archives: [
        { id: "M-one", items: [taskItem("T9999", "done", "M-one")] },
        { id: "M-two", items: [archived] },
      ],
    });
    await expect(resolveUniqueTaskState(fixture.reader, "T2322")).resolves.toEqual(archived);
    expect(fixture.archiveReads).toEqual(["M-one", "M-two"]);
  });

  test("terminal release runner admits only the equal archived disposition [Behavioral-Active Blackbox-GoodCommunication]", async () => {
    const repo = await repository();
    const store = new InMemoryLedgerStore();
    await store.init();
    const milestone = await store.createMilestone({ id: "M2322", title: "Archived runner" });
    await store.createItem(TASKS_LEDGER, milestone.id, {
      id: "T2322",
      status: "done",
      fields: { headline: "Archived release runner" },
    });
    await store.updateMilestone(milestone.id, { status: "done" });
    await store.archiveMilestone(milestone.id, "runner fixture");
    const branch = "implement/T2322";
    const worktreePath = join(repo.root, ".claude", "worktrees", "archived-runner");
    await git(repo.root, ["branch", branch, repo.head]);
    await git(repo.root, ["worktree", "add", "--quiet", worktreePath, branch]);
    const bindingInput = {
      taskId: "T2322",
      handleToken: "runner-handle",
      handleFingerprint: "a".repeat(64),
      repositoryRoot: repo.root,
      worktreePath,
      branch,
    } as const;
    try {
      const mismatchRunner = createManagedWorktreeGitEffectRunner({
        store,
        taskId: "T2322",
        repositoryRoot: repo.root,
        terminalReleaseBinding: mintManagedTerminalReleaseBinding({
          ...bindingInput,
          terminalDisposition: "abandoned",
        }),
      });
      await expect(
        mismatchRunner(repo.root, ["worktree", "remove", "--force", worktreePath]),
      ).rejects.toThrow("task status done does not equal bound disposition abandoned");
      expect((await stat(worktreePath)).isDirectory()).toBe(true);

      const equalRunner = createManagedWorktreeGitEffectRunner({
        store,
        taskId: "T2322",
        repositoryRoot: repo.root,
        terminalReleaseBinding: mintManagedTerminalReleaseBinding({
          ...bindingInput,
          terminalDisposition: "done",
        }),
      });
      expect(
        (await equalRunner(repo.root, ["worktree", "remove", "--force", worktreePath])).code,
      ).toBe(0);
      expect(
        await stat(worktreePath)
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
    } finally {
      await store.dispose();
    }
  });
});

describe("D398 unique active-or-archived goal state", () => {
  test("returns the exact archived owning goal [Behavioral-Active Blackbox-Atomic]", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const milestone = await store.createMilestone({ id: "M398", title: "Archived goal" });
    const goal = await store.createItem(GOALS_LEDGER, milestone.id, {
      id: "G398",
      status: "done",
      fields: {
        title: "Archived implementation-evidence owner",
        description: "Production authority remains resolvable after archival.",
      },
    });
    await store.updateMilestone(milestone.id, { status: "done" });
    await store.archiveMilestone(milestone.id, "archived goal fixture");

    await expect(resolveUniqueGoalState(store, goal.id)).resolves.toMatchObject({
      id: goal.id,
      status: "done",
      milestoneId: milestone.id,
    });
  });
});

describe("T1984 durable Git effect replacement ordering", () => {
  test("the managed-worktree adapter brokers combined create and guarded release mutations [Behavioral-Active Blackbox-GoodCommunication]", async () => {
    const repo = await repository();
    const store = new InMemoryLedgerStore();
    await store.init();
    await store.createMilestone({ id: "M1984", title: "Git effect fixture" });
    await store.createItem("tasks", "M1984", {
      id: "T1984",
      status: "planned",
      fields: { headline: "Broker managed worktree Git" },
    });
    await requireWorksetStore(store).setRoots(["tasks:T1984"]);
    const runner = createManagedWorktreeGitEffectRunner({
      store,
      taskId: "T1984",
      repositoryRoot: repo.root,
    });
    const worktreePath = join(repo.root, ".claude", "worktrees", "managed-effect");
    try {
      expect(
        (
          await runner(repo.root, [
            "worktree",
            "add",
            "--quiet",
            "-b",
            "implement/T1984",
            worktreePath,
            repo.head,
          ])
        ).code,
      ).toBe(0);
      expect(await git(worktreePath, ["rev-parse", "HEAD"])).toBe(repo.head);
      expect((await runner(repo.root, ["worktree", "remove", "--force", worktreePath])).code).toBe(
        0,
      );
      expect((await runner(repo.root, ["branch", "-D", "implement/T1984"])).code).toBe(0);
    } finally {
      await store.dispose();
    }
  });

  test("an acquired effect makes replacement wait through registered Git completion [Behavioral-Active Blackbox-GoodCommunication]", async () => {
    const repo = await repository();
    const holder = createFsWorksetStore({ root: repo.root });
    const peer = createFsWorksetStore({ root: repo.root });
    await holder.setRoots(["tasks:T1984"]);
    const beforeLaunch = deferred();
    const permitLaunch = deferred();
    const binding: WorksetGitEffectBinding = {
      kind: "branch-create",
      targetRef: "tasks:T1984",
      repositoryRoot: repo.root,
      branch: "implement/T1984",
      commit: repo.head,
    };
    let resolutions = 0;
    const effect = runWorksetGitEffectGate({
      expected: binding,
      resolve: async () => {
        resolutions += 1;
        if (resolutions === 2) {
          beforeLaunch.resolve();
          await permitLaunch.promise;
        }
        return binding;
      },
      provider: worksetEffectAdmissionProviderFromStore(holder),
    });
    await beforeLaunch.promise;
    let replaced = false;
    const replacement = peer.setRoots(["tasks:T-revoked"]).then((value) => {
      replaced = true;
      return value;
    });
    await Bun.sleep(40);
    expect(replaced).toBe(false);
    permitLaunch.resolve();
    expect((await effect).code).toBe(0);
    expect((await replacement).roots).toEqual(["tasks:T-revoked"]);
  });

  test("broker death settles the registered Git group before replacement commits [Behavioral-Active Blackbox-GoodCommunication]", async () => {
    const repo = await repository();
    const worktreePath = join(repo.root, ".claude", "worktrees", "crash-rebase");
    const branch = "implement/T1984";
    await git(repo.root, ["branch", branch, repo.head]);
    await git(repo.root, ["worktree", "add", "--quiet", worktreePath, branch]);
    await Bun.write(join(worktreePath, "feature.txt"), "feature\n");
    await git(worktreePath, ["add", "feature.txt"]);
    await git(worktreePath, ["commit", "--quiet", "-m", "feature"]);
    const featureTip = await git(worktreePath, ["rev-parse", "HEAD"]);
    await Bun.write(join(repo.root, "main.txt"), "main\n");
    await git(repo.root, ["add", "main.txt"]);
    await git(repo.root, ["commit", "--quiet", "-m", "main"]);
    const ontoCommit = await git(repo.root, ["rev-parse", "HEAD"]);
    const marker = join(repo.root, "crash-hook-pids");
    const hook = join(repo.root, ".git", "hooks", "pre-rebase");
    await Bun.write(
      hook,
      `#!/bin/sh\ntrap '' TERM\nsleep 30 &\necho "$$ $!" > ${JSON.stringify(marker)}\nwait\n`,
    );
    await chmod(hook, 0o755);

    const peer = createFsWorksetStore({ root: repo.root });
    await peer.setRoots(["tasks:T1984"]);
    const broker = Bun.spawn(
      [process.execPath, "run", BROKER_FIXTURE, repo.root, worktreePath, ontoCommit],
      { stdout: "pipe", stderr: "pipe" },
    );
    let pids: number[] = [];
    try {
      await waitForFile(marker);
      pids = (await readFile(marker, "utf8")).trim().split(" ").map(Number);
      expect(peer.activeAdmissionCount()).toBe(1);

      let replaced = false;
      const replacement = peer.setRoots(["tasks:T-revoked"]).then((snapshot) => {
        replaced = true;
        return snapshot;
      });
      await Bun.sleep(40);
      expect(replaced).toBe(false);

      broker.kill("SIGKILL");
      expect(await broker.exited).not.toBe(0);
      expect((await replacement).roots).toEqual(["tasks:T-revoked"]);
      expect(await git(worktreePath, ["rev-parse", "HEAD"])).toBe(featureTip);
      for (const pid of pids) expect(await readProcessIdentity(pid)).toBeNull();
      expect(peer.activeAdmissionCount()).toBe(0);
    } finally {
      broker.kill("SIGKILL");
      await broker.exited;
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The registered group normally exits before cleanup reaches this fallback.
        }
      }
    }
  }, 10_000);

  test("a replacement that wins first revokes the effect before Git launch [Behavioral-Active Blackbox-GoodCommunication]", async () => {
    const repo = await repository();
    const exclusiveReady = deferred();
    const permitReplacement = deferred();
    const setter = createFsWorksetStore({
      root: repo.root,
      hooks: {
        afterExclusiveReady: async () => {
          exclusiveReady.resolve();
          await permitReplacement.promise;
        },
      },
    });
    const holder = createFsWorksetStore({ root: repo.root });
    await holder.setRoots(["tasks:T1984"]);
    const replacement = setter.setRoots(["tasks:T-revoked"]);
    await exclusiveReady.promise;
    const binding: WorksetGitEffectBinding = {
      kind: "branch-create",
      targetRef: "tasks:T1984",
      repositoryRoot: repo.root,
      branch: "implement/T1984",
      commit: repo.head,
    };
    let effectSettled = false;
    const effect = runWorksetGitEffectGate({
      expected: binding,
      resolve: async () => binding,
      provider: worksetEffectAdmissionProviderFromStore(holder),
    }).finally(() => {
      effectSettled = true;
    });
    await Bun.sleep(40);
    expect(effectSettled).toBe(false);
    permitReplacement.resolve();
    await replacement;
    await expect(effect).rejects.toBeInstanceOf(WorksetAdmissionError);
    expect(await git(repo.root, ["branch", "--list", "implement/T1984"])).toBe("");
  });
});
