/**
 * T1956 — effect admission on the Git-object WorksetStore.
 *
 * Focused Effectual Good-Communication cases beyond the shared Blackbox
 * contract: cross-store set waits for published leases, crash reclaim of dead
 * holders, set/effect races under durable leases, and settlement-before-reclaim.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  WorksetAdmissionError,
  createGitObjectWorksetStore,
  readWorksetRootsEpoch,
  type WorksetStore,
} from "../src/index.js";

const exec = promisify(execFile);

const repos: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function seedRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "workset-adm-git-"));
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

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterAll(async () => {
  for (const d of repos) await fs.rm(d, { recursive: true, force: true });
});

describe("workset effect admission git-object [T1956]", () => {
  it("set on a peer store waits for a live published admission lease", async () => {
    const dir = await seedRepo();
    const holder = await createGitObjectWorksetStore({ repoRoot: dir });
    const peer = await createGitObjectWorksetStore({ repoRoot: dir });

    const admission = await holder.admitExternalEffect({
      kind: "rebase",
      targetRef: "tasks:T-hold",
    });
    expect(holder.activeAdmissionCount()).toBe(1);

    let peerDone = false;
    const setPromise = peer.setRoots(["goals:G1"]).then((snap) => {
      peerDone = true;
      return snap;
    });
    // Give the peer a turn to reach the lease wait.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 50));
    expect(peerDone).toBe(false);

    admission.registerProcessGroup({ pgid: 4242, leaderPid: 4242 });
    admission.markSettled();
    await admission.releaseAfterSettlement();

    const snap = await setPromise;
    expect(snap).toEqual({ roots: ["goals:G1"], epoch: 1 });
    expect(await readWorksetRootsEpoch(holder)).toEqual(snap);
  });

  it("crash cleanup reclaims a dead ledger-mutation lease before exclusive set", async () => {
    const dir = await seedRepo();
    const locksDir = path.join(dir, ".cq", ".locks");
    const admissionsDir = path.join(locksDir, "workset-admissions");
    await fs.mkdir(admissionsDir, { recursive: true });
    // Synthetic dead-holder lease (pid that is not alive).
    const deadPid = 2_147_000_000;
    await fs.writeFile(
      path.join(admissionsDir, "lm-dead.json"),
      `${JSON.stringify({
        id: "lm-dead",
        form: "ledger-mutation",
        kind: "generic-write",
        epoch: 0,
        roots: [],
        targets: [],
        pid: deadPid,
        hostname: "test",
        startedAt: Date.now(),
      })}\n`,
      "utf8",
    );

    const store = await createGitObjectWorksetStore({
      repoRoot: dir,
      isPidAlive: (pid) => pid !== deadPid && pid === process.pid,
    });
    const snap = await store.setRoots(["goals:G-after-crash"]);
    expect(snap).toEqual({ roots: ["goals:G-after-crash"], epoch: 1 });
    // Lease file reclaimed.
    await expect(fs.stat(path.join(admissionsDir, "lm-dead.json"))).rejects.toBeDefined();
  });

  it("crash cleanup keeps a live external-effect process group blocking set", async () => {
    const dir = await seedRepo();
    const locksDir = path.join(dir, ".cq", ".locks");
    const admissionsDir = path.join(locksDir, "workset-admissions");
    await fs.mkdir(admissionsDir, { recursive: true });
    const deadHolderPid = 2_147_000_001;
    const livePgid = process.pid; // treat current process as still-running group
    await fs.writeFile(
      path.join(admissionsDir, "ee-live-pg.json"),
      `${JSON.stringify({
        id: "ee-live-pg",
        form: "external-effect",
        kind: "merge",
        epoch: 0,
        roots: [],
        targets: ["tasks:T1"],
        targetRef: "tasks:T1",
        pid: deadHolderPid,
        hostname: "test",
        startedAt: Date.now(),
        pgid: livePgid,
        settled: false,
      })}\n`,
      "utf8",
    );

    const store = await createGitObjectWorksetStore({
      repoRoot: dir,
      isPidAlive: (pid) => pid !== deadHolderPid,
      // Group liveness is kill(-pgid,0) — mock that separately (D296).
      isProcessGroupAlive: (pgid) => pgid === livePgid,
      // Bound the wait: use a short race then settle by flipping settled via file.
      sleep: async () => {
        /* spin without real delay in the poll body; test unblocks via file */
      },
    });

    // Unblock after a microtask chain by marking settled (crash cleanup path
    // that observed settlement evidence).
    const setPromise = store.setRoots(["goals:G-blocked"]);
    // Allow the waiter to observe the blocking lease at least once.
    await new Promise((r) => setTimeout(r, 20));
    const raw = await fs.readFile(path.join(admissionsDir, "ee-live-pg.json"), "utf8");
    const lease = JSON.parse(raw) as Record<string, unknown>;
    lease["settled"] = true;
    await fs.writeFile(
      path.join(admissionsDir, "ee-live-pg.json"),
      `${JSON.stringify(lease)}\n`,
      "utf8",
    );

    const snap = await setPromise;
    expect(snap.epoch).toBe(1);
  }, 15_000);

  it("in-process set waits for held external effect then commits (durable path)", async () => {
    const effectAck = deferred();
    const setSawEmpty = deferred();
    const dir = await seedRepo();
    const store = await createGitObjectWorksetStore({
      repoRoot: dir,
      hooks: {
        afterExclusiveReady: () => {
          setSawEmpty.resolve();
        },
      },
    });

    const effect = await store.admitExternalEffect({
      kind: "rebase",
      targetRef: "tasks:T9",
    });
    expect(store.activeAdmissionCount()).toBe(1);

    const setPromise = store.setRoots(["goals:G1"]);
    let setDone = false;
    void setPromise.then(() => {
      setDone = true;
    });
    await Promise.resolve();
    expect(setDone).toBe(false);
    expect(store.exclusiveHeld()).toBe(true);

    effect.registerProcessGroup({ pgid: 100, leaderPid: 100 });
    effect.markSettled();
    queueMicrotask(() => {
      void effect.releaseAfterSettlement().then(() => effectAck.resolve());
    });
    await effectAck.promise;
    await setSawEmpty.promise;
    const snap = await setPromise;
    expect(snap).toEqual({ roots: ["goals:G1"], epoch: 1 });
    expect(store.activeAdmissionCount()).toBe(0);
  });

  it("set-first ordering revokes a not-yet-admitted effect under durable store", async () => {
    const beforeGrant = deferred();
    const releaseGrant = deferred();
    const dir = await seedRepo();
    const store = await createGitObjectWorksetStore({
      repoRoot: dir,
      hooks: {
        beforeAdmissionGrant: async () => {
          beforeGrant.resolve();
          await releaseGrant.promise;
        },
      },
    });

    const effectPromise = store.admitExternalEffect({
      kind: "merge",
      targetRef: "tasks:T-old",
    });
    await beforeGrant.promise;

    const setPromise = store.setRoots(["goals:G-only"]);
    releaseGrant.resolve();
    try {
      await effectPromise;
      throw new Error("expected revoked");
    } catch (err) {
      expect(err).toBeInstanceOf(WorksetAdmissionError);
      expect((err as WorksetAdmissionError).code).toBe("revoked");
    }
    const snap = await setPromise;
    expect(snap).toEqual({ roots: ["goals:G-only"], epoch: 1 });
  });

  it("invalid replacement leaves durable tip unchanged", async () => {
    const dir = await seedRepo();
    const store = await createGitObjectWorksetStore({
      repoRoot: dir,
      validateReplacement: (roots) => {
        if (roots.includes("bad:ROOT")) {
          throw new WorksetAdmissionError(
            "invalid-replacement",
            "synthetic invalid member",
          );
        }
      },
    });
    await store.setRoots(["goals:G1"]);
    await expect(store.setRoots(["goals:G1", "bad:ROOT"])).rejects.toMatchObject({
      code: "invalid-replacement",
    });
    expect(await readWorksetRootsEpoch(store)).toEqual({
      roots: ["goals:G1"],
      epoch: 1,
    });
    // Fresh store sees the same tip.
    const reader = await createGitObjectWorksetStore({ repoRoot: dir });
    expect(await readWorksetRootsEpoch(reader)).toEqual({
      roots: ["goals:G1"],
      epoch: 1,
    });
  });

  it("cleanup-before-release still enforced on the durable store", async () => {
    const dir = await seedRepo();
    const store: WorksetStore = await createGitObjectWorksetStore({ repoRoot: dir });
    const admission = await store.admitExternalEffect({
      kind: "worktree-create",
      targetRef: "tasks:T1",
    });
    await expect(admission.releaseAfterSettlement()).rejects.toMatchObject({
      code: "admission-not-registered",
    });
    admission.registerProcessGroup({ pgid: 7, leaderPid: 7 });
    await expect(admission.releaseAfterSettlement()).rejects.toMatchObject({
      code: "process-group-not-settled",
    });
    admission.markSettled();
    await admission.releaseAfterSettlement();
    expect(store.activeAdmissionCount()).toBe(0);
  });
});
