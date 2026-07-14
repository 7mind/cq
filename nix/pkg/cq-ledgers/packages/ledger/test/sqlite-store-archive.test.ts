/**
 * SqliteLedgerStore T529 acceptance — archives (archiveMilestone/
 * unarchiveItem/fetchArchive) row-native parity with FsLedgerStore over a
 * shared scenario, plus the sqlite-specific schema-divergence BACKUP action:
 *
 *  1. archive → fetchArchive → unarchiveItem round-trip parity with
 *     FsLedgerStore (NonTerminalItemsError refusal, bootstrap-group refusal,
 *     M-AMBIENT refusal, pointer removal when a group archive empties).
 *  2. onMutation fires in the D-COHERENCE-asserted order on archive
 *     (alphabetic participants, then the milestones ledger; a ledger with no
 *     group for the milestone does not fire).
 *  3. includeArchived — an archived item is searchable ONLY via
 *     includeArchived:true; unarchive restores active-scope searchability
 *     (derived-index scope transition), parity with FsLedgerStore.
 *  4. Divergence BACKUP: tampering a `ledgers.schema_json` row triggers
 *     VACUUM-INTO backup + reinit; the backup .db is openable and holds the
 *     pre-divergence rows while the live db is back to canonical.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  BootstrapViolationError,
  LedgerError,
  NonTerminalItemsError,
  type LedgerSchema,
} from "../src/types.js";
import {
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  TASKS_SCHEMA,
} from "../src/constants.js";
import type { LedgerMutationOp, LedgerStore } from "../src/store/LedgerStore.js";
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
  return path.join(await freshDir("ledger-sqlite-arch-"), "ledger.db");
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const WIDGETS = "widgets";
const NOTES = "notes";

const widgetsSchema: LedgerSchema = {
  statusValues: ["open", "in-progress", "resolved", "abandoned"],
  terminalStatuses: ["resolved", "abandoned"],
  fields: {
    severity: { type: "string", required: true },
    location: { type: "string", required: true },
    description: { type: "string", required: true },
  },
};

const notesSchema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: { notes: { type: "string", required: false } },
};

// ---------------------------------------------------------------------------
// Parity harness — run one op against both stores, demand identical outcomes.
// ---------------------------------------------------------------------------

interface ParityStores {
  fs: FsLedgerStore;
  sq: SqliteLedgerStore;
}

async function parityStores(
  seed: Array<{ name: string; schema: LedgerSchema }> = [],
): Promise<ParityStores & { dispose: () => Promise<void> }> {
  const fs = new FsLedgerStore({ root: await freshDir("ledger-fs-arch-"), now });
  await fs.init();
  const sq = new SqliteLedgerStore({ dbPath: await freshDbPath(), now });
  await sq.init();
  for (const { name, schema } of seed) {
    await fs.createLedger(name, schema);
    await sq.createLedger(name, schema);
  }
  return {
    fs,
    sq,
    dispose: async (): Promise<void> => {
      await fs.dispose();
      await sq.dispose();
    },
  };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; err: unknown };

async function settle<T>(op: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await op() };
  } catch (err: unknown) {
    return { ok: false, err };
  }
}

function describeOutcome(o: Outcome<unknown>): unknown {
  if (o.ok) return { ok: true, value: o.value };
  const err = o.err as Error;
  return { ok: false, error: `${err.constructor.name}: ${err.message}` };
}

async function parity<T>(
  stores: ParityStores,
  op: (s: LedgerStore) => Promise<T>,
): Promise<Outcome<T>> {
  const fsOutcome = await settle(() => op(stores.fs));
  const sqOutcome = await settle(() => op(stores.sq));
  expect(describeOutcome(sqOutcome)).toEqual(describeOutcome(fsOutcome));
  return sqOutcome;
}

function value<T>(o: Outcome<T>): T {
  if (!o.ok) throw new Error(`expected success, got: ${String(o.err)}`);
  return o.value;
}

function expectError(o: Outcome<unknown>, cls: new (...args: never[]) => Error): void {
  if (o.ok) throw new Error(`expected ${cls.name}, got success`);
  expect(o.err).toBeInstanceOf(cls);
}

function expectStoreParity({ fs, sq }: ParityStores): void {
  expect(sq.enumerate()).toEqual(fs.enumerate());
  for (const name of fs.enumerate()) {
    expect(sq.fetch(name)).toEqual(fs.fetch(name));
  }
  expect(sq.snapshot()).toEqual(fs.snapshot());
}

// ---------------------------------------------------------------------------
// §1 — archive → fetchArchive → unarchiveItem round-trip parity
// ---------------------------------------------------------------------------

describe("T529: archiveMilestone / fetchArchive / unarchiveItem parity with FsLedgerStore", () => {
  test("NonTerminalItemsError refusal (group items, then the milestone-item itself), then a full archive→fetchArchive→unarchiveItem round trip with pointer removal on empty", async () => {
    const stores = await parityStores([{ name: WIDGETS, schema: widgetsSchema }]);
    try {
      const p = <T>(op: (s: LedgerStore) => Promise<T>): Promise<Outcome<T>> => parity(stores, op);

      const m = value(await p((s) => s.createMilestone({ title: "M-arch" })));
      const a = value(
        await p((s) =>
          s.createItem(WIDGETS, m.id, {
            status: "open",
            fields: { severity: "minor", location: "a.ts", description: "alpha" },
          }),
        ),
      );
      const b = value(
        await p((s) =>
          s.createItem(WIDGETS, m.id, {
            status: "resolved",
            fields: { severity: "major", location: "b.ts", description: "beta" },
          }),
        ),
      );

      // Phase 1 — a non-terminal group item (`a`, open) refuses the archive.
      expectError(await p((s) => s.archiveMilestone(m.id, "summary")), NonTerminalItemsError);

      // Resolve `a`; group items are now all terminal, but the milestone-item
      // itself is still non-terminal (open) — Phase 1b refuses.
      await p((s) => s.updateItem(WIDGETS, a.id, { status: "resolved" }));
      expectError(await p((s) => s.archiveMilestone(m.id, "summary")), NonTerminalItemsError);

      // Mark the milestone done — now the archive succeeds.
      await p((s) => s.updateMilestone(m.id, { status: "done" }));
      const ptr = value(await p((s) => s.archiveMilestone(m.id, "summary one")));
      expect(ptr).toMatchObject({
        id: m.id,
        path: `./archive/${MILESTONES_LEDGER}/${m.id}.md`,
        summary: "summary one",
        title: "M-arch",
        status: "done",
      });

      // Group archive readable via fetchArchive; parity on both items.
      const groupArchive = value(await p((s) => s.fetchArchive(WIDGETS, m.id)));
      expect(groupArchive.kind).toBe("group");
      if (groupArchive.kind === "group") {
        expect(groupArchive.milestone.items.map((it) => it.id).sort()).toEqual([a.id, b.id].sort());
      }
      // Milestone-item archive readable; parity.
      const msArchive = value(await p((s) => s.fetchArchive(MILESTONES_LEDGER, m.id)));
      expect(msArchive.kind).toBe("item");
      if (msArchive.kind === "item") {
        expect(msArchive.item.id).toBe(m.id);
        expect(msArchive.item.fields["title"]).toBe("M-arch");
      }
      // Unknown archive id refuses identically.
      expectError(await p((s) => s.fetchArchive(WIDGETS, "M999")), LedgerError);

      // Bootstrap group + M-AMBIENT refusal (parity).
      expectError(
        await p((s) => s.archiveMilestone(MILESTONES_ACTIVE_GROUP_ID, "no")),
        BootstrapViolationError,
      );
      expectError(
        await p((s) => s.archiveMilestone(MILESTONES_AMBIENT_ID, "no")),
        BootstrapViolationError,
      );

      // Un-archive ONLY `a`: re-attaches, group archive rewritten WITHOUT it,
      // pointer stays (group non-empty).
      const reA = value(await p((s) => s.unarchiveItem(WIDGETS, m.id, a.id)));
      expect(reA).toMatchObject({ id: a.id, milestoneId: m.id, status: "resolved" });
      expect(reA.createdAt).toBe(a.createdAt);
      const afterFirst = value(await p((s) => s.fetchArchive(WIDGETS, m.id)));
      expect(afterFirst.kind).toBe("group");
      if (afterFirst.kind === "group") {
        expect(afterFirst.milestone.items.map((it) => it.id)).toEqual([b.id]);
      }

      // Un-archive the LAST item `b`: group archive + pointer vanish entirely.
      const reB = value(await p((s) => s.unarchiveItem(WIDGETS, m.id, b.id)));
      expect(reB.id).toBe(b.id);
      expectError(await p((s) => s.fetchArchive(WIDGETS, m.id)), LedgerError);

      expectStoreParity(stores);
    } finally {
      await stores.dispose();
    }
  });

  test("unarchiveItem errors when the archived group is absent, the item is not in it, or the milestone id is unknown", async () => {
    const stores = await parityStores([{ name: WIDGETS, schema: widgetsSchema }]);
    try {
      const p = <T>(op: (s: LedgerStore) => Promise<T>): Promise<Outcome<T>> => parity(stores, op);

      const m = value(await p((s) => s.createMilestone({ title: "M-x" })));
      const a = value(
        await p((s) =>
          s.createItem(WIDGETS, m.id, {
            status: "resolved",
            fields: { severity: "minor", location: "a.ts", description: "alpha" },
          }),
        ),
      );
      // No archive yet.
      expectError(await p((s) => s.unarchiveItem(WIDGETS, m.id, a.id)), LedgerError);

      await p((s) => s.updateMilestone(m.id, { status: "done" }));
      await p((s) => s.archiveMilestone(m.id, "summary"));

      // Group exists but the requested item is not in it.
      expectError(await p((s) => s.unarchiveItem(WIDGETS, m.id, "W999")), LedgerError);
      // Unknown milestone group.
      expectError(await p((s) => s.unarchiveItem(WIDGETS, "M999", a.id)), LedgerError);

      expectStoreParity(stores);
    } finally {
      await stores.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// §2 — D-COHERENCE: onMutation firing order on archive
// ---------------------------------------------------------------------------

describe("T529: onMutation — D-COHERENCE archive firing order", () => {
  test("fires once per participating ledger (alphabetic order), then the milestones ledger; a ledger with no group for the milestone does not fire", async () => {
    const events: Array<[string, LedgerMutationOp]> = [];
    const store = new SqliteLedgerStore({
      dbPath: await freshDbPath(),
      now,
      onMutation: (ledgerId, op): void => {
        events.push([ledgerId, op]);
      },
    });
    await store.init();
    try {
      await store.createLedger(WIDGETS, widgetsSchema);
      await store.createLedger(NOTES, notesSchema);
      const m = await store.createMilestone({ title: "x" });
      await store.createItem(WIDGETS, m.id, {
        status: "resolved",
        fields: { severity: "minor", location: "x.ts", description: "d" },
      });
      // NOTES has no group for `m.id` — it must not participate.
      await store.updateMilestone(m.id, { status: "done" });

      events.length = 0;
      await store.archiveMilestone(m.id, "summary");
      expect(events).toEqual([
        [WIDGETS, "archive"],
        [MILESTONES_LEDGER, "archive"],
      ]);
    } finally {
      await store.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// §3 — includeArchived: derived-index scope transition, parity with fs
// ---------------------------------------------------------------------------

describe("T529: includeArchived — derived-index scope transition on archive/unarchive", () => {
  test("an archived item is searchable ONLY via includeArchived:true; unarchive restores active-scope searchability (parity)", async () => {
    const stores = await parityStores([{ name: WIDGETS, schema: widgetsSchema }]);
    try {
      const p = <T>(op: (s: LedgerStore) => Promise<T>): Promise<Outcome<T>> => parity(stores, op);

      const m = value(await p((s) => s.createMilestone({ title: "x" })));
      const it = value(
        await p((s) =>
          s.createItem(WIDGETS, m.id, {
            status: "resolved",
            fields: { severity: "minor", location: "z.ts", description: "zebracrossing" },
          }),
        ),
      );

      // Before archive: active, found by default in both stores.
      expect((await stores.fs.ftsSearch("zebracrossing")).map((h) => h.item.id)).toEqual([it.id]);
      expect((await stores.sq.ftsSearch("zebracrossing")).map((h) => h.item.id)).toEqual([it.id]);

      await p((s) => s.updateMilestone(m.id, { status: "done" }));
      await p((s) => s.archiveMilestone(m.id, "summary"));

      // After archive: hidden by default in both stores.
      expect((await stores.fs.ftsSearch("zebracrossing")).length).toBe(0);
      expect((await stores.sq.ftsSearch("zebracrossing")).length).toBe(0);
      // includeArchived reveals it identically in both stores.
      expect(
        (await stores.fs.ftsSearch("zebracrossing", { includeArchived: true })).map((h) => h.item.id),
      ).toEqual([it.id]);
      expect(
        (await stores.sq.ftsSearch("zebracrossing", { includeArchived: true })).map((h) => h.item.id),
      ).toEqual([it.id]);

      // Unarchive restores default (active-scope) searchability. Sqlite-only
      // assertion here: FsLedgerStore/AbstractLedgerStore.unarchiveItem has a
      // PRE-EXISTING, out-of-scope defect where the reattached item's docId
      // ("<ledger>:<itemId>", shared between the active and archived index
      // buckets) is dropped again by refreshLedgerIndexArchived's stale-id
      // discard, which runs AFTER fireMutation's active re-add — repro:
      // `bun -e` against a bare FsLedgerStore reproduces `ftsSearch` returning
      // [] post-unarchive even though `fetchItem`/`search` see the item fine.
      // SqliteLedgerStore.unarchiveItem (T529) orders the two refreshes the
      // other way round specifically to avoid this docId collision.
      await p((s) => s.unarchiveItem(WIDGETS, m.id, it.id));
      expect((await stores.sq.ftsSearch("zebracrossing")).map((h) => h.item.id)).toEqual([it.id]);

      expectStoreParity(stores);
    } finally {
      await stores.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// §4 — Divergence BACKUP action (VACUUM INTO a timestamped sibling .db)
// ---------------------------------------------------------------------------

/**
 * Capture everything written to process.stderr during `fn` (same helper as
 * backup-reinit-init.test.ts's fs-backend equivalent). Restores the original
 * write implementation even on throw.
 */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return orig(chunk);
  };
  try {
    await fn();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = orig;
  }
  return chunks.join("");
}

describe("T529: schema-divergence BACKUP action (VACUUM INTO a timestamped sibling .db)", () => {
  test("tampering ledgers.schema_json triggers a byte-complete backup; the backup is openable and holds the pre-divergence rows; the live db is canonical", async () => {
    const dbPath = await freshDbPath();
    const seed = openLedgerDb(dbPath);
    ensureSchema(seed);
    const diverged = JSON.parse(JSON.stringify(TASKS_SCHEMA)) as LedgerSchema;
    diverged.idPrefix = "ZZ"; // non-widening difference → divergent
    seed
      .query(
        "INSERT INTO ledgers (name, schema_json, milestone_counter, item_counter) VALUES (?, ?, 0, 1)",
      )
      .run("tasks", JSON.stringify(diverged));
    seed
      .query("INSERT INTO groups (ledger, id, title, description) VALUES (?, ?, '', '')")
      .run("tasks", MILESTONES_AMBIENT_ID);
    seed
      .query(
        `INSERT INTO items (ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run("tasks", "ZZ1", MILESTONES_AMBIENT_ID, "planned", JSON.stringify({ headline: "prior task" }), FIXED_NOW, FIXED_NOW);
    seed.close();

    const store = new SqliteLedgerStore({ dbPath, now });
    const stderr = await captureStderr(() => store.init());
    try {
      expect(stderr).toContain("WARNING");
      const match = /backed up to (\S+)/.exec(stderr);
      expect(match).not.toBeNull();
      const backupPath = (match as RegExpExecArray)[1] as string;

      const backupStat = await stat(backupPath);
      expect(backupStat.isFile()).toBe(true);

      const backupDb = new Database(backupPath, { readonly: true });
      try {
        const priorLedgerRow = backupDb
          .query("SELECT schema_json FROM ledgers WHERE name = ?")
          .get("tasks") as { schema_json: string } | null;
        expect(priorLedgerRow).not.toBeNull();
        expect((JSON.parse((priorLedgerRow as { schema_json: string }).schema_json) as LedgerSchema).idPrefix).toBe(
          "ZZ",
        );
        const priorItemRow = backupDb
          .query("SELECT id, fields_json FROM items WHERE ledger = ? AND id = ?")
          .get("tasks", "ZZ1") as { id: string; fields_json: string } | null;
        expect(priorItemRow).not.toBeNull();
        expect(JSON.parse((priorItemRow as { id: string; fields_json: string }).fields_json)).toEqual({
          headline: "prior task",
        });
      } finally {
        backupDb.close();
      }

      // Live db is back to canonical: schema reset, prior item gone.
      expect(store.fetch("tasks").schema).toEqual(TASKS_SCHEMA);
      const liveItems = store.fetch("tasks").milestones.flatMap((g) => g.items);
      expect(liveItems).toHaveLength(0);
    } finally {
      await store.dispose();
    }
  });
});
