import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { SQL } from "bun";

import {
  WorkCohortServiceV1,
  WorkCohortStaleAuthorityError,
  parseWorkCohortPortableStateV1,
} from "../src/workCohortStore.js";
import { GOALS_LEDGER, GOALS_SCHEMA } from "../src/constants.js";
import { buildBackupDump } from "../src/store/backupExporter.js";
import { openPgPool } from "../src/store/postgres/connection.js";
import { PostgresLedgerStore } from "../src/store/postgres/PostgresLedgerStore.js";
import { restoreDumpToPostgres } from "../src/store/postgres/restoreImporter.js";
import {
  createPostgresWorkCohortStore,
} from "../src/store/postgres/postgresWorkCohortStore.js";
import { ensureSchema, PG_SCHEMA_VERSION } from "../src/store/postgres/schema.js";
import { createTrustedWorksetManagementAuthority } from "../src/worksetInvocationAuthority.js";
import { sha256 } from "./workCohortFixture.js";
import { recordFixtureCohortAcceptance } from "./workCohortAcceptanceFixture.js";
import { workCohortAcceptanceContract } from "./workCohortAcceptanceContract.js";
import { workCohortAuthorityContract } from "./workCohortAuthorityContract.js";
import {
  prepareWorkCohortStore,
  workCohortStoreContract,
  workCohortStoreFixture,
} from "./workCohortStoreContract.js";

const PG_URL = process.env.CQ_TEST_PG_URL;

function projectKey(label: string): string {
  return `cohort-${label}-${randomUUID()}`;
}

async function removeOwnedFixtureTenant(pool: SQL, key: string): Promise<void> {
  await pool.begin(async (tx) => {
    await tx`DELETE FROM workset_admissions WHERE project_key = ${key}`;
    await tx`DELETE FROM workset_roots WHERE project_key = ${key}`;
    await tx`DELETE FROM work_cohort_state WHERE project_key = ${key}`;
    await tx`DELETE FROM implementation_completion_bindings WHERE project_key = ${key}`;
    await tx`DELETE FROM plan_operations WHERE project_key = ${key}`;
    await tx`DELETE FROM plan_claims WHERE project_key = ${key}`;
    await tx`DELETE FROM mcp_usage_stats WHERE project_key = ${key}`;
    await tx`DELETE FROM archived_items WHERE project_key = ${key}`;
    await tx`DELETE FROM archive_pointers WHERE project_key = ${key}`;
    await tx`DELETE FROM items WHERE project_key = ${key}`;
    await tx`DELETE FROM groups WHERE project_key = ${key}`;
    await tx`DELETE FROM ledgers WHERE project_key = ${key}`;
    await tx`DELETE FROM logs WHERE project_key = ${key}`;
    await tx`DELETE FROM projects WHERE project_key = ${key}`;
  });
}

async function disposeFixtureStores(stores: readonly PostgresLedgerStore[]): Promise<void> {
  const disposals = await Promise.allSettled(stores.map((store) => store.dispose()));
  const failures = disposals.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "failed to dispose PostgreSQL peer fixtures");
  }
}

describe.skipIf(PG_URL === undefined)("PostgreSQL work cohort store", () => {
  const fixture = async () => {
    const pool = openPgPool(PG_URL!);
    await ensureSchema(pool);
    const key = projectKey("contract");
    await pool`INSERT INTO projects (project_key, display_name) VALUES (${key}, ${key})`;
    return {
      store: await createPostgresWorkCohortStore(pool, key),
      close: async () => {
        await pool`DELETE FROM work_cohort_state WHERE project_key = ${key}`;
        await pool`DELETE FROM projects WHERE project_key = ${key}`;
        await pool.close();
      },
    };
  };
  workCohortStoreContract("PostgreSQL", fixture);
  workCohortAuthorityContract("PostgreSQL [Behavioral-Active Blackbox-GoodCommunication]", fixture);
  workCohortAcceptanceContract("PostgreSQL [Behavioral-Active Blackbox-GoodCommunication]", fixture);

  test("upgrades an isolated real v3 layout to the current schema", async () => {
    const admin = openPgPool(PG_URL!);
    const schema = `cohort_upgrade_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    const url = new URL(PG_URL!);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    const pool = openPgPool(url.toString());
    try {
      await ensureSchema(pool);
      await pool`DROP TABLE work_cohort_state`;
      await pool`UPDATE meta SET value = '3' WHERE key = 'schema_version'`;
      await ensureSchema(pool);
      const version = await pool<Array<{ value: string }>>`
        SELECT value FROM meta WHERE key = 'schema_version'
      `;
      const tables = await pool<Array<{ table_name: string }>>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = ${schema} AND table_name = 'work_cohort_state'
      `;
      const columns = await pool<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = ${schema} AND table_name = 'work_cohort_state'
      `;
      expect(version[0]?.value).toBe(String(PG_SCHEMA_VERSION));
      expect(PG_SCHEMA_VERSION).toBe(5);
      expect(tables).toHaveLength(1);
      expect(columns.map(({ column_name }) => column_name)).toContain("resume_required");
    } finally {
      await pool.close();
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    }
  });

  test("cross-connection reservation, seal, finalization, restart, isolation, and stale-holder fencing", async () => {
    const poolA = openPgPool(PG_URL!);
    const poolB = openPgPool(PG_URL!);
    await ensureSchema(poolA);
    const key = projectKey("cross-connection");
    const otherKey = projectKey("isolated");
    await poolA`INSERT INTO projects (project_key, display_name) VALUES (${key}, ${key}), (${otherKey}, ${otherKey})`;
    const storeA = await createPostgresWorkCohortStore(poolA, key);
    const storeB = await createPostgresWorkCohortStore(poolB, key);
    const isolated = await createPostgresWorkCohortStore(poolB, otherKey);
    try {
      const fixture = await workCohortStoreFixture("postgres-live", 1);
      await prepareWorkCohortStore(storeA, fixture);
      expect((await isolated.snapshot()).portable.definitions).toEqual([]);

      const reservations = await Promise.allSettled([
        storeA.transitionReservation("reserve:a", {
          reservationId: "reservation:a",
          cohortId: fixture.definition.cohortId,
          definitionDigest: fixture.definition.definitionDigest,
          memberRefs: fixture.definition.members.map((member) => member.memberRef),
          transition: "reserved",
        }),
        storeB.transitionReservation("reserve:b", {
          reservationId: "reservation:b",
          cohortId: fixture.definition.cohortId,
          definitionDigest: fixture.definition.definitionDigest,
          memberRefs: fixture.definition.members.map((member) => member.memberRef),
          transition: "reserved",
        }),
      ]);
      expect(reservations.filter((result) => result.status === "fulfilled")).toHaveLength(1);

      const sealed = await storeA.sealCandidate("seal:live", fixture.request);
      expect(await storeB.sealCandidate("seal:live", fixture.request)).toEqual(sealed);
      const focusedProbe = await storeB.recordProbe("probe:focused", {
        evidenceSubjectDigest: sealed.evidenceSubject.evidenceSubjectDigest,
        probeKind: "focused",
        probeEpoch: 1,
        commandDigest: sha256("focused command"),
      });
      const sharedProbe = await storeB.recordProbe("probe:shared", {
        evidenceSubjectDigest: sealed.evidenceSubject.evidenceSubjectDigest,
        probeKind: "shared-regression",
        probeEpoch: 1,
        commandDigest: sha256("shared command"),
      });
      await storeA.recordCommandEvidence("evidence:focused", {
        evidenceSubjectDigest: sealed.evidenceSubject.evidenceSubjectDigest,
        acceptanceMatrixDigest: fixture.definition.acceptanceMatrixDigest,
        probeDigest: focusedProbe.probeDigest,
        evidenceKind: "focused",
        passed: true,
        receiptDigest: sha256("focused receipt"),
      });
      await storeA.recordCommandEvidence("evidence:shared", {
        evidenceSubjectDigest: sealed.evidenceSubject.evidenceSubjectDigest,
        acceptanceMatrixDigest: fixture.definition.acceptanceMatrixDigest,
        probeDigest: sharedProbe.probeDigest,
        evidenceKind: "shared-regression",
        passed: true,
        receiptDigest: sha256("shared receipt"),
      });
      await recordFixtureCohortAcceptance(storeA, sealed.evidenceSubject.evidenceSubjectDigest);
      const completion = await storeB.finalize("finalize:live", {
        definitionDigest: fixture.definition.definitionDigest,
        evidenceSubjectDigest: sealed.evidenceSubject.evidenceSubjectDigest,
      });
      expect(completion.sealDigest).toBe(sealed.seal.sealDigest);

      const lease = await storeA.acquireLease({
        holderId: "holder:before-restart",
        semanticSubject: sealed.evidenceSubject.evidenceSubjectDigest,
      });
      const restarted = await createPostgresWorkCohortStore(poolB, key);
      await restarted.beginNewExecutionEpoch();
      expect((await restarted.snapshot()).portable.completionReceipts).toContainEqual(completion);
      await expect(restarted.assertLiveAuthority(lease)).rejects.toBeInstanceOf(
        WorkCohortStaleAuthorityError,
      );
    } finally {
      await poolA`DELETE FROM work_cohort_state WHERE project_key IN (${key}, ${otherKey})`;
      await poolA`DELETE FROM projects WHERE project_key IN (${key}, ${otherKey})`;
      await poolA.close();
      await poolB.close();
    }
  });

  test("ordinary tenant peers preserve live authority until explicit takeover", async () => {
    const poolA = openPgPool(PG_URL!);
    const poolB = openPgPool(PG_URL!);
    await ensureSchema(poolA);
    const key = projectKey("peer-open");
    const first = new PostgresLedgerStore({ pool: poolA, projectKey: key, displayName: key });
    const peer = new PostgresLedgerStore({ pool: poolB, projectKey: key, displayName: key });
    try {
      await first.init();
      const lease = await first.workCohortStore().acquireLease({
        holderId: "holder:postgres-peer-open",
        semanticSubject: "subject:postgres-peer-open",
      });
      await peer.init();
      await expect(first.workCohortStore().assertLiveAuthority(lease)).resolves.toBeUndefined();
      await peer.workCohortStore().beginNewExecutionEpoch();
      await expect(first.workCohortStore().assertLiveAuthority(lease)).rejects.toBeInstanceOf(
        WorkCohortStaleAuthorityError,
      );
    } finally {
      try {
        await removeOwnedFixtureTenant(poolA, key);
      } finally {
        await disposeFixtureStores([first, peer]);
      }
    }
  });

  test("production backup, restore, reset, erase, and metadata-only admission preserve lifecycle boundaries", async () => {
    const admin = openPgPool(PG_URL!);
    await ensureSchema(admin);
    const sourceKey = projectKey("lifecycle-source");
    const targetKey = projectKey("lifecycle-target");
    const source = new PostgresLedgerStore({
      pool: openPgPool(PG_URL!),
      projectKey: sourceKey,
      displayName: sourceKey,
    });
    const fixture = await workCohortStoreFixture("postgres-lifecycle", 1);
    await source.init();
    await prepareWorkCohortStore(source.workCohortStore(), fixture);
    const before = await source.workCohortStore().snapshot();
    const dump = await buildBackupDump(source, null);

    await expect(
      restoreDumpToPostgres({
        pool: admin,
        projectKey: targetKey,
        dump,
        authority: {},
        overwriteAuthorized: false,
      }),
    ).rejects.toThrow("trusted management authority");
    expect(
      await admin<Array<{ count: string }>>`
        SELECT count(*)::text AS count FROM projects WHERE project_key = ${targetKey}
      `,
    ).toEqual([{ count: "0" }]);

    await restoreDumpToPostgres({
      pool: admin,
      projectKey: targetKey,
      dump,
      authority: createTrustedWorksetManagementAuthority(),
      overwriteAuthorized: false,
    });
    const target = new PostgresLedgerStore({
      pool: openPgPool(PG_URL!),
      projectKey: targetKey,
      displayName: targetKey,
    });
    await target.init();
    try {
      const restored = await target.workCohortStore().snapshot();
      expect(restored.portable).toEqual(before.portable);
      expect(restored.runtime.executionEpoch).not.toBe(before.runtime.executionEpoch);
      expect(restored.runtime.resumeRequired).toBeTrue();
      expect(restored.runtime.lease).toBeNull();

      const metadataOnly = new WorkCohortServiceV1({
        store: target.workCohortStore(),
        executor: null,
      });
      const beforeDeniedEffects = await metadataOnly.status();
      expect(() => metadataOnly.enrollCandidate("remote:enroll", fixture.pending)).toThrow(
        "requires a repository executor",
      );
      expect(() =>
        metadataOnly.acquireRepositoryEffect({
          holderId: "remote-holder",
          semanticSubject: fixture.definition.definitionDigest,
        }),
      ).toThrow("requires a repository executor");
      expect(await metadataOnly.status()).toEqual(beforeDeniedEffects);

      await expect(target.resetTenant({ authority: {} })).rejects.toThrow(
        "trusted management authority",
      );
      expect((await target.workCohortStore().snapshot()).portable).toEqual(before.portable);
      await target.resetTenant({ authority: createTrustedWorksetManagementAuthority() });
      expect((await target.workCohortStore().snapshot()).portable.observations).toEqual([]);

      await prepareWorkCohortStore(target.workCohortStore(), fixture);
      await expect(target.eraseTenant({ authority: {} })).rejects.toThrow(
        "trusted management authority",
      );
      expect((await target.workCohortStore().snapshot()).portable.definitions).toHaveLength(1);
      await target.eraseTenant({ authority: createTrustedWorksetManagementAuthority() });
      expect(
        await admin<Array<{ count: string }>>`
          SELECT count(*)::text AS count FROM work_cohort_state WHERE project_key = ${targetKey}
        `,
      ).toEqual([{ count: "0" }]);
    } finally {
      await target.dispose();
      await source.eraseTenant({ authority: createTrustedWorksetManagementAuthority() });
      await source.dispose();
      await admin.close();
    }
  });

  test("schema divergence shadows portable history with a fresh fenced runtime", async () => {
    const admin = openPgPool(PG_URL!);
    await ensureSchema(admin);
    const key = projectKey("divergence");
    const timestamp = "2026-09-19T12:30:00.000Z";
    const shadowKey = `${key}__divergence-backup-${timestamp.replace(/[^0-9A-Za-z]/g, "-")}`;
    const seed = new PostgresLedgerStore({
      pool: openPgPool(PG_URL!),
      projectKey: key,
      displayName: key,
    });
    const fixture = await workCohortStoreFixture("postgres-divergence", 1);
    await seed.init();
    await prepareWorkCohortStore(seed.workCohortStore(), fixture);
    const before = await seed.workCohortStore().snapshot();
    await seed.dispose();
    await admin`
      UPDATE ledgers SET schema_json = ${JSON.stringify({ ...GOALS_SCHEMA, statusValues: ["divergent"] })}
      WHERE project_key = ${key} AND name = ${GOALS_LEDGER}
    `;

    const reinitialized = new PostgresLedgerStore({
      pool: openPgPool(PG_URL!),
      projectKey: key,
      displayName: key,
      now: () => timestamp,
      onSchemaDivergence: "backup-reinit",
      worksetAuthority: createTrustedWorksetManagementAuthority(),
    });
    let initialized = false;
    try {
      await reinitialized.init();
      initialized = true;
      expect((await reinitialized.workCohortStore().snapshot()).portable.observations).toEqual([]);
      const shadow = await admin<Array<{
        state_json: string;
        execution_epoch: string;
        resume_required: boolean;
        lease_json: string | null;
      }>>`
        SELECT state_json, execution_epoch, resume_required, lease_json
        FROM work_cohort_state WHERE project_key = ${shadowKey}
      `;
      expect(shadow).toHaveLength(1);
      expect(parseWorkCohortPortableStateV1(shadow[0]!.state_json)).toEqual(before.portable);
      expect(shadow[0]!.execution_epoch).not.toBe(before.runtime.executionEpoch);
      expect(shadow[0]!.resume_required).toBeTrue();
      expect(shadow[0]!.lease_json).toBeNull();
    } finally {
      if (initialized) {
        await reinitialized.eraseTenant({ authority: createTrustedWorksetManagementAuthority() });
      }
      await reinitialized.dispose();
      await admin.close();
    }
  });
});
