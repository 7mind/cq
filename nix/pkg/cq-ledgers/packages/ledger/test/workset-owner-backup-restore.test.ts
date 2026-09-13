/**
 * T1976 — canonical ownership survives destructive SQLite backup/reinitialization.
 *
 * Constructive taxonomy: Behavioral / Active / Blackbox for the lifecycle
 * write, with one Effectual / Good-Communication assertion at the SQLite archive
 * boundary that a reinitialization backup remains structurally complete.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  GOALS_LEDGER,
  MILESTONES_LEDGER,
  MILESTONES_AMBIENT_ID,
  PLAN_REVIEW_DRAFT_FIELD,
  REVIEWS_LEDGER,
  SqliteLedgerStore,
  TASKS_LEDGER,
  buildBackupDump,
  createTrustedWorksetManagementAuthority,
  createWorksetGuardedPlanLifecycleStore,
  readCanonicalOwnership,
  restoreDumpToXdg,
  type Item,
} from "../src/index.js";
import { injectSqliteSchemaDivergence, sqliteDivergenceBackupPath } from "./sqliteSchemaFixture.js";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("workset owner backup/restore [T1976]", () => {
  it("SQLite reinitialization snapshots owned archived items before clearing the live archive", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workset-owner-reset-"));
    roots.push(root);
    const authority = createTrustedWorksetManagementAuthority();
    const sourceDb = path.join(root, "ledger.db");
    const timestamp = "2026-08-13T18:00:00.000Z";
    const rawStore = new SqliteLedgerStore({
      dbPath: sourceDb,
      now: () => "2026-08-13T18:00:00.000Z",
      worksetAuthority: authority,
    });
    await rawStore.init();
    const worksetStore = rawStore.worksetStore();
    const store = createWorksetGuardedPlanLifecycleStore({
      rawStore,
      worksetStore,
      invocationAuthority: authority,
      runOwnedTransaction: (mutate) => rawStore.runAtomicOwnedMutation(mutate),
      runPlanLifecycleTransaction: (goalId, mutate) =>
        rawStore.runAtomicWorksetPlanLifecycleMutation(goalId, mutate),
    });

    try {
      await store.init();
      await store.owned.createOwnerless({
        ledgerId: GOALS_LEDGER,
        milestoneId: MILESTONES_AMBIENT_ID,
        id: "G1",
        status: "clarifying",
        fields: { title: "Deliver", description: "Deliver the workset" },
        author: "T1976",
        session: "owner-backup",
      });
      const claimed = await store.claimPlan({
        goalId: "G1",
        purpose: "initial",
        claimRequestId: "claim-1",
        ownerFenceToken: "aaaaaaaaaaaaaaaaaaaaaa",
        expectedGeneration: null,
        author: "T1976",
        session: "owner-backup",
      });
      if (!claimed.ok) throw new Error(`claim failed: ${claimed.conflict.code}`);
      const published = await store.publishPlanDraft({
        goalId: "G1",
        claimId: claimed.acknowledgement.claimId,
        generation: claimed.acknowledgement.generation,
        operationId: "publish-1",
        ownerFenceToken: claimed.acknowledgement.ownerFenceToken,
        manifest: {
          milestones: [{ key: "delivery", title: "Delivery" }],
          tasks: [{ key: "task", milestoneKey: "delivery", headline: "Implement" }],
        },
        author: "T1976",
        session: "owner-backup",
      });
      if (!published.ok) throw new Error(`publish failed: ${published.conflict.code}`);
      const milestoneId = published.acknowledgement.manifest.milestones[0]?.id;
      const taskId = published.acknowledgement.manifest.tasks[0]?.id;
      if (milestoneId === undefined || taskId === undefined) throw new Error("manifest incomplete");
      await store.owned.createOwned({
        owner: { ledgerId: GOALS_LEDGER, itemId: "G1" },
        creationKind: "review",
        child: {
          ledgerId: REVIEWS_LEDGER,
          milestoneId: MILESTONES_AMBIENT_ID,
          id: "R1",
          status: "go-ahead",
          fields: {
            [PLAN_REVIEW_DRAFT_FIELD]: JSON.stringify({
              goalId: "G1",
              claimId: claimed.acknowledgement.claimId,
              generation: claimed.acknowledgement.generation,
              revision: published.acknowledgement.manifest.revision,
            }),
          },
          author: "T1976",
          session: "owner-backup",
        },
      });
      const finalized = await store.finalizePlan({
        goalId: "G1",
        claimId: claimed.acknowledgement.claimId,
        generation: claimed.acknowledgement.generation,
        operationId: "finalize-1",
        ownerFenceToken: claimed.acknowledgement.ownerFenceToken,
        reviewId: "R1",
        draftRevision: published.acknowledgement.manifest.revision,
        decision: { headline: "Proceed" },
        author: "T1976",
        session: "owner-backup",
      });
      if (!finalized.ok) throw new Error(`finalize failed: ${finalized.conflict.code}`);
      await store.mutations.updateItem(TASKS_LEDGER, taskId, { status: "done" });
      await store.mutations.updateItem(MILESTONES_LEDGER, milestoneId, { status: "done" });
      const pointer = await store.mutations.archiveMilestone(milestoneId, "completed delivery");
      const portableDump = await buildBackupDump(rawStore, null);

      await store.dispose();
      injectSqliteSchemaDivergence(sourceDb);
      const reinitialized = new SqliteLedgerStore({
        dbPath: sourceDb,
        now: () => timestamp,
        onSchemaDivergence: "backup-reinit",
        allowDestructiveReinitOfPopulatedStore: true,
        worksetAuthority: authority,
      });
      try {
        await reinitialized.init();
        const backup = new Database(sqliteDivergenceBackupPath(sourceDb, timestamp), { readonly: true });
        try {
          const archived = backup.query<Omit<Item, "fields"> & { fields_json: string }, [string, string]>(
            "SELECT id, milestone_id AS milestoneId, status, created_at AS createdAt, updated_at AS updatedAt, fields_json " +
            "FROM archived_items WHERE ledger = ? AND id = ?",
          ).get(MILESTONES_LEDGER, pointer.id);
          if (archived === null) throw new Error("backed-up owned milestone missing");
          expect(readCanonicalOwnership({ ...archived, fields: JSON.parse(archived.fields_json) as Item["fields"] })).toEqual({
            ownerRef: "goals:G1",
            edgeKind: "finalized-manifest",
          });
        } finally {
          backup.close();
        }
        await expect(reinitialized.fetchArchive(MILESTONES_LEDGER, pointer.id)).rejects.toThrow();
      } finally {
        await reinitialized.dispose();
      }

      const restoreDir = path.join(root, "restored");
      await mkdir(restoreDir, { recursive: true });
      const dbPath = path.join(restoreDir, "ledger.db");
      await restoreDumpToXdg({
        dbPath,
        logsDir: null,
        dump: portableDump,
        authority,
        overwriteAuthorized: false,
      });
      const restored = new SqliteLedgerStore({ dbPath });
      await restored.init();
      try {
        expect(readCanonicalOwnership(restored.fetchItem(REVIEWS_LEDGER, "R1"))).toEqual({
          ownerRef: "goals:G1",
          edgeKind: "review",
        });
        const milestoneArchive = await restored.fetchArchive(MILESTONES_LEDGER, pointer.id);
        if (milestoneArchive.kind !== "item") throw new Error("milestone archive kind mismatch");
        expect(readCanonicalOwnership(milestoneArchive.item)).toEqual({
          ownerRef: "goals:G1",
          edgeKind: "finalized-manifest",
        });
        const restoredTasks = await restored.fetchArchive(TASKS_LEDGER, pointer.id);
        if (restoredTasks.kind !== "group") throw new Error("task archive kind mismatch");
        const restoredTask = restoredTasks.milestone.items.find(({ id }) => id === taskId);
        if (restoredTask === undefined) throw new Error("restored archived task missing");
        expect(readCanonicalOwnership(restoredTask)).toEqual({
          ownerRef: "goals:G1",
          edgeKind: "finalized-manifest",
        });
      } finally {
        await restored.dispose();
      }
    } finally {
      await store.dispose();
    }
  });

  async function backupFailureFixture(prefix: string, timestamp: string) {
    const root = await mkdtemp(path.join(tmpdir(), prefix));
    roots.push(root);
    const dbPath = path.join(root, "ledger.db");
    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    try {
      const milestone = await store.createMilestone({ title: "backup failure" });
      await store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
        id: "G1",
        status: "planned",
        fields: { title: "archive owner", description: "ownership must survive" },
      });
      await store.runAtomicOwnedMutation((tx) => tx.createItemWithSealedOwnership(
        TASKS_LEDGER,
        milestone.id,
        { status: "done", fields: { headline: "sealed archive bytes" } },
        { ownerRef: "goals:G1", edgeKind: "finalized-manifest" },
      ));
      await store.updateMilestone(milestone.id, { status: "done" });
      await store.archiveMilestone(milestone.id, "sealed archive");
    } finally {
      await store.dispose();
    }
    injectSqliteSchemaDivergence(dbPath);
    return {
      dbPath,
      backupPath: sqliteDivergenceBackupPath(dbPath, timestamp),
      reinitialize: () => new SqliteLedgerStore({
        dbPath,
        now: () => timestamp,
        onSchemaDivergence: "backup-reinit",
        allowDestructiveReinitOfPopulatedStore: true,
        worksetAuthority: createTrustedWorksetManagementAuthority(),
      }),
    };
  }

  function archivedRows(dbPath: string) {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.query("SELECT * FROM archived_items ORDER BY ledger, pointer_id, id").all();
    } finally {
      db.close();
    }
  }

  it("SQLite snapshot failure keeps the live archive recoverable for retry", async () => {
    const fixture = await backupFailureFixture(
      "workset-owner-copy-failure-",
      "2026-08-13T18:30:00.000Z",
    );
    const before = archivedRows(fixture.dbPath);
    expect(before.length).toBeGreaterThan(0);
    await writeFile(fixture.backupPath, "destination collision", "utf8");
    await expect(fixture.reinitialize().init()).rejects.toThrow();
    expect(archivedRows(fixture.dbPath)).toEqual(before);

    await rm(fixture.backupPath);
    const retried = fixture.reinitialize();
    try {
      await retried.init();
      expect(archivedRows(fixture.backupPath)).toEqual(before);
      expect(archivedRows(fixture.dbPath)).toEqual([]);
    } finally {
      await retried.dispose();
    }
  });

  it("SQLite late reinitialization failure retains both snapshot and live archives until retry", async () => {
    const fixture = await backupFailureFixture(
      "workset-owner-late-failure-",
      "2026-08-13T18:45:00.000Z",
    );
    const before = archivedRows(fixture.dbPath);
    expect(before.length).toBeGreaterThan(0);
    const fault = new Database(fixture.dbPath, { readwrite: true, create: false });
    try {
      fault.exec(`
        CREATE TRIGGER test_reinit_fault BEFORE DELETE ON archived_items
        BEGIN SELECT RAISE(ABORT, 'injected reinitialization failure'); END
      `);
    } finally {
      fault.close();
    }
    await expect(fixture.reinitialize().init()).rejects.toThrow("injected reinitialization failure");
    expect(archivedRows(fixture.backupPath)).toEqual(before);
    expect(archivedRows(fixture.dbPath)).toEqual(before);

    const repaired = new Database(fixture.dbPath, { readwrite: true, create: false });
    try {
      repaired.exec("DROP TRIGGER test_reinit_fault");
    } finally {
      repaired.close();
    }
    const retainedBackup = `${fixture.backupPath}.retained`;
    await rename(fixture.backupPath, retainedBackup);
    const retried = fixture.reinitialize();
    try {
      await retried.init();
      expect(archivedRows(retainedBackup)).toEqual(before);
      expect(archivedRows(fixture.backupPath)).toEqual(before);
      expect(archivedRows(fixture.dbPath)).toEqual([]);
    } finally {
      await retried.dispose();
    }
  });
});
