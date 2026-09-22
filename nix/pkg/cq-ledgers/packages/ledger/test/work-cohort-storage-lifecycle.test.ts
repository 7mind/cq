import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { constructCohortDecisionsV1, createCohortDefinitionIdentityV1 } from "../src/workCohort.js";
import {
  WORK_COHORT_DUMP_PATH,
  parseWorkCohortPortableStateV1,
} from "../src/workCohortStore.js";
import { buildBackupDump } from "../src/store/backupExporter.js";
import { restoreDumpToXdg } from "../src/store/restoreImporter.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { createTrustedWorksetManagementAuthority } from "../src/worksetInvocationAuthority.js";
import { observationFor } from "./workCohortFixture.js";
import {
  injectSqliteSchemaDivergence,
  sqliteDivergenceBackupPath,
} from "./sqliteSchemaFixture.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";

const directories: string[] = [];

async function freshPath(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `cq-cohort-lifecycle-${label}-`));
  directories.push(directory);
  return join(directory, "ledger.db");
}

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("work cohort storage lifecycle", () => {
  test("portable parsing rejects open and internally inconsistent records", async () => {
    const observation = await observationFor([{ ref: "tasks:T1" }]);
    const decision = constructCohortDecisionsV1(observation)[0]!;
    const definition = createCohortDefinitionIdentityV1({
      cohortId: "cohort:strict-portable",
      observation,
      decision,
      prior: null,
    });
    const source = new SqliteLedgerStore({ dbPath: await freshPath("strict-portable") });
    await source.init();
    try {
      await source.workCohortStore().recordObservation("observe", observation);
      await source.workCohortStore().recordDecision("decide", decision);
      await source.workCohortStore().recordDefinition("define", definition);
      const portable = (await source.workCohortStore().snapshot()).portable;
      expect(() =>
        parseWorkCohortPortableStateV1(
          JSON.stringify({ ...portable, unexpectedPortableAuthority: "capability" }),
        ),
      ).toThrow("unknown field");
      expect(() =>
        parseWorkCohortPortableStateV1(
          JSON.stringify({
            ...portable,
            definitions: [{ ...definition, environment: { environmentDigest: "0".repeat(64) } }],
          }),
        ),
      ).toThrow("definition digest");
    } finally {
      await source.dispose();
    }
  });

  test("backup and restore preserve portable identity while clearing live authority", async () => {
    const source = new SqliteLedgerStore({ dbPath: await freshPath("source") });
    await source.init();
    const observation = await observationFor([{ ref: "tasks:T1" }, { ref: "tasks:T2" }]);
    const decision = constructCohortDecisionsV1(observation)[0]!;
    const definition = createCohortDefinitionIdentityV1({
      cohortId: "cohort:lifecycle",
      observation,
      decision,
      prior: null,
    });
    const cohort = source.workCohortStore();
    await cohort.recordObservation("observe", observation);
    await cohort.recordDecision("decide", decision);
    await cohort.recordDefinition("define", definition);
    const lease = await cohort.acquireLease({
      holderId: "holder:source",
      semanticSubject: definition.definitionDigest,
    });
    const before = await cohort.snapshot();
    const dump = await buildBackupDump(source, null);
    await source.dispose();

    const cohortFile = dump.find((file) => file.path === WORK_COHORT_DUMP_PATH);
    expect(cohortFile).toBeDefined();
    expect(cohortFile?.content).not.toContain(lease.capability);
    expect(cohortFile?.content).not.toContain(before.runtime.executionEpoch);

    const targetPath = await freshPath("target");
    await restoreDumpToXdg({
      dbPath: targetPath,
      logsDir: null,
      dump,
      authority: createTrustedWorksetManagementAuthority(),
      overwriteAuthorized: false,
    });
    const target = new SqliteLedgerStore({ dbPath: targetPath });
    await target.init();
    try {
      const restored = await target.workCohortStore().snapshot();
      expect(restored.portable).toEqual(before.portable);
      expect(restored.runtime.executionEpoch).not.toBe(before.runtime.executionEpoch);
      expect(restored.runtime.resumeRequired).toBeTrue();
      expect(restored.runtime.lease).toBeNull();
      expect(restored.runtime.resumeValidation).toBeNull();
    } finally {
      await target.dispose();
    }
  });

  test("restore refuses ordinary authority before opening or changing the target", async () => {
    const source = new SqliteLedgerStore({ dbPath: await freshPath("denied-source") });
    await source.init();
    const dump = await buildBackupDump(source, null);
    await source.dispose();
    await expect(
      restoreDumpToXdg({
        dbPath: await freshPath("denied-target"),
        logsDir: null,
        dump,
        authority: {},
        overwriteAuthorized: false,
      }),
    ).rejects.toThrow("trusted management authority");
  });

  test("schema-divergence reinitialization preserves cohort history only in its backup", async () => {
    const dbPath = await freshPath("divergence");
    const seed = new SqliteLedgerStore({ dbPath });
    await seed.init();
    const observation = await observationFor([{ ref: "tasks:T1" }]);
    await seed.workCohortStore().recordObservation("observe", observation);
    await seed.dispose();
    injectSqliteSchemaDivergence(dbPath);

    const timestamp = "2026-09-19T12:00:00.000Z";
    const backupPath = sqliteDivergenceBackupPath(dbPath, timestamp);
    const reinitialized = new SqliteLedgerStore({
      dbPath,
      now: () => timestamp,
      onSchemaDivergence: "backup-reinit",
      worksetAuthority: createTrustedWorksetManagementAuthority(),
    });
    await reinitialized.init();
    try {
      expect((await reinitialized.workCohortStore().snapshot()).portable.observations).toEqual([]);
      const backup = openLedgerDb(backupPath);
      try {
        const row = backup
          .query<{ state_json: string }, []>(
            "SELECT state_json FROM work_cohort_state WHERE id = 1",
          )
          .get();
        expect(row).not.toBeNull();
        expect(parseWorkCohortPortableStateV1(row!.state_json).observations).toEqual([
          observation,
        ]);
      } finally {
        backup.close();
      }
    } finally {
      await reinitialized.dispose();
    }
  });
});
