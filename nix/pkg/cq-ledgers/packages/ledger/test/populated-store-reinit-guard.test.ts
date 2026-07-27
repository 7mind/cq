/**
 * D170 destructive-intent gate — `backup-reinit` must NOT silently destroy a
 * ledger that already holds user data.
 *
 * REPRODUCE-FIRST HISTORY (this is a regression test for a real, twice-repeated
 * data-loss incident, not a hypothetical):
 * On 2026-07-27 the live ledger was destroyed twice — 1147 then 1155 active
 * items, each with 2278 archived items — replaced by a single bootstrap
 * milestone. Both wipes ran THIS code path: divergence detected, then
 * `VACUUM INTO` a sibling followed by `DELETE FROM` every table and a canon
 * reseed. Production never passes a divergence policy (it always takes the
 * `'abort'` default), but test-shaped code passes `'backup-reinit'` in many
 * places, and two DIFFERENT resolution routes reached the real store: one from
 * inside an agent worktree, one presenting the main-checkout path. Guarding
 * routes was whack-a-mole; this gate guards the DESTRUCTION, so it holds
 * regardless of how the store was reached.
 *
 * The gate deliberately does NOT restrict reinit of a fresh/bootstrap-only
 * store, so ordinary fresh-store tests are untouched.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { MILESTONES_AMBIENT_ID } from "../src/constants.js";

/** Make one canonical ledger's persisted schema diverge from canon. */
function injectDivergence(dbPath: string): void {
  const db = new Database(dbPath);
  const row = db.query<{ schema_json: string }, []>("SELECT schema_json FROM ledgers WHERE name = 'tasks'").get();
  if (row === null) throw new Error("fixture: tasks ledger missing");
  const schema = JSON.parse(row.schema_json) as { statusValues?: string[] };
  schema.statusValues = [...(schema.statusValues ?? []), "a-status-canon-does-not-know"];
  db.query("UPDATE ledgers SET schema_json = ? WHERE name = 'tasks'").run(JSON.stringify(schema));
  db.close();
}

function countItems(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  const row = db.query<{ c: number }, []>("SELECT count(*) AS c FROM items").get();
  db.close();
  return row === null ? 0 : row.c;
}

async function seedPopulatedStore(dbPath: string, n: number): Promise<void> {
  const store = new SqliteLedgerStore({ dbPath });
  await store.init();
  for (let i = 0; i < n; i++) {
    await store.createItem("tasks", MILESTONES_AMBIENT_ID, {
      status: "planned",
      fields: { headline: `seeded item ${i}` },
    });
  }
  await store.dispose();
}

describe("D170: backup-reinit refuses to destroy a POPULATED store", () => {
  it("refuses, names what would have been lost, and leaves every row intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d170-gate-"));
    const dbPath = join(dir, "ledger.db");
    await seedPopulatedStore(dbPath, 5);
    const before = countItems(dbPath);
    expect(before).toBeGreaterThan(1); // bootstrap milestone + seeded rows
    injectDivergence(dbPath);

    const store = new SqliteLedgerStore({ dbPath, onSchemaDivergence: "backup-reinit" });
    await expect(store.init()).rejects.toThrow(/refusing to reinitialise a POPULATED ledger/);

    // The refusal must be non-destructive: same row count, still openable.
    expect(countItems(dbPath)).toBe(before);
  });

  it("the refusal reports the actual row counts at risk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d170-gate-counts-"));
    const dbPath = join(dir, "ledger.db");
    await seedPopulatedStore(dbPath, 3);
    injectDivergence(dbPath);

    const store = new SqliteLedgerStore({ dbPath, onSchemaDivergence: "backup-reinit" });
    // 3 seeded items — the bootstrap milestone is excluded from the count.
    await expect(store.init()).rejects.toThrow(/DESTROY 3 item\(s\)/);
  });

  it("EXPLICIT consent still permits reinit (the escape hatch works)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d170-gate-consent-"));
    const dbPath = join(dir, "ledger.db");
    await seedPopulatedStore(dbPath, 4);
    injectDivergence(dbPath);

    const store = new SqliteLedgerStore({
      dbPath,
      onSchemaDivergence: "backup-reinit",
      allowDestructiveReinitOfPopulatedStore: true,
    });
    await store.init(); // must NOT throw
    // Reinit happened: only the reseeded bootstrap milestone remains.
    expect(countItems(dbPath)).toBe(1);
    await store.dispose();
  });

  it("a FRESH (bootstrap-only) store is NOT considered populated, so reinit is unaffected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d170-gate-fresh-"));
    const dbPath = join(dir, "ledger.db");
    // Bootstrap only — no user rows.
    const seed = new SqliteLedgerStore({ dbPath });
    await seed.init();
    await seed.dispose();
    expect(countItems(dbPath)).toBe(1);
    injectDivergence(dbPath);

    // No consent flag, yet this must succeed: nothing of value is at risk.
    const store = new SqliteLedgerStore({ dbPath, onSchemaDivergence: "backup-reinit" });
    await store.init();
    await store.dispose();
  });

  it("the 'abort' default is unchanged and still refuses first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d170-gate-abort-"));
    const dbPath = join(dir, "ledger.db");
    await seedPopulatedStore(dbPath, 2);
    const before = countItems(dbPath);
    injectDivergence(dbPath);

    // Default policy — must still be the schema-divergence abort, not the new gate.
    const store = new SqliteLedgerStore({ dbPath });
    await expect(store.init()).rejects.toThrow(/different schema than their canonical bootstrap schema/);
    expect(countItems(dbPath)).toBe(before);
  });
});
