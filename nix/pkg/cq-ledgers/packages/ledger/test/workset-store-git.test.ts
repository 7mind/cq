/**
 * T1956 — Git-object WorksetStore adapter.
 *
 * Runs the shared T1954 Blackbox contract against the git-object backend and
 * adds Effectual Good-Communication cases: restart/ref reload, CAS conflict,
 * injected object/ref failures, peer coherence, and host-tree isolation.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  GitPlumbing,
  WorksetAdmissionError,
  WORKSET_ROOTS_FILENAME,
  createGitObjectWorksetStore,
  parseWorksetRootsDocument,
  readWorksetRootsEpoch,
  serializeWorksetRootsDocument,
  type WorksetStore,
} from "../src/index.js";
import {
  runWorksetStoreContract,
  type WorksetStoreContractFactory,
} from "./worksetStoreContract.js";

const exec = promisify(execFile);
const BRANCH = "cq-ledger";
const REF = `refs/heads/${BRANCH}`;

const repos: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function seedRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "workset-git-"));
  repos.push(dir);
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "test");
  await git(dir, "config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(dir, "src.txt"), "host source, must stay byte-identical\n");
  await git(dir, "add", "src.txt");
  await git(dir, "commit", "-q", "-m", "main: initial");
  return dir;
}

afterAll(async () => {
  for (const d of repos) await fs.rm(d, { recursive: true, force: true });
});

const gitObjectWorksetStoreFactory: WorksetStoreContractFactory = {
  name: "GitObjectWorksetStore",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  async build(options) {
    const dir = await seedRepo();
    return createGitObjectWorksetStore({
      repoRoot: dir,
      ...(options?.hooks !== undefined ? { hooks: options.hooks } : {}),
      ...(options?.validateReplacement !== undefined
        ? { validateReplacement: options.validateReplacement }
        : {}),
      ...(options?.isTargetAdmitted !== undefined
        ? { isTargetAdmitted: options.isTargetAdmitted }
        : {}),
    });
  },
};

runWorksetStoreContract(gitObjectWorksetStoreFactory);

describe("workset store git-object [T1956]", () => {
  it("createGitObjectWorksetStore returns a WorksetStore at empty epoch 0", async () => {
    const dir = await seedRepo();
    const store: WorksetStore = await createGitObjectWorksetStore({ repoRoot: dir });
    expect(await readWorksetRootsEpoch(store)).toEqual({ roots: [], epoch: 0 });
    expect(typeof store.setRoots).toBe("function");
    expect(typeof store.admitLedgerMutation).toBe("function");
    expect(typeof store.admitExternalEffect).toBe("function");
  });

  it("restart/ref reload retains exact root order and epoch", async () => {
    const dir = await seedRepo();
    const writer = await createGitObjectWorksetStore({ repoRoot: dir });
    const committed = await writer.setRoots(["goals:G1", "tasks:T2", "goals:G1", "ideas:I3"]);
    expect(committed).toEqual({
      roots: ["goals:G1", "tasks:T2", "ideas:I3"],
      epoch: 1,
    });

    const reader = await createGitObjectWorksetStore({ repoRoot: dir });
    expect(await readWorksetRootsEpoch(reader)).toEqual(committed);

    // Raw tip blob is one complete batch.
    const plumbing = GitPlumbing.withCwd(dir, path.join(dir, ".git"));
    const text = await plumbing.catFile(REF, WORKSET_ROOTS_FILENAME);
    expect(parseWorksetRootsDocument(text)).toEqual(committed);
  });

  it("every successful set advances the orphan ref by exactly one commit", async () => {
    const dir = await seedRepo();
    const store = await createGitObjectWorksetStore({ repoRoot: dir });
    const before = await git(dir, "rev-list", "--count", REF);
    await store.setRoots(["goals:G1"]);
    await store.setRoots(["tasks:T1"]);
    const after = await git(dir, "rev-list", "--count", REF);
    // ensureRef seeds 1 commit; two sets → +2
    expect(Number(after) - Number(before)).toBe(2);
  });

  it("host working tree, HEAD, and status stay byte-identical across setRoots", async () => {
    const dir = await seedRepo();
    const headBefore = await git(dir, "rev-parse", "HEAD");
    const statusBefore = await git(dir, "status", "--porcelain");
    const srcBefore = await fs.readFile(path.join(dir, "src.txt"), "utf8");

    const store = await createGitObjectWorksetStore({ repoRoot: dir });
    await store.setRoots(["goals:G-host"]);
    await store.setRoots([]);

    expect(await git(dir, "rev-parse", "HEAD")).toBe(headBefore);
    expect(await git(dir, "status", "--porcelain")).toBe(statusBefore);
    expect(await fs.readFile(path.join(dir, "src.txt"), "utf8")).toBe(srcBefore);
  });

  it("lockfiles and admission leases never appear on the orphan tree", async () => {
    const dir = await seedRepo();
    const store = await createGitObjectWorksetStore({ repoRoot: dir });
    const admission = await store.admitExternalEffect({
      kind: "merge",
      targetRef: "tasks:T1",
    });
    admission.registerProcessGroup({ pgid: 9, leaderPid: 9 });
    admission.markSettled();
    await admission.releaseAfterSettlement();
    await store.setRoots(["goals:G2"]);

    const tree = await git(dir, "ls-tree", "-r", "--name-only", REF);
    expect(tree.includes(".locks")).toBe(false);
    expect(tree.includes("workset-admissions")).toBe(false);
    expect(tree.split("\n").includes(WORKSET_ROOTS_FILENAME)).toBe(true);
  });

  it("peer coherence: a second store observes the tip without shared memory", async () => {
    const dir = await seedRepo();
    const a = await createGitObjectWorksetStore({ repoRoot: dir });
    const b = await createGitObjectWorksetStore({ repoRoot: dir });
    await a.setRoots(["milestones:M1", "tasks:T9"]);
    expect(await readWorksetRootsEpoch(b)).toEqual({
      roots: ["milestones:M1", "tasks:T9"],
      epoch: 1,
    });
    // Peer admit adopts the tip roots for target checks.
    await expect(
      b.admitLedgerMutation({ kind: "generic-write", targets: ["tasks:T-out"] }),
    ).rejects.toMatchObject({ code: "target-excluded" });
    const ok = await b.admitLedgerMutation({
      kind: "generic-write",
      targets: ["milestones:M1"],
    });
    expect(ok.epoch).toBe(1);
    await ok.acknowledge();
  });

  it("losing CAS writer reports stale-epoch and leaves prior ref authoritative", async () => {
    const dir = await seedRepo();
    const store = await createGitObjectWorksetStore({
      repoRoot: dir,
      commitRoots: async (next, defaultCommit) => {
        // Simulate a peer winning the ref between reload and our CAS by
        // advancing the tip first, then attempting the real commit.
        const plumbing = GitPlumbing.withCwd(dir, path.join(dir, ".git"));
        const peer = {
          roots: ["goals:G-peer"],
          epoch: next.epoch, // same epoch number — occupies the CAS slot
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

    // First set from empty: peer writes epoch 1, then defaultCommit also wants
    // epoch 1 → stale-epoch (tip epoch is not predecessor).
    try {
      await store.setRoots(["goals:G-local"]);
      throw new Error("expected stale-epoch");
    } catch (err) {
      expect(err).toBeInstanceOf(WorksetAdmissionError);
      expect((err as WorksetAdmissionError).code).toBe("stale-epoch");
    }

    // Prior authoritative tip is the peer's complete batch (or empty if peer
    // path failed) — never a partial local write. Peer wrote goals:G-peer@1.
    const tip = await readWorksetRootsEpoch(
      await createGitObjectWorksetStore({ repoRoot: dir }),
    );
    expect(tip).toEqual({ roots: ["goals:G-peer"], epoch: 1 });
  });

  it("injected hash/object failure leaves the prior ref authoritative", async () => {
    const dir = await seedRepo();
    const ok = await createGitObjectWorksetStore({ repoRoot: dir });
    await ok.setRoots(["goals:G-prior"]);

    const broken = await createGitObjectWorksetStore({
      repoRoot: dir,
      commitRoots: async () => {
        throw new Error("injected object write failure");
      },
    });
    try {
      await broken.setRoots(["goals:G-new"]);
      throw new Error("expected failure");
    } catch (err) {
      expect(err).toBeInstanceOf(WorksetAdmissionError);
      expect((err as WorksetAdmissionError).code).toBe("invalid-replacement");
    }

    const tip = await readWorksetRootsEpoch(
      await createGitObjectWorksetStore({ repoRoot: dir }),
    );
    expect(tip).toEqual({ roots: ["goals:G-prior"], epoch: 1 });
  });

  it("serialize/parse round-trip preserves a complete batch only", () => {
    const snap = { roots: ["goals:G1", "tasks:T2"], epoch: 7 };
    const text = serializeWorksetRootsDocument(snap);
    expect(parseWorksetRootsDocument(text)).toEqual(snap);
    expect(() => parseWorksetRootsDocument(`{"version":1,"epoch":1}`)).toThrow(
      WorksetAdmissionError,
    );
    expect(() =>
      parseWorksetRootsDocument(`{"version":1,"epoch":1,"roots":[""]}`),
    ).toThrow(WorksetAdmissionError);
  });
});
