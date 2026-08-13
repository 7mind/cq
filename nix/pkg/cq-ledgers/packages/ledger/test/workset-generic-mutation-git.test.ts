/**
 * T1973 — Git-object durable leg of the guarded generic-mutation dual-test pair.
 *
 * Runs the shared Behavioral-Active Blackbox contract unchanged against
 * {@link createGitObjectWorksetManagementLedger}, plus focused Effectual
 * Good-Communication cases: durable updates, closure refs, exact-root
 * unarchive, archive sweeps, competing writers, replacement races,
 * restart/ref reload, and watcher invalidation.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  createGitObjectWorksetManagementLedger,
  assertNoPublicRawWriteEscape,
  WorksetGenericMutationError,
  TASKS_LEDGER,
  MILESTONES_LEDGER,
  GitPlumbing,
  type WorksetGuardedLedger,
} from "../src/index.js";
import { runWorksetGenericMutationContract } from "./worksetGenericMutationContract.js";

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
  const dir = await fs.mkdtemp(path.join(tmpdir(), "workset-gmut-git-"));
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
  options: {
    readonly afterGenericAdmit?: () => Promise<void> | void;
    readonly hooks?: Parameters<typeof createGitObjectWorksetManagementLedger>[0]["hooks"];
    readonly now?: () => string;
    readonly onMutation?: Parameters<typeof createGitObjectWorksetManagementLedger>[0]["onMutation"];
    readonly repoRoot?: string;
  } = {},
): Promise<WorksetGuardedLedger> {
  const repoRoot = options.repoRoot ?? (await seedRepo());
  return createGitObjectWorksetManagementLedger({
    repoRoot,
    ...(options.afterGenericAdmit !== undefined
      ? { afterGenericAdmit: options.afterGenericAdmit }
      : {}),
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.onMutation !== undefined ? { onMutation: options.onMutation } : {}),
  });
}

async function readRefSha(repoRoot: string): Promise<string | null> {
  const plumbing = GitPlumbing.withCwd(repoRoot, path.join(repoRoot, ".git"));
  return plumbing.readRef(REF);
}

afterAll(async () => {
  for (const d of repos) await fs.rm(d, { recursive: true, force: true });
});

runWorksetGenericMutationContract({
  name: "git-object",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  timeoutMs: ORCHESTRATION_WAIT_MS,
  build: (options) =>
    buildGitGuarded({
      ...(options?.afterGenericAdmit !== undefined
        ? { afterGenericAdmit: options.afterGenericAdmit }
        : {}),
      ...(options?.hooks !== undefined ? { hooks: options.hooks } : {}),
      ...(options?.now !== undefined ? { now: options.now } : {}),
    }),
});

describe("workset generic-mutation git-object focused [T1973]", () => {
  it(
    "public surface freezes the gateway form and hides raw writes",
    async () => {
      const ledger = await buildGitGuarded();
      await ledger.init();
      assertNoPublicRawWriteEscape(ledger);
      expect(Object.isFrozen(ledger.mutations)).toBe(true);
      expect(ledger.mutations.form).toBe("workset-generic-mutation-gateway");
      await ledger.dispose();
    },
    ORCHESTRATION_WAIT_MS,
  );

  it(
    "durable in-graph update survives restart/ref reload",
    async () => {
      const dir = await seedRepo();
      const writer = await buildGitGuarded({ repoRoot: dir });
      await writer.init();
      const m = await writer.mutations.createMilestone({ title: "reload-m" });
      const t = await writer.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "reload-t" },
      });
      await writer.setRoots([`${TASKS_LEDGER}:${t.id}`]);
      const updated = await writer.mutations.updateItem(TASKS_LEDGER, t.id, {
        status: "wip",
        fields: { headline: "reload-t-updated" },
      });
      expect(updated.status).toBe("wip");
      const tipAfterWrite = await readRefSha(dir);
      expect(tipAfterWrite).not.toBeNull();
      await writer.dispose();

      const reader = await buildGitGuarded({ repoRoot: dir });
      await reader.init();
      try {
        expect(await readRefSha(dir)).toBe(tipAfterWrite);
        const item = reader.fetchItem(TASKS_LEDGER, t.id);
        expect(item.status).toBe("wip");
        expect(item.fields.headline).toBe("reload-t-updated");
        expect(await reader.snapshotRoots()).toEqual({
          roots: [`${TASKS_LEDGER}:${t.id}`],
          epoch: 1,
        });
      } finally {
        await reader.dispose();
      }
    },
    ORCHESTRATION_WAIT_MS,
  );

  it(
    "closure-forming dependsOn to admitted member persists; excluded ref denied before tip advance",
    async () => {
      const dir = await seedRepo();
      const ledger = await buildGitGuarded({ repoRoot: dir });
      await ledger.init();
      try {
        const m = await ledger.mutations.createMilestone({ title: "dep-m" });
        const a = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
          status: "planned",
          fields: { headline: "a" },
        });
        const b = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
          status: "planned",
          fields: { headline: "b", dependsOn: [`${TASKS_LEDGER}:${a.id}`] },
        });
        const out = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
          status: "planned",
          fields: { headline: "out" },
        });
        await ledger.setRoots([`${TASKS_LEDGER}:${b.id}`]);

        const ok = await ledger.mutations.updateItem(TASKS_LEDGER, b.id, {
          fields: { dependsOn: [`${TASKS_LEDGER}:${a.id}`], blockedBy: [] },
        });
        expect(ok.fields.dependsOn).toEqual([`${TASKS_LEDGER}:${a.id}`]);

        const tipBefore = await readRefSha(dir);
        const before = ledger.fetchItem(TASKS_LEDGER, b.id);
        try {
          await ledger.mutations.updateItem(TASKS_LEDGER, b.id, {
            fields: { dependsOn: [`${TASKS_LEDGER}:${out.id}`] },
          });
          throw new Error("expected introduced-ref-excluded");
        } catch (error) {
          expect(error).toBeInstanceOf(WorksetGenericMutationError);
          expect((error as WorksetGenericMutationError).code).toBe(
            "introduced-ref-excluded",
          );
        }
        expect(ledger.fetchItem(TASKS_LEDGER, b.id)).toEqual(before);
        expect(await readRefSha(dir)).toBe(tipBefore);
      } finally {
        await ledger.dispose();
      }
    },
    ORCHESTRATION_WAIT_MS,
  );

  it(
    "exact inactive-root unarchive recovers; non-root denied with tip unchanged",
    async () => {
      const dir = await seedRepo();
      const ledger = await buildGitGuarded({ repoRoot: dir });
      await ledger.init();
      try {
        const m = await ledger.mutations.createMilestone({ title: "arch-m" });
        const keep = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
          status: "done",
          fields: { headline: "keep-root" },
        });
        const other = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
          status: "done",
          fields: { headline: "other-archived" },
        });
        await ledger.mutations.updateMilestone(m.id, { status: "done" });
        await ledger.mutations.archiveMilestone(m.id, "seed archive");
        await ledger.setRoots([`${TASKS_LEDGER}:${keep.id}`]);

        const restored = await ledger.mutations.unarchiveItem(
          TASKS_LEDGER,
          m.id,
          keep.id,
        );
        expect(restored.id).toBe(keep.id);
        expect(ledger.fetchItem(TASKS_LEDGER, keep.id).id).toBe(keep.id);

        const tipBefore = await readRefSha(dir);
        try {
          await ledger.mutations.unarchiveItem(TASKS_LEDGER, m.id, other.id);
          throw new Error("expected unarchive-not-exact-inactive-root");
        } catch (error) {
          expect(error).toBeInstanceOf(WorksetGenericMutationError);
          expect((error as WorksetGenericMutationError).code).toBe(
            "unarchive-not-exact-inactive-root",
          );
        }
        expect(await readRefSha(dir)).toBe(tipBefore);
      } finally {
        await ledger.dispose();
      }
    },
    ORCHESTRATION_WAIT_MS,
  );

  it(
    "archive sweep incomplete fails before tip advance; full sweep commits one admitted state",
    async () => {
      const dir = await seedRepo();
      const ledger = await buildGitGuarded({ repoRoot: dir });
      await ledger.init();
      try {
        const m = await ledger.mutations.createMilestone({ title: "sweep-m" });
        const taskIn = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
          status: "done",
          fields: { headline: "in" },
        });
        const taskOut = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
          status: "done",
          fields: { headline: "out" },
        });
        await ledger.mutations.updateMilestone(m.id, { status: "done" });
        await ledger.setRoots([`${TASKS_LEDGER}:${taskIn.id}`]);

        const tipBefore = await readRefSha(dir);
        const beforeM = ledger.fetchItem(MILESTONES_LEDGER, m.id);
        try {
          await ledger.mutations.archiveMilestone(m.id, "should-fail");
          throw new Error("expected archive-sweep-incomplete");
        } catch (error) {
          expect(error).toBeInstanceOf(WorksetGenericMutationError);
          expect((error as WorksetGenericMutationError).code).toBe(
            "archive-sweep-incomplete",
          );
        }
        expect(ledger.fetchItem(MILESTONES_LEDGER, m.id)).toEqual(beforeM);
        expect(await readRefSha(dir)).toBe(tipBefore);

        await ledger.setRoots([
          `${MILESTONES_LEDGER}:${m.id}`,
          `${TASKS_LEDGER}:${taskIn.id}`,
          `${TASKS_LEDGER}:${taskOut.id}`,
        ]);
        const ptr = await ledger.mutations.archiveMilestone(m.id, "ok");
        expect(ptr.id).toBe(m.id);
        expect(await readRefSha(dir)).not.toBe(tipBefore);
      } finally {
        await ledger.dispose();
      }
    },
    ORCHESTRATION_WAIT_MS,
  );

  it(
    "competing writers over one repo preserve every admitted mutation on the tip",
    async () => {
      const dir = await seedRepo();
      const a = await buildGitGuarded({ repoRoot: dir });
      const b = await buildGitGuarded({ repoRoot: dir });
      await a.init();
      await b.init();
      try {
        const m = await a.mutations.createMilestone({ title: "race-m" });
        const t1 = await a.mutations.createItem(TASKS_LEDGER, m.id, {
          status: "planned",
          fields: { headline: "t1" },
        });
        const t2 = await b.mutations.createItem(TASKS_LEDGER, m.id, {
          status: "planned",
          fields: { headline: "t2" },
        });
        // Unrestricted empty roots for create; then each writer updates its task.
        await a.setRoots([
          `${TASKS_LEDGER}:${t1.id}`,
          `${TASKS_LEDGER}:${t2.id}`,
        ]);
        // Peer b must observe the new roots epoch from the ref tip.
        expect(await b.snapshotRoots()).toEqual({
          roots: [`${TASKS_LEDGER}:${t1.id}`, `${TASKS_LEDGER}:${t2.id}`],
          epoch: 1,
        });

        const u1 = await a.mutations.updateItem(TASKS_LEDGER, t1.id, {
          status: "wip",
          fields: { headline: "t1-a" },
        });
        const u2 = await b.mutations.updateItem(TASKS_LEDGER, t2.id, {
          status: "wip",
          fields: { headline: "t2-b" },
        });
        expect(u1.fields.headline).toBe("t1-a");
        expect(u2.fields.headline).toBe("t2-b");

        const reader = await buildGitGuarded({ repoRoot: dir });
        await reader.init();
        try {
          expect(reader.fetchItem(TASKS_LEDGER, t1.id).fields.headline).toBe("t1-a");
          expect(reader.fetchItem(TASKS_LEDGER, t2.id).fields.headline).toBe("t2-b");
        } finally {
          await reader.dispose();
        }
      } finally {
        await a.dispose();
        await b.dispose();
      }
    },
    ORCHESTRATION_WAIT_MS,
  );

  it(
    "replacement race: setRoots waits on in-flight mutation then new roots bind subsequent admits",
    async () => {
      const admitted = (() => {
        let resolve!: () => void;
        const promise = new Promise<void>((res) => {
          resolve = res;
        });
        return { promise, resolve };
      })();
      const releaseHold = (() => {
        let resolve!: () => void;
        const promise = new Promise<void>((res) => {
          resolve = res;
        });
        return { promise, resolve };
      })();
      let holdEnabled = false;
      const dir = await seedRepo();
      const ledger = await buildGitGuarded({
        repoRoot: dir,
        afterGenericAdmit: async () => {
          if (!holdEnabled) return;
          admitted.resolve();
          await releaseHold.promise;
        },
      });
      await ledger.init();
      try {
        const m = await ledger.mutations.createMilestone({ title: "replace-m" });
        const taskIn = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
          status: "planned",
          fields: { headline: "in" },
        });
        const taskOut = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
          status: "planned",
          fields: { headline: "out" },
        });
        await ledger.setRoots([
          `${TASKS_LEDGER}:${taskIn.id}`,
          `${TASKS_LEDGER}:${taskOut.id}`,
        ]);

        holdEnabled = true;
        const mutPromise = ledger.mutations.updateItem(TASKS_LEDGER, taskOut.id, {
          fields: { headline: "held-out" },
        });
        await admitted.promise;
        expect(ledger.activeAdmissionCount()).toBeGreaterThan(0);

        let setDone = false;
        const setPromise = ledger
          .setRoots([`${TASKS_LEDGER}:${taskIn.id}`])
          .then((snap) => {
            setDone = true;
            return snap;
          });
        await new Promise((r) => setTimeout(r, 30));
        expect(setDone).toBe(false);

        releaseHold.resolve();
        await mutPromise;
        const setSnap = await setPromise;
        expect(setSnap.roots).toEqual([`${TASKS_LEDGER}:${taskIn.id}`]);
        expect(ledger.activeAdmissionCount()).toBe(0);

        // After replacement, taskOut is excluded.
        const beforeOut = ledger.fetchItem(TASKS_LEDGER, taskOut.id);
        try {
          await ledger.mutations.updateItem(TASKS_LEDGER, taskOut.id, {
            status: "done",
          });
          throw new Error("expected target-excluded");
        } catch (error) {
          expect(error).toBeInstanceOf(WorksetGenericMutationError);
          expect((error as WorksetGenericMutationError).code).toBe("target-excluded");
        }
        expect(ledger.fetchItem(TASKS_LEDGER, taskOut.id)).toEqual(beforeOut);
        // In-graph target still writable.
        const ok = await ledger.mutations.updateItem(TASKS_LEDGER, taskIn.id, {
          status: "done",
        });
        expect(ok.status).toBe("done");
      } finally {
        await ledger.dispose();
      }
    },
    ORCHESTRATION_WAIT_MS,
  );

  it(
    "watcher invalidation: onMutation fires after admitted write; peer invalidate reloads tip",
    async () => {
      const dir = await seedRepo();
      const seen: Array<{ ledgerId: string; op: string }> = [];
      const writer = await buildGitGuarded({
        repoRoot: dir,
        onMutation: (ledgerId, op) => {
          seen.push({ ledgerId, op });
        },
      });
      await writer.init();
      try {
        const m = await writer.mutations.createMilestone({ title: "watch-m" });
        expect(seen.some((e) => e.ledgerId === MILESTONES_LEDGER)).toBe(true);

        const peer = await buildGitGuarded({ repoRoot: dir });
        await peer.init();
        try {
          // Peer already has m from init; writer adds a task then peer invalidates.
          const t = await writer.mutations.createItem(TASKS_LEDGER, m.id, {
            status: "planned",
            fields: { headline: "watched-t" },
          });
          expect(seen.some((e) => e.ledgerId === TASKS_LEDGER)).toBe(true);
          await peer.invalidate(TASKS_LEDGER);
          expect(peer.fetchItem(TASKS_LEDGER, t.id).fields.headline).toBe("watched-t");
        } finally {
          await peer.dispose();
        }
      } finally {
        await writer.dispose();
      }
    },
    ORCHESTRATION_WAIT_MS,
  );
});
