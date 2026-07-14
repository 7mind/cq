/**
 * SqliteLedgerStore T526 acceptance: init/bootstrap parity with FsLedgerStore,
 * read-surface deep-equality over an equivalent seeded fixture, WAL
 * cross-connection coherence with NO invalidate, and dispose() releasing the
 * handle. Mutations land in T527, so the sqlite fixture is seeded with raw
 * INSERTs mirroring the rows T527 will produce (read parity is the point).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  BootstrapViolationError,
  ItemNotFoundError,
  LedgerNotFoundError,
  type LedgerSchema,
} from "../src/types.js";
import {
  CANONICAL_LEDGERS,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  TASKS_SCHEMA,
} from "../src/constants.js";
import { FsLedgerStore } from "../src/store/FsLedgerStore.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { ensureSchema } from "../src/store/sqlite/schema.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";
const now = (): string => FIXED_NOW;

const dirs: string[] = [];

async function freshDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function freshDbPath(): Promise<string> {
  return path.join(await freshDir("ledger-sqlite-store-"), "ledger.db");
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Insert-statement bundle over a raw connection (mirrors T527's write shape). */
function rawInserters(db: ReturnType<typeof openLedgerDb>) {
  return {
    ledger: db.query(
      "INSERT INTO ledgers (name, schema_json, milestone_counter, item_counter) VALUES (?, ?, ?, ?)",
    ),
    group: db.query("INSERT INTO groups (ledger, id, title, description) VALUES (?, ?, ?, ?)"),
    item: db.query(
      "INSERT INTO items (ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
  };
}

/**
 * Mirror the fs store's ACTIVE state into the sqlite db as normalized rows —
 * the same rows T527's mutations will produce. Raw group rows carry the
 * empty title/description for non-milestones ledgers (the resolved view in
 * FetchedLedger comes from the milestones ledger at read time).
 */
function seedDbFromFsStore(dbPath: string, fsStore: FsLedgerStore): void {
  const db = openLedgerDb(dbPath);
  ensureSchema(db);
  const ins = rawInserters(db);
  db.transaction(() => {
    for (const name of fsStore.enumerate()) {
      const view = fsStore.fetch(name);
      ins.ledger.run(name, JSON.stringify(view.schema), view.counters.milestone, view.counters.item);
      const isMilestones = name === MILESTONES_LEDGER;
      for (const group of view.milestones) {
        ins.group.run(
          name,
          group.id,
          isMilestones ? group.milestone.title : "",
          isMilestones ? group.milestone.description : "",
        );
        for (const item of group.items) {
          ins.item.run(
            name,
            item.id,
            item.milestoneId,
            item.status,
            JSON.stringify(item.fields),
            item.createdAt,
            item.updatedAt,
            item.author ?? null,
            item.session ?? null,
          );
        }
      }
    }
  })();
  db.close();
}

async function freshFsStore(): Promise<FsLedgerStore> {
  const store = new FsLedgerStore({ root: await freshDir("ledger-fs-parity-"), now });
  await store.init();
  return store;
}

describe("SqliteLedgerStore init/bootstrap (acceptance a)", () => {
  test("fresh init yields exactly the canonical ledgers, bootstrap group, M-AMBIENT — parity with FsLedgerStore", async () => {
    const fsStore = await freshFsStore();
    const sq = new SqliteLedgerStore({ dbPath: await freshDbPath(), now });
    await sq.init();
    try {
      const canonicalNames = CANONICAL_LEDGERS.map((c) => c.name).sort();
      expect(sq.enumerate()).toEqual(canonicalNames);
      expect(sq.enumerate()).toEqual(fsStore.enumerate());

      for (const name of canonicalNames) {
        expect(sq.fetch(name)).toEqual(fsStore.fetch(name));
      }

      // Bootstrap active group + immortal M-AMBIENT.
      const milestones = sq.fetch(MILESTONES_LEDGER);
      expect(milestones.milestones.map((g) => g.id)).toEqual(["active"]);
      expect(sq.fetchItem(MILESTONES_LEDGER, MILESTONES_AMBIENT_ID)).toEqual(
        fsStore.fetchItem(MILESTONES_LEDGER, MILESTONES_AMBIENT_ID),
      );
      expect(sq.fetchMilestone(MILESTONES_AMBIENT_ID)).toEqual(
        fsStore.fetchMilestone(MILESTONES_AMBIENT_ID),
      );
      expect(sq.snapshot()).toEqual(fsStore.snapshot());
    } finally {
      await sq.dispose();
      await fsStore.dispose();
    }
  });

  test("re-init over an already-bootstrapped db is idempotent (no duplicate seeds)", async () => {
    const dbPath = await freshDbPath();
    const first = new SqliteLedgerStore({ dbPath, now });
    await first.init();
    await first.dispose();
    const second = new SqliteLedgerStore({ dbPath, now });
    await second.init();
    try {
      const view = second.fetch(MILESTONES_LEDGER);
      expect(view.milestones.map((g) => g.id)).toEqual(["active"]);
      const active = view.milestones[0];
      expect(active?.items.filter((it) => it.id === MILESTONES_AMBIENT_ID)).toHaveLength(1);
    } finally {
      await second.dispose();
    }
  });

  test("forward-compatible widening: persisted schema lacking canon's optional field is upgraded in place", async () => {
    const dbPath = await freshDbPath();
    const db = openLedgerDb(dbPath);
    ensureSchema(db);
    const narrowed = JSON.parse(JSON.stringify(TASKS_SCHEMA)) as LedgerSchema;
    delete narrowed.fields["rawLogs"]; // optional in canon → widening, not divergence
    db.query(
      "INSERT INTO ledgers (name, schema_json, milestone_counter, item_counter) VALUES (?, ?, 0, 0)",
    ).run("tasks", JSON.stringify(narrowed));
    db.close();

    const sq = new SqliteLedgerStore({ dbPath, now });
    await sq.init();
    try {
      expect(sq.fetch("tasks").schema).toEqual(TASKS_SCHEMA);
    } finally {
      await sq.dispose();
    }
  });

  test("schema divergence: 'abort' throws BootstrapViolationError; default policy throws the T529 backup stub", async () => {
    const divergedDbPath = async (): Promise<string> => {
      const dbPath = await freshDbPath();
      const db = openLedgerDb(dbPath);
      ensureSchema(db);
      const diverged = JSON.parse(JSON.stringify(TASKS_SCHEMA)) as LedgerSchema;
      diverged.idPrefix = "ZZ"; // non-widening difference → divergent
      db.query(
        "INSERT INTO ledgers (name, schema_json, milestone_counter, item_counter) VALUES (?, ?, 0, 0)",
      ).run("tasks", JSON.stringify(diverged));
      db.close();
      return dbPath;
    };

    const abortStore = new SqliteLedgerStore({
      dbPath: await divergedDbPath(),
      now,
      onSchemaDivergence: "abort",
    });
    await expect(abortStore.init()).rejects.toThrow(BootstrapViolationError);

    const backupStore = new SqliteLedgerStore({ dbPath: await divergedDbPath(), now });
    await expect(backupStore.init()).rejects.toThrow(/T529/);
  });
});

describe("SqliteLedgerStore read parity over an equivalent seeded fixture (acceptance b)", () => {
  async function buildFixture(): Promise<{ fsStore: FsLedgerStore; sq: SqliteLedgerStore }> {
    const fsStore = await freshFsStore();
    await fsStore.createMilestone({
      title: "read-parity fixture",
      description: "seeded via fs mutations, mirrored to sqlite rows",
      dependsOn: ["M-AMBIENT"],
    });
    await fsStore.createItem("tasks", "M1", {
      status: "planned",
      fields: { headline: "task one", tags: ["alpha", "beta"] },
      author: "fable",
      session: "s-fixture",
    });
    await fsStore.createItem("tasks", "M1", {
      status: "planned",
      fields: { headline: "task two", description: "second task" },
    });
    await fsStore.createItem("defects", "M1", {
      status: "open",
      fields: { headline: "defect one", severity: "low" },
    });
    await fsStore.updateItem("tasks", "T1", { status: "wip", author: "fable" });
    await fsStore.createItem("questions", MILESTONES_AMBIENT_ID, {
      status: "open",
      fields: { question: "ambient question?" },
    });

    const dbPath = await freshDbPath();
    seedDbFromFsStore(dbPath, fsStore);
    const sq = new SqliteLedgerStore({ dbPath, now });
    await sq.init();
    return { fsStore, sq };
  }

  test("fetch/fetchItem/fetchMilestone/listMilestoneItems/snapshot/search are deep-equal to FsLedgerStore", async () => {
    const { fsStore, sq } = await buildFixture();
    try {
      expect(sq.enumerate()).toEqual(fsStore.enumerate());
      for (const name of fsStore.enumerate()) {
        expect(sq.fetch(name)).toEqual(fsStore.fetch(name));
      }
      for (const [ledger, id] of [
        ["tasks", "T1"],
        ["tasks", "T2"],
        ["defects", "D1"],
        ["questions", "Q1"],
        [MILESTONES_LEDGER, "M1"],
        [MILESTONES_LEDGER, MILESTONES_AMBIENT_ID],
      ] as Array<[string, string]>) {
        expect(sq.fetchItem(ledger, id)).toEqual(fsStore.fetchItem(ledger, id));
      }
      expect(sq.fetchMilestone("M1")).toEqual(fsStore.fetchMilestone("M1"));
      expect(sq.fetchMilestone(MILESTONES_AMBIENT_ID)).toEqual(
        fsStore.fetchMilestone(MILESTONES_AMBIENT_ID),
      );
      expect(sq.listMilestoneItems("M1")).toEqual(fsStore.listMilestoneItems("M1"));
      expect(sq.listMilestoneItems(MILESTONES_AMBIENT_ID)).toEqual(
        fsStore.listMilestoneItems(MILESTONES_AMBIENT_ID),
      );
      expect(sq.snapshot()).toEqual(fsStore.snapshot());
      expect(sq.search("tasks", "task")).toEqual(fsStore.search("tasks", "task"));
      expect(sq.search("tasks", "wip")).toEqual(fsStore.search("tasks", "wip"));
    } finally {
      await sq.dispose();
      await fsStore.dispose();
    }
  });

  test("not-found errors match the fs semantics", async () => {
    const { fsStore, sq } = await buildFixture();
    try {
      expect(() => sq.fetchItem("tasks", "T999")).toThrow(ItemNotFoundError);
      expect(() => sq.fetchItem("nope", "T1")).toThrow(LedgerNotFoundError);
      expect(() => sq.fetch("nope")).toThrow(LedgerNotFoundError);
      expect(() => sq.fetchMilestone("M999")).toThrow("milestone M999 not found");
    } finally {
      await sq.dispose();
      await fsStore.dispose();
    }
  });
});

describe("WAL cross-connection coherence (acceptance c)", () => {
  test("a second store observes a peer connection's committed insert on its next ROW fetch, no invalidate", async () => {
    const dbPath = await freshDbPath();
    const s1 = new SqliteLedgerStore({ dbPath, now });
    const s2 = new SqliteLedgerStore({ dbPath, now });
    await s1.init();
    await s2.init();
    const peer = openLedgerDb(dbPath);
    try {
      expect(() => s2.fetchItem("tasks", "T7")).toThrow(ItemNotFoundError);

      // Peer connection commits rows the way T527's createItem will.
      const ins = rawInserters(peer);
      peer.transaction(() => {
        ins.group.run("tasks", MILESTONES_AMBIENT_ID, "", "");
        ins.item.run(
          "tasks",
          "T7",
          MILESTONES_AMBIENT_ID,
          "planned",
          JSON.stringify({ headline: "peer insert" }),
          FIXED_NOW,
          FIXED_NOW,
          "peer-author",
          null,
        );
      })();

      // Both stores observe the committed insert without any invalidate call.
      expect(s2.fetchItem("tasks", "T7").fields["headline"]).toBe("peer insert");
      expect(s1.fetch("tasks").milestones.map((g) => g.id)).toEqual([MILESTONES_AMBIENT_ID]);
      expect(s1.listMilestoneItems(MILESTONES_AMBIENT_ID)["tasks"]?.map((it) => it.id)).toEqual([
        "T7",
      ]);

      // invalidate() is a no-op for the row read surface (TODO(T528): index refresh).
      await s1.invalidate("tasks");
      expect(s1.fetchItem("tasks", "T7").author).toBe("peer-author");
    } finally {
      peer.close();
      await s1.dispose();
      await s2.dispose();
    }
  });
});

describe("dispose() (acceptance d)", () => {
  test("a disposed handle throws on a subsequent query; a fresh store reopens the same file", async () => {
    const dbPath = await freshDbPath();
    const store = new SqliteLedgerStore({ dbPath, now });
    await store.init();
    expect(store.enumerate().length).toBeGreaterThan(0);
    await store.dispose();

    expect(() => store.enumerate()).toThrow("not initialised");
    expect(() => store.fetch("tasks")).toThrow("not initialised");

    // No lingering lock: a fresh store reopens (and init's bootstrap
    // transaction takes the write lock) on the same file.
    const reopened = new SqliteLedgerStore({ dbPath, now });
    await reopened.init();
    try {
      expect(reopened.enumerate()).toContain("tasks");
      expect(reopened.fetchItem(MILESTONES_LEDGER, MILESTONES_AMBIENT_ID).id).toBe(
        MILESTONES_AMBIENT_ID,
      );
    } finally {
      await reopened.dispose();
    }
  });
});

describe("not-yet-owned surfaces name their owning task", () => {
  test("mutations → T527, ftsSearch → T528, archives → T529", async () => {
    const store = new SqliteLedgerStore({ dbPath: await freshDbPath(), now });
    await store.init();
    try {
      await expect(store.createItem("tasks", "M1", { status: "planned", fields: {} })).rejects.toThrow(
        /T527/,
      );
      await expect(store.updateItem("tasks", "T1", {})).rejects.toThrow(/T527/);
      await expect(store.createMilestone({ title: "x" })).rejects.toThrow(/T527/);
      await expect(store.updateMilestone("M1", {})).rejects.toThrow(/T527/);
      await expect(store.createLedger("x", TASKS_SCHEMA)).rejects.toThrow(/T527/);
      await expect(store.reopenItem("tasks", "T1", "planned")).rejects.toThrow(/T527/);
      await expect(store.ftsSearch("anything")).rejects.toThrow(/T528/);
      await expect(store.fetchArchive("tasks", "M1")).rejects.toThrow(/T529/);
      await expect(store.archiveMilestone("M1", "s")).rejects.toThrow(/T529/);
      await expect(store.unarchiveItem("tasks", "M1", "T1")).rejects.toThrow(/T529/);
    } finally {
      await store.dispose();
    }
  });
});
