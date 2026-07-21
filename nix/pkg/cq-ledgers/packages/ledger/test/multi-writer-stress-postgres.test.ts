/**
 * T576 — multi-writer concurrency contract, LIVE against PostgresLedgerStore.
 *
 * Symmetric to multi-writer-stress.test.ts (T497/T531, `SqliteLedgerStore`):
 * the same store-factory-parameterized stress harness
 * (multiWriterStressHarness.ts) run over `PostgresLedgerStore`
 * (postgresWriterStore.ts) instead, proving the K102 cross-process
 * no-lost-update contract holds when it is Postgres write transactions
 * (`writeTransaction`/`withSerializationRetry`, T573) — not sqlite's WAL +
 * busy_timeout — serializing the concurrent writer subprocesses over one
 * shared tenant.
 *
 * Env-gated on CQ_TEST_PG_URL (Q286, same gate as every other
 * postgres-*.test.ts): no Postgres server in this sandbox/CI, so the suite
 * SKIPS cleanly offline. See dev/docker-compose.postgres.yml + dev/README.md
 * for how to stand up a local throwaway Postgres and export the var.
 */

import { describe, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  runMultiWriterStress,
  type MultiWriterStoreFactory,
} from "./multiWriterStressHarness.js";
import { createStore } from "./postgresWriterStore.js";

const PG_URL = process.env.CQ_TEST_PG_URL;
const POSTGRES_WRITER_STORE_MODULE = fileURLToPath(new URL("./postgresWriterStore.ts", import.meta.url));

function postgresMultiWriterStoreFactory(): MultiWriterStoreFactory {
  return {
    writerStoreModule: POSTGRES_WRITER_STORE_MODULE,
    createStore,
  };
}

describe.skipIf(!PG_URL)("multi-writer concurrency contract (T576, PostgresLedgerStore)", () => {
  test(
    ">= 2 writer processes over one shared PostgresLedgerStore tenant — zero lost updates, zero parse/read failures",
    async () => {
      await runMultiWriterStress(postgresMultiWriterStoreFactory(), {
        writers: 2,
        opsPerWriter: 20,
      });
    },
    60_000,
  );
});
