/**
 * D-LED-01 — path-traversal hardening (msunify shape).
 *
 * Three layers of defence:
 *   1. `applyCreateItem` (and via it, the milestone auto-create path)
 *      rejects ids that don't match `/^[A-Za-z0-9_-]+$/` (InvalidIdError).
 *   2. SQLite archival treats forged identifiers as database keys, not paths.
 *   3. Archive lookup cannot turn a stored path into a filesystem read.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  SqliteLedgerStore,
  InMemoryLedgerStore,
  InvalidIdError,
  type LedgerSchema,
  MILESTONES_LEDGER,
  LEDGER_STORAGE_DIRNAME,
} from "../src/index.js";

import { openLedgerDb } from "../src/store/sqlite/connection.js";

const dirs: string[] = [];
const stores: SqliteLedgerStore[] = [];
afterAll(async () => {
  await Promise.all(stores.map((store) => store.dispose()));
  for (const d of dirs) {
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

const schema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: { note: { type: "string", required: false } },
};

async function setupSqlite(): Promise<{ store: SqliteLedgerStore; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-trav-"));
  dirs.push(root);
  const store = new SqliteLedgerStore({ dbPath: path.join(root, "ledger.db") });
  await store.init();
  await store.createLedger("xenos", schema);
  stores.push(store);
  return { store, root };
}

describe("D-LED-01 — id validation in core helpers", () => {
  const badIds = ["../etc/passwd", "a/b", "a b", "", "..", ".", "a.b", "a/../b"];

  it.each(badIds)("createMilestone (milestones ledger) rejects id %p", async (badId) => {
    const store = new InMemoryLedgerStore();
    await store.init();
    await expect(
      store.createMilestone({ id: badId, title: "x" }),
    ).rejects.toThrow(InvalidIdError);
  });

  it.each(badIds)("createItem rejects unsafe explicit id %p", async (badId) => {
    const store = new InMemoryLedgerStore({ seed: [{ name: "xenos", schema }] });
    await store.init();
    const m = await store.createMilestone({ title: "m" });
    await expect(
      store.createItem("xenos", m.id, { id: badId, status: "open", fields: {} }),
    ).rejects.toThrow(InvalidIdError);
  });

  it.each(badIds)("createItem rejects unsafe milestoneId %p (auto-create path)", async (badId) => {
    const store = new InMemoryLedgerStore({ seed: [{ name: "xenos", schema }] });
    await store.init();
    // milestone existence check happens before the auto-create validation
    // — either way the call must throw with a typed error (most badIds
    // also fail strict-existence). For ".." / "" we rely on the
    // strict-existence check.
    await expect(
      store.createItem("xenos", badId, { status: "open", fields: {} }),
    ).rejects.toThrow();
  });

  it("safe, prefix-matching ids are accepted (positive control)", async () => {
    const store = new InMemoryLedgerStore({ seed: [{ name: "xenos", schema }] });
    await store.init();
    // Caller-supplied ids must match the ledger's `^<prefix>\d+$` (§8a):
    // milestones prefix M, the seeded `xenos` ledger prefix X.
    const m = await store.createMilestone({ id: "M7", title: "x" });
    expect(m.id).toBe("M7");
    const it = await store.createItem("xenos", "M7", {
      id: "X42",
      status: "open",
      fields: {},
    });
    expect(it.id).toBe("X42");
  });
});

describe("D-LED-01 — SqliteLedgerStore defense-in-depth", () => {
  it("archiveMilestone cannot write outside the fixture root for a forged persisted milestone id", async () => {
    const { store, root } = await setupSqlite();
    await store.createMilestone({ id: "M7", title: "forged" });
    await store.updateMilestone("M7", { status: "done" });
    const forgedId = "../../../../tmp/pwned";
    const db = openLedgerDb(path.join(root, "ledger.db"));
    try {
      db.query("UPDATE items SET id = ? WHERE ledger = ? AND id = ?").run(forgedId, MILESTONES_LEDGER, "M7");
      db.query("INSERT INTO groups (ledger, id, title, description) VALUES (?, ?, '', '')").run("xenos", forgedId);
    } finally { db.close(); }

    const archived = await store.archiveMilestone(forgedId, "summary");
    expect(archived.id).toBe(forgedId);
    expect(await store.fetchArchive("xenos", forgedId)).toEqual({
      kind: "group", milestone: { id: forgedId, title: "", description: "", items: [] },
    });

    const escaped = path.resolve(
      path.join(root, LEDGER_STORAGE_DIRNAME, "archive", "xenos"),
      `${forgedId}.md`,
    );
    expect(escaped.startsWith(path.join(root, LEDGER_STORAGE_DIRNAME) + path.sep)).toBe(false);
    await expect(stat(escaped)).rejects.toBeDefined();
  });

  it("fetchArchive cannot read a filesystem path from a forged archive pointer", async () => {
    const { store, root } = await setupSqlite();
    const outsidePath = path.join(root, "secret.md");
    await writeFile(outsidePath, "---\nschemaVersion: 1\n---\n# leaked\n", "utf8");

    const db = openLedgerDb(path.join(root, "ledger.db"));
    try {
      db.query("INSERT INTO archive_pointers (ledger, id, summary, title, status, archived_at) VALUES ('xenos', '../secret.md', 'forged', '', '', ?)").run("2026-01-01T00:00:00Z");
    } finally { db.close(); }

    const archived = await store.fetchArchive("xenos", "../secret.md");
    expect(archived).toEqual({
      kind: "group", milestone: { id: "../secret.md", title: "", description: "", items: [] },
    });
    expect(await Bun.file(outsidePath).text()).toBe("---\nschemaVersion: 1\n---\n# leaked\n");
  });
});
