/**
 * The milestones "active" group must carry its canonical title, and opening a
 * store must repair it when it does not.
 *
 * Observed 2026-09-24: after deploying, `cq web` refused to serve this
 * repository's own live ledger (projectId cq-ledger-suite-production):
 *
 *     rejected XDG project cq-ledger-suite-production: invalid-bootstrap-state:
 *     ledger database lacks a valid active group and M-AMBIENT bootstrap milestone
 *
 * M-AMBIENT was sound. The `(milestones, active)` group row had title "" where
 * the catalog requires "active". Of 768 stores in the XDG directory, 767 carried
 * "active" and exactly one — the production store, the one with a history of
 * reinitialization and restore — carried "".
 *
 * Bootstrap already TRIES to set the title, but through
 * `INSERT OR IGNORE INTO groups ... VALUES (?, ?, 'active', '')`. When the row
 * already exists with the wrong title, IGNORE makes that a no-op, so no number
 * of reopenings can repair it. Two lazy group-materialisation paths insert
 * groups with an empty title, and neither ever updates. So a store in this
 * state stays rejected forever.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { SqliteXdgProjectIdentityAccess } from "../src/store/sqlite/projectIdentity.js";
import {
  FilesystemXdgProjectCatalogSource,
  ReadOnlyXdgProjectCatalog,
} from "../src/store/sqlite/xdgProjectCatalog.js";

const KEY = "active-group-title";

async function storeWithEmptyActiveGroupTitle(): Promise<{
  readonly root: string;
  readonly dbPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "cq-active-group-"));
  const stateDir = path.join(root, KEY, "state");
  await mkdir(stateDir, { recursive: true });
  const dbPath = path.join(stateDir, "ledger.db");
  const seed = new SqliteLedgerStore({ dbPath });
  await seed.init();
  await seed.dispose();
  // createLedgerStore records the project identity the catalog requires; a bare
  // store does not. The production store has one, so the fixture does too —
  // otherwise the catalog would reject it for a reason unrelated to this fix.
  const identityDb = openLedgerDb(dbPath);
  try {
    new SqliteXdgProjectIdentityAccess(identityDb).upsertProjectIdentity({
      repositoryPath: root,
      displayName: KEY,
    });
  } finally {
    identityDb.close();
  }
  // Forge the exact production anomaly. This is a test fixture reproducing a
  // durable state the store must cope with, not a pattern for real stores.
  const raw = new Database(dbPath);
  raw.query("UPDATE groups SET title = '' WHERE ledger = 'milestones' AND id = 'active'").run();
  raw.close();
  return { root, dbPath };
}

function activeGroupTitle(dbPath: string): unknown {
  const raw = new Database(dbPath, { readonly: true });
  try {
    const row = raw
      .query("SELECT title FROM groups WHERE ledger = 'milestones' AND id = 'active'")
      .get() as { title: unknown } | null;
    return row?.title;
  } finally {
    raw.close();
  }
}

async function catalogCode(root: string): Promise<string | undefined> {
  const catalog = new ReadOnlyXdgProjectCatalog(new FilesystemXdgProjectCatalogSource());
  const result = await catalog.discover(root);
  return result.diagnostics.find((entry) => entry.key === KEY)?.code;
}

describe("milestones active group bootstrap repair", () => {
  test("the catalog rejects an empty active-group title, reproducing the production symptom", async () => {
    const { root } = await storeWithEmptyActiveGroupTitle();
    try {
      expect(await catalogCode(root)).toBe("invalid-bootstrap-state");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("opening the store repairs the title, and the catalog then serves it", async () => {
    const { root, dbPath } = await storeWithEmptyActiveGroupTitle();
    try {
      const reopened = new SqliteLedgerStore({ dbPath });
      await reopened.init();
      await reopened.dispose();

      expect(activeGroupTitle(dbPath)).toBe("active");
      expect(await catalogCode(root)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("repair touches only the milestones active group", async () => {
    // The lazy paths legitimately create other groups with an empty title;
    // those are not bootstrap state and must be left exactly as they are.
    const { root, dbPath } = await storeWithEmptyActiveGroupTitle();
    try {
      const raw = new Database(dbPath);
      raw
        .query("INSERT INTO groups (ledger, id, title, description) VALUES ('tasks', 'M-LAZY', '', '')")
        .run();
      raw.close();

      const reopened = new SqliteLedgerStore({ dbPath });
      await reopened.init();
      await reopened.dispose();

      const check = new Database(dbPath, { readonly: true });
      const lazy = check
        .query("SELECT title FROM groups WHERE ledger = 'tasks' AND id = 'M-LAZY'")
        .get() as { title: string } | null;
      check.close();
      expect(lazy?.title).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
