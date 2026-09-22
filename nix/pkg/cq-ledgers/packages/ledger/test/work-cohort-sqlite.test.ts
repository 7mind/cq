import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { SCHEMA_VERSION, ensureSchema } from "../src/store/sqlite/schema.js";
import { createSqliteWorkCohortStore } from "../src/store/sqlite/sqliteWorkCohortStore.js";
import { workCohortStoreContract } from "./workCohortStoreContract.js";
import { workCohortAuthorityContract } from "./workCohortAuthorityContract.js";

const directories: string[] = [];

async function databasePath(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `cq-work-cohort-${label}-`));
  directories.push(directory);
  return join(directory, "ledger.db");
}

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SQLite work cohort store", () => {
  const fixture = async () => {
    const db = openLedgerDb(await databasePath("contract"));
    ensureSchema(db);
    return {
      store: await createSqliteWorkCohortStore(db),
      close: async () => db.close(),
    };
  };
  workCohortStoreContract("SQLite", fixture);
  workCohortAuthorityContract("SQLite [Behavioral-Active Blackbox-GoodCommunication]", fixture);

  test("upgrades an existing v8 database and mounts one XDG cohort store", async () => {
    const dbPath = await databasePath("v8-upgrade");
    const prior = openLedgerDb(dbPath);
    ensureSchema(prior);
    prior.exec("DROP TABLE work_cohort_state");
    prior.query("UPDATE meta SET value = 8 WHERE key = 'schema_version'").run();
    prior.close();

    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    try {
      expect(store.workCohortStore()).toBeDefined();
      const check = openLedgerDb(dbPath);
      try {
        const version = check
          .query<{ value: number }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
          .get();
        expect(version?.value).toBe(SCHEMA_VERSION);
        expect(
          check
            .query<{ name: string }, []>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_cohort_state'",
            )
            .get()?.name,
        ).toBe("work_cohort_state");
        expect(
          check
            .query<{ name: string }, []>("PRAGMA table_info(work_cohort_state)")
            .all()
            .map(({ name }) => name),
        ).toContain("resume_required");
      } finally {
        check.close();
      }
    } finally {
      await store.dispose();
    }
  });

  test("opening an ordinary peer connection preserves a live cohort lease", async () => {
    const dbPath = await databasePath("peer-open");
    const first = new SqliteLedgerStore({ dbPath });
    const peer = new SqliteLedgerStore({ dbPath });
    await first.init();
    const lease = await first.workCohortStore().acquireLease({
      holderId: "holder:peer-open",
      semanticSubject: "subject:peer-open",
    });
    try {
      await peer.init();
      await expect(first.workCohortStore().assertLiveAuthority(lease)).resolves.toBeUndefined();
    } finally {
      await peer.dispose();
      await first.dispose();
    }
  });
});
