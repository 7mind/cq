/** The shared attestation contract against the production Git-object adapter. */

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttestationStorageError, FakeDispatchClock, type AttestationNamespace } from "@cq/config";
import {
  GitObjectAttestationBackend,
  GitPlumbing,
  type GitObjectAttestationBackendOptions,
} from "../src/index.js";
import {
  AttestationDriver,
  runAttestationStoreContract,
  type AttestationContractFixture,
} from "../../cq-config/test/attestationStoreContract.js";

const NAMESPACE_BACKEND = "git-object" as const;
const REF = "cq-ledger-attestations-test";
const FULL_REF = `refs/heads/${REF}`;
const roots: string[] = [];

function freshRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cq-t2816-git-attestations-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  roots.push(root);
  return root;
}

function open(
  repoRoot: string,
  projectKey: string,
  options: Partial<GitObjectAttestationBackendOptions> = {},
): GitObjectAttestationBackend {
  return new GitObjectAttestationBackend({
    namespace: { backend: NAMESPACE_BACKEND, projectKey },
    repoRoot,
    ref: REF,
    ...options,
  });
}

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

runAttestationStoreContract({
  name: "Git object",
  namespaceBackend: NAMESPACE_BACKEND,
  async build(projectKey: string): Promise<AttestationContractFixture> {
    const repoRoot = freshRepo();
    let live = open(repoRoot, projectKey);
    const extra: GitObjectAttestationBackend[] = [];
    return {
      get backend() {
        return live;
      },
      peer: () => {
        const peer = open(repoRoot, projectKey);
        extra.push(peer);
        return Promise.resolve(peer);
      },
      restart: async () => {
        await live.close();
        live = open(repoRoot, projectKey);
        return live;
      },
      sibling: (key: string) => {
        const sibling = open(repoRoot, key);
        extra.push(sibling);
        return Promise.resolve(sibling);
      },
      rows: () => live.storedRows(),
      dump: () => live.rawStorageDump(),
      artifacts: () => live.storageArtifacts(),
      breakBackend: () => {
        renameSync(join(repoRoot, ".git"), join(repoRoot, ".git-disabled"));
        return Promise.resolve();
      },
      dispose: async () => {
        await live.close();
        for (const backend of extra) await backend.close();
      },
    };
  },
  openWithBadCredentials: async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "cq-t2816-not-a-git-repo-"));
    roots.push(repoRoot);
    const backend = open(repoRoot, "unusable");
    await backend.transact({ kind: "namespace" }, (store) => store.rows());
  },
});

describe("Git-object attestation transaction", () => {
  test("a non-cooperating ref writer wins the CAS and the attestation write fails closed", async () => {
    const repoRoot = freshRepo();
    const backend = open(repoRoot, "cas-race");
    const driver = new AttestationDriver(
      backend,
      new FakeDispatchClock("2026-07-27T09:00:00.000Z"),
    );
    const prepared = await driver.prepare();
    const git = GitPlumbing.withCwd(repoRoot, join(repoRoot, ".git"));
    try {
      await expect(
        backend.transact({ kind: "namespace" }, async (store) => {
          const [row] = store.rows();
          if (row === undefined) throw new Error("prepared row missing");
          store.remove(row);

          const oldHead = await git.readRef(FULL_REF);
          if (oldHead === null) throw new Error("attestation ref missing");
          const entries = await git.lsTreeEntries(oldHead);
          const marker = await git.hashObject("concurrent writer\n");
          entries.push({ mode: "100644", sha: marker, path: "concurrent-marker.txt" });
          const tree = await git.writeTree(entries);
          const commit = await git.commitTree(tree, oldHead, "concurrent writer");
          await git.updateRef(FULL_REF, commit, oldHead);
        }),
      ).rejects.toThrow(AttestationStorageError);

      expect(await backend.storedRows()).toEqual([
        expect.objectContaining({
          attestationId: prepared.attestationId,
          generation: prepared.generation,
        }),
      ]);
      expect(await git.catFile(FULL_REF, "concurrent-marker.txt")).toBe("concurrent writer\n");
    } finally {
      await backend.close();
    }
  });

  test("rejects a namespace for a different backend", () => {
    const repoRoot = freshRepo();
    const namespace: AttestationNamespace = { backend: "fs", projectKey: "wrong-backend" };
    expect(() => new GitObjectAttestationBackend({ namespace, repoRoot, ref: REF })).toThrow(
      AttestationStorageError,
    );
  });
});
