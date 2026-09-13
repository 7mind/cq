import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";

const LIVE_DOCUMENTS = 20_000;
const REPLACEMENTS_BEFORE_RECLAIM = 999;
const FIXED_NOW = "2026-01-01T00:00:00.000Z";

test("sqlite search projection keeps the main loop responsive across reclaim", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sqlite-search-reclaim-"));
  const dbPath = path.join(root, "ledger.db");
  const store = new SqliteLedgerStore({ dbPath });
  let cadenceTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    await store.init();
    await store.createMilestone({ title: "search reclaim" });
    const db = openLedgerDb(dbPath);
    try {
      db.transaction(() => {
        db.query(
          "INSERT INTO groups (ledger, id, title, description) VALUES ('tasks', 'M1', 'search reclaim', '')",
        ).run();
        const insert = db.query(`INSERT INTO items
          (ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
          VALUES ('tasks', ?, 'M1', 'planned', ?, ?, ?, NULL, NULL)`);
        for (let index = 0; index < LIVE_DOCUMENTS; index += 1) {
          insert.run(
            `T${index + 1}`,
            JSON.stringify({ headline: `retained document ${index}` }),
            FIXED_NOW,
            FIXED_NOW,
          );
        }
      })();
    } finally {
      db.close();
    }
    await store.invalidate("tasks");
    for (let replacement = 0; replacement < REPLACEMENTS_BEFORE_RECLAIM; replacement += 1) {
      await store.updateItem("tasks", "T1", { fields: { headline: `replacement ${replacement}` } });
    }
    let servicedDuringReclaim = false;
    cadenceTimer = setTimeout(() => {
      servicedDuringReclaim = true;
    }, 0);
    await store.updateItem("tasks", "T1", { fields: { headline: "reclaimed sentinel" } });
    expect(servicedDuringReclaim).toBe(true);
    await store.updateItem("tasks", "T1", { fields: { headline: "afterreclaim sentinel" } });
    expect((await store.ftsSearch("afterreclaim")).map((hit) => hit.item.id)).toEqual(["T1"]);
    expect(await store.ftsSearch("reclaimed")).toEqual([]);
    expect((await store.ftsSearch("retained", { limit: LIVE_DOCUMENTS })).length).toBe(
      LIVE_DOCUMENTS - 1,
    );
  } finally {
    if (cadenceTimer !== null) clearTimeout(cadenceTimer);
    await store.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
