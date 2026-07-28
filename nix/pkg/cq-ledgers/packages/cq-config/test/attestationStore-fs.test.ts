/**
 * The shared adapter contract against the cross-process-safe filesystem
 * production backend, plus the properties only this backend has (T720, goal G94).
 *
 * This is the one adapter whose lock a plain synchronous write can ignore, so it
 * is where the journal's durable digest predicate is actually REACHED
 * (`outOfBandReplaceSync`) rather than left as unreachable defence-in-depth.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTESTATION_LOCKS_DIR,
  AttestationStorageError,
  AttestationTransportError,
  FsAttestationBackend,
  fsAttestationNamespaceDir,
  fsAttestationRowFileContent,
  fsAttestationRowPath,
  type AttestationNamespace,
  type AttestationRow,
} from "@cq/config";
import {
  runAttestationStoreContract,
  type AttestationContractFixture,
} from "./attestationStoreContract.js";

const NAMESPACE_BACKEND = "fs" as const;

const roots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cq-t720-fs-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

runAttestationStoreContract({
  name: "filesystem (fs)",
  namespaceBackend: NAMESPACE_BACKEND,
  build(projectKey: string): Promise<AttestationContractFixture> {
    const root = freshRoot();
    const namespace: AttestationNamespace = { backend: NAMESPACE_BACKEND, projectKey };
    // A short lock timeout keeps a genuinely contended case from stalling the
    // suite; the contract never contends across processes.
    const open = (key: string): FsAttestationBackend =>
      new FsAttestationBackend({
        namespace: { backend: NAMESPACE_BACKEND, projectKey: key },
        root,
        lockTimeoutMs: 2_000,
      });

    let live = open(projectKey);
    const extra: FsAttestationBackend[] = [];
    return Promise.resolve({
      get backend() {
        return live;
      },
      peer: () => {
        const peer = open(projectKey);
        extra.push(peer);
        return Promise.resolve(peer);
      },
      restart: async () => {
        await live.close();
        live = open(projectKey);
        return live;
      },
      sibling: (key: string) => {
        const sibling = open(key);
        extra.push(sibling);
        return Promise.resolve(sibling);
      },
      rows: () => Promise.resolve(live.storedRows()),
      dump: () => Promise.resolve(live.rawStorageDump()),
      artifacts: () => Promise.resolve(live.storageArtifacts()),
      breakBackend: () => {
        // OUT OF BAND: replace the namespace DIRECTORY with a regular file, so
        // `mkdir` fails ENOTDIR at the head of every unit of work — reads
        // included. Closing `live` would only prove the `closed` flag works.
        const dir = fsAttestationNamespaceDir(root, namespace);
        rmSync(dir, { recursive: true, force: true });
        writeFileSync(dir, "not a directory\n", "utf8");
        return Promise.resolve();
      },
      outOfBandReplaceSync(row: AttestationRow): void {
        // A plain write that ignores the lockfile entirely — the only way the
        // journal's `WHERE row_digest = ?` equivalent can be reached here.
        writeFileSync(fsAttestationRowPath(root, namespace, row), fsAttestationRowFileContent(row));
      },
      dispose: async () => {
        await live.close();
        for (const backend of extra) {
          await backend.close();
        }
      },
    });
  },
  openWithBadCredentials: async () => {
    // The root exists as a FILE, so the namespace directory can never be made.
    const root = join(freshRoot(), "root-is-a-file");
    writeFileSync(root, "not a directory\n", "utf8");
    const backend = new FsAttestationBackend({
      namespace: { backend: NAMESPACE_BACKEND, projectKey: "unusable" },
      root,
      lockTimeoutMs: 200,
    });
    // A filesystem store cannot detect an unusable root at construction (there
    // is nothing to open), so the failure lands on the first unit of work —
    // still before any dispatch is prepared against it.
    await backend.transact({ kind: "namespace" }, (store) => store.rows());
  },
});

// ---------------------------------------------------------------------------
// Properties specific to this backend
// ---------------------------------------------------------------------------

describe("filesystem attestation backend specifics", () => {
  test("only the fs backend may be served, and the excluded ones fail at construction", () => {
    const root = freshRoot();
    for (const backend of ["xdg", "postgres"] as const) {
      expect(
        () => new FsAttestationBackend({ namespace: { backend, projectKey: "p" }, root }),
        backend,
      ).toThrow(AttestationStorageError);
    }
    for (const backend of ["git-object", "remote"] as const) {
      expect(
        () => new FsAttestationBackend({ namespace: { backend, projectKey: "p" }, root }),
        backend,
      ).toThrow(/cannot hold dispatch attestations/);
    }
  });

  test("a row file name is a digest, so no attestation id becomes a path component", () => {
    const root = "/synthetic/root";
    const namespace: AttestationNamespace = { backend: "fs", projectKey: "proj" };
    const path = fsAttestationRowPath(root, namespace, {
      attestationId: `att_${"z".repeat(32)}`,
      generation: 3,
    });
    expect(path.startsWith(join(root, "fs", "proj"))).toBe(true);
    expect(path).toMatch(/\/[0-9a-f]{64}\.json$/);
    // Different generations of ONE attestation occupy different files.
    const other = fsAttestationRowPath(root, namespace, {
      attestationId: `att_${"z".repeat(32)}`,
      generation: 4,
    });
    expect(other).not.toBe(path);
    // Two namespaces whose keys concatenate identically stay separate.
    expect(
      fsAttestationRowPath(
        root,
        { backend: "fs", projectKey: "a-b" },
        {
          attestationId: `att_${"z".repeat(32)}`,
          generation: 1,
        },
      ),
    ).not.toBe(
      fsAttestationRowPath(
        root,
        { backend: "fs", projectKey: "a" },
        {
          attestationId: `att_${"z".repeat(32)}`,
          generation: 1,
        },
      ),
    );
  });

  test("a live lock holder is waited out and then reported, never stolen", async () => {
    const root = freshRoot();
    const namespace: AttestationNamespace = { backend: "fs", projectKey: "locked" };
    mkdirSync(join(root, ATTESTATION_LOCKS_DIR), { recursive: true });
    writeFileSync(
      join(root, ATTESTATION_LOCKS_DIR, "fs__locked.lock"),
      JSON.stringify({ pid: 4242, hostname: "peer", startedAt: Date.now() }),
      "utf8",
    );
    const backend = new FsAttestationBackend({
      namespace,
      root,
      lockTimeoutMs: 120,
      lockPollMs: 10,
      // The holder is ALIVE, so the lock must not be reclaimed.
      isPidAlive: () => true,
    });
    await expect(backend.transact({ kind: "namespace" }, (store) => store.rows())).rejects.toThrow(
      AttestationTransportError,
    );
    // The holder's lockfile is still there: a waiter never removes it.
    expect(existsSync(join(root, ATTESTATION_LOCKS_DIR, "fs__locked.lock"))).toBe(true);
    await backend.close();
  });

  test("a DEAD holder's lock is reclaimed, so a crash cannot wedge the store", async () => {
    const root = freshRoot();
    const namespace: AttestationNamespace = { backend: "fs", projectKey: "stale" };
    mkdirSync(join(root, ATTESTATION_LOCKS_DIR), { recursive: true });
    writeFileSync(
      join(root, ATTESTATION_LOCKS_DIR, "fs__stale.lock"),
      JSON.stringify({ pid: 4242, hostname: "peer", startedAt: 0 }),
      "utf8",
    );
    const backend = new FsAttestationBackend({
      namespace,
      root,
      lockTimeoutMs: 500,
      lockPollMs: 10,
      isPidAlive: () => false,
    });
    expect(await backend.transact({ kind: "namespace" }, (store) => store.rows())).toEqual([]);
    // The lock is released again afterwards.
    expect(existsSync(join(root, ATTESTATION_LOCKS_DIR, "fs__stale.lock"))).toBe(false);
    await backend.close();
  });

  test("a corrupted row file is storage corruption, never a lifecycle answer", async () => {
    const root = freshRoot();
    const namespace: AttestationNamespace = { backend: "fs", projectKey: "corrupt" };
    const dir = fsAttestationNamespaceDir(root, namespace);
    mkdirSync(dir, { recursive: true });
    const handle = { attestationId: `att_${"c".repeat(32)}`, generation: 1 };
    const path = fsAttestationRowPath(root, namespace, handle);
    const backend = new FsAttestationBackend({ namespace, root, lockTimeoutMs: 500 });

    for (const [what, body] of [
      ["not JSON", "{{{"],
      ["not an object", "[]"],
      ["no envelope", '{"nope":1}'],
      ["a malformed envelope", '{"rowDigest":1,"body":2}'],
      ["a body that is not JSON", '{"rowDigest":"x","body":"{{{"}'],
      [
        "a digest that does not match",
        `{"rowDigest":"${"0".repeat(64)}","body":"{\\"kind\\":\\"envelope\\",\\"namespace\\":{\\"backend\\":\\"fs\\",\\"projectKey\\":\\"corrupt\\"},\\"attestationId\\":\\"att_${"c".repeat(32)}\\",\\"generation\\":1,\\"idempotencyKey\\":\\"k\\"}"}`,
      ],
    ] as const) {
      writeFileSync(path, body, "utf8");
      await expect(
        backend.transact({ kind: "handle", handle }, (store) => store.read(handle)),
        what,
      ).rejects.toThrow(AttestationStorageError);
    }
    await backend.close();
  });

  test("a stored body carrying a forbidden prototype key is refused, not sanitised", async () => {
    // `JSON.parse` materialises "__proto__" as an OWN property rather than
    // walking the setter, so a hostile body survives parsing — and a later
    // spread would copy it onto a fresh object where it does hit the setter.
    // This package has produced four prototype-pollution instances; a body read
    // back out of storage is exactly how that class arrives.
    const root = freshRoot();
    const namespace: AttestationNamespace = { backend: "fs", projectKey: "proto" };
    const dir = fsAttestationNamespaceDir(root, namespace);
    mkdirSync(dir, { recursive: true });
    const handle = { attestationId: `att_${"p".repeat(32)}`, generation: 1 };
    const path = fsAttestationRowPath(root, namespace, handle);
    const backend = new FsAttestationBackend({ namespace, root, lockTimeoutMs: 500 });

    for (const forbidden of ["__proto__", "constructor", "prototype"]) {
      const hostile = `{"kind":"envelope","namespace":{"backend":"fs","projectKey":"proto"},"attestationId":"${handle.attestationId}","generation":1,"idempotencyKey":"k","${forbidden}":{"polluted":true}}`;
      writeFileSync(path, JSON.stringify({ rowDigest: "0".repeat(64), body: hostile }), "utf8");
      await expect(
        backend.transact({ kind: "handle", handle }, (store) => store.read(handle)),
        forbidden,
      ).rejects.toThrow(/forbidden "/);
    }
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    await backend.close();
  });

  test("the namespace directory holds exactly one file per row and nothing else", async () => {
    const root = freshRoot();
    const namespace: AttestationNamespace = { backend: "fs", projectKey: "artifacts" };
    const backend = new FsAttestationBackend({ namespace, root, lockTimeoutMs: 500 });
    await backend.transact({ kind: "namespace" }, (store) => store.rows());
    // The lock is released, so only the (empty) namespace dir remains — no
    // temporary file survives a successful write path.
    expect(readdirSync(fsAttestationNamespaceDir(root, namespace))).toEqual([]);
    expect(readdirSync(join(root, ATTESTATION_LOCKS_DIR))).toEqual([]);
    await backend.close();
  });
});
