/**
 * T1973 — Git-object fault / denial cases for the guarded generic-mutation gateway.
 *
 * Object and ref failures leave the prior orphan tip authoritative. Excluded
 * and sealed mutations fail before any ref advance. Raw primitives stay internal.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  createGitObjectWorksetManagementLedger,
  WorksetGenericMutationError,
  WorksetAdmissionError,
  GitPlumbing,
  nodeGitRunner,
  serializeWorksetRootsDocument,
  WORKSET_OWNER_REF_FIELD,
  TASKS_LEDGER,
  MILESTONES_LEDGER,
  type GitRunner,
  type WorksetGuardedLedger,
} from "../src/index.js";
import { WORKSET_ROOTS_FILENAME } from "../src/store/ledgerArtifacts.js";

const exec = promisify(execFile);
const BRANCH = "cq-ledger";
const REF = `refs/heads/${BRANCH}`;
const ORCHESTRATION_WAIT_MS = 120_000;

const repos: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function seedRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "workset-gmut-git-fault-"));
  repos.push(dir);
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "test");
  await git(dir, "config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(dir, "src.txt"), "x\n");
  await git(dir, "add", "src.txt");
  await git(dir, "commit", "-q", "-m", "main: initial");
  return dir;
}

async function buildGitGuarded(
  options: Parameters<typeof createGitObjectWorksetManagementLedger>[0],
): Promise<WorksetGuardedLedger> {
  return createGitObjectWorksetManagementLedger(options);
}

async function readRefSha(repoRoot: string): Promise<string | null> {
  const plumbing = GitPlumbing.withCwd(repoRoot, path.join(repoRoot, ".git"));
  return plumbing.readRef(REF);
}

afterAll(async () => {
  for (const d of repos) await fs.rm(d, { recursive: true, force: true });
});

describe("workset generic-mutation git-object faults [T1973]", () => {
  it(
    "target-excluded fails before ref advance and preserves item bytes",
    async () => {
      const dir = await seedRepo();
      const ledger = await buildGitGuarded({ repoRoot: dir });
      await ledger.init();
      try {
        const m = await ledger.mutations.createMilestone({ title: "ex-m" });
        const taskIn = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
          status: "planned",
          fields: { headline: "in" },
        });
        const taskOut = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
          status: "planned",
          fields: { headline: "out" },
        });
        await ledger.setRoots([`${TASKS_LEDGER}:${taskIn.id}`]);
        const tipBefore = await readRefSha(dir);
        const before = ledger.fetchItem(TASKS_LEDGER, taskOut.id);
        try {
          await ledger.mutations.updateItem(TASKS_LEDGER, taskOut.id, {
            status: "wip",
          });
          throw new Error("expected target-excluded");
        } catch (error) {
          expect(error).toBeInstanceOf(WorksetGenericMutationError);
          expect((error as WorksetGenericMutationError).code).toBe(
            "target-excluded",
          );
        }
        expect(ledger.fetchItem(TASKS_LEDGER, taskOut.id)).toEqual(before);
        expect(await readRefSha(dir)).toBe(tipBefore);
      } finally {
        await ledger.dispose();
      }
    },
    ORCHESTRATION_WAIT_MS,
  );

  it(
    "creation-denied and sealed-ownership leave counters and tip unchanged",
    async () => {
      const dir = await seedRepo();
      const ledger = await buildGitGuarded({ repoRoot: dir });
      await ledger.init();
      try {
        const m = await ledger.mutations.createMilestone({ title: "deny-m" });
        const t = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
          status: "planned",
          fields: { headline: "t" },
        });
        await ledger.setRoots([`${TASKS_LEDGER}:${t.id}`]);
        const tipBefore = await readRefSha(dir);
        const beforeCount = ledger.fetch(TASKS_LEDGER).counters.item;
        const beforeItem = ledger.fetchItem(TASKS_LEDGER, t.id);

        try {
          await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
            status: "planned",
            fields: { headline: "nope" },
          });
          throw new Error("expected creation-denied");
        } catch (error) {
          expect(error).toBeInstanceOf(WorksetGenericMutationError);
          expect((error as WorksetGenericMutationError).code).toBe(
            "creation-denied",
          );
        }
        try {
          await ledger.mutations.updateItem(TASKS_LEDGER, t.id, {
            fields: { [WORKSET_OWNER_REF_FIELD]: "goals:G1" },
          });
          throw new Error("expected sealed-ownership");
        } catch (error) {
          expect(error).toBeInstanceOf(WorksetGenericMutationError);
          expect((error as WorksetGenericMutationError).code).toBe(
            "sealed-ownership",
          );
        }

        expect(ledger.fetch(TASKS_LEDGER).counters.item).toBe(beforeCount);
        expect(ledger.fetchItem(TASKS_LEDGER, t.id)).toEqual(beforeItem);
        expect(await readRefSha(dir)).toBe(tipBefore);
      } finally {
        await ledger.dispose();
      }
    },
    ORCHESTRATION_WAIT_MS,
  );

  it(
    "injected workset roots object failure leaves prior roots tip authoritative",
    async () => {
      const dir = await seedRepo();
      const ok = await buildGitGuarded({ repoRoot: dir });
      await ok.init();
      try {
        const m = await ok.mutations.createMilestone({ title: "fault-m" });
        const t = await ok.mutations.createItem(TASKS_LEDGER, m.id, {
          status: "planned",
          fields: { headline: "t" },
        });
        await ok.setRoots([`${TASKS_LEDGER}:${t.id}`]);
        const priorRoots = await ok.snapshotRoots();
        expect(priorRoots).toEqual({
          roots: [`${TASKS_LEDGER}:${t.id}`],
          epoch: 1,
        });
        await ok.dispose();

        const broken = await buildGitGuarded({
          repoRoot: dir,
          commitRoots: async () => {
            throw new Error("injected object write failure");
          },
        });
        await broken.init();
        try {
          await broken.setRoots([]);
          throw new Error("expected invalid-replacement");
        } catch (error) {
          expect(error).toBeInstanceOf(WorksetAdmissionError);
          expect((error as WorksetAdmissionError).code).toBe(
            "invalid-replacement",
          );
        }
        expect(await broken.snapshotRoots()).toEqual(priorRoots);
        await broken.dispose();
      } finally {
        // ok already disposed above
      }
    },
    ORCHESTRATION_WAIT_MS,
  );

  it(
    "losing workset CAS reports stale-epoch and leaves peer tip authoritative",
    async () => {
      const dir = await seedRepo();
      const seed = await buildGitGuarded({ repoRoot: dir });
      await seed.init();
      const m = await seed.mutations.createMilestone({ title: "cas-m" });
      const tLocal = await seed.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "local" },
      });
      const tPeer = await seed.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "peer" },
      });
      await seed.dispose();

      const store = await buildGitGuarded({
        repoRoot: dir,
        commitRoots: async (next, defaultCommit) => {
          const plumbing = GitPlumbing.withCwd(dir, path.join(dir, ".git"));
          const peer = {
            roots: [`${TASKS_LEDGER}:${tPeer.id}`],
            epoch: next.epoch,
          };
          const text = serializeWorksetRootsDocument(peer);
          const expectedOld = await plumbing.readRef(REF);
          const blob = await plumbing.hashObject(text);
          const current =
            expectedOld === null ? [] : await plumbing.lsTreeEntries(REF);
          const kept = current.filter((e) => e.path !== WORKSET_ROOTS_FILENAME);
          kept.push({ mode: "100644", sha: blob, path: WORKSET_ROOTS_FILENAME });
          const tree = await plumbing.writeTree(kept);
          const commit = await plumbing.commitTree(
            tree,
            expectedOld,
            "peer: win CAS",
          );
          await plumbing.updateRef(REF, commit, expectedOld);
          await defaultCommit(next);
        },
      });
      await store.init();
      try {
        try {
          await store.setRoots([`${TASKS_LEDGER}:${tLocal.id}`]);
          throw new Error("expected stale-epoch");
        } catch (error) {
          expect(error).toBeInstanceOf(WorksetAdmissionError);
          expect((error as WorksetAdmissionError).code).toBe("stale-epoch");
        }
        expect(await store.snapshotRoots()).toEqual({
          roots: [`${TASKS_LEDGER}:${tPeer.id}`],
          epoch: 1,
        });
      } finally {
        await store.dispose();
      }
    },
    ORCHESTRATION_WAIT_MS,
  );

  it(
    "injected GitPlumbing hash-object failure aborts a mutation without advancing the tip",
    async () => {
      const dir = await seedRepo();
      // First build a healthy graph with the real plumbing.
      const seed = await buildGitGuarded({ repoRoot: dir });
      await seed.init();
      const m = await seed.mutations.createMilestone({ title: "obj-m" });
      const t = await seed.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "t" },
      });
      await seed.setRoots([`${TASKS_LEDGER}:${t.id}`]);
      const tipBefore = await readRefSha(dir);
      const before = seed.fetchItem(TASKS_LEDGER, t.id);
      await seed.dispose();

      const baseRunner = nodeGitRunner(dir);
      let failHash = false;
      const runner: GitRunner = async (args, opts) => {
        if (failHash && args[0] === "hash-object") {
          return { code: 1, stdout: "", stderr: "injected hash-object failure" };
        }
        return baseRunner(args, opts);
      };
      const sabotaged = new GitPlumbing({
        runner,
        scratchDir: path.join(dir, ".git"),
      });

      const broken = await buildGitGuarded({ repoRoot: dir, git: sabotaged });
      await broken.init();
      try {
        failHash = true;
        try {
          await broken.mutations.updateItem(TASKS_LEDGER, t.id, {
            status: "wip",
          });
          throw new Error("expected mutation failure");
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          // Must not be a silent success path.
          expect(String((error as Error).message).length).toBeGreaterThan(0);
        }
        expect(await readRefSha(dir)).toBe(tipBefore);

        // Fresh reader still sees the prior admitted graph.
        const reader = await buildGitGuarded({ repoRoot: dir });
        await reader.init();
        try {
          expect(reader.fetchItem(TASKS_LEDGER, t.id)).toEqual(before);
          expect(await reader.snapshotRoots()).toEqual({
            roots: [`${TASKS_LEDGER}:${t.id}`],
            epoch: 1,
          });
        } finally {
          await reader.dispose();
        }
      } finally {
        await broken.dispose();
      }
    },
    ORCHESTRATION_WAIT_MS,
  );

  it(
    "raw write methods remain absent on the public surface after durable init",
    async () => {
      const dir = await seedRepo();
      const ledger = await buildGitGuarded({ repoRoot: dir });
      await ledger.init();
      try {
        for (const method of [
          "updateItem",
          "createItem",
          "createMilestone",
          "archiveMilestone",
          "unarchiveItem",
          "reopenItem",
          "createLedger",
          "updateMilestone",
        ] as const) {
          expect(
            typeof (ledger as unknown as Record<string, unknown>)[method],
          ).not.toBe("function");
        }
        expect(ledger.mutations.form).toBe("workset-generic-mutation-gateway");
        // Milestone ledger must exist after init (canonical bootstrap).
        expect(ledger.enumerate()).toContain(MILESTONES_LEDGER);
      } finally {
        await ledger.dispose();
      }
    },
    ORCHESTRATION_WAIT_MS,
  );
});
