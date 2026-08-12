/**
 * T2051 — prepare-only adoption orchestration.
 *
 * The same behavioral contract runs with the hand-written in-memory ledger
 * authority and the real filesystem ledger adapter. Git, filesystem overlay,
 * frozen-install planning, and managed-registry publication remain real in
 * both arms.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import { delimiter as pathDelimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createWorktreeManageCapability,
  createGitLegacyWorktreeActivityFence,
  FsLedgerStore,
  InMemoryLedgerStore,
  isUuidV7,
  listManagedLiveWorktrees,
  MILESTONES_AMBIENT_ID,
  TASKS_LEDGER,
  WORKTREE_MANAGE_TOOL_SPEC,
  type LedgerStore,
  type LegacyWorktreeActivityFence,
  type ManagedWorktreeDeps,
  type ManagedWorktreeFaultBoundary,
  type ManagedWorktreeHandle,
  type ManagedWorktreeInstallPlan,
} from "../src/index.js";

const exec = promisify(execFile);
const roots: string[] = [];
const crashWorker = fileURLToPath(
  new URL("./managedWorktreeAdoptionCrashWorker.ts", import.meta.url),
);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "T2051",
  GIT_AUTHOR_EMAIL: "t2051@example.invalid",
  GIT_COMMITTER_NAME: "T2051",
  GIT_COMMITTER_EMAIL: "t2051@example.invalid",
  GIT_TERMINAL_PROMPT: "0",
};

interface T1207Fixture {
  readonly root: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly dependencyCommit: string;
  readonly expectedHead: string;
  readonly untrackedPath: string;
  readonly untrackedSha256: string;
}

interface AuthorityFactory {
  readonly name: string;
  readonly classification: string;
  open(root: string): Promise<LedgerStore>;
}

interface AdoptionResult {
  readonly status: string;
  readonly reason?: string;
  readonly detail?: string;
  readonly handle?: ManagedWorktreeHandle;
  readonly evidence?: Record<string, unknown>;
}

interface AdoptionRequestOverrides {
  readonly baseCommit?: string;
  readonly adoptWorktreePath?: string;
  readonly expectedHead?: string;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await exec("git", [...args], { cwd, env: GIT_ENV, encoding: "utf8" });
  return result.stdout.trim();
}

async function gitResult(
  cwd: string,
  args: readonly string[],
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  try {
    const result = await exec("git", [...args], { cwd, env: GIT_ENV, encoding: "utf8" });
    return { code: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    const failed = error as { readonly code?: number; readonly stdout?: string; readonly stderr?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      stdout: String(failed.stdout ?? "").trim(),
      stderr: String(failed.stderr ?? "").trim(),
    };
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function seedT1207Shape(): Promise<T1207Fixture> {
  const root = await fs.mkdtemp(join(tmpdir(), "t2051-adoption-"));
  roots.push(root);
  const repositoryRoot = join(root, "repo");
  const worktreePath = join(repositoryRoot, ".claude", "worktrees", "implement-T1207");
  await fs.mkdir(repositoryRoot);
  await git(repositoryRoot, ["init", "-q", "-b", "main"]);
  await fs.writeFile(join(repositoryRoot, ".gitignore"), "node_modules/\n.install-cache/\n");
  await fs.writeFile(join(repositoryRoot, "bun.lock"), "t2051 fixture lock\n");
  await fs.writeFile(join(repositoryRoot, "package.json"), '{"name":"t2051-fixture"}\n');
  await fs.writeFile(join(repositoryRoot, "seed.txt"), "seed\n");
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
  const dependencyCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);

  await git(repositoryRoot, ["switch", "-q", "-c", "implement/T1207"]);
  const legacyCommits: string[] = [];
  for (let index = 1; index <= 5; index += 1) {
    await fs.writeFile(join(repositoryRoot, `landed-${index}.txt`), `change ${index}\n`);
    await git(repositoryRoot, ["add", "."]);
    await git(repositoryRoot, ["commit", "-q", "-m", `legacy ${index}`]);
    legacyCommits.push(await git(repositoryRoot, ["rev-parse", "HEAD"]));
  }
  const expectedHead = legacyCommits.at(-1)!;
  await git(repositoryRoot, ["switch", "-q", "main"]);
  for (const commit of legacyCommits) {
    await git(repositoryRoot, ["cherry-pick", "-x", commit]);
  }
  await fs.writeFile(join(repositoryRoot, "seed.txt"), "main advanced seed\n");
  await fs.writeFile(join(repositoryRoot, "main-only.txt"), "main-only addition\n");
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-q", "-m", "unrelated main advance"]);
  const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  await fs.mkdir(dirname(worktreePath), { recursive: true });
  await git(repositoryRoot, ["worktree", "add", "-q", worktreePath, "implement/T1207"]);

  const untrackedPath = join(
    worktreePath,
    "nix/pkg/cq-ledgers/packages/cq-config/test/expectedFailureMarkerContract.test.ts",
  );
  await fs.mkdir(dirname(untrackedPath), { recursive: true });
  const untrackedBytes = Buffer.from([0, 255, 10, 13, 65]);
  await fs.writeFile(untrackedPath, untrackedBytes);
  return {
    root,
    repositoryRoot,
    worktreePath,
    baseCommit,
    dependencyCommit,
    expectedHead,
    untrackedPath,
    untrackedSha256: sha256(untrackedBytes),
  };
}

async function seedEligibleTask(store: LedgerStore, fixture: T1207Fixture): Promise<void> {
  await store.init();
  await store.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: "T1206",
    status: "done",
    fields: {
      headline: "landed dependency",
      resultCommit: fixture.dependencyCommit,
    },
  });
  await store.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: "T1207",
    status: "wip",
    fields: {
      headline: "adopt exact legacy worktree",
      dependsOn: ["tasks:T1206"],
    },
  });
}

function contentFence(untrackedPath: string): LegacyWorktreeActivityFence {
  return {
    async observe() {
      return {
        epoch: "t1207-quiescent",
        contentToken: sha256(await fs.readFile(untrackedPath)),
        liveDispatches: [],
        liveLeases: [],
        liveProcesses: [],
      };
    },
  };
}

async function executableFrozenInstall(
  plans: ManagedWorktreeInstallPlan[],
  plan: ManagedWorktreeInstallPlan,
): Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number }> {
  plans.push(plan);
  expect(plan.args).toEqual(["install", "--frozen-lockfile"]);
  const nodeGypBin = plan.env["PATH"]!.split(pathDelimiter)[0]!;
  const nodeGyp = join(nodeGypBin, "node-gyp");
  await fs.access(nodeGyp, fsConstants.X_OK);
  const version = await exec(nodeGyp, ["--version"], {
    cwd: plan.cwd,
    env: plan.env,
    encoding: "utf8",
  });
  return { stdout: version.stdout, stderr: version.stderr, code: 0 };
}

async function invokeAdoption(
  store: LedgerStore,
  fixture: T1207Fixture,
  overrides: Partial<ManagedWorktreeDeps> = {},
  requestOverrides: AdoptionRequestOverrides = {},
): Promise<AdoptionResult> {
  return (await WORKTREE_MANAGE_TOOL_SPEC.run(
    store,
    createWorktreeManageCapability(fixture.repositoryRoot, {
      deps: {
        stateDir: join(fixture.root, "managed-registry"),
        cacheRoot: join(fixture.root, "install-cache"),
        bunWorkspaceRoot: fixture.repositoryRoot,
        adoptionActivityFence: contentFence(fixture.untrackedPath),
        install: async () => ({ stdout: "", stderr: "", code: 0 }),
        ...overrides,
      },
    }),
    {
      operation: "prepare",
      taskId: "T1207",
      baseCommit: fixture.baseCommit,
      adoptWorktreePath: fixture.worktreePath,
      expectedHead: fixture.expectedHead,
      ...requestOverrides,
    },
  )) as unknown as AdoptionResult;
}

async function synthesizePublishedV1Journal(
  store: LedgerStore,
  fixture: T1207Fixture,
): Promise<{
  readonly published: AdoptionResult & { readonly handle: ManagedWorktreeHandle };
  readonly journalPath: string;
  readonly indexPath: string;
  readonly staleIndexBytes: Buffer;
}> {
  const published = await invokeAdoption(store, fixture);
  if (published.status !== "prepared" || published.handle === undefined) {
    throw new Error(`could not publish synthetic v1 fixture: ${published.reason}: ${published.detail}`);
  }
  const journalPath = join(
    fixture.root,
    "managed-registry",
    "adoption-reconciliation",
    `adopt-T1207-${fixture.expectedHead.slice(0, 16)}.json`,
  );
  const journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as Record<string, unknown> & {
    index: { readonly bytesBase64: string };
  };
  journal["version"] = 1;
  delete journal["semanticOverlay"];
  delete journal["semanticOverlaySha256"];
  await fs.writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  const rawIndexPath = await git(fixture.worktreePath, ["rev-parse", "--git-path", "index"]);
  const indexPath = isAbsolute(rawIndexPath)
    ? rawIndexPath
    : resolve(fixture.worktreePath, rawIndexPath);
  const staleIndexBytes = Buffer.from(journal.index.bytesBase64, "base64");
  await fs.writeFile(indexPath, staleIndexBytes);
  return { published: published as AdoptionResult & { readonly handle: ManagedWorktreeHandle }, journalPath, indexPath, staleIndexBytes };
}

const factories: readonly AuthorityFactory[] = [
  {
    name: "hand-written in-memory authority",
    classification: "Behavioral-Active Blackbox-Atomic",
    async open() {
      return new InMemoryLedgerStore();
    },
  },
  {
    name: "real filesystem authority",
    classification: "Behavioral-Active Blackbox-GoodCommunication",
    async open(root) {
      return new FsLedgerStore({ root: join(root, "ledger-authority") });
    },
  },
];

afterAll(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

for (const factory of factories) {
  describe(`prepare-only legacy adoption — ${factory.name} (${factory.classification})`, () => {
    it("adopts the unmodified real-Git T1207 shape with a post-transition activity baseline", async () => {
      const fixture = await seedT1207Shape();
      const store = await factory.open(fixture.root);
      await seedEligibleTask(store, fixture);

      const result = await invokeAdoption(store, fixture, {
        adoptionActivityFence: createGitLegacyWorktreeActivityFence(),
      });

      expect(result.status).toBe("prepared");
      expect(result.handle).toMatchObject({ version: 2, taskId: "T1207" });
      expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(fixture.baseCommit);
      expect(sha256(await fs.readFile(fixture.untrackedPath))).toBe(fixture.untrackedSha256);
    });

    it("adopts the exact T1207 shape without changing its path or untracked bytes", async () => {
      const fixture = await seedT1207Shape();
      const store = await factory.open(fixture.root);
      const installPlans: ManagedWorktreeInstallPlan[] = [];
      try {
        await seedEligibleTask(store, fixture);
        expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(
          fixture.expectedHead,
        );
        expect((await git(fixture.repositoryRoot, ["cherry", fixture.baseCommit, fixture.expectedHead])).split("\n"))
          .toHaveLength(5);

        const result = await invokeAdoption(store, fixture, {
          install: (plan) => executableFrozenInstall(installPlans, plan),
        });

        expect(result.status).toBe("prepared");
        const handle = result.handle!;
        expect(handle).toMatchObject({
          version: 2,
          taskId: "T1207",
          branch: "implement/T1207",
          absolutePath: fixture.worktreePath,
          baseCommit: fixture.baseCommit,
        });
        expect(isUuidV7(handle.worktreeId)).toBe(true);
        expect(result.evidence).toMatchObject({
          absolutePath: fixture.worktreePath,
          baseCommit: fixture.baseCommit,
          headCommit: fixture.baseCommit,
          mode: "adopted",
        });
        expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(
          fixture.baseCommit,
        );
        await expect(
          git(fixture.worktreePath, ["merge-base", "--is-ancestor", fixture.baseCommit, "HEAD"]),
        ).resolves.toBe("");
        expect(sha256(await fs.readFile(fixture.untrackedPath))).toBe(fixture.untrackedSha256);
        expect(installPlans).toHaveLength(1);
        expect(installPlans[0]!.cwd).toBe(fixture.worktreePath);
        expect(await listManagedLiveWorktrees(
          fixture.repositoryRoot,
          "T1207",
          join(fixture.root, "managed-registry"),
        )).toEqual([handle]);
      } finally {
        await store.dispose();
      }
    }, 30_000);
  });
}

describe("prepare-only adoption crash recovery (Effectual-GoodCommunication)", () => {
  for (const { boundary, liveAfterCrash } of [
    { boundary: "after-adoption-stage", liveAfterCrash: false },
    { boundary: "after-adoption-publication", liveAfterCrash: true },
  ] satisfies readonly {
    readonly boundary: ManagedWorktreeFaultBoundary;
    readonly liveAfterCrash: boolean;
  }[]) {
    it(`fresh process after ${boundary} converges to one authoritative v2 handle`, async () => {
      const fixture = await seedT1207Shape();
      const ledgerRoot = join(fixture.root, "ledger-authority");
      const stateDir = join(fixture.root, "managed-registry");
      const store = new FsLedgerStore({ root: ledgerRoot });
      await seedEligibleTask(store, fixture);
      await store.dispose();
      const payloadPath = join(fixture.root, `adoption-crash-${boundary}.json`);
      await fs.writeFile(
        payloadPath,
        JSON.stringify({
          repositoryRoot: fixture.repositoryRoot,
          ledgerRoot,
          stateDir,
          cacheRoot: join(fixture.root, "install-cache"),
          worktreePath: fixture.worktreePath,
          untrackedPath: fixture.untrackedPath,
          baseCommit: fixture.baseCommit,
          expectedHead: fixture.expectedHead,
          boundary,
        }),
      );

      const child = Bun.spawn({
        cmd: [process.execPath, crashWorker, payloadPath],
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(86);
      expect(
        await listManagedLiveWorktrees(fixture.repositoryRoot, "T1207", stateDir),
      ).toHaveLength(liveAfterCrash ? 1 : 0);

      const restarted = new FsLedgerStore({ root: ledgerRoot });
      await restarted.init();
      try {
        const recovered = await invokeAdoption(restarted, fixture);
        if (recovered.status !== "prepared") {
          throw new Error(`crash recovery refused: ${recovered.reason}: ${recovered.detail}`);
        }
        expect(recovered.handle).toMatchObject({
          version: 2,
          taskId: "T1207",
          absolutePath: fixture.worktreePath,
          baseCommit: fixture.baseCommit,
        });
        const recoveredHandle = recovered.handle!;
        expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(
          fixture.baseCommit,
        );
        expect(sha256(await fs.readFile(fixture.untrackedPath))).toBe(fixture.untrackedSha256);
        expect(
          await listManagedLiveWorktrees(fixture.repositoryRoot, "T1207", stateDir),
        ).toEqual([recoveredHandle]);
      } finally {
        await restarted.dispose();
      }
    }, 30_000);
  }
});

describe("prepare-only adoption publication visibility", () => {
  it("repairs a synthetic published v1 stale index without replacing its v2 handle or extra untracked bytes", async () => {
    const fixture = await seedT1207Shape();
    const store = new InMemoryLedgerStore();
    await seedEligibleTask(store, fixture);
    try {
      const { published } = await synthesizePublishedV1Journal(store, fixture);
      const additionalUntrackedPath = join(fixture.worktreePath, "additional-untracked.bin");
      const additionalUntrackedBytes = Buffer.from([3, 0, 255, 12]);
      await fs.writeFile(additionalUntrackedPath, additionalUntrackedBytes);
      expect({
        cached: (await gitResult(fixture.worktreePath, ["diff", "--cached", "--quiet", "--exit-code"])).code,
        unstaged: (await gitResult(fixture.worktreePath, ["diff", "--quiet", "--exit-code"])).code,
      }).toEqual({ cached: 1, unstaged: 1 });

      const resumed = await invokeAdoption(store, fixture);
      expect(resumed.status).toBe("prepared");
      expect(resumed.handle).toEqual(published.handle);
      expect(resumed.handle?.absolutePath).toBe(fixture.worktreePath);
      expect({
        cached: (await gitResult(fixture.worktreePath, ["diff", "--cached", "--quiet", "--exit-code"])).code,
        unstaged: (await gitResult(fixture.worktreePath, ["diff", "--quiet", "--exit-code"])).code,
      }).toEqual({ cached: 0, unstaged: 0 });
      expect(await fs.readFile(additionalUntrackedPath)).toEqual(additionalUntrackedBytes);
      expect(sha256(await fs.readFile(fixture.untrackedPath))).toBe(fixture.untrackedSha256);

      const repeated = await invokeAdoption(store, fixture);
      if (repeated.status !== "prepared") {
        throw new Error(`repeated v1 repair refused: ${repeated.reason}: ${repeated.detail}`);
      }
      expect(repeated.handle).toEqual(published.handle);
      expect(await fs.readFile(additionalUntrackedPath)).toEqual(additionalUntrackedBytes);
    } finally {
      await store.dispose();
    }
  }, 30_000);

  for (const scenario of [
    { name: "staged modification reversed unstaged", path: "landed-1.txt" },
    { name: "staged addition deleted unstaged", path: "staged-then-deleted.txt" },
  ] as const) {
    it(`repairs a synthetic published v1 layered delta with ${scenario.name}`, async () => {
      const fixture = await seedT1207Shape();
      const store = new InMemoryLedgerStore();
      await seedEligibleTask(store, fixture);
      const layeredPath = join(fixture.worktreePath, scenario.path);
      const observeLayerPaths = async (): Promise<{ readonly cached: string; readonly unstaged: string }> => ({
        cached: await git(fixture.worktreePath, ["diff", "--cached", "--name-only", "--"]),
        unstaged: await git(fixture.worktreePath, ["diff", "--name-only", "--"]),
      });
      try {
        await fs.writeFile(layeredPath, `${scenario.name}\n`);
        await git(fixture.worktreePath, ["add", "--", scenario.path]);
        if (scenario.name === "staged modification reversed unstaged") {
          await fs.writeFile(layeredPath, "change 1\n");
        } else {
          await fs.rm(layeredPath);
        }
        expect(await observeLayerPaths()).toEqual({ cached: scenario.path, unstaged: scenario.path });

        const { published } = await synthesizePublishedV1Journal(store, fixture);
        const resumed = await invokeAdoption(store, fixture);

        if (resumed.status !== "prepared") {
          throw new Error(`v1 layered repair refused: ${resumed.reason}: ${resumed.detail}`);
        }
        expect(resumed.status).toBe("prepared");
        expect(resumed.handle).toEqual(published.handle);
        expect(await observeLayerPaths()).toEqual({ cached: scenario.path, unstaged: scenario.path });
        if (scenario.name === "staged modification reversed unstaged") {
          expect(await fs.readFile(layeredPath, "utf8")).toBe("change 1\n");
        } else {
          await expect(fs.access(layeredPath)).rejects.toMatchObject({ code: "ENOENT" });
        }

        const repeated = await invokeAdoption(store, fixture);
        if (repeated.status !== "prepared") {
          throw new Error(`repeated v1 layered repair refused: ${repeated.reason}: ${repeated.detail}`);
        }
        expect(repeated.handle).toEqual(published.handle);
        expect(await observeLayerPaths()).toEqual({ cached: scenario.path, unstaged: scenario.path });
      } finally {
        await store.dispose();
      }
    }, 30_000);
  }

  it("refuses v1 layered repair when an absent-overlay staged path diverges after publication", async () => {
    const fixture = await seedT1207Shape();
    const store = new InMemoryLedgerStore();
    await seedEligibleTask(store, fixture);
    const layeredPath = join(fixture.worktreePath, "landed-1.txt");
    try {
      await fs.writeFile(layeredPath, "staged modification\n");
      await git(fixture.worktreePath, ["add", "--", "landed-1.txt"]);
      await fs.writeFile(layeredPath, "change 1\n");
      const synthetic = await synthesizePublishedV1Journal(store, fixture);
      const divergentBytes = Buffer.from("post-publication divergence\n");
      await fs.writeFile(layeredPath, divergentBytes);

      const result = await invokeAdoption(store, fixture);

      expect(result).toMatchObject({ status: "refused", reason: "adoption-recovery-failed" });
      expect(await fs.readFile(layeredPath)).toEqual(divergentBytes);
      expect((await fs.readFile(synthetic.indexPath)).equals(synthetic.staleIndexBytes)).toBe(true);
      expect(await listManagedLiveWorktrees(
        fixture.repositoryRoot,
        "T1207",
        join(fixture.root, "managed-registry"),
      )).toEqual([synthetic.published.handle]);
    } finally {
      await store.dispose();
    }
  }, 30_000);

  it("refuses v1 repair after post-publication tracked mutation without changing data or registry authority", async () => {
    const fixture = await seedT1207Shape();
    const store = new InMemoryLedgerStore();
    await seedEligibleTask(store, fixture);
    try {
      const synthetic = await synthesizePublishedV1Journal(store, fixture);
      const mutatedBytes = Buffer.from("post-publication mutation\n");
      await fs.writeFile(join(fixture.worktreePath, "seed.txt"), mutatedBytes);
      const result = await invokeAdoption(store, fixture);
      expect(result).toMatchObject({ status: "refused", reason: "adoption-recovery-failed" });
      expect(await fs.readFile(join(fixture.worktreePath, "seed.txt"))).toEqual(mutatedBytes);
      expect((await fs.readFile(synthetic.indexPath)).equals(synthetic.staleIndexBytes)).toBe(true);
      expect(await listManagedLiveWorktrees(
        fixture.repositoryRoot,
        "T1207",
        join(fixture.root, "managed-registry"),
      )).toEqual([synthetic.published.handle]);
    } finally {
      await store.dispose();
    }
  }, 30_000);

  for (const control of ["live-owner", "activity-race"] as const) {
    it(`refuses v1 repair on ${control} without installing an index`, async () => {
      const fixture = await seedT1207Shape();
      const store = new InMemoryLedgerStore();
      await seedEligibleTask(store, fixture);
      let observations = 0;
      try {
        const synthetic = await synthesizePublishedV1Journal(store, fixture);
        const result = await invokeAdoption(store, fixture, {
          adoptionActivityFence: {
            async observe() {
              observations += 1;
              return {
                epoch: "t1207-quiescent",
                contentToken: control === "activity-race" && observations > 1
                  ? "changed-during-repair"
                  : "stable-during-repair",
                liveDispatches: control === "live-owner" && observations === 1 ? ["dispatch-live"] : [],
                liveLeases: [],
                liveProcesses: [],
              };
            },
          },
        });
        expect(result).toMatchObject({ status: "refused", reason: "adoption-recovery-failed" });
        expect((await fs.readFile(synthetic.indexPath)).equals(synthetic.staleIndexBytes)).toBe(true);
        expect(await listManagedLiveWorktrees(
          fixture.repositoryRoot,
          "T1207",
          join(fixture.root, "managed-registry"),
        )).toEqual([synthetic.published.handle]);
      } finally {
        await store.dispose();
      }
    }, 30_000);
  }

  it("refuses a mismatched committed v1 journal without following its repair data", async () => {
    const fixture = await seedT1207Shape();
    const store = new InMemoryLedgerStore();
    await seedEligibleTask(store, fixture);
    try {
      const synthetic = await synthesizePublishedV1Journal(store, fixture);
      const journal = JSON.parse(await fs.readFile(synthetic.journalPath, "utf8")) as {
        request: { baseCommit: string };
      };
      journal.request.baseCommit = "f".repeat(40);
      await fs.writeFile(synthetic.journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      const result = await invokeAdoption(store, fixture);
      expect(result).toMatchObject({ status: "refused", reason: "adoption-recovery-failed" });
      expect((await fs.readFile(synthetic.indexPath)).equals(synthetic.staleIndexBytes)).toBe(true);
      expect(await listManagedLiveWorktrees(
        fixture.repositoryRoot,
        "T1207",
        join(fixture.root, "managed-registry"),
      )).toEqual([synthetic.published.handle]);
    } finally {
      await store.dispose();
    }
  }, 30_000);

  it("keeps the first externally visible v2 pointer authoritative after a commit fault", async () => {
    const fixture = await seedT1207Shape();
    const store = new InMemoryLedgerStore();
    const stateDir = join(fixture.root, "managed-registry");
    const currentPath = join(stateDir, "tasks", "T1207", "current.json");
    let observedPointer: string | null = null;
    await seedEligibleTask(store, fixture);
    try {
      const observer = (async (): Promise<string> => {
        for (let attempt = 0; attempt < 2_000; attempt += 1) {
          try {
            return await fs.readFile(currentPath, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            await Bun.sleep(1);
          }
        }
        throw new Error("concurrent observer did not see the v2 current pointer");
      })();
      const result = await invokeAdoption(store, fixture, {
        async faultInjector(boundary) {
          if (boundary !== "before-adoption-commit") return;
          observedPointer = await observer;
          expect(JSON.parse(observedPointer)).toMatchObject({ version: 2 });
          throw new Error("injected post-publication commit failure");
        },
      });

      expect(result.status).toBe("prepared");
      if (result.status !== "prepared") throw new Error(`unexpected ${result.reason}`);
      if (result.handle === undefined) throw new Error("prepared adoption lacks a handle");
      if (observedPointer === null) throw new Error("observer did not capture the pointer");
      expect(await fs.readFile(currentPath, "utf8")).toBe(observedPointer);
      expect(
        await listManagedLiveWorktrees(fixture.repositoryRoot, "T1207", stateDir),
      ).toEqual([result.handle]);
      expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(
        fixture.baseCommit,
      );
    } finally {
      await store.dispose();
    }
  }, 30_000);
});

async function openControlFixture(): Promise<{
  readonly fixture: T1207Fixture;
  readonly store: InMemoryLedgerStore;
}> {
  const fixture = await seedT1207Shape();
  const store = new InMemoryLedgerStore();
  await seedEligibleTask(store, fixture);
  return { fixture, store };
}

async function expectRestored(
  fixture: T1207Fixture,
  expectedBytes: Uint8Array,
): Promise<void> {
  expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(fixture.expectedHead);
  expect(sha256(await fs.readFile(fixture.untrackedPath))).toBe(sha256(expectedBytes));
  expect(
    await listManagedLiveWorktrees(
      fixture.repositoryRoot,
      "T1207",
      join(fixture.root, "managed-registry"),
    ),
  ).toEqual([]);
}

describe("prepare-only adoption refusal and compensation controls", () => {
  it("refuses an expected-HEAD identity mismatch without reconciliation", async () => {
    const { fixture, store } = await openControlFixture();
    const bytes = await fs.readFile(fixture.untrackedPath);
    try {
      const result = await invokeAdoption(store, fixture, {}, { expectedHead: "f".repeat(40) });
      expect(result).toMatchObject({ status: "refused", reason: "adoption-invalid" });
      await expectRestored(fixture, bytes);
    } finally {
      await store.dispose();
    }
  });

  it("refuses malformed WIP state before reconciliation", async () => {
    const { fixture, store } = await openControlFixture();
    try {
      await fs.writeFile(join(fixture.worktreePath, "WIP-T1207.md"), "not a WIP artifact\n");
      const result = await invokeAdoption(store, fixture);
      expect(result).toMatchObject({ status: "refused", reason: "adoption-invalid" });
      expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(
        fixture.expectedHead,
      );
    } finally {
      await store.dispose();
    }
  });

  it("refuses stale task eligibility before reconciliation", async () => {
    const { fixture, store } = await openControlFixture();
    try {
      await store.updateItem(TASKS_LEDGER, "T1207", { status: "blocked" });
      const result = await invokeAdoption(store, fixture);
      expect(result).toMatchObject({ status: "refused", reason: "adoption-ineligible" });
      expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(
        fixture.expectedHead,
      );
    } finally {
      await store.dispose();
    }
  });

  it("refuses live dispatch/process ownership without mutating source", async () => {
    const { fixture, store } = await openControlFixture();
    const bytes = await fs.readFile(fixture.untrackedPath);
    try {
      const result = await invokeAdoption(store, fixture, {
        adoptionActivityFence: {
          async observe() {
            return {
              epoch: "live-owner",
              contentToken: sha256(await fs.readFile(fixture.untrackedPath)),
              liveDispatches: ["dispatch-1"],
              liveLeases: ["lease-1"],
              liveProcesses: ["pid-123"],
            };
          },
        },
      });
      expect(result).toMatchObject({
        status: "refused",
        reason: "adoption-reconciliation-failed",
      });
      await expectRestored(fixture, bytes);
    } finally {
      await store.dispose();
    }
  });

  it("refuses a pre-existing node_modules symlink before install", async () => {
    const { fixture, store } = await openControlFixture();
    const external = join(fixture.root, "external-node-modules");
    await fs.mkdir(external);
    await fs.symlink(external, join(fixture.worktreePath, "node_modules"));
    try {
      const result = await invokeAdoption(store, fixture);
      expect(result).toMatchObject({
        status: "refused",
        reason: "bun-install-plan-invalid",
      });
      expect(await fs.realpath(join(fixture.worktreePath, "node_modules"))).toBe(external);
    } finally {
      await store.dispose();
    }
  });

  it("rolls reconciliation back after frozen install failure", async () => {
    const { fixture, store } = await openControlFixture();
    const bytes = await fs.readFile(fixture.untrackedPath);
    try {
      const result = await invokeAdoption(store, fixture, {
        install: async () => ({ stdout: "", stderr: "injected install failure", code: 17 }),
      });
      expect(result).toMatchObject({ status: "refused", reason: "bun-install-failed" });
      await expectRestored(fixture, bytes);
    } finally {
      await store.dispose();
    }
  });

  it("detects install-time content overlay and restores observed bytes", async () => {
    const { fixture, store } = await openControlFixture();
    const bytes = await fs.readFile(fixture.untrackedPath);
    try {
      const result = await invokeAdoption(store, fixture, {
        install: async () => {
          await fs.writeFile(fixture.untrackedPath, "install-time overlay\n");
          return { stdout: "", stderr: "", code: 0 };
        },
      });
      expect(result).toMatchObject({
        status: "refused",
        reason: "adoption-activity-changed",
      });
      await expectRestored(fixture, bytes);
    } finally {
      await store.dispose();
    }
  });

  it("detects a publication-time content overlay and restores observed bytes", async () => {
    const { fixture, store } = await openControlFixture();
    const bytes = await fs.readFile(fixture.untrackedPath);
    try {
      const result = await invokeAdoption(store, fixture, {
        async faultInjector(boundary) {
          if (boundary === "after-adoption-stage") {
            await fs.writeFile(fixture.untrackedPath, "publication-time overlay\n");
          }
        },
      });
      expect(result).toMatchObject({
        status: "refused",
        reason: "adoption-activity-changed",
      });
      await expectRestored(fixture, bytes);
    } finally {
      await store.dispose();
    }
  });

  it("refuses a replay conflict and restores the original legacy branch", async () => {
    const { fixture, store } = await openControlFixture();
    const bytes = await fs.readFile(fixture.untrackedPath);
    try {
      await fs.writeFile(join(fixture.worktreePath, "seed.txt"), "legacy conflict\n");
      await git(fixture.worktreePath, ["add", "seed.txt"]);
      await git(fixture.worktreePath, ["commit", "-q", "-m", "legacy conflict"]);
      const expectedHead = await git(fixture.worktreePath, ["rev-parse", "HEAD"]);

      await fs.writeFile(join(fixture.repositoryRoot, "seed.txt"), "base conflict\n");
      await git(fixture.repositoryRoot, ["add", "seed.txt"]);
      await git(fixture.repositoryRoot, ["commit", "-q", "-m", "base conflict"]);
      const baseCommit = await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]);

      const result = await invokeAdoption(store, fixture, {}, { baseCommit, expectedHead });
      expect(result).toMatchObject({
        status: "refused",
        reason: "adoption-reconciliation-failed",
      });
      expect(result.detail).toContain("replay-conflict");
      await expectRestored({ ...fixture, expectedHead }, bytes);
    } finally {
      await store.dispose();
    }
  });

  it("rejects a task-authority mutation during install and restores source", async () => {
    const { fixture, store } = await openControlFixture();
    const bytes = await fs.readFile(fixture.untrackedPath);
    try {
      const result = await invokeAdoption(store, fixture, {
        install: async () => {
          await store.updateItem(TASKS_LEDGER, "T1207", { status: "blocked" });
          return { stdout: "", stderr: "", code: 0 };
        },
      });
      expect(result).toMatchObject({
        status: "refused",
        reason: "adoption-authority-stale",
      });
      await expectRestored(fixture, bytes);
    } finally {
      await store.dispose();
    }
  });

  for (const boundary of [
    "after-adoption-reconciliation",
    "after-adoption-install",
    "after-adoption-stage",
  ] satisfies readonly ManagedWorktreeFaultBoundary[]) {
    it(`restores bounded state after a caught ${boundary} fault`, async () => {
      const { fixture, store } = await openControlFixture();
      const bytes = await fs.readFile(fixture.untrackedPath);
      try {
        const result = await invokeAdoption(store, fixture, {
          faultInjector(observed) {
            if (observed === boundary) throw new Error(`injected ${boundary}`);
          },
        });
        expect(result.status).toBe("refused");
        await expectRestored(fixture, bytes);
      } finally {
        await store.dispose();
      }
    });
  }
});
