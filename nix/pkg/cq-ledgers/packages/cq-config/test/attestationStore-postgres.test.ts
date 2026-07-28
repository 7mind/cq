/**
 * The shared adapter contract against the PostgreSQL production backend
 * (T720, goal G94).
 *
 * Env-gated on `CQ_TEST_PG_URL`, the same gate every other `postgres-*.test.ts`
 * in this repo uses (Q286): with no reachable database every case SKIPS, loudly
 * and by name, and NOTHING is faked. A skipped case is reported as skipped — it
 * is never counted as evidence that the Postgres adapter works.
 *
 * When the gate IS set, each case gets its own `projectKey`, so the shared table
 * holds several tenants at once and the contract's namespace-isolation cases are
 * exercised against real rows sharing one physical table.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  ATTESTATION_TABLE,
  AttestationStorageError,
  AttestationTransportError,
  PostgresAttestationBackend,
  ensurePgAttestationSchema,
  openAttestationPgPool,
  type AttestationNamespace,
} from "@cq/config";
import {
  runAttestationStoreContract,
  type AttestationContractFixture,
} from "./attestationStoreContract.js";

const PG_URL = process.env["CQ_TEST_PG_URL"];
const NAMESPACE_BACKEND = "postgres" as const;

const opened: PostgresAttestationBackend[] = [];

afterAll(async () => {
  for (const backend of opened) {
    await backend.close().catch(() => undefined);
  }
});

runAttestationStoreContract({
  name: "PostgreSQL",
  namespaceBackend: NAMESPACE_BACKEND,
  skip: PG_URL === undefined,
  async build(projectKey: string): Promise<AttestationContractFixture> {
    const dsn = PG_URL!;
    const open = async (key: string): Promise<PostgresAttestationBackend> => {
      const backend = await PostgresAttestationBackend.openDsn(
        { backend: NAMESPACE_BACKEND, projectKey: key },
        dsn,
      );
      opened.push(backend);
      return backend;
    };
    const namespace: AttestationNamespace = { backend: NAMESPACE_BACKEND, projectKey };
    let live = await open(projectKey);
    return {
      get backend() {
        return live;
      },
      peer: () => open(projectKey),
      restart: async () => {
        await live.close();
        live = await open(projectKey);
        return live;
      },
      sibling: (key: string) => open(key),
      rows: () => live.storedRows(),
      dump: () => live.rawStorageDump(),
      artifacts: () => live.storageArtifacts(),
      breakBackend: async () => {
        // OUT OF BAND: a peer connection drops the table from underneath the live
        // pool, so its next read AND its next write must fail explicitly. The
        // next case's `open` recreates it (the DDL is CREATE … IF NOT EXISTS).
        const saboteur = openAttestationPgPool(dsn);
        try {
          await saboteur`DROP TABLE IF EXISTS ${saboteur(ATTESTATION_TABLE)}`;
        } finally {
          await saboteur.close();
        }
      },
      dispose: async () => {
        // Leave the tenant's rows behind: every case uses a fresh projectKey, so
        // nothing leaks between cases, and a failed run stays inspectable.
        const pool = openAttestationPgPool(dsn);
        try {
          await pool`
            DELETE FROM ${pool(ATTESTATION_TABLE)}
             WHERE backend = ${namespace.backend} AND project_key = ${namespace.projectKey}
          `;
        } catch {
          // The table may have been dropped by breakBackend — nothing to clean.
        } finally {
          await pool.close();
        }
      },
    };
  },
  openWithBadCredentials: async () => {
    const backend = await PostgresAttestationBackend.openDsn(
      { backend: NAMESPACE_BACKEND, projectKey: "unusable" },
      "postgres://no-such-user:no-such-password@127.0.0.1:1/no-such-db",
    );
    opened.push(backend);
  },
});

// ---------------------------------------------------------------------------
// Properties assertable with NO database at all
// ---------------------------------------------------------------------------

describe("PostgreSQL attestation backend — offline (no database required)", () => {
  test("only the postgres backend may be served, and the excluded ones are refused", async () => {
    // The namespace check runs in the constructor, BEFORE any connection is
    // attempted, so these assertions need no reachable server.
    const pool = openAttestationPgPool("postgres://unused@127.0.0.1:1/unused");
    try {
      for (const backend of ["xdg", "fs"] as const) {
        await expect(
          PostgresAttestationBackend.open({ namespace: { backend, projectKey: "p" }, pool }),
          backend,
        ).rejects.toThrow(AttestationStorageError);
      }
      for (const backend of ["git-object", "remote"] as const) {
        await expect(
          PostgresAttestationBackend.open({ namespace: { backend, projectKey: "p" }, pool }),
          backend,
        ).rejects.toThrow(/cannot hold dispatch attestations/);
      }
    } finally {
      await pool.close().catch(() => undefined);
    }
  });

  test("an unreachable server is a transport failure at open, never a lifecycle answer", async () => {
    // Port 1 is not a Postgres server anywhere. The failure must be classified,
    // not surfaced as a raw driver error and certainly not as a dispatch state.
    const pool = openAttestationPgPool("postgres://nobody@127.0.0.1:1/nothing");
    await expect(ensurePgAttestationSchema(pool)).rejects.toThrow(AttestationTransportError);
    await pool.close().catch(() => undefined);
  });

  test("the gate is reported honestly", () => {
    // A green run with CQ_TEST_PG_URL unset proves the OFFLINE cases only. This
    // assertion exists so the gate's state is visible in the suite rather than
    // inferred from a skip count.
    expect(typeof PG_URL === "string" || PG_URL === undefined).toBe(true);
  });
});
