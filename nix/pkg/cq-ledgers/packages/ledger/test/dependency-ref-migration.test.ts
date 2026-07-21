/**
 * G80/M245 dependency-ref data migration (T553) — the FINAL expand-then-migrate
 * step. Readers (T552/T554) and writers (T551) already tolerate BOTH the bare
 * ("T523") and prefixed ("tasks:T523") forms; this task settles the STORED data
 * on the canonical `<ledger>:<id>` form:
 *
 *   1. SqliteLedgerStore.init() runs a versioned in-place v1→v2 migration:
 *      snapshot first (VACUUM INTO sibling), then rewrite every items AND
 *      archived_items fields_json dependsOn/blockedBy to prefixed form by exact
 *      alpha-prefix resolution, refresh canonical ledgers' schema_json to canon
 *      (satisfiesDependencyStatuses), bump schema_version to 2. Unresolvable
 *      entries (free-text, unknown prefix, the dash-bearing M-AMBIENT) survive
 *      VERBATIM. Opening a v2 store is a strict no-op.
 *   2. `cq restore` (restoreDumpToXdg) normalizes the same way as it re-inserts
 *      rows, so an OLD (pre-grammar) backup with bare refs lands normalized.
 *   3. The shared pure helper normalizeStoredRefFields is the single source of
 *      truth all three ingestion points (migration, restore, in-memory load)
 *      call — proven here to be idempotent + data-preserving.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { FieldValue, LedgerSchema } from "../src/types.js";
import {
  CANONICAL_LEDGERS,
  DEFECTS_SCHEMA,
  MILESTONES_AMBIENT_ID,
} from "../src/constants.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { buildBackupDump, type BackupDumpFile } from "../src/store/backupExporter.js";
import { restoreDumpToXdg } from "../src/store/restoreImporter.js";
import { buildPrefixRegistry, normalizeStoredRefFields } from "../src/refs.js";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";
const now = (): string => FIXED_NOW;

const dirs: string[] = [];
async function freshDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Raw SELECT of every active + archived item's stored fields_json, keyed by a
 * stable `<table>:<ledger>:<id>` composite so two reads compare byte-for-byte. */
function captureFieldsJson(dbPath: string): Map<string, string> {
  const db = openLedgerDb(dbPath);
  try {
    const out = new Map<string, string>();
    for (const table of ["items", "archived_items"] as const) {
      const rows = db
        .query(`SELECT ledger, id, fields_json FROM ${table} ORDER BY ledger, id`)
        .all() as Array<{ ledger: string; id: string; fields_json: string }>;
      for (const r of rows) out.set(`${table}:${r.ledger}:${r.id}`, r.fields_json);
    }
    return out;
  } finally {
    db.close();
  }
}

async function snapshotFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  return names.filter((n) => n.includes(".pre-v2-migration-")).sort();
}

/**
 * Build a v1-shaped fixture db: init a fresh (v2) store, create a target task,
 * a dependent defect, and a milestone, then REGRESS the rows via raw SQL to the
 * bare-ref pre-grammar shape + schema_version 1 — mimicking real v1 data with a
 * cross-ledger defect→task bare ref, a milestone dependsOn bare ref, and a
 * free-text (+ dash-bearing M-AMBIENT) blockedBy.
 */
async function buildV1Fixture(dbPath: string): Promise<void> {
  const store = new SqliteLedgerStore({ dbPath, now });
  await store.init();
  await store.createItem("tasks", MILESTONES_AMBIENT_ID, {
    status: "planned",
    fields: { headline: "target task" },
  }); // -> T1
  await store.createItem("defects", MILESTONES_AMBIENT_ID, {
    status: "open",
    fields: { headline: "dependent defect", severity: "low" },
  }); // -> D1
  await store.createMilestone({ title: "milestone one" }); // -> M1
  await store.dispose();

  // Regress to v1 with raw SQL.
  const db = openLedgerDb(dbPath);
  try {
    db.query("UPDATE items SET fields_json = ? WHERE ledger = 'defects' AND id = 'D1'").run(
      JSON.stringify({
        headline: "dependent defect",
        severity: "low",
        dependsOn: ["T1"], // cross-ledger bare ref -> tasks:T1
        blockedBy: ["awaiting external sign-off", "M-AMBIENT"], // free-text + dash: verbatim
      }),
    );
    db.query("UPDATE items SET fields_json = ? WHERE ledger = 'milestones' AND id = 'M1'").run(
      JSON.stringify({ title: "milestone one", dependsOn: ["M245"] }), // bare -> milestones:M245
    );
    // Downgrade every canonical ledger's schema_json to a pre-v2 shape (strip
    // satisfiesDependencyStatuses); schemasEqual ignores that facet, so Pass 1
    // would NOT restore it on its own — the migration's step (c) must.
    const upgrade = db.query("UPDATE ledgers SET schema_json = ? WHERE name = ?");
    for (const c of CANONICAL_LEDGERS) {
      const stripped: LedgerSchema = { ...c.schema };
      delete stripped.satisfiesDependencyStatuses;
      upgrade.run(JSON.stringify(stripped), c.name);
    }
    db.query("UPDATE meta SET value = 1 WHERE key = 'schema_version'").run();
  } finally {
    db.close();
  }
}

function readSchemaJson(dbPath: string, name: string): LedgerSchema {
  const db = openLedgerDb(dbPath);
  try {
    const row = db
      .query("SELECT schema_json FROM ledgers WHERE name = ?")
      .get(name) as { schema_json: string };
    return JSON.parse(row.schema_json) as LedgerSchema;
  } finally {
    db.close();
  }
}

function readSchemaVersion(dbPath: string): number {
  const db = openLedgerDb(dbPath);
  try {
    const row = db
      .query("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: number };
    return Number(row.value);
  } finally {
    db.close();
  }
}

describe("SqliteLedgerStore v1->v2 dependency-ref migration (T553)", () => {
  test("on-open migration: snapshot + prefixed refs + verbatim free-text + schema + version", async () => {
    const dir = await freshDir("ledger-mig-");
    const dbPath = path.join(dir, "ledger.db");
    await buildV1Fixture(dbPath);

    // Sanity: fixture really is v1-shaped bare data.
    expect(readSchemaVersion(dbPath)).toBe(1);

    // Re-open → migration runs.
    const store = new SqliteLedgerStore({ dbPath, now });
    await store.init();

    // (a) A pre-migration snapshot was written.
    expect(await snapshotFiles(dir)).toEqual([
      "ledger.pre-v2-migration-2026-01-01T00-00-00.000Z.db",
    ]);

    // (b) Cross-ledger bare ref canonicalized; free-text + dash preserved.
    const defect = store.fetchItem("defects", "D1");
    expect(defect.fields["dependsOn"]).toEqual(["tasks:T1"]);
    expect(defect.fields["blockedBy"]).toEqual(["awaiting external sign-off", "M-AMBIENT"]);

    // Milestone bare ref canonicalized against the milestones idPrefix.
    const ms = store.fetchMilestone("M1");
    expect(ms.milestone.fields["dependsOn"]).toEqual(["milestones:M245"]);

    await store.dispose();

    // (c) Canonical ledgers' schema_json now carries satisfiesDependencyStatuses.
    expect(readSchemaJson(dbPath, "defects").satisfiesDependencyStatuses).toEqual(
      DEFECTS_SCHEMA.satisfiesDependencyStatuses,
    );
    // (d) Version bumped.
    expect(readSchemaVersion(dbPath)).toBe(2);
  });

  test("second open is a strict no-op — fields_json byte-identical, no new snapshot", async () => {
    const dir = await freshDir("ledger-mig-idem-");
    const dbPath = path.join(dir, "ledger.db");
    await buildV1Fixture(dbPath);

    const first = new SqliteLedgerStore({ dbPath, now });
    await first.init();
    await first.dispose();
    const afterMigrate = captureFieldsJson(dbPath);
    const snapsAfterFirst = await snapshotFiles(dir);

    const second = new SqliteLedgerStore({ dbPath, now });
    await second.init();
    await second.dispose();
    const afterSecond = captureFieldsJson(dbPath);

    expect(afterSecond).toEqual(afterMigrate);
    // No second snapshot: opening a v2 store never re-runs the migration.
    expect(await snapshotFiles(dir)).toEqual(snapsAfterFirst);
  });

  test("restore of an OLD bare-ref dump lands normalized — equal to the on-open migration output", async () => {
    // Source: a live store with a canonical dependsOn; build a dump, then
    // REGRESS the serialized ref to the bare pre-grammar form.
    const srcPath = path.join(await freshDir("ledger-restore-src-"), "ledger.db");
    const src = new SqliteLedgerStore({ dbPath: srcPath, now });
    await src.init();
    await src.createItem("tasks", MILESTONES_AMBIENT_ID, {
      status: "planned",
      fields: { headline: "target task" },
    }); // T1
    await src.createItem("defects", MILESTONES_AMBIENT_ID, {
      status: "open",
      fields: { headline: "dependent", severity: "low", dependsOn: ["tasks:T1"] },
    }); // D1 -> dependsOn canonical
    const dump = await buildBackupDump(src, null);
    await src.dispose();

    // Regress the defects dump to the bare form (pre-grammar backup).
    const oldDump: BackupDumpFile[] = dump.map((f) =>
      f.path === "defects.md"
        ? { path: f.path, content: f.content.replace(/tasks:T1/g, "T1") }
        : f,
    );
    const defectsMd = oldDump.find((f) => f.path === "defects.md")?.content ?? "";
    expect(defectsMd).not.toContain("tasks:T1");
    expect(defectsMd).toContain("T1");

    const dstPath = path.join(await freshDir("ledger-restore-dst-"), "ledger.db");
    await restoreDumpToXdg({ dbPath: dstPath, logsDir: null, dump: oldDump });

    const restored = new SqliteLedgerStore({ dbPath: dstPath, now });
    await restored.init();
    expect(restored.fetchItem("defects", "D1").fields["dependsOn"]).toEqual(["tasks:T1"]);
    await restored.dispose();
  });
});

describe("normalizeStoredRefFields shared helper (T553)", () => {
  const registry = buildPrefixRegistry(CANONICAL_LEDGERS);

  test("in-memory materialize normalizes the same way: bare -> prefixed, free-text verbatim", () => {
    const fields: Record<string, FieldValue> = {
      headline: "x",
      dependsOn: ["T1", "D5", "M245"],
      blockedBy: ["awaiting sign-off", "M-AMBIENT", "goals:G7"],
    };
    const res = normalizeStoredRefFields(fields, registry);
    expect(res.changed).toBe(true);
    expect(res.unresolved).toBe(true);
    expect(res.fields["dependsOn"]).toEqual(["tasks:T1", "defects:D5", "milestones:M245"]);
    // free-text + dash verbatim; already-prefixed passes through unchanged.
    expect(res.fields["blockedBy"]).toEqual(["awaiting sign-off", "M-AMBIENT", "goals:G7"]);
    // pure: input untouched.
    expect(fields["dependsOn"]).toEqual(["T1", "D5", "M245"]);
  });

  test("idempotent: re-normalizing canonical fields changes nothing", () => {
    const fields: Record<string, FieldValue> = {
      dependsOn: ["tasks:T1", "milestones:M245"],
      blockedBy: ["free text"],
    };
    const res = normalizeStoredRefFields(fields, registry);
    expect(res.changed).toBe(false);
    expect(res.fields).toEqual(fields);
  });
});
