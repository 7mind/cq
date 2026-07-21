/**
 * postgresWriterStore — the T576 {@link WriterStoreModule} for
 * `PostgresLedgerStore`, proving the K102 cross-process multi-writer
 * contract (multiWriterStressHarness.ts doc comment) is satisfied by real
 * Postgres write transactions (`writeTransaction`/`withSerializationRetry`,
 * T573) instead of sqlite's WAL + busy_timeout (sqliteWriterStore.ts, T531).
 *
 * Imported both in-process (as the `MultiWriterStoreFactory`'s `createStore`,
 * for the coordinator's seed + verification stores) and by each writer
 * SUBPROCESS via dynamic `import()` (`multiWriterStressWriter.ts`), which
 * calls `createStore(location)` directly — this module must therefore stay
 * import-safe outside `bun test` (no `bun:test` imports; see the harness doc
 * comment).
 *
 * `location` is the harness's ONE shared value (a mkdtemp'd temp directory,
 * per `runMultiWriterStress`) handed identically to the coordinator's seed
 * store, every writer subprocess, and the final verifier — the harness has
 * no Postgres-specific hook, so this module treats that single string as a
 * combined DSN+tenant reference: the DSN comes from `CQ_TEST_PG_URL` (same
 * env gate as every other postgres-*.test.ts, Q286), while `location` itself
 * is reused (via its basename, which mkdtemp already made unique per run) as
 * the shared `projectKey` tenant every instance must converge on despite each
 * opening its own pool. `PostgresLedgerStore.init()` auto-registers the
 * tenant's `projects` row on every connect (T574), so no separate
 * registration step is needed here.
 */

import * as path from "node:path";
import type { LedgerStore } from "../src/index.js";
import { ensureSchema, openPgPool, PostgresLedgerStore } from "../src/index.js";

/** Same env var every other postgres-*.test.ts gates on (Q286). */
const PG_URL_ENV = "CQ_TEST_PG_URL";

/** Prefix distinguishing this harness's tenants from other postgres-*.test.ts suites. */
const PROJECT_KEY_PREFIX = "mw576-";

export async function createStore(location: string): Promise<LedgerStore> {
  const dsn = process.env[PG_URL_ENV];
  if (dsn === undefined || dsn.length === 0) {
    throw new Error(`postgresWriterStore: ${PG_URL_ENV} is not set`);
  }
  const projectKey = `${PROJECT_KEY_PREFIX}${path.basename(location)}`;
  const pool = openPgPool(dsn);
  await ensureSchema(pool);
  const store = new PostgresLedgerStore({ pool, projectKey, displayName: projectKey });
  await store.init();
  return store;
}
