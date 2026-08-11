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
import { fileURLToPath } from "node:url";
import {
  WorksetAdmissionError,
  createFsWorksetStore,
  readWorksetRootsEpoch,
  type WorksetAdmissionErrorCode,
  type WorksetStore,
} from "../src/index.js";
import { atomicWrite } from "../src/store/fsAtomic.js";

const dirs: string[] = [];
const PEER_FIXTURE = fileURLToPath(new URL("./worksetFsStorePeer.ts", import.meta.url));
const PEER_WAIT_TIMEOUT_MS = 5_000;

afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

async function freshRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "workset-effect-fs-"));
  dirs.push(dir);
  return dir;
}

interface PeerOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function spawnPeer(request: Readonly<Record<string, unknown>>): {
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly outcome: Promise<PeerOutcome>;
  result(): Promise<{ readonly roots: readonly string[]; readonly epoch: number }>;
} {
  const child = Bun.spawn([process.execPath, "run", PEER_FIXTURE], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(`${JSON.stringify(request)}\n`);
  child.stdin.end();
  const outcome = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([code, stdout, stderr]) => ({ code, stdout, stderr }));
  return {
    child,
    outcome,
    result: async () =>
      await outcome.then(({ code, stdout, stderr }) => {
        if (code !== 0) throw new Error(`workset peer exited ${String(code)}: ${stderr}`);
        return JSON.parse(stdout) as { readonly roots: readonly string[]; readonly epoch: number };
      }),
  };
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + PEER_WAIT_TIMEOUT_MS;
  while (!(await Bun.file(file).exists())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await Bun.sleep(5);
  }
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

  it("same-process independent stores serialize nonce-qualified exclusive replacement", async () => {
    const root = await freshRoot();
    const firstReady = deferred();
    const releaseFirst = deferred();
    const a = openStore(root, {
      hooks: {
        afterExclusiveReady: async () => {
          firstReady.resolve();
          await releaseFirst.promise;
        },
      },
    });
    const b = openStore(root);
    const first = a.setRoots(["goals:GA"]);
    await firstReady.promise;
    const holder = JSON.parse(
      await fs.readFile(path.join(root, ".cq", "workset", "exclusive-holder.json"), "utf8"),
    ) as { readonly nonce?: unknown };
    const holderNonceType = typeof holder.nonce;

    let secondDone = false;
    const second = b.setRoots(["goals:GB"]).then((result) => {
      secondDone = true;
      return result;
    });
    await Bun.sleep(40);
    const completedWhileFirstHeld = secondDone;
    releaseFirst.resolve();
    const results = await Promise.all([first, second]);
    expect(holderNonceType).toBe("string");
    expect(completedWhileFirstHeld).toBe(false);
    const epochs = results.map((r) => r.epoch).sort((x, y) => x - y);
    expect(epochs).toEqual([1, 2]);
    const final = await readWorksetRootsEpoch(openStore(root));
    expect(final.epoch).toBe(2);
    expect(final.roots.length).toBe(1);
    expect(final.roots[0] === "goals:GA" || final.roots[0] === "goals:GB").toBe(
      true,
    );
  });

  it("peer processes serialize exclusive replacement [Effectual-GoodCommunication]", async () => {
    const root = await freshRoot();
    const readyFile = path.join(root, "first.ready");
    const releaseFile = path.join(root, "first.release");
    const secondStarted = path.join(root, "second.started");
    const secondCompleted = path.join(root, "second.completed");
    const first = spawnPeer({ root, roots: ["goals:GA"], readyFile, releaseFile });
    await waitForFile(readyFile);
    const second = spawnPeer({
      root,
      roots: ["goals:GB"],
      startedFile: secondStarted,
      completedFile: secondCompleted,
    });
    await waitForFile(secondStarted);
    await Bun.sleep(40);
    expect(await Bun.file(secondCompleted).exists()).toBe(false);

    await fs.writeFile(releaseFile, "release\n");
    const results = await Promise.all([first.result(), second.result()]);
    expect(results.map((result) => result.epoch).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(await readWorksetRootsEpoch(openStore(root))).toEqual(results[1]);
  });

  it("a stale nonce-qualified holder is reclaimed by PID liveness", async () => {
    const root = await freshRoot();
    const worksetDir = path.join(root, ".cq", "workset");
    await fs.mkdir(worksetDir, { recursive: true });
    await fs.writeFile(
      path.join(worksetDir, "exclusive-holder.json"),
      `${JSON.stringify({
        pid: 9_000_003,
        hostname: "stale-holder",
        startedAt: 1,
        kind: "exclusive-set",
        nonce: "stale-store:1",
      })}\n`,
    );
    const store = openStore(root, {
      isPidAlive: (pid) => pid !== 9_000_003 && defaultPidAlive(pid),
    });
    expect(await store.setRoots(["goals:G-reclaimed"])).toEqual({
      roots: ["goals:G-reclaimed"],
      epoch: 1,
    });
  });

  it("a fresh peer reclaims an exclusive holder after process crash [Effectual-GoodCommunication]", async () => {
    const root = await freshRoot();
    const readyFile = path.join(root, "crash.ready");
    const neverRelease = path.join(root, "crash.release");
    const crashed = spawnPeer({
      root,
      roots: ["goals:G-crashed"],
      readyFile,
      releaseFile: neverRelease,
    });
    await waitForFile(readyFile);
    crashed.child.kill("SIGKILL");
    const crashedOutcome = await crashed.outcome;
    expect(crashedOutcome.code).not.toBe(0);
    expect(await Bun.file(path.join(root, ".cq", "workset", "exclusive-holder.json")).exists()).toBe(
      true,
    );

    const recovered = await spawnPeer({ root, roots: ["goals:G-recovered"] }).result();
    expect(recovered).toEqual({ roots: ["goals:G-recovered"], epoch: 1 });
    expect(await readWorksetRootsEpoch(openStore(root))).toEqual(recovered);
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
