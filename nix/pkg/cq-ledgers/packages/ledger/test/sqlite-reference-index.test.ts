import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SqliteLedgerStore, TASKS_LEDGER } from "../src/index.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchPath(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `${label}-`));
  roots.push(root);
  return path.join(root, "ledger.db");
}

interface ReferenceEdge {
  readonly source_ledger: string;
  readonly source_id: string;
  readonly field_name: string;
  readonly target_ledger: string;
  readonly target_id: string;
}

function readEdges(dbPath: string): ReferenceEdge[] {
  const db = openLedgerDb(dbPath);
  try {
    return db
      .query(
        `SELECT source_ledger, source_id, field_name, target_ledger, target_id
         FROM item_references
         ORDER BY source_ledger, source_id, field_name, target_ledger, target_id`,
      )
      .all() as ReferenceEdge[];
  } finally {
    db.close();
  }
}

async function populate(dbPath: string): Promise<{ milestoneId: string; dependentId: string }> {
  const store = new SqliteLedgerStore({ dbPath });
  await store.init();
  try {
    const milestone = await store.createMilestone({ title: "reference fixture" });
    const target = await store.createItem(TASKS_LEDGER, milestone.id, {
      id: "T9501",
      status: "planned",
      fields: { headline: "target" },
    });
    const dependent = await store.createItem(TASKS_LEDGER, milestone.id, {
      id: "T9502",
      status: "planned",
      fields: {
        headline: "dependent",
        dependsOn: [`${TASKS_LEDGER}:${target.id}`],
        ledgerRefs: [`${TASKS_LEDGER}:${target.id}`],
      },
    });
    return { milestoneId: milestone.id, dependentId: dependent.id };
  } finally {
    await store.dispose();
  }
}

test("v5 migration and fresh v6 writes produce identical active reference edges", async () => {
  const freshPath = scratchPath("sqlite-reference-fresh");
  const migratedPath = scratchPath("sqlite-reference-migrated");
  await populate(freshPath);
  await populate(migratedPath);

  const legacy = openLedgerDb(migratedPath);
  legacy.query("DELETE FROM item_references").run();
  legacy.query("UPDATE meta SET value = 5 WHERE key = 'schema_version'").run();
  legacy.close();

  const migrated = new SqliteLedgerStore({ dbPath: migratedPath });
  await migrated.init();
  await migrated.dispose();

  expect(readEdges(migratedPath)).toEqual(readEdges(freshPath));

  const v6 = openLedgerDb(migratedPath);
  v6.query("DELETE FROM item_references WHERE source_ledger = ? AND source_id = ?").run(
    TASKS_LEDGER,
    "T9502",
  );
  v6.close();
  const reopened = new SqliteLedgerStore({ dbPath: migratedPath });
  await reopened.init();
  await reopened.dispose();
  expect(readEdges(migratedPath)).toEqual([]);
});

test("active reference edges follow update, archive, and unarchive moves", async () => {
  const dbPath = scratchPath("sqlite-reference-maintenance");
  const fixture = await populate(dbPath);
  const store = new SqliteLedgerStore({ dbPath });
  await store.init();
  try {
    expect(
      readEdges(dbPath)
        .map(({ field_name }) => field_name)
        .sort(),
    ).toEqual(["dependsOn", "ledgerRefs"]);
    await store.updateItem(TASKS_LEDGER, fixture.dependentId, {
      fields: { dependsOn: [], ledgerRefs: [] },
    });
    expect(readEdges(dbPath)).toEqual([]);

    await store.updateItem(TASKS_LEDGER, fixture.dependentId, {
      fields: { dependsOn: [`${TASKS_LEDGER}:T9501`] },
    });
    await store.updateItem(TASKS_LEDGER, "T9501", { status: "done" });
    await store.updateItem(TASKS_LEDGER, fixture.dependentId, { status: "done" });
    await store.updateMilestone(fixture.milestoneId, { status: "done" });
    await store.archiveMilestone(fixture.milestoneId, "complete");
    expect(readEdges(dbPath)).toEqual([]);

    await store.unarchiveItem(TASKS_LEDGER, fixture.milestoneId, fixture.dependentId);
    expect(readEdges(dbPath)).toEqual([
      {
        source_ledger: TASKS_LEDGER,
        source_id: fixture.dependentId,
        field_name: "dependsOn",
        target_ledger: TASKS_LEDGER,
        target_id: "T9501",
      },
    ]);
  } finally {
    await store.dispose();
  }
});
