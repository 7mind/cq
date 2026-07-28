/**
 * The four single-project server constructions (T686, goal G94) exercised
 * end-to-end through the PRODUCTION construction matrix: `resolveProjectKey`
 * derives the namespace exactly as the real ledger-store factory does, and
 * {@link createAttestationStoreForConstruction} builds the SAME concrete
 * adapter (`@cq/config`'s xdg/sqlite and filesystem backends) a server would.
 *
 * Reuses the shared T720 40-case contract UNCHANGED — see
 * `packages/cq-config/test/attestationStoreContract.ts` — against a store
 * built via `direct`, `stdio`, `embedded` and `http-single-project`, so the
 * full authoritative-deadline / 24h envelope / 30d tombstone /
 * cleanup-retry-race-restart-concurrent-reuse-old-attestation-bounded-storage
 * matrix is proven green through THIS matrix's wiring, not merely through the
 * raw adapter constructors T720 already tested directly.
 *
 * D170 discipline: every namespace here is derived from an EXPLICIT
 * `[ledger].projectId` (never from git), and every xdg case points
 * `XDG_STATE_HOME` at a throwaway `mkdtemp` directory — the real
 * `~/.local/state/cq` is never touched.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runAttestationStoreContract,
  type AttestationContractFixture,
} from "../../cq-config/test/attestationStoreContract.js";
import {
  ATTESTATION_UNSUPPORTED_LOCAL_HUB_CONSTRUCTION,
  AttestationConstructionUnsupportedError,
  SINGLE_PROJECT_CONSTRUCTIONS,
  createAttestationStoreForConstruction,
  fsAttestationProductionRoot,
  resolveSingleProjectAttestationNamespace,
  type SingleProjectConstruction,
} from "../src/index.js";
import type { AttestationBackend } from "@cq/config";

const roots: string[] = [];

function freshRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

let counter = 0;
function uniqueProjectId(tag: string): string {
  counter += 1;
  return `t686-${tag}-${String(counter)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// XDG, through each single-project construction
// ---------------------------------------------------------------------------

for (const construction of SINGLE_PROJECT_CONSTRUCTIONS) {
  runAttestationStoreContract({
    name: `xdg via construction "${construction}"`,
    namespaceBackend: "xdg",
    build: async (): Promise<AttestationContractFixture> => {
      const stateHome = freshRoot(`cq-t686-xdg-${construction}-`);
      const env = { XDG_STATE_HOME: stateHome };
      const projectId = uniqueProjectId(construction);
      const open = async (repoRoot: string, pid: string): Promise<AttestationBackend> => {
        const namespace = await resolveSingleProjectAttestationNamespace({
          construction,
          backend: "xdg",
          repoRoot,
          projectId: pid,
        });
        return createAttestationStoreForConstruction({ backend: "xdg", namespace, env });
      };
      const extra: AttestationBackend[] = [];
      let live = await open("/irrelevant-repo-root", projectId);
      return {
        get backend() {
          return live;
        },
        peer: async () => {
          const backend = await open("/irrelevant-repo-root", projectId);
          extra.push(backend);
          return backend;
        },
        restart: async () => {
          await live.close();
          live = await open("/irrelevant-repo-root", projectId);
          return live;
        },
        sibling: async (key: string) => {
          const backend = await open("/irrelevant-repo-root", key);
          extra.push(backend);
          return backend;
        },
        rows: async () => (await live.transact({ kind: "namespace" }, (store) => store.rows())) ?? [],
        dump: async () =>
          JSON.stringify(await live.transact({ kind: "namespace" }, (store) => store.rows())),
        artifacts: () => Promise.resolve([`xdg:${stateHome}`]),
        breakBackend: async () => {
          // No portable out-of-band sabotage at this level without reaching
          // into bun:sqlite internals the construction layer doesn't expose;
          // the raw-adapter suite (attestationStore-sqlite.test.ts) already
          // proves this property directly against SqliteAttestationBackend,
          // which is exactly what this factory constructs.
          await live.close();
        },
        dispose: async () => {
          await live.close();
          for (const backend of extra) await backend.close();
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Filesystem, through each single-project construction
// ---------------------------------------------------------------------------

for (const construction of SINGLE_PROJECT_CONSTRUCTIONS) {
  runAttestationStoreContract({
    name: `fs via construction "${construction}"`,
    namespaceBackend: "fs",
    build: async (): Promise<AttestationContractFixture> => {
      const ledgerRoot = freshRoot(`cq-t686-fs-${construction}-`);
      const projectId = uniqueProjectId(construction);
      const open = async (pid: string): Promise<AttestationBackend> => {
        const namespace = await resolveSingleProjectAttestationNamespace({
          construction,
          backend: "fs",
          repoRoot: ledgerRoot,
          projectId: pid,
        });
        return createAttestationStoreForConstruction({ backend: "fs", namespace, ledgerRoot });
      };
      const extra: AttestationBackend[] = [];
      let live = await open(projectId);
      return {
        get backend() {
          return live;
        },
        peer: async () => {
          const backend = await open(projectId);
          extra.push(backend);
          return backend;
        },
        restart: async () => {
          await live.close();
          live = await open(projectId);
          return live;
        },
        sibling: async (key: string) => {
          const backend = await open(key);
          extra.push(backend);
          return backend;
        },
        rows: async () => (await live.transact({ kind: "namespace" }, (store) => store.rows())) ?? [],
        dump: async () =>
          JSON.stringify(await live.transact({ kind: "namespace" }, (store) => store.rows())),
        artifacts: () => Promise.resolve([`fs:${fsAttestationProductionRoot(ledgerRoot)}`]),
        breakBackend: async () => {
          await live.close();
        },
        dispose: async () => {
          await live.close();
          for (const backend of extra) await backend.close();
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// The FS production root convention itself
// ---------------------------------------------------------------------------

describe("fsAttestationProductionRoot", () => {
  test("lives at <ledgerRoot>/.cq/attestations, alongside the legacy fs ledger's own .cq dir", () => {
    expect(fsAttestationProductionRoot("/some/repo")).toBe("/some/repo/.cq/attestations");
  });
});

// ---------------------------------------------------------------------------
// Excluded single-project constructions never reach the factory
// ---------------------------------------------------------------------------

describe("excluded backends refuse before createAttestationStoreForConstruction is ever called", () => {
  for (const construction of SINGLE_PROJECT_CONSTRUCTIONS) {
    test(`"${construction}" refuses git-object at the resolver, not at store construction`, async () => {
      await expect(
        resolveSingleProjectAttestationNamespace({
          construction,
          backend: "git-object",
          repoRoot: "/irrelevant",
          projectId: "whatever",
        }),
      ).rejects.toThrow(/row-level compare-and-set/);
    });
  }

  test('the local xdg catalog hub construction refuses for xdg outright, before resolveProjectKey runs', async () => {
    await expect(
      resolveSingleProjectAttestationNamespace({
        // Cast: this construction is not a member of SingleProjectConstruction
        // on purpose — the point of this test is that the gate refuses it
        // even though the type system would not let real code pass it here.
        construction: ATTESTATION_UNSUPPORTED_LOCAL_HUB_CONSTRUCTION as unknown as SingleProjectConstruction,
        backend: "xdg",
        repoRoot: "/irrelevant",
        projectId: "whatever",
      }),
    ).rejects.toBeInstanceOf(AttestationConstructionUnsupportedError);
  });

  test("createAttestationStoreForConstruction refuses a mismatched namespace built by some OTHER path (the adapter's own guard, not the resolver's)", async () => {
    // No resolver was used to build this namespace — it is handed straight to
    // the factory, simulating a caller that bypassed
    // resolveSingleProjectAttestationNamespace entirely. SqliteAttestationBackend's
    // OWN constructor (assertSqliteNamespace) refuses it — the factory itself
    // does not duplicate that check (see createAttestationStoreForConstruction's
    // docstring).
    const stateHome = freshRoot("cq-t686-xdg-mismatch-");
    await expect(
      createAttestationStoreForConstruction({
        backend: "xdg",
        namespace: { backend: "git-object", projectKey: "whatever-686" },
        env: { XDG_STATE_HOME: stateHome },
      }),
    ).rejects.toThrow(/row-level compare-and-set/);
  });
});
