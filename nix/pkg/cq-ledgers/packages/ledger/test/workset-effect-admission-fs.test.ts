/**
 * T1955 — Behavioral-Active Effectual Good-Communication tests for the
 * filesystem workset admission adapter.
 *
 * Covers restart durability, complete-batch peer observations, stale-generation
 * revocation, peer coherence across independently constructed stores, broker
 * process-group death cleanup, set∥effect races, and write/rename failures
 * that must leave the prior roots document authoritative.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  WorksetAdmissionError,
  createFsWorksetStore,
  readWorksetRootsEpoch,
  type WorksetAdmissionErrorCode,
  type WorksetStore,
} from "../src/index.js";
import { atomicWrite } from "../src/store/fsAtomic.js";

const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

async function freshRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "workset-effect-fs-"));
  dirs.push(dir);
  return dir;
}

function openStore(
  root: string,
  extra: Parameters<typeof createFsWorksetStore>[0] extends infer O
    ? Omit<Extract<O, object>, "root">
    : never = {},
): WorksetStore {
  return createFsWorksetStore({ root, ...extra });
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

async function expectRejection(
  promise: Promise<unknown>,
  code: WorksetAdmissionErrorCode,
): Promise<WorksetAdmissionError> {
  try {
    await promise;
    throw new Error(`expected WorksetAdmissionError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(WorksetAdmissionError);
    const admissionError = error as WorksetAdmissionError;
    expect(admissionError.code).toBe(code);
    return admissionError;
  }
}

describe("workset effect admission filesystem [T1955]", () => {
  it("restart retains exact root order and epoch", async () => {
    const root = await freshRoot();
    const a = openStore(root);
    const committed = await a.setRoots(["goals:G1", "tasks:T2", "ideas:I3"]);
    expect(committed).toEqual({
      roots: ["goals:G1", "tasks:T2", "ideas:I3"],
      epoch: 1,
    });

    // Fresh process-equivalent: new store instance, no shared memory.
    const b = openStore(root);
    expect(await readWorksetRootsEpoch(b)).toEqual(committed);
    const again = await b.setRoots(["tasks:T9"]);
    expect(again).toEqual({ roots: ["tasks:T9"], epoch: 2 });

    const c = openStore(root);
    expect(await readWorksetRootsEpoch(c)).toEqual(again);
  });

  it("peer stores observe only complete root/epoch batches", async () => {
    const root = await freshRoot();
    const writer = openStore(root);
    const reader = openStore(root);

    const batches = [
      ["goals:G-a"],
      ["goals:G-a", "tasks:T-b"],
      ["ideas:I-only"],
      [],
    ] as const;

    for (let i = 0; i < batches.length; i++) {
      const committed = await writer.setRoots(batches[i]!);
      expect(committed.epoch).toBe(i + 1);
      const observed = await readWorksetRootsEpoch(reader);
      expect(observed).toEqual(committed);
      // Never a torn half: roots length and epoch always cohere with a submitted batch.
      expect(observed.roots).toEqual([...batches[i]!]);
    }
  });

  it("stale generation revokes a not-yet-granted admit (set-first)", async () => {
    const root = await freshRoot();
    const beforeGrant = deferred();
    const releaseGrant = deferred();
    const store = openStore(root, {
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
    await expectRejection(effectPromise, "revoked");
    expect(await setPromise).toEqual({ roots: ["goals:G-only"], epoch: 1 });
  });

  it("peer coherence: second store waits on first store's live admission", async () => {
    const root = await freshRoot();
    const broker = openStore(root);
    const peer = openStore(root);

    await broker.setRoots(["goals:G0"]);
    const effect = await broker.admitExternalEffect({
      kind: "rebase",
      targetRef: "goals:G0",
    });
    expect(broker.activeAdmissionCount()).toBe(1);
    // Peer observes the shared admission lease.
    expect(peer.activeAdmissionCount()).toBe(1);

    const setPromise = peer.setRoots(["goals:G1"]);
    let setDone = false;
    void setPromise.then(() => {
      setDone = true;
    });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 40));
    expect(setDone).toBe(false);
    expect(peer.exclusiveHeld()).toBe(true);

    effect.registerProcessGroup({ pgid: 4242, leaderPid: 4242 });
    effect.markSettled();
    await effect.releaseAfterSettlement();
    const snap = await setPromise;
    expect(snap).toEqual({ roots: ["goals:G1"], epoch: 2 });
    expect(await readWorksetRootsEpoch(broker)).toEqual(snap);
    expect(broker.activeAdmissionCount()).toBe(0);
    expect(peer.activeAdmissionCount()).toBe(0);
  });

  it("broker death with unsettled process group: exclusive waits until pg settles", async () => {
    const root = await freshRoot();
    // Simulate a dead broker pid that left a registered, unsettled admission
    // whose process group is still "alive" until we flip the probe.
    let pgAlive = true;
    const deadBrokerPid = 9_000_001;
    const store = openStore(root, {
      isPidAlive: (pid) => {
        if (pid === deadBrokerPid) return false;
        return defaultPidAlive(pid);
      },
      isProcessGroupAlive: (pgid) => {
        if (pgid === 7_777) return pgAlive;
        return false;
      },
    });

    // Manually plant a durable admission as if the dead broker wrote it.
    const worksetDir = path.join(root, ".cq", "workset", "admissions");
    await fs.mkdir(worksetDir, { recursive: true });
    const admission = {
      id: "ee-dead-broker-1",
      form: "external-effect",
      kind: "child-dispatch",
      epoch: 0,
      roots: [] as string[],
      targetRef: "tasks:T1",
      pid: deadBrokerPid,
      hostname: "test",
      createdAt: Date.now(),
      generation: 0,
      processGroup: { pgid: 7_777, leaderPid: 7_777 },
      settled: false,
    };
    await atomicWrite(
      path.join(worksetDir, `${admission.id}.json`),
      `${JSON.stringify(admission, null, 2)}\n`,
    );
    expect(store.activeAdmissionCount()).toBe(1);

    const setPromise = store.setRoots(["goals:G-after-death"]);
    let setDone = false;
    void setPromise.then(() => {
      setDone = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(setDone).toBe(false);

    // Process group settles (exits) — cleanup-before-release may reclaim.
    pgAlive = false;
    const snap = await setPromise;
    expect(snap).toEqual({ roots: ["goals:G-after-death"], epoch: 1 });
    expect(store.activeAdmissionCount()).toBe(0);
  });

  it("dead broker without process group is reclaimed immediately", async () => {
    const root = await freshRoot();
    const deadBrokerPid = 9_000_002;
    const store = openStore(root, {
      isPidAlive: (pid) => {
        if (pid === deadBrokerPid) return false;
        return defaultPidAlive(pid);
      },
    });
    const worksetDir = path.join(root, ".cq", "workset", "admissions");
    await fs.mkdir(worksetDir, { recursive: true });
    const admission = {
      id: "ee-dead-no-pg",
      form: "external-effect",
      kind: "merge",
      epoch: 0,
      roots: [] as string[],
      targetRef: "tasks:T1",
      pid: deadBrokerPid,
      hostname: "test",
      createdAt: Date.now(),
      generation: 0,
      processGroup: null,
      settled: false,
    };
    await atomicWrite(
      path.join(worksetDir, `${admission.id}.json`),
      `${JSON.stringify(admission, null, 2)}\n`,
    );
    // No live holder and no pg → set may proceed after reclaim.
    const snap = await store.setRoots(["goals:G-reclaim"]);
    expect(snap).toEqual({ roots: ["goals:G-reclaim"], epoch: 1 });
    expect(store.activeAdmissionCount()).toBe(0);
  });

  it("set∥effect race never leaves a live pre-commit epoch admission", async () => {
    const root = await freshRoot();
    for (let i = 0; i < 50; i++) {
      // Isolate each iteration under a subdir so residual leases cannot leak.
      const iterRoot = path.join(root, `iter-${i}`);
      await fs.mkdir(iterRoot, { recursive: true });
      const store = openStore(iterRoot);
      await store.setRoots(["goals:G0"]);
      const admitP = store.admitExternalEffect({
        kind: "merge",
        targetRef: "goals:G0",
      });
      const setP = store.setRoots(["goals:G1"]);
      void admitP
        .then(async (adm) => {
          adm.registerProcessGroup({ pgid: 1, leaderPid: 1 });
          adm.markSettled();
          await adm.releaseAfterSettlement();
        })
        .catch(() => {
          // revoked / target-excluded
        });
      const setSnap = await setP;
      expect(setSnap).toEqual({ roots: ["goals:G1"], epoch: 2 });
      const admitOutcome = await Promise.allSettled([admitP]).then((r) => r[0]!);
      if (admitOutcome.status === "fulfilled") {
        const adm = admitOutcome.value;
        expect(adm.epoch === 1 || adm.epoch === 2).toBe(true);
      } else {
        const reason = admitOutcome.reason as { code?: string };
        expect(
          reason.code === "revoked" || reason.code === "target-excluded",
        ).toBe(true);
      }
      expect(store.activeAdmissionCount()).toBe(0);
      expect(await readWorksetRootsEpoch(store)).toEqual({
        roots: ["goals:G1"],
        epoch: 2,
      });
    }
  });

  it("injected write failure preserves the prior roots document", async () => {
    const root = await freshRoot();
    let failNext = false;
    const store = openStore(root, {
      atomicWrite: async (filePath, text) => {
        if (failNext && filePath.endsWith("roots.json")) {
          failNext = false;
          throw new Error("injected roots write failure");
        }
        await atomicWrite(filePath, text);
      },
    });

    const first = await store.setRoots(["goals:G-ok"]);
    expect(first).toEqual({ roots: ["goals:G-ok"], epoch: 1 });

    failNext = true;
    await expect(store.setRoots(["goals:G-fail"])).rejects.toThrow(
      /injected roots write failure/,
    );
    // Prior state authoritative for a fresh reader.
    expect(await readWorksetRootsEpoch(store)).toEqual(first);
    const peer = openStore(root);
    expect(await readWorksetRootsEpoch(peer)).toEqual(first);

    // Subsequent write succeeds and advances from the preserved epoch.
    const third = await store.setRoots(["goals:G-recovered"]);
    expect(third).toEqual({ roots: ["goals:G-recovered"], epoch: 2 });
  });

  it("injected rename failure (atomicWrite) leaves no partial roots.json", async () => {
    const root = await freshRoot();
    let failRename = false;
    const store = openStore(root, {
      atomicWrite: async (filePath, text) => {
        if (failRename && filePath.endsWith("roots.json")) {
          failRename = false;
          // Simulate tmp written but rename failing: do nothing to dest.
          throw Object.assign(new Error("injected rename EXDEV"), {
            code: "EXDEV",
          });
        }
        await atomicWrite(filePath, text);
      },
    });
    await store.setRoots(["tasks:T-prior"]);
    failRename = true;
    await expect(store.setRoots(["tasks:T-new"])).rejects.toThrow(/injected rename/);
    const peer = openStore(root);
    expect(await readWorksetRootsEpoch(peer)).toEqual({
      roots: ["tasks:T-prior"],
      epoch: 1,
    });
  });

  it("two peer writers serialize exclusive replacement", async () => {
    const root = await freshRoot();
    const a = openStore(root);
    const b = openStore(root);
    const results = await Promise.all([
      a.setRoots(["goals:GA"]),
      b.setRoots(["goals:GB"]),
    ]);
    const epochs = results.map((r) => r.epoch).sort((x, y) => x - y);
    expect(epochs).toEqual([1, 2]);
    const final = await readWorksetRootsEpoch(openStore(root));
    expect(final.epoch).toBe(2);
    expect(final.roots.length).toBe(1);
    expect(final.roots[0] === "goals:GA" || final.roots[0] === "goals:GB").toBe(
      true,
    );
  });
});

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}
