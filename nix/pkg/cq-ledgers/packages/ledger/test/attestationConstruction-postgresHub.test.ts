/**
 * The PostgreSQL HUB construction (T686, goal G94) — `cq serve`'s multi-project
 * routing, exercised through the SAME construction-matrix factory the
 * single-project constructions use, with a namespace derived from
 * {@link attestationNamespaceForTrustedHubProject} (a TRUSTED
 * `projects.project_key`, never request content) instead of
 * {@link resolveProjectKey}.
 *
 * Env-gated on `CQ_TEST_PG_URL` (Q286): every case SKIPS, loudly and by name,
 * with no reachable database. Connection discipline follows T720's
 * `attestationStore-postgres.test.ts`: every pool is capped `max: 1` and every
 * handle this file opens is closed before the file ends — this env var also
 * enables every other Postgres suite in the repo, sharing ONE server.
 */

import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import {
  ATTESTATION_TABLE,
  FakeDispatchClock,
  openAttestationPgPool,
} from "@cq/config";
import {
  AttestationDriver,
  runAttestationStoreContract,
  type AttestationContractFixture,
} from "../../cq-config/test/attestationStoreContract.js";
import { attestationNamespaceForTrustedHubProject, createAttestationStoreForConstruction } from "../src/index.js";
import type { AttestationBackend } from "@cq/config";

const PG_URL = process.env["CQ_TEST_PG_URL"];
const LIVE_SUITE_SKIPPED = PG_URL === undefined;

let counter = 0;
function trustedHubProjectKey(tag: string): string {
  counter += 1;
  return `t686-hub-${tag}-${String(counter)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function openHub(trustedProjectKey: string): Promise<AttestationBackend> {
  const namespace = attestationNamespaceForTrustedHubProject(trustedProjectKey);
  return createAttestationStoreForConstruction({
    backend: "postgres",
    namespace,
    pool: new SQL({ url: PG_URL!, max: 1 }),
    ownsPool: true,
  });
}

async function cleanupTenant(trustedProjectKey: string): Promise<void> {
  const pool = openAttestationPgPool(PG_URL!);
  try {
    await pool`
      DELETE FROM ${pool(ATTESTATION_TABLE)}
       WHERE backend = 'postgres' AND project_key = ${trustedProjectKey}
    `;
  } catch {
    // ignore — table may not exist yet on a cold database.
  } finally {
    await pool.close();
  }
}

// ---------------------------------------------------------------------------
// The shared T720 contract, run through the HUB construction path
// ---------------------------------------------------------------------------

runAttestationStoreContract({
  name: "PostgreSQL hub construction",
  namespaceBackend: "postgres",
  skip: LIVE_SUITE_SKIPPED,
  build: async (): Promise<AttestationContractFixture> => {
    const trustedProjectKey = trustedHubProjectKey("contract");
    const handles: AttestationBackend[] = [];
    const open = async (key: string): Promise<AttestationBackend> => {
      const backend = await openHub(key);
      handles.push(backend);
      return backend;
    };
    let live = await open(trustedProjectKey);
    return {
      get backend() {
        return live;
      },
      peer: () => open(trustedProjectKey),
      restart: async () => {
        await live.close();
        live = await open(trustedProjectKey);
        return live;
      },
      sibling: (key: string) => open(key),
      rows: async () => (await live.transact({ kind: "namespace" }, (store) => store.rows())) ?? [],
      dump: async () =>
        JSON.stringify(await live.transact({ kind: "namespace" }, (store) => store.rows())),
      artifacts: () => Promise.resolve([ATTESTATION_TABLE]),
      breakBackend: async () => {
        const saboteur = openAttestationPgPool(PG_URL!);
        try {
          await saboteur`DROP TABLE IF EXISTS ${saboteur(ATTESTATION_TABLE)}`;
        } finally {
          await saboteur.close();
        }
      },
      dispose: async () => {
        for (const handle of handles) {
          await handle.close().catch(() => undefined);
        }
        await cleanupTenant(trustedProjectKey);
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Two hub projects, colliding external keys — the acceptance's own example
// ---------------------------------------------------------------------------

describe.skipIf(LIVE_SUITE_SKIPPED)(
  "two PostgreSQL hub projects with colliding external keys",
  () => {
    test("the SAME idempotency key, prepared through two hub tenants, produces two INDEPENDENT prepared dispatches", async () => {
      const projectA = trustedHubProjectKey("collide-a");
      const projectB = trustedHubProjectKey("collide-b");
      const backendA = await openHub(projectA);
      const backendB = await openHub(projectB);
      const clock = new FakeDispatchClock("2026-07-28T00:00:00.000Z");
      const driverA = new AttestationDriver(backendA, clock);
      const driverB = new AttestationDriver(backendB, clock);
      const collidingIdempotencyKey = "shared-external-key-t686";
      try {
        const preparedA = await driverA.prepare({ idempotencyKey: collidingIdempotencyKey });
        const preparedB = await driverB.prepare({ idempotencyKey: collidingIdempotencyKey });

        // Two distinct attestation ids: the second prepare was NOT treated as
        // an idempotent replay of the first, because the two tenants are
        // different namespaces sharing one physical table.
        expect(preparedA.attestationId).not.toBe(preparedB.attestationId);

        // Each tenant only ever sees its OWN row for the colliding key — a
        // whole-namespace scan (the broadest legal scope) still returns
        // exactly one row per tenant, never the other tenant's.
        const rowsA = await backendA.transact({ kind: "namespace" }, (store) => store.rows());
        const rowsB = await backendB.transact({ kind: "namespace" }, (store) => store.rows());
        expect(rowsA).toHaveLength(1);
        expect(rowsB).toHaveLength(1);
        expect(rowsA[0]?.attestationId).toBe(preparedA.attestationId);
        expect(rowsB[0]?.attestationId).toBe(preparedB.attestationId);
        expect(rowsA[0]?.namespace.projectKey).toBe(projectA);
        expect(rowsB[0]?.namespace.projectKey).toBe(projectB);

        // Re-preparing the SAME idempotency key against tenant A refuses as a
        // held-key conflict (prepareDispatch has no replay path — the SAME key
        // is either reclaimable past its horizon or refused). The conflict must
        // cite A's OWN attestation id, never B's — proving A's key is durably
        // held independently of B's colliding key living in a DIFFERENT
        // namespace, rather than the two tenants' rows having collided onto
        // whichever one happened to land second.
        try {
          await driverA.prepareOutcome({ idempotencyKey: collidingIdempotencyKey });
          throw new Error("expected a held-key conflict");
        } catch (error) {
          expect((error as Error).message).toContain(preparedA.attestationId);
          expect((error as Error).message).not.toContain(preparedB.attestationId);
        }
      } finally {
        await backendA.close();
        await backendB.close();
        await cleanupTenant(projectA);
        await cleanupTenant(projectB);
      }
    });

    test("distinct trusted project keys never derive the same namespace", () => {
      const a = attestationNamespaceForTrustedHubProject("tenant-x");
      const b = attestationNamespaceForTrustedHubProject("tenant-y");
      expect(a).not.toEqual(b);
    });
  },
);

// ---------------------------------------------------------------------------
// The hub construction never reaches the network for an unsupported backend
// ---------------------------------------------------------------------------

describe("attestationNamespaceForTrustedHubProject is offline by construction", () => {
  test("builds a namespace synchronously — no connection, no await, no I/O", () => {
    const namespace = attestationNamespaceForTrustedHubProject("offline-check");
    expect(namespace).toEqual({ backend: "postgres", projectKey: "offline-check" });
  });
});
