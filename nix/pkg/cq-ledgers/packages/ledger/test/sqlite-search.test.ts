/**
 * SqliteLedgerStore T528 acceptance — direct FTS search outcomes over seeded
 * SQLite data. Archive scope transitions are owned by T529; the shared store
 * contract covers broader behavior. This suite preserves SQLite-specific
 * incremental post-commit index maintenance and peer-commit invalidation.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { LedgerSchema } from "../src/types.js";
import type { FtsSearchHit } from "../src/store/LedgerStore.js";
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
  return path.join(await freshDir("ledger-sqlite-fts-"), "ledger.db");
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// Non-canonical ledgers (same shapes as store-abstract.ts).
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
  fields: {
    notes: { type: "string", required: false },
  },
};

async function sqliteStore(
  seed: Array<{ name: string; schema: LedgerSchema }> = [],
): Promise<SqliteLedgerStore> {
  const store = new SqliteLedgerStore({ dbPath: await freshDbPath(), now });
  await store.init();
  for (const { name, schema } of seed) {
    await store.createLedger(name, schema);
  }
  return store;
}

function projectHits(hits: FtsSearchHit[]) {
  const projections = hits.map(({ ledgerId, item, score, matchedFields }) => ({
    ledgerId,
    itemId: item.id,
    status: item.status,
    score,
    matchedFields,
  }));
  return projections;
}

// ---------------------------------------------------------------------------
// Ranked search, boosts, fuzzy/prefix/status, qualifiers, limit
// ---------------------------------------------------------------------------

describe("T528: ftsSearch outcomes", () => {
  test("cross-ledger ranked search + single-ledger filter + full Item + score>0", async () => {
    const store = await sqliteStore([
      { name: WIDGETS, schema: widgetsSchema },
      { name: NOTES, schema: notesSchema },
    ]);
    try {
      await store.createMilestone({ title: "x" });
      await store.createItem(WIDGETS, "M1", {
        status: "open",
        fields: { severity: "minor", location: "x.ts", description: "stream scroll defect" },
      });
      await store.createItem(NOTES, "M1", {
        status: "open",
        fields: { notes: "stream notes here" },
      });

      const cross = await store.ftsSearch("stream");
      expect(projectHits(cross)).toEqual([
        {
          ledgerId: NOTES,
          itemId: "N1",
          status: "open",
          score: 2.0329364592780506,
          matchedFields: ["body"],
        },
        {
          ledgerId: WIDGETS,
          itemId: "W1",
          status: "open",
          score: 1.6483955729033781,
          matchedFields: ["body"],
        },
      ]);

      const single = await store.ftsSearch("stream", { ledger: NOTES });
      expect(projectHits(single)).toEqual([
        {
          ledgerId: NOTES,
          itemId: "N1",
          status: "open",
          score: 2.0329364592780506,
          matchedFields: ["body"],
        },
      ]);
    } finally {
      await store.dispose();
    }
  });

  test("a headline-field match outranks a body-only match (boosts + matchedFields)", async () => {
    // The canonical defects ledger's required field IS 'headline'.
    const store = await sqliteStore();
    try {
      await store.createMilestone({ title: "x" });
      await store.createItem("defects", "M1", {
        status: "open",
        fields: { headline: "widget overflow", severity: "minor", description: "x" },
      });
      await store.createItem("defects", "M1", {
        status: "open",
        fields: {
          headline: "unrelated heading",
          severity: "minor",
          description: "the widget here",
        },
      });
      const hits = await store.ftsSearch("widget", { ledger: "defects" });
      expect(projectHits(hits)).toEqual([
        {
          ledgerId: "defects",
          itemId: "D1",
          status: "open",
          score: 6.680107172389065,
          matchedFields: ["headline"],
        },
        {
          ledgerId: "defects",
          itemId: "D2",
          status: "open",
          score: 2.9465650211134755,
          matchedFields: ["body"],
        },
      ]);
    } finally {
      await store.dispose();
    }
  });

  test("edit-distance fuzzy, prefix, and statusFilter return expected hits", async () => {
    const store = await sqliteStore([{ name: WIDGETS, schema: widgetsSchema }]);
    try {
      await store.createMilestone({ title: "x" });
      await store.createItem(WIDGETS, "M1", {
        status: "open",
        fields: { severity: "minor", location: "x.ts", description: "neuromancer motorcycle" },
      });
      await store.createItem(WIDGETS, "M1", {
        status: "resolved",
        fields: { severity: "major", location: "y.ts", description: "neuromancer scooter" },
      });
      // Exact misses the typo; fuzzy (edit distance) finds both.
      expect((await store.ftsSearch("neromancer")).length).toBe(0);
      expect(projectHits(await store.ftsSearch("neromancer", { fuzzy: true }))).toEqual([
        {
          ledgerId: WIDGETS,
          itemId: "W1",
          status: "open",
          score: 0.741742825283985,
          matchedFields: ["body"],
        },
        {
          ledgerId: WIDGETS,
          itemId: "W2",
          status: "resolved",
          score: 0.741742825283985,
          matchedFields: ["body"],
        },
      ]);
      // Prefix finds by term prefix.
      expect((await store.ftsSearch("motor")).length).toBe(0);
      expect(projectHits(await store.ftsSearch("motor", { prefix: true }))).toEqual([
        {
          ledgerId: WIDGETS,
          itemId: "W1",
          status: "open",
          score: 1.018483610464757,
          matchedFields: ["body"],
        },
      ]);
      // Status filter restricts.
      expect(projectHits(await store.ftsSearch("neuromancer", { statusFilter: "open" }))).toEqual([
        {
          ledgerId: WIDGETS,
          itemId: "W1",
          status: "open",
          score: 1.7981644249308726,
          matchedFields: ["body"],
        },
      ]);
    } finally {
      await store.dispose();
    }
  });

  test("status:/ledger: qualifiers, OR-of-qualifiers, and limit return expected hits", async () => {
    const store = await sqliteStore([
      { name: WIDGETS, schema: widgetsSchema },
      { name: NOTES, schema: notesSchema },
    ]);
    try {
      await store.createMilestone({ title: "x" });
      await store.createItem(WIDGETS, "M1", {
        status: "open",
        fields: { severity: "minor", location: "a.ts", description: "falcon launch" },
      });
      await store.createItem(WIDGETS, "M1", {
        status: "resolved",
        fields: { severity: "major", location: "b.ts", description: "falcon landing" },
      });
      await store.createItem(NOTES, "M1", { status: "open", fields: { notes: "falcon notes" } });

      // Free text + status: qualifier.
      const open = await store.ftsSearch("falcon status:open");
      expect(projectHits(open)).toEqual([
        {
          ledgerId: NOTES,
          itemId: "N1",
          status: "open",
          score: 1.748988645234638,
          matchedFields: ["body"],
        },
        {
          ledgerId: WIDGETS,
          itemId: "W1",
          status: "open",
          score: 1.3682218864752826,
          matchedFields: ["body"],
        },
      ]);
      // Free text + ledger: qualifier.
      const widgetsOnly = await store.ftsSearch("falcon ledger:widgets");
      expect(projectHits(widgetsOnly)).toEqual([
        {
          ledgerId: WIDGETS,
          itemId: "W1",
          status: "open",
          score: 1.3682218864752826,
          matchedFields: ["body"],
        },
        {
          ledgerId: WIDGETS,
          itemId: "W2",
          status: "resolved",
          score: 1.3682218864752826,
          matchedFields: ["body"],
        },
      ]);
      // OR-of-qualifiers (structured evaluator, not the MiniSearch fast path).
      const orHits = await store.ftsSearch("falcon (status:open OR status:resolved)");
      expect(projectHits(orHits)).toEqual([
        {
          ledgerId: NOTES,
          itemId: "N1",
          status: "open",
          score: 1.748988645234638,
          matchedFields: ["body"],
        },
        {
          ledgerId: WIDGETS,
          itemId: "W1",
          status: "open",
          score: 1.3682218864752826,
          matchedFields: ["body"],
        },
        {
          ledgerId: WIDGETS,
          itemId: "W2",
          status: "resolved",
          score: 1.3682218864752826,
          matchedFields: ["body"],
        },
      ]);
      // Pure-qualifier OR query (no free text) — matches ALL open/resolved
      // items in the canonical bootstrap ledger set included.
      const pureOr = await store.ftsSearch("(status:open OR status:resolved) ledger:widgets");
      expect(projectHits(pureOr)).toEqual([
        { ledgerId: WIDGETS, itemId: "W1", status: "open", score: 0, matchedFields: [] },
        { ledgerId: WIDGETS, itemId: "W2", status: "resolved", score: 0, matchedFields: [] },
      ]);
      // limit caps the ranked list.
      const limited = await store.ftsSearch("falcon", { limit: 1 });
      expect(projectHits(limited)).toEqual([
        {
          ledgerId: NOTES,
          itemId: "N1",
          status: "open",
          score: 1.748988645234638,
          matchedFields: ["body"],
        },
      ]);
    } finally {
      await store.dispose();
    }
  });

  test("milestone title is searchable; updateMilestone is reflected", async () => {
    const store = await sqliteStore();
    try {
      await store.createMilestone({ title: "quasar migration" });
      expect(projectHits(await store.ftsSearch("quasar"))).toEqual([
        {
          ledgerId: "milestones",
          itemId: "M1",
          status: "open",
          score: 3.8458488727842126,
          matchedFields: ["headline"],
        },
      ]);
      await store.updateMilestone("M1", { title: "pulsar migration" });
      expect(projectHits(await store.ftsSearch("quasar"))).toEqual([]);
      expect(projectHits(await store.ftsSearch("pulsar"))).toEqual([
        {
          ledgerId: "milestones",
          itemId: "M1",
          status: "open",
          score: 3.8458488727842126,
          matchedFields: ["headline"],
        },
      ]);
    } finally {
      await store.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Incremental maintenance + cross-process coherence (sqlite-specific)
// ---------------------------------------------------------------------------

describe("T528: sqlite derived-index coherence", () => {
  test("local coherence: create/update/reopen reflected in ftsSearch without any rebuild call", async () => {
    const sq = new SqliteLedgerStore({ dbPath: await freshDbPath(), now });
    await sq.init();
    try {
      await sq.createLedger(WIDGETS, widgetsSchema);
      const m = await sq.createMilestone({ title: "x" });
      const it = await sq.createItem(WIDGETS, m.id, {
        status: "open",
        fields: { severity: "minor", location: "x.ts", description: "aardvark" },
      });
      expect(projectHits(await sq.ftsSearch("aardvark"))).toEqual([
        {
          ledgerId: WIDGETS,
          itemId: "W1",
          status: "open",
          score: 2.400450540265541,
          matchedFields: ["body"],
        },
      ]);
      // Update swaps the searchable text.
      await sq.updateItem(WIDGETS, it.id, { fields: { description: "buffalo" } });
      expect(projectHits(await sq.ftsSearch("aardvark"))).toEqual([]);
      expect(projectHits(await sq.ftsSearch("buffalo"))).toEqual([
        {
          ledgerId: WIDGETS,
          itemId: "W1",
          status: "open",
          score: 2.400450540265541,
          matchedFields: ["body"],
        },
      ]);
      // Terminal → reopen: the status: qualifier tracks each transition.
      await sq.updateItem(WIDGETS, it.id, { status: "resolved" });
      expect(projectHits(await sq.ftsSearch("buffalo status:resolved"))).toEqual([
        {
          ledgerId: WIDGETS,
          itemId: "W1",
          status: "resolved",
          score: 2.400450540265541,
          matchedFields: ["body"],
        },
      ]);
      await sq.reopenItem(WIDGETS, it.id, "in-progress");
      expect(projectHits(await sq.ftsSearch("buffalo status:resolved"))).toEqual([]);
      expect(projectHits(await sq.ftsSearch("buffalo status:in-progress"))).toEqual([
        {
          ledgerId: WIDGETS,
          itemId: "W1",
          status: "in-progress",
          score: 2.400450540265541,
          matchedFields: ["body"],
        },
      ]);
    } finally {
      await sq.dispose();
    }
  });

  test("cross-process coherence: a peer's committed create + invalidate(ledgerId) surfaces in ftsSearch", async () => {
    const dbPath = await freshDbPath();
    const a = new SqliteLedgerStore({ dbPath, now });
    await a.init();
    const b = new SqliteLedgerStore({ dbPath, now });
    await b.init();
    try {
      await a.createLedger(WIDGETS, widgetsSchema);
      const m = await a.createMilestone({ title: "x" });
      // Peer connection B commits an item. B's OWN index reflects it at once…
      await b.invalidate(WIDGETS); // B learned of A's createLedger via its watcher
      await b.createItem(WIDGETS, m.id, {
        status: "open",
        fields: { severity: "minor", location: "x.ts", description: "xylophone" },
      });
      expect(projectHits(await b.ftsSearch("xylophone"))).toEqual([
        {
          ledgerId: WIDGETS,
          itemId: "W1",
          status: "open",
          score: 1.8210493974474302,
          matchedFields: ["body"],
        },
      ]);
      // …but A's derived index is in-memory and does NOT auto-observe the
      // peer commit (the row IS visible to A's row reads).
      expect(projectHits(await a.ftsSearch("xylophone"))).toEqual([]);
      expect(a.search(WIDGETS, "xylophone").length).toBe(1);
      // invalidate — the T530 coherence watcher's trigger — rebuilds the
      // bucket from the committed rows.
      await a.invalidate(WIDGETS);
      const hits = await a.ftsSearch("xylophone");
      expect(projectHits(hits)).toEqual([
        {
          ledgerId: WIDGETS,
          itemId: "W1",
          status: "open",
          score: 2.400450540265541,
          matchedFields: ["body"],
        },
      ]);
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });

  test("invalidate also surfaces a peer-created LEDGER's items; unknown ids are a no-op", async () => {
    const dbPath = await freshDbPath();
    const a = new SqliteLedgerStore({ dbPath, now });
    await a.init();
    const b = new SqliteLedgerStore({ dbPath, now });
    await b.init();
    try {
      const m = await b.createMilestone({ title: "x" });
      await b.createLedger(NOTES, notesSchema);
      await b.createItem(NOTES, m.id, { status: "open", fields: { notes: "quokka" } });
      // A has never seen the notes ledger; its index is stale until invalidated.
      expect(projectHits(await a.ftsSearch("quokka"))).toEqual([]);
      await a.invalidate(NOTES);
      expect(projectHits(await a.ftsSearch("quokka"))).toEqual([
        {
          ledgerId: NOTES,
          itemId: "N1",
          status: "open",
          score: 2.0794415416798357,
          matchedFields: ["body"],
        },
      ]);
      // Unknown ledger id: no throw, nothing surfaces.
      await a.invalidate("nope-not-here");
      expect(a.enumerate()).not.toContain("nope-not-here");
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });
});
