import { afterAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  assessLegacyReconciliationActivity,
  assessLegacyReconciliationHistory,
  beginLegacyWorktreeReconciliation,
  classifyLegacyHistory,
  createGitLegacyWorktreeActivityFence,
  createGitLegacyReconciliationObservationAdapter,
  nodeLegacyReconciliationGitRunner,
  recoverLegacyWorktreeReconciliation,
  type LegacyWorktreeActivityFence,
  type LegacyWorktreeActivityObservation,
  type LegacyReconciliationFaultBoundary,
  type LegacyReconciliationGitRunner,
  type LegacyReconciliationHistoryObservation,
  type LegacyReconciliationObservationAdapter,
  type LegacyWorktreeManagerLock,
} from "../src/index.js";

const exec = promisify(execFile);
const roots: string[] = [];
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "T2050",
  GIT_AUTHOR_EMAIL: "t2050@example.invalid",
  GIT_COMMITTER_NAME: "T2050",
  GIT_COMMITTER_EMAIL: "t2050@example.invalid",
  GIT_TERMINAL_PROMPT: "0",
};

const T1207_OBSERVED = {
  head: "949081b4b1f186275369317fff6b23dcfb5e82f3",
  cherry: [
    "- 9917d543ac7a1b7b855bb1b025c7eadfdc3ae00a",
    "- e833468228f59ad3c896a384c2cd5df376c42ed1",
    "- 0dce2fa807a758d731f78319b24efdd6c040bfdc",
    "- 640cdded4d9b110854f7902f3777e1b32ff76143",
    "- 949081b4b1f186275369317fff6b23dcfb5e82f3",
  ],
  wipArtifacts: [],
  untracked: [
    "nix/pkg/cq-ledgers/packages/cq-config/test/expectedFailureMarkerContract.test.ts",
  ],
} as const;

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
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      stdout: String(failed.stdout ?? "").trim(),
      stderr: String(failed.stderr ?? "").trim(),
    };
  }
}

async function refValue(cwd: string, ref: string): Promise<string | null> {
  const result = await gitResult(cwd, ["rev-parse", "--verify", "--quiet", ref]);
  return result.code === 0 ? result.stdout : null;
}

const managerLock: LegacyWorktreeManagerLock = {
  async acquire() {
    return async () => undefined;
  },
};

const stableActivity: LegacyWorktreeActivityFence = {
  async observe() {
    return {
      epoch: "epoch-1",
      contentToken: "content-1",
      liveDispatches: [],
      liveLeases: [],
      liveProcesses: [],
    };
  },
};

function activity(
  epoch: string,
  contentToken: string,
  overrides: Partial<LegacyWorktreeActivityObservation> = {},
): LegacyWorktreeActivityObservation {
  return {
    epoch,
    contentToken,
    liveDispatches: [],
    liveLeases: [],
    liveProcesses: [],
    ...overrides,
  };
}

function scriptedActivity(
  observations: readonly LegacyWorktreeActivityObservation[],
): LegacyWorktreeActivityFence {
  let index = 0;
  return {
    async observe() {
      const observed = observations[Math.min(index, observations.length - 1)]!;
      index += 1;
      return observed;
    },
  };
}

function contentDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileContentActivity(filePath: string): LegacyWorktreeActivityFence {
  return {
    async observe() {
      return activity("byte-content-epoch", contentDigest(await fs.readFile(filePath)));
    },
  };
}

class InMemoryLegacyObservationAdapter implements LegacyReconciliationObservationAdapter {
  private bytes = Buffer.from("captured bytes\n");

  constructor(
    private readonly histories: ReadonlyMap<string, LegacyReconciliationHistoryObservation>,
  ) {}

  async observeActivity(): Promise<LegacyWorktreeActivityObservation> {
    return activity("byte-content-epoch", contentDigest(this.bytes));
  }

  async observeHistory(input: {
    readonly repositoryRoot: string;
    readonly baseCommit: string;
    readonly headCommit: string;
  }): Promise<LegacyReconciliationHistoryObservation> {
    const observed = this.histories.get(`${input.baseCommit}:${input.headCommit}`);
    if (observed === undefined) {
      return { status: "unresolvable", detail: "in-memory history pair is absent" };
    }
    return observed;
  }

  mutateBytes(): void {
    this.bytes = Buffer.from("mutated bytes\n");
  }
}

async function seedRepository(prefix: string): Promise<{
  readonly root: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly journalDirectory: string;
  readonly rootCommit: string;
}> {
  const root = await fs.mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  const repositoryRoot = path.join(root, "repo");
  const worktreePath = path.join(root, "legacy");
  const journalDirectory = path.join(root, "journals");
  await fs.mkdir(repositoryRoot);
  await git(repositoryRoot, ["init", "-q", "-b", "main"]);
  await fs.writeFile(path.join(repositoryRoot, ".gitignore"), "node_modules/\n.install-cache/\n");
  await fs.writeFile(path.join(repositoryRoot, "seed.txt"), "seed\n");
  await fs.writeFile(path.join(repositoryRoot, "delete-me.txt"), "delete me\n");
  await fs.symlink("seed.txt", path.join(repositoryRoot, "seed-link"));
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
  return {
    root,
    repositoryRoot,
    worktreePath,
    journalDirectory,
    rootCommit: await git(repositoryRoot, ["rev-parse", "HEAD"]),
  };
}

async function seedT1207Shape(): Promise<{
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly legacyHead: string;
  readonly cherry: readonly string[];
  readonly journalDirectory: string;
  readonly untrackedPath: string;
}> {
  const seeded = await seedRepository("t2050-reconcile-");
  const { repositoryRoot, worktreePath, journalDirectory, rootCommit } = seeded;
  await git(repositoryRoot, ["switch", "-q", "-c", "implement/T1207"]);
  const legacyCommits: string[] = [];
  for (let index = 1; index <= 5; index += 1) {
    await fs.writeFile(path.join(repositoryRoot, `landed-${index}.txt`), `change ${index}\n`);
    await git(repositoryRoot, ["add", "."]);
    await git(repositoryRoot, ["commit", "-q", "-m", `legacy ${index}`]);
    legacyCommits.push(await git(repositoryRoot, ["rev-parse", "HEAD"]));
  }
  const legacyHead = legacyCommits.at(-1)!;
  await git(repositoryRoot, ["switch", "-q", "main"]);
  await git(repositoryRoot, ["reset", "--hard", "-q", rootCommit]);
  for (const commit of legacyCommits) {
    await git(repositoryRoot, ["cherry-pick", "-x", commit]);
  }
  await fs.writeFile(path.join(repositoryRoot, "seed.txt"), "main advanced seed\n");
  await fs.writeFile(path.join(repositoryRoot, "main-only.txt"), "main-only addition\n");
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-q", "-m", "unrelated main advance"]);
  const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  await git(repositoryRoot, ["worktree", "add", "-q", worktreePath, "implement/T1207"]);
  const untrackedPath = path.join(
    worktreePath,
    "nix/pkg/cq-ledgers/packages/cq-config/test/expectedFailureMarkerContract.test.ts",
  );
  await fs.mkdir(path.dirname(untrackedPath), { recursive: true });
  await fs.writeFile(untrackedPath, Buffer.from([0, 255, 10, 13, 65]));
  const cherry = (await git(repositoryRoot, ["cherry", baseCommit, legacyHead])).split("\n");
  return {
    repositoryRoot,
    worktreePath,
    baseCommit,
    legacyHead,
    cherry,
    journalDirectory,
    untrackedPath,
  };
}

async function seedLinearLegacy(): Promise<{
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly journalDirectory: string;
  readonly baseCommit: string;
  readonly legacyHead: string;
  readonly untrackedPath: string;
  readonly indexPath: string;
  readonly indexHex: string;
}> {
  const seeded = await seedRepository("t2050-linear-");
  const { repositoryRoot, worktreePath, journalDirectory } = seeded;
  await git(repositoryRoot, ["switch", "-q", "-c", "implement/T2050"]);
  await fs.writeFile(path.join(repositoryRoot, "legacy-feature.txt"), "unpublished\n");
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-q", "-m", "unpublished feature"]);
  const legacyHead = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  await git(repositoryRoot, ["switch", "-q", "main"]);
  await fs.writeFile(path.join(repositoryRoot, "upstream.txt"), "upstream\n");
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-q", "-m", "upstream"]);
  const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  await git(repositoryRoot, ["worktree", "add", "-q", worktreePath, "implement/T2050"]);

  const seedPath = path.join(worktreePath, "seed.txt");
  await fs.writeFile(seedPath, Buffer.from("staged bytes\n"));
  await fs.chmod(seedPath, 0o755);
  await git(worktreePath, ["add", "seed.txt"]);
  await fs.writeFile(seedPath, Buffer.from([0, 1, 2, 255, 10]));
  await fs.rm(path.join(worktreePath, "delete-me.txt"));
  await fs.rm(path.join(worktreePath, "seed-link"));
  await fs.symlink("legacy-feature.txt", path.join(worktreePath, "seed-link"));
  const untrackedPath = path.join(worktreePath, "deliverable.bin");
  await fs.writeFile(untrackedPath, Buffer.from([255, 0, 13, 10, 42]));
  await fs.mkdir(path.join(worktreePath, "node_modules", "package"), { recursive: true });
  await fs.writeFile(path.join(worktreePath, "node_modules", "package", "cache.bin"), "ignored");
  await fs.mkdir(path.join(worktreePath, ".install-cache"), { recursive: true });
  await fs.writeFile(path.join(worktreePath, ".install-cache", "cache.bin"), "ignored");
  const rawIndexPath = await git(worktreePath, ["rev-parse", "--git-path", "index"]);
  const indexPath = path.isAbsolute(rawIndexPath)
    ? rawIndexPath
    : path.resolve(worktreePath, rawIndexPath);
  return {
    repositoryRoot,
    worktreePath,
    journalDirectory,
    baseCommit,
    legacyHead,
    untrackedPath,
    indexPath,
    indexHex: (await fs.readFile(indexPath)).toString("hex"),
  };
}

async function seedSimpleLegacy(prefix: string): Promise<{
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly journalDirectory: string;
  readonly baseCommit: string;
  readonly legacyHead: string;
}> {
  const seeded = await seedRepository(prefix);
  await git(seeded.repositoryRoot, ["switch", "-q", "-c", "implement/T2050"]);
  await fs.writeFile(path.join(seeded.repositoryRoot, "legacy.txt"), "legacy\n");
  await git(seeded.repositoryRoot, ["add", "."]);
  await git(seeded.repositoryRoot, ["commit", "-q", "-m", "legacy"]);
  const legacyHead = await git(seeded.repositoryRoot, ["rev-parse", "HEAD"]);
  await git(seeded.repositoryRoot, ["switch", "-q", "main"]);
  await fs.writeFile(path.join(seeded.repositoryRoot, "base.txt"), "base\n");
  await git(seeded.repositoryRoot, ["add", "."]);
  await git(seeded.repositoryRoot, ["commit", "-q", "-m", "base"]);
  const baseCommit = await git(seeded.repositoryRoot, ["rev-parse", "HEAD"]);
  await git(seeded.repositoryRoot, [
    "worktree",
    "add",
    "-q",
    seeded.worktreePath,
    "implement/T2050",
  ]);
  return {
    repositoryRoot: seeded.repositoryRoot,
    worktreePath: seeded.worktreePath,
    journalDirectory: seeded.journalDirectory,
    baseCommit,
    legacyHead,
  };
}

function simpleRequest(
  fixture: Awaited<ReturnType<typeof seedSimpleLegacy>>,
  transactionId: string,
) {
  return {
    repositoryRoot: fixture.repositoryRoot,
    worktreePath: fixture.worktreePath,
    branch: "implement/T2050",
    baseCommit: fixture.baseCommit,
    expectedHead: fixture.legacyHead,
    transactionId,
    journalDirectory: fixture.journalDirectory,
  } as const;
}

interface ObservationContractCase {
  readonly name: string;
  readonly repositoryRoot: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly expected:
    | { readonly status: "accepted"; readonly classification: "upstream-equivalent" | "linear-unpublished" }
    | { readonly status: "refused"; readonly reason: "divergent-merge" | "history-unresolvable" };
}

interface ObservationContractFixture {
  readonly adapter: LegacyReconciliationObservationAdapter;
  readonly worktreePath: string;
  readonly cases: readonly ObservationContractCase[];
  mutateBytes(): Promise<void>;
}

async function seedRealObservationContract(): Promise<ObservationContractFixture> {
  const seeded = await seedRepository("t2050-observation-contract-");
  const root = seeded.rootCommit;

  await git(seeded.repositoryRoot, ["switch", "-q", "-c", "contract-linear-head", root]);
  await fs.writeFile(path.join(seeded.repositoryRoot, "linear.txt"), "linear\n");
  await git(seeded.repositoryRoot, ["add", "."]);
  await git(seeded.repositoryRoot, ["commit", "-q", "-m", "linear"]);
  const linearHead = await git(seeded.repositoryRoot, ["rev-parse", "HEAD"]);
  await git(seeded.repositoryRoot, ["switch", "-q", "-c", "contract-linear-base", root]);
  await fs.writeFile(path.join(seeded.repositoryRoot, "base-only.txt"), "base\n");
  await git(seeded.repositoryRoot, ["add", "."]);
  await git(seeded.repositoryRoot, ["commit", "-q", "-m", "linear base"]);
  const linearBase = await git(seeded.repositoryRoot, ["rev-parse", "HEAD"]);

  await git(seeded.repositoryRoot, ["switch", "-q", "-c", "contract-equivalent-head", root]);
  await fs.writeFile(path.join(seeded.repositoryRoot, "equivalent.txt"), "equivalent\n");
  await git(seeded.repositoryRoot, ["add", "."]);
  await git(seeded.repositoryRoot, ["commit", "-q", "-m", "equivalent"]);
  const equivalentHead = await git(seeded.repositoryRoot, ["rev-parse", "HEAD"]);
  await git(seeded.repositoryRoot, ["switch", "-q", "-c", "contract-equivalent-base", root]);
  await git(seeded.repositoryRoot, ["cherry-pick", "-x", equivalentHead]);
  const equivalentBase = await git(seeded.repositoryRoot, ["rev-parse", "HEAD"]);

  await git(seeded.repositoryRoot, ["switch", "-q", "-c", "contract-merge-head", root]);
  await fs.writeFile(path.join(seeded.repositoryRoot, "merge-main.txt"), "main\n");
  await git(seeded.repositoryRoot, ["add", "."]);
  await git(seeded.repositoryRoot, ["commit", "-q", "-m", "merge main"]);
  await git(seeded.repositoryRoot, ["switch", "-q", "-c", "contract-merge-side", root]);
  await fs.writeFile(path.join(seeded.repositoryRoot, "merge-side.txt"), "side\n");
  await git(seeded.repositoryRoot, ["add", "."]);
  await git(seeded.repositoryRoot, ["commit", "-q", "-m", "merge side"]);
  await git(seeded.repositoryRoot, ["switch", "-q", "contract-merge-head"]);
  await git(seeded.repositoryRoot, [
    "merge",
    "--no-ff",
    "-m",
    "contract merge",
    "contract-merge-side",
  ]);
  const mergeHead = await git(seeded.repositoryRoot, ["rev-parse", "HEAD"]);

  await git(seeded.repositoryRoot, ["switch", "--orphan", "contract-unrelated"]);
  for (const name of [
    ".gitignore",
    "seed.txt",
    "delete-me.txt",
    "seed-link",
    "merge-main.txt",
    "merge-side.txt",
  ]) {
    await fs.rm(path.join(seeded.repositoryRoot, name), { force: true });
  }
  await fs.writeFile(path.join(seeded.repositoryRoot, "unrelated.txt"), "unrelated\n");
  await git(seeded.repositoryRoot, ["add", "."]);
  await git(seeded.repositoryRoot, ["commit", "-q", "-m", "unrelated"]);
  const unrelatedBase = await git(seeded.repositoryRoot, ["rev-parse", "HEAD"]);

  const activityPath = path.join(seeded.repositoryRoot, "contract-activity.bin");
  await fs.writeFile(activityPath, Buffer.from("captured bytes\n"));
  return {
    adapter: createGitLegacyReconciliationObservationAdapter(
      nodeLegacyReconciliationGitRunner,
      fileContentActivity(activityPath),
    ),
    worktreePath: seeded.repositoryRoot,
    cases: [
      {
        name: "upstream-equivalent",
        repositoryRoot: seeded.repositoryRoot,
        baseCommit: equivalentBase,
        headCommit: equivalentHead,
        expected: { status: "accepted", classification: "upstream-equivalent" },
      },
      {
        name: "linear-unpublished",
        repositoryRoot: seeded.repositoryRoot,
        baseCommit: linearBase,
        headCommit: linearHead,
        expected: { status: "accepted", classification: "linear-unpublished" },
      },
      {
        name: "divergent-merge",
        repositoryRoot: seeded.repositoryRoot,
        baseCommit: root,
        headCommit: mergeHead,
        expected: { status: "refused", reason: "divergent-merge" },
      },
      {
        name: "history-unresolvable",
        repositoryRoot: seeded.repositoryRoot,
        baseCommit: unrelatedBase,
        headCommit: linearHead,
        expected: { status: "refused", reason: "history-unresolvable" },
      },
    ],
    async mutateBytes() {
      await fs.writeFile(activityPath, Buffer.from("mutated bytes\n"));
    },
  };
}

async function seedInMemoryObservationContract(): Promise<ObservationContractFixture> {
  const commits = {
    equivalentBase: "a".repeat(40),
    equivalentHead: "b".repeat(40),
    linearBase: "c".repeat(40),
    linearHead: "d".repeat(40),
    mergeBase: "e".repeat(40),
    mergeHead: "1".repeat(40),
    missingBase: "2".repeat(40),
    missingHead: "3".repeat(40),
  } as const;
  const histories = new Map<string, LegacyReconciliationHistoryObservation>([
    [
      `${commits.equivalentBase}:${commits.equivalentHead}`,
      { status: "observed", mergeCommits: [], cherry: [`- ${commits.equivalentHead}`] },
    ],
    [
      `${commits.linearBase}:${commits.linearHead}`,
      { status: "observed", mergeCommits: [], cherry: [`+ ${commits.linearHead}`] },
    ],
    [
      `${commits.mergeBase}:${commits.mergeHead}`,
      {
        status: "observed",
        mergeCommits: [commits.mergeHead],
        cherry: [`+ ${commits.mergeHead}`],
      },
    ],
    [
      `${commits.missingBase}:${commits.missingHead}`,
      { status: "unresolvable", detail: "in-memory histories are unrelated" },
    ],
  ]);
  const adapter = new InMemoryLegacyObservationAdapter(histories);
  return {
    adapter,
    worktreePath: "/in-memory/legacy",
    cases: [
      {
        name: "upstream-equivalent",
        repositoryRoot: "/in-memory/repository",
        baseCommit: commits.equivalentBase,
        headCommit: commits.equivalentHead,
        expected: { status: "accepted", classification: "upstream-equivalent" },
      },
      {
        name: "linear-unpublished",
        repositoryRoot: "/in-memory/repository",
        baseCommit: commits.linearBase,
        headCommit: commits.linearHead,
        expected: { status: "accepted", classification: "linear-unpublished" },
      },
      {
        name: "divergent-merge",
        repositoryRoot: "/in-memory/repository",
        baseCommit: commits.mergeBase,
        headCommit: commits.mergeHead,
        expected: { status: "refused", reason: "divergent-merge" },
      },
      {
        name: "history-unresolvable",
        repositoryRoot: "/in-memory/repository",
        baseCommit: commits.missingBase,
        headCommit: commits.missingHead,
        expected: { status: "refused", reason: "history-unresolvable" },
      },
    ],
    async mutateBytes() {
      adapter.mutateBytes();
    },
  };
}

afterAll(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

function runObservationAdapterContract(
  name: string,
  build: () => Promise<ObservationContractFixture>,
): void {
  describe(`legacy classification/fencing contract: ${name}`, () => {
    it("classifies equivalent, unpublished, merged, and unresolvable histories", async () => {
      const fixture = await build();
      for (const scenario of fixture.cases) {
        const assessed = await assessLegacyReconciliationHistory(fixture.adapter, {
          repositoryRoot: scenario.repositoryRoot,
          baseCommit: scenario.baseCommit,
          headCommit: scenario.headCommit,
        });
        expect(assessed.status).toBe(scenario.expected.status);
        if (assessed.status === "accepted" && scenario.expected.status === "accepted") {
          expect(assessed.classification).toBe(scenario.expected.classification);
        } else if (assessed.status === "refused" && scenario.expected.status === "refused") {
          expect(assessed.reason).toBe(scenario.expected.reason);
        } else {
          throw new Error(`${name} produced the wrong assessment arm for ${scenario.name}`);
        }
      }
    });

    it("derives the content fence from bytes and rejects an actual byte mutation", async () => {
      const fixture = await build();
      const captured = await assessLegacyReconciliationActivity(
        fixture.adapter,
        fixture.worktreePath,
        null,
      );
      expect(captured.status).toBe("accepted");
      if (captured.status !== "accepted") return;
      expect(captured.observation.contentToken).toBe(
        contentDigest(Buffer.from("captured bytes\n")),
      );
      await fixture.mutateBytes();
      expect(
        await assessLegacyReconciliationActivity(
          fixture.adapter,
          fixture.worktreePath,
          captured.observation,
        ),
      ).toMatchObject({ status: "refused", reason: "activity-changed" });
    });
  });
}

runObservationAdapterContract("hand-written in-memory dummy", seedInMemoryObservationContract);
runObservationAdapterContract("real Git adapter", seedRealObservationContract);

describe("legacy worktree reconciliation", () => {
  it("pins the observed T1207 HEAD, five-minus history, no-WIP state, and sole untracked test", () => {
    expect(T1207_OBSERVED.head).toBe("949081b4b1f186275369317fff6b23dcfb5e82f3");
    expect(T1207_OBSERVED.cherry).toHaveLength(5);
    expect(T1207_OBSERVED.cherry.at(-1)).toContain(T1207_OBSERVED.head);
    expect(T1207_OBSERVED.wipArtifacts).toEqual([]);
    expect(T1207_OBSERVED.untracked).toEqual([
      "nix/pkg/cq-ledgers/packages/cq-config/test/expectedFailureMarkerContract.test.ts",
    ]);
    expect(classifyLegacyHistory({ mergeCommits: [], cherry: T1207_OBSERVED.cherry })).toEqual({
      classification: "upstream-equivalent",
      replayedCommits: [],
    });
  });

  it("reproduces the exact T1207 all-upstream-equivalent shape without losing its untracked bytes", async () => {
    const fixture = await seedT1207Shape();
    expect(fixture.cherry).toHaveLength(5);
    expect(fixture.cherry.every((line) => line.startsWith("- "))).toBe(true);
    expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(fixture.legacyHead);
    expect(await git(fixture.worktreePath, ["status", "--short", "--untracked-files=all"])).toContain(
      "expectedFailureMarkerContract.test.ts",
    );
    const before = await fs.readFile(fixture.untrackedPath);

    const result = await beginLegacyWorktreeReconciliation(
      {
        repositoryRoot: fixture.repositoryRoot,
        worktreePath: fixture.worktreePath,
        branch: "implement/T1207",
        baseCommit: fixture.baseCommit,
        expectedHead: fixture.legacyHead,
        transactionId: "T1207-adoption",
        journalDirectory: fixture.journalDirectory,
      },
      { managerLock, activityFence: stableActivity },
    );

    expect(result.status).toBe("reconciled");
    if (result.status !== "reconciled") return;
    expect(result.evidence.classification).toBe("upstream-equivalent");
    expect(result.evidence.oldHead).toBe(fixture.legacyHead);
    expect(result.evidence.candidateHead).toBe(fixture.baseCommit);
    expect(result.evidence.cherry).toEqual(fixture.cherry);
    expect(result.evidence.replayedCommits).toEqual([]);
    expect(result.evidence.wipArtifacts).toEqual([]);
    expect(result.evidence.overlayEntries.map((entry) => entry.path)).toEqual([
      "nix/pkg/cq-ledgers/packages/cq-config/test/expectedFailureMarkerContract.test.ts",
    ]);
    expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(fixture.baseCommit);
    expect(await fs.readFile(fixture.untrackedPath)).toEqual(before);
    const [cached, unstaged] = await Promise.all([
      gitResult(fixture.worktreePath, ["diff", "--cached", "--quiet", "--exit-code"]),
      gitResult(fixture.worktreePath, ["diff", "--quiet", "--exit-code"]),
    ]);
    expect({
      head: await git(fixture.worktreePath, ["rev-parse", "HEAD"]),
      untrackedSha256: contentDigest(await fs.readFile(fixture.untrackedPath)),
      cachedExit: cached.code,
      unstagedExit: unstaged.code,
    }).toEqual({
      head: fixture.baseCommit,
      untrackedSha256: contentDigest(before),
      cachedExit: 0,
      unstagedExit: 0,
    });
    expect(await refValue(fixture.repositoryRoot, result.evidence.recoveryRef)).toBe(
      fixture.legacyHead,
    );
    expect(await refValue(fixture.repositoryRoot, result.evidence.candidateRef)).toBe(
      fixture.baseCommit,
    );

    expect(await result.transaction.commit()).toEqual({ status: "committed", idempotent: false });
    expect(await result.transaction.commit()).toEqual({ status: "committed", idempotent: true });
    expect(await refValue(fixture.repositoryRoot, result.evidence.recoveryRef)).toBeNull();
    expect(await refValue(fixture.repositoryRoot, result.evidence.candidateRef)).toBeNull();
  });

  it("replays only linear unpublished commits and rolls back bytes, types, modes, index, refs, and new overlay paths", async () => {
    const fixture = await seedLinearLegacy();
    const seedBytes = await fs.readFile(path.join(fixture.worktreePath, "seed.txt"));
    const linkBytes = Buffer.from(
      await fs.readlink(path.join(fixture.worktreePath, "seed-link"), {
        encoding: "buffer",
      }),
    );
    const untrackedBytes = await fs.readFile(fixture.untrackedPath);

    const result = await beginLegacyWorktreeReconciliation(
      {
        repositoryRoot: fixture.repositoryRoot,
        worktreePath: fixture.worktreePath,
        branch: "implement/T2050",
        baseCommit: fixture.baseCommit,
        expectedHead: fixture.legacyHead,
        transactionId: "linear-unpublished",
        journalDirectory: fixture.journalDirectory,
      },
      { managerLock, activityFence: stableActivity },
    );

    expect(result.status).toBe("reconciled");
    if (result.status !== "reconciled") return;
    expect(result.evidence.classification).toBe("linear-unpublished");
    expect(result.evidence.replayedCommits).toEqual([fixture.legacyHead]);
    expect(result.evidence.candidateHead).not.toBe(fixture.baseCommit);
    expect(result.evidence.candidateHead).not.toBe(fixture.legacyHead);
    expect(result.evidence.overlayEntries.map((entry) => [entry.path, entry.type])).toEqual([
      ["delete-me.txt", "deleted"],
      ["deliverable.bin", "file"],
      ["seed-link", "symlink"],
      ["seed.txt", "file"],
    ]);
    expect(result.evidence.overlayEntries.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256))).toBe(
      true,
    );
    expect(result.evidence.overlayEntries.some((entry) => entry.path.includes("node_modules"))).toBe(
      false,
    );
    expect(result.evidence.overlayEntries.some((entry) => entry.path.includes(".install-cache"))).toBe(
      false,
    );
    expect((await fs.readFile(fixture.indexPath)).toString("hex")).toBe(fixture.indexHex);
    expect(await fs.readFile(path.join(fixture.worktreePath, "seed.txt"))).toEqual(seedBytes);
    expect(
      Buffer.from(
        await fs.readlink(path.join(fixture.worktreePath, "seed-link"), { encoding: "buffer" }),
      ),
    ).toEqual(linkBytes);
    expect((await fs.stat(path.join(fixture.worktreePath, "seed.txt"))).mode & 0o777).toBe(0o755);
    await expect(fs.stat(path.join(fixture.worktreePath, "delete-me.txt"))).rejects.toBeDefined();
    expect(await fs.readFile(fixture.untrackedPath)).toEqual(untrackedBytes);
    expect(await refValue(fixture.repositoryRoot, result.evidence.recoveryRef)).toBe(
      fixture.legacyHead,
    );

    await fs.writeFile(fixture.untrackedPath, "caller mutation");
    const postTransitionPath = path.join(fixture.worktreePath, "new-during-install.txt");
    await fs.writeFile(postTransitionPath, "remove on rollback\n");
    expect(await result.transaction.rollback()).toEqual({ status: "rolled-back", idempotent: false });
    expect(await result.transaction.rollback()).toEqual({ status: "rolled-back", idempotent: true });
    expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(fixture.legacyHead);
    expect((await fs.readFile(fixture.indexPath)).toString("hex")).toBe(fixture.indexHex);
    expect(await fs.readFile(path.join(fixture.worktreePath, "seed.txt"))).toEqual(seedBytes);
    expect(
      Buffer.from(
        await fs.readlink(path.join(fixture.worktreePath, "seed-link"), { encoding: "buffer" }),
      ),
    ).toEqual(linkBytes);
    expect(await fs.readFile(fixture.untrackedPath)).toEqual(untrackedBytes);
    await expect(fs.stat(postTransitionPath)).rejects.toBeDefined();
    expect(await refValue(fixture.repositoryRoot, result.evidence.recoveryRef)).toBeNull();
    expect(await refValue(fixture.repositoryRoot, result.evidence.candidateRef)).toBeNull();
  });

  it("replays the same linear commits to the same candidate across wall-clock seconds", async () => {
    const fixture = await seedSimpleLegacy("t2050-deterministic-replay-");
    const first = await beginLegacyWorktreeReconciliation(
      simpleRequest(fixture, "deterministic-first"),
      { managerLock, activityFence: stableActivity },
    );
    expect(first.status).toBe("reconciled");
    if (first.status !== "reconciled") return;
    const firstCandidate = first.evidence.candidateHead;
    await first.transaction.rollback();

    await delay(1_100);
    const second = await beginLegacyWorktreeReconciliation(
      simpleRequest(fixture, "deterministic-second"),
      { managerLock, activityFence: stableActivity },
    );
    expect(second.status).toBe("reconciled");
    if (second.status !== "reconciled") return;
    expect(second.evidence.candidateHead).toBe(firstCandidate);
    await second.transaction.rollback();
  });

  it("refuses a divergent merge before creating reconciliation refs", async () => {
    const seeded = await seedRepository("t2050-merge-");
    await git(seeded.repositoryRoot, ["switch", "-q", "-c", "implement/T2050"]);
    await fs.writeFile(path.join(seeded.repositoryRoot, "legacy.txt"), "legacy\n");
    await git(seeded.repositoryRoot, ["add", "."]);
    await git(seeded.repositoryRoot, ["commit", "-q", "-m", "legacy"]);
    await git(seeded.repositoryRoot, ["switch", "-q", "-c", "merge-side", seeded.rootCommit]);
    await fs.writeFile(path.join(seeded.repositoryRoot, "side.txt"), "side\n");
    await git(seeded.repositoryRoot, ["add", "."]);
    await git(seeded.repositoryRoot, ["commit", "-q", "-m", "side"]);
    await git(seeded.repositoryRoot, ["switch", "-q", "implement/T2050"]);
    await git(seeded.repositoryRoot, ["merge", "--no-ff", "-m", "merge side", "merge-side"]);
    const legacyHead = await git(seeded.repositoryRoot, ["rev-parse", "HEAD"]);
    await git(seeded.repositoryRoot, ["switch", "-q", "main"]);
    await fs.writeFile(path.join(seeded.repositoryRoot, "base.txt"), "base\n");
    await git(seeded.repositoryRoot, ["add", "."]);
    await git(seeded.repositoryRoot, ["commit", "-q", "-m", "base"]);
    const baseCommit = await git(seeded.repositoryRoot, ["rev-parse", "HEAD"]);
    await git(seeded.repositoryRoot, [
      "worktree",
      "add",
      "-q",
      seeded.worktreePath,
      "implement/T2050",
    ]);

    const result = await beginLegacyWorktreeReconciliation(
      {
        repositoryRoot: seeded.repositoryRoot,
        worktreePath: seeded.worktreePath,
        branch: "implement/T2050",
        baseCommit,
        expectedHead: legacyHead,
        transactionId: "divergent-merge",
        journalDirectory: seeded.journalDirectory,
      },
      { managerLock, activityFence: stableActivity },
    );
    expect(result).toMatchObject({ status: "refused", reason: "divergent-merge", restored: true });
    expect(await git(seeded.worktreePath, ["rev-parse", "HEAD"])).toBe(legacyHead);
    expect(await refValue(seeded.repositoryRoot, "refs/cq-managed-recovery/legacy/divergent-merge")).toBeNull();
  });

  it("aborts an off-path replay conflict without mutating the legacy branch or overlay", async () => {
    const seeded = await seedRepository("t2050-conflict-");
    await git(seeded.repositoryRoot, ["switch", "-q", "-c", "implement/T2050"]);
    await fs.writeFile(path.join(seeded.repositoryRoot, "seed.txt"), "legacy value\n");
    await git(seeded.repositoryRoot, ["add", "."]);
    await git(seeded.repositoryRoot, ["commit", "-q", "-m", "legacy value"]);
    const legacyHead = await git(seeded.repositoryRoot, ["rev-parse", "HEAD"]);
    await git(seeded.repositoryRoot, ["switch", "-q", "main"]);
    await fs.writeFile(path.join(seeded.repositoryRoot, "seed.txt"), "upstream value\n");
    await git(seeded.repositoryRoot, ["add", "."]);
    await git(seeded.repositoryRoot, ["commit", "-q", "-m", "upstream value"]);
    const baseCommit = await git(seeded.repositoryRoot, ["rev-parse", "HEAD"]);
    await git(seeded.repositoryRoot, [
      "worktree",
      "add",
      "-q",
      seeded.worktreePath,
      "implement/T2050",
    ]);
    const deliverable = path.join(seeded.worktreePath, "deliverable.bin");
    await fs.writeFile(deliverable, Buffer.from([1, 0, 255]));
    const before = await fs.readFile(deliverable);

    const result = await beginLegacyWorktreeReconciliation(
      {
        repositoryRoot: seeded.repositoryRoot,
        worktreePath: seeded.worktreePath,
        branch: "implement/T2050",
        baseCommit,
        expectedHead: legacyHead,
        transactionId: "replay-conflict",
        journalDirectory: seeded.journalDirectory,
      },
      { managerLock, activityFence: stableActivity },
    );
    expect(result).toMatchObject({ status: "refused", reason: "replay-conflict", restored: true });
    expect(await git(seeded.worktreePath, ["rev-parse", "HEAD"])).toBe(legacyHead);
    expect(await fs.readFile(deliverable)).toEqual(before);
    expect(await refValue(seeded.repositoryRoot, "refs/cq-managed-recovery/legacy/replay-conflict")).toBeNull();
  });

  it("refuses unrelated history as unresolvable without mutation", async () => {
    const seeded = await seedRepository("t2050-unrelated-");
    await git(seeded.repositoryRoot, ["switch", "-q", "-c", "implement/T2050"]);
    await fs.writeFile(path.join(seeded.repositoryRoot, "legacy.txt"), "legacy\n");
    await git(seeded.repositoryRoot, ["add", "."]);
    await git(seeded.repositoryRoot, ["commit", "-q", "-m", "legacy"]);
    const legacyHead = await git(seeded.repositoryRoot, ["rev-parse", "HEAD"]);
    await git(seeded.repositoryRoot, ["switch", "--orphan", "unrelated"]);
    await fs.rm(path.join(seeded.repositoryRoot, "seed.txt"), { force: true });
    await fs.rm(path.join(seeded.repositoryRoot, "delete-me.txt"), { force: true });
    await fs.rm(path.join(seeded.repositoryRoot, "seed-link"), { force: true });
    await fs.rm(path.join(seeded.repositoryRoot, "legacy.txt"), { force: true });
    await fs.writeFile(path.join(seeded.repositoryRoot, "unrelated.txt"), "unrelated\n");
    await git(seeded.repositoryRoot, ["add", "."]);
    await git(seeded.repositoryRoot, ["commit", "-q", "-m", "unrelated"]);
    const baseCommit = await git(seeded.repositoryRoot, ["rev-parse", "HEAD"]);
    await git(seeded.repositoryRoot, [
      "worktree",
      "add",
      "-q",
      seeded.worktreePath,
      "implement/T2050",
    ]);

    const result = await beginLegacyWorktreeReconciliation(
      {
        repositoryRoot: seeded.repositoryRoot,
        worktreePath: seeded.worktreePath,
        branch: "implement/T2050",
        baseCommit,
        expectedHead: legacyHead,
        transactionId: "unrelated-history",
        journalDirectory: seeded.journalDirectory,
      },
      { managerLock, activityFence: stableActivity },
    );
    expect(result).toMatchObject({ status: "refused", reason: "history-unresolvable", restored: true });
    expect(await git(seeded.worktreePath, ["rev-parse", "HEAD"])).toBe(legacyHead);
  });
});

describe("legacy reconciliation fences and recovery", () => {
  const raceCases = [
    { name: "capture", boundary: "after-capture" },
    {
      name: "durable-journal",
      boundary: "after-journal-durable",
    },
    { name: "transition", boundary: "after-candidate-overlay" },
  ] as const;

  for (const race of raceCases) {
    it(`refuses an overlay race at ${race.name} before source mutation`, async () => {
      const fixture = await seedSimpleLegacy(`t2050-race-${race.name}-`);
      const deliverable = path.join(fixture.worktreePath, "deliverable.bin");
      await fs.writeFile(deliverable, Buffer.from([0, 1, 255]));
      const sourceMutations: string[] = [];
      const recordingGit: LegacyReconciliationGitRunner = async (cwd, args, environment) => {
        if (
          (cwd === fixture.repositoryRoot || cwd === fixture.worktreePath) &&
          (["update-ref", "fetch", "clean", "reset"].includes(args[0]!))
        ) {
          sourceMutations.push(`${cwd}:${args.join(" ")}`);
        }
        return nodeLegacyReconciliationGitRunner(cwd, args, environment);
      };
      let lockHeld = false;
      const lock: LegacyWorktreeManagerLock = {
        async acquire() {
          expect(lockHeld).toBe(false);
          lockHeld = true;
          return async () => {
            lockHeld = false;
          };
        },
      };
      const result = await beginLegacyWorktreeReconciliation(simpleRequest(fixture, `race-${race.name}`), {
        managerLock: lock,
        activityFence: fileContentActivity(deliverable),
        git: recordingGit,
        faultInjector: async (boundary) => {
          if (boundary === race.boundary) {
            await fs.writeFile(deliverable, `external ${race.name} mutation\n`);
          }
        },
      });

      expect(result).toMatchObject({ status: "refused", reason: "activity-changed", restored: true });
      expect(sourceMutations).toEqual([]);
      expect(lockHeld).toBe(false);
      expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(fixture.legacyHead);
      expect(await refValue(fixture.repositoryRoot, `refs/cq-managed-recovery/legacy/race-${race.name}`)).toBeNull();
    });
  }

  it("refuses live dispatch, lease, and process ownership while the manager lock is held", async () => {
    const fixture = await seedSimpleLegacy("t2050-live-owners-");
    let lockHeld = false;
    let releases = 0;
    const lock: LegacyWorktreeManagerLock = {
      async acquire() {
        lockHeld = true;
        return async () => {
          releases += 1;
          lockHeld = false;
        };
      },
    };
    const fence: LegacyWorktreeActivityFence = {
      async observe() {
        expect(lockHeld).toBe(true);
        return activity("epoch-live", "content-live", {
          liveDispatches: ["dispatch-1"],
          liveLeases: ["lease-1"],
          liveProcesses: ["pid-123"],
        });
      },
    };
    const result = await beginLegacyWorktreeReconciliation(
      simpleRequest(fixture, "live-owners"),
      { managerLock: lock, activityFence: fence },
    );
    expect(result).toMatchObject({ status: "refused", reason: "activity-live", restored: true });
    expect(releases).toBe(1);
    expect(lockHeld).toBe(false);
  });

  for (const boundary of [
    "before-first-mutation",
    "after-candidate-import",
    "after-recovery-ref",
    "after-head-cas",
    "after-reset",
    "after-overlay-restore",
    "after-reconciled-journal",
  ] satisfies readonly LegacyReconciliationFaultBoundary[]) {
    it(`restores bounded source state after a caught ${boundary} fault`, async () => {
      const fixture = await seedSimpleLegacy(`t2050-fault-${boundary}-`);
      const deliverable = path.join(fixture.worktreePath, "deliverable.bin");
      const bytes = Buffer.from([0, 255, 42, 10]);
      await fs.writeFile(deliverable, bytes);
      const rawIndexPath = await git(fixture.worktreePath, ["rev-parse", "--git-path", "index"]);
      const indexPath = path.isAbsolute(rawIndexPath)
        ? rawIndexPath
        : path.resolve(fixture.worktreePath, rawIndexPath);
      const indexBytes = await fs.readFile(indexPath);
      const transactionId = `fault-${boundary}`;
      const result = await beginLegacyWorktreeReconciliation(simpleRequest(fixture, transactionId), {
        managerLock,
        activityFence: stableActivity,
        faultInjector: (observed) => {
          if (observed === boundary) throw new Error(`injected ${boundary}`);
        },
      });

      expect(result).toMatchObject({ status: "refused", reason: "transition-failed", restored: true });
      expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(fixture.legacyHead);
      expect(await fs.readFile(indexPath)).toEqual(indexBytes);
      expect(await fs.readFile(deliverable)).toEqual(bytes);
      expect(await refValue(fixture.repositoryRoot, `refs/cq-managed-recovery/legacy/${transactionId}`)).toBeNull();
      expect(await refValue(fixture.repositoryRoot, `refs/cq-managed-candidates/legacy/${transactionId}`)).toBeNull();
    });
  }

  it("recovers an interrupted reconciled journal exactly once and repeats idempotently", async () => {
    const fixture = await seedSimpleLegacy("t2050-restart-");
    const deliverable = path.join(fixture.worktreePath, "deliverable.bin");
    const bytes = Buffer.from([9, 8, 0, 255]);
    await fs.writeFile(deliverable, bytes);
    const result = await beginLegacyWorktreeReconciliation(simpleRequest(fixture, "restart-recovery"), {
      managerLock,
      activityFence: stableActivity,
    });
    expect(result.status).toBe("reconciled");
    if (result.status !== "reconciled") return;
    expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(
      result.evidence.candidateHead,
    );

    const recoveryRequest = {
      transactionId: "restart-recovery",
      journalDirectory: fixture.journalDirectory,
    } as const;
    const recovered = await recoverLegacyWorktreeReconciliation(recoveryRequest, {
      managerLock,
      activityFence: stableActivity,
    });
    expect(recovered).toEqual({ status: "recovered", outcome: "rolled-back", idempotent: false });
    expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(fixture.legacyHead);
    expect(await fs.readFile(deliverable)).toEqual(bytes);
    expect(await refValue(fixture.repositoryRoot, result.evidence.recoveryRef)).toBeNull();
    expect(await refValue(fixture.repositoryRoot, result.evidence.candidateRef)).toBeNull();

    expect(
      await recoverLegacyWorktreeReconciliation(recoveryRequest, {
        managerLock,
        activityFence: stableActivity,
      }),
    ).toEqual({ status: "recovered", outcome: "rolled-back", idempotent: true });
  });

  it("uses the restored legacy-state activity baseline for a repeated real-Git rollback recovery", async () => {
    const fixture = await seedSimpleLegacy("t2050-restart-real-git-");
    const fence = createGitLegacyWorktreeActivityFence();
    const result = await beginLegacyWorktreeReconciliation(simpleRequest(fixture, "restart-real-git"), {
      managerLock,
      activityFence: fence,
    });
    expect(result.status).toBe("reconciled");
    if (result.status !== "reconciled") return;

    const recoveryRequest = {
      transactionId: "restart-real-git",
      journalDirectory: fixture.journalDirectory,
    } as const;
    expect(
      await recoverLegacyWorktreeReconciliation(recoveryRequest, {
        managerLock,
        activityFence: fence,
      }),
    ).toEqual({ status: "recovered", outcome: "rolled-back", idempotent: false });
    expect(
      await recoverLegacyWorktreeReconciliation(recoveryRequest, {
        managerLock,
        activityFence: fence,
      }),
    ).toEqual({ status: "recovered", outcome: "rolled-back", idempotent: true });
  });

  it("refuses restart restoration when activity differs from the journal-persisted capture", async () => {
    const fixture = await seedSimpleLegacy("t2050-restart-fence-");
    const result = await beginLegacyWorktreeReconciliation(
      simpleRequest(fixture, "restart-fence"),
      {
        managerLock,
        activityFence: scriptedActivity([
          activity("captured-epoch", "captured-bytes"),
          activity("captured-epoch", "captured-bytes"),
          activity("captured-epoch", "captured-bytes"),
        ]),
      },
    );
    expect(result.status).toBe("reconciled");
    if (result.status !== "reconciled") return;

    expect(
      await recoverLegacyWorktreeReconciliation(
        { transactionId: "restart-fence", journalDirectory: fixture.journalDirectory },
        {
          managerLock,
          activityFence: scriptedActivity([
            activity("later-epoch", "later-bytes"),
            activity("later-epoch", "later-bytes"),
          ]),
        },
      ),
    ).toMatchObject({ status: "refused", reason: "activity-changed" });
    expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(
      result.evidence.candidateHead,
    );
    expect(await refValue(fixture.repositoryRoot, result.evidence.recoveryRef)).toBe(
      fixture.legacyHead,
    );
    await result.transaction.rollback();
  });

  for (const terminalBoundary of ["before-commit", "before-rollback"] as const) {
    it(`restores before surfacing a caught ${terminalBoundary} fault`, async () => {
      const fixture = await seedSimpleLegacy(`t2050-terminal-${terminalBoundary}-`);
      const deliverable = path.join(fixture.worktreePath, "deliverable.bin");
      const bytes = Buffer.from([7, 0, 255]);
      await fs.writeFile(deliverable, bytes);
      let held = false;
      const lock: LegacyWorktreeManagerLock = {
        async acquire() {
          expect(held).toBe(false);
          held = true;
          return async () => {
            held = false;
          };
        },
      };
      const result = await beginLegacyWorktreeReconciliation(
        simpleRequest(fixture, `terminal-${terminalBoundary}`),
        {
          managerLock: lock,
          activityFence: stableActivity,
          faultInjector: (boundary) => {
            if (boundary === terminalBoundary) throw new Error(`injected ${terminalBoundary}`);
          },
        },
      );
      expect(result.status).toBe("reconciled");
      if (result.status !== "reconciled") return;
      expect(held).toBe(true);
      if (terminalBoundary === "before-commit") {
        await expect(result.transaction.commit()).rejects.toThrow("injected before-commit");
      } else {
        await expect(result.transaction.rollback()).rejects.toThrow("injected before-rollback");
      }
      expect(held).toBe(false);
      expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(fixture.legacyHead);
      expect(await fs.readFile(deliverable)).toEqual(bytes);
      expect(await result.transaction.rollback()).toEqual({ status: "rolled-back", idempotent: true });
      expect(await refValue(fixture.repositoryRoot, result.evidence.recoveryRef)).toBeNull();
      expect(await refValue(fixture.repositoryRoot, result.evidence.candidateRef)).toBeNull();
    });
  }

  it("refuses a corrupt restart journal before following any stored path or ref", async () => {
    const fixture = await seedSimpleLegacy("t2050-corrupt-journal-");
    const result = await beginLegacyWorktreeReconciliation(
      simpleRequest(fixture, "corrupt-journal"),
      { managerLock, activityFence: stableActivity },
    );
    expect(result.status).toBe("reconciled");
    if (result.status !== "reconciled") return;
    const parsed = JSON.parse(await fs.readFile(result.evidence.journalPath, "utf8")) as {
      overlaySha256: string;
    };
    parsed.overlaySha256 = "0".repeat(64);
    await fs.writeFile(result.evidence.journalPath, `${JSON.stringify(parsed)}\n`);
    expect(
      await recoverLegacyWorktreeReconciliation(
        { transactionId: "corrupt-journal", journalDirectory: fixture.journalDirectory },
        { managerLock, activityFence: stableActivity },
      ),
    ).toMatchObject({ status: "refused", reason: "journal-invalid" });
    expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(
      result.evidence.candidateHead,
    );
    await result.transaction.rollback();
  });

  it("refuses a missing base object before journal or ref mutation", async () => {
    const fixture = await seedSimpleLegacy("t2050-missing-object-");
    const result = await beginLegacyWorktreeReconciliation(
      { ...simpleRequest(fixture, "missing-object"), baseCommit: "f".repeat(40) },
      { managerLock, activityFence: stableActivity },
    );
    expect(result).toMatchObject({ status: "refused", reason: "history-unresolvable", restored: true });
    expect(await git(fixture.worktreePath, ["rev-parse", "HEAD"])).toBe(fixture.legacyHead);
    expect(await refValue(fixture.repositoryRoot, "refs/cq-managed-recovery/legacy/missing-object")).toBeNull();
  });
});
