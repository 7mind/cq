/**
 * SqliteLedgerStore T528 acceptance — ftsSearch parity with FsLedgerStore
 * over identical seeded data, mirroring the archive-INDEPENDENT FTS
 * assertions of test/store-abstract.ts (the includeArchived-after-archive
 * assertion needs archiveMilestone and is owned by T529; sqlite joins
 * runStoreAbstractSuite in T530). Both stores share the same derived
 * LedgerSearchIndex, so hits are compared EXACTLY (ids, order, scores,
 * matchedFields). Plus the sqlite-specific coherence contract: incremental
 * post-commit index maintenance and the peer-commit + invalidate() refresh
 * path (the T530 data_version watcher's trigger).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { LedgerSchema } from "../src/types.js";
import type {
  FtsSearchHit,
  FtsSearchOpts,
  LedgerStore,
} from "../src/store/LedgerStore.js";
import { FsLedgerStore } from "../src/store/FsLedgerStore.js";
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

// ---------------------------------------------------------------------------
// Parity harness — seed IDENTICAL data into both stores, compare hits exactly.
// ---------------------------------------------------------------------------

interface ParityStores {
  fs: FsLedgerStore;
  sq: SqliteLedgerStore;
  /** Run one op against BOTH stores (deterministic ids via fixed `now`). */
  both: (op: (s: LedgerStore) => Promise<unknown>) => Promise<void>;
  dispose: () => Promise<void>;
}

async function parityStores(
  seed: Array<{ name: string; schema: LedgerSchema }> = [],
): Promise<ParityStores> {
  const fs = new FsLedgerStore({ root: await freshDir("ledger-fs-fts-"), now });
  await fs.init();
  const sq = new SqliteLedgerStore({ dbPath: await freshDbPath(), now });
  await sq.init();
  const both = async (op: (s: LedgerStore) => Promise<unknown>): Promise<void> => {
    await op(fs);
    await op(sq);
  };
  for (const { name, schema } of seed) {
    await both((s) => s.createLedger(name, schema));
  }
  return {
    fs,
    sq,
    both,
    dispose: async (): Promise<void> => {
      await fs.dispose();
      await sq.dispose();
    },
  };
}

/** Comparable projection of a hit — id, rank-relevant score, matched fields. */
function hitKey(h: FtsSearchHit): unknown {
  return {
    ledgerId: h.ledgerId,
    itemId: h.item.id,
    status: h.item.status,
    score: h.score,
    matchedFields: [...h.matchedFields].sort(),
  };
}

/**
 * ftsSearch BOTH stores with the same query/opts and assert the hit lists are
 * identical (same items, same ORDER, same scores, same matchedFields — both
 * stores run the same LedgerSearchIndex over the same docs). Returns the
 * sqlite hits for extra pinning.
 */
async function ftsParity(
  stores: ParityStores,
  query: string,
  opts?: FtsSearchOpts,
): Promise<FtsSearchHit[]> {
  const fsHits = await stores.fs.ftsSearch(query, opts);
  const sqHits = await stores.sq.ftsSearch(query, opts);
  expect(sqHits.map(hitKey)).toEqual(fsHits.map(hitKey));
  return sqHits;
}

// ---------------------------------------------------------------------------
// Parity: ranked search, boosts, fuzzy/prefix/status, qualifiers, limit
// ---------------------------------------------------------------------------

describe("T528: ftsSearch parity with FsLedgerStore", () => {
  test("cross-ledger ranked search + single-ledger filter + full Item + score>0", async () => {
    const stores = await parityStores([
      { name: WIDGETS, schema: widgetsSchema },
      { name: NOTES, schema: notesSchema },
    ]);
    try {
      await stores.both((s) => s.createMilestone({ title: "x" }));
      await stores.both((s) =>
        s.createItem(WIDGETS, "M1", {
          status: "open",
          fields: { severity: "minor", location: "x.ts", description: "stream scroll defect" },
        }),
      );
      await stores.both((s) =>
        s.createItem(NOTES, "M1", { status: "open", fields: { notes: "stream notes here" } }),
      );

      const cross = await ftsParity(stores, "stream");
      expect(cross.map((h) => h.ledgerId).sort()).toEqual([NOTES, WIDGETS].sort());

      const single = await ftsParity(stores, "stream", { ledger: NOTES });
      expect(single.map((h) => h.ledgerId)).toEqual([NOTES]);
      expect(single[0]?.item.fields["notes"]).toBe("stream notes here");
      expect((single[0]?.score ?? 0) > 0).toBe(true);
    } finally {
      await stores.dispose();
    }
  });

  test("a headline-field match outranks a body-only match (boosts + matchedFields)", async () => {
    // The canonical defects ledger's required field IS 'headline'.
    const stores = await parityStores();
    try {
      await stores.both((s) => s.createMilestone({ title: "x" }));
      await stores.both((s) =>
        s.createItem("defects", "M1", {
          status: "open",
          fields: { headline: "widget overflow", severity: "minor", description: "x" },
        }),
      );
      await stores.both((s) =>
        s.createItem("defects", "M1", {
          status: "open",
          fields: { headline: "unrelated heading", severity: "minor", description: "the widget here" },
        }),
      );
      const hits = await ftsParity(stores, "widget", { ledger: "defects" });
      expect(hits.length).toBe(2);
      expect(hits[0]?.item.fields["headline"]).toBe("widget overflow");
      expect((hits[0]?.score ?? 0) > (hits[1]?.score ?? 1)).toBe(true);
      expect(hits[0]?.matchedFields).toContain("headline");
    } finally {
      await stores.dispose();
    }
  });

  test("edit-distance fuzzy, prefix, and statusFilter behave identically", async () => {
    const stores = await parityStores([{ name: WIDGETS, schema: widgetsSchema }]);
    try {
      await stores.both((s) => s.createMilestone({ title: "x" }));
      await stores.both((s) =>
        s.createItem(WIDGETS, "M1", {
          status: "open",
          fields: { severity: "minor", location: "x.ts", description: "neuromancer motorcycle" },
        }),
      );
      await stores.both((s) =>
        s.createItem(WIDGETS, "M1", {
          status: "resolved",
          fields: { severity: "major", location: "y.ts", description: "neuromancer scooter" },
        }),
      );
      // Exact misses the typo; fuzzy (edit distance) finds both.
      expect((await ftsParity(stores, "neromancer")).length).toBe(0);
      expect((await ftsParity(stores, "neromancer", { fuzzy: true })).length).toBe(2);
      // Prefix finds by term prefix.
      expect((await ftsParity(stores, "motor")).length).toBe(0);
      expect((await ftsParity(stores, "motor", { prefix: true })).length).toBe(1);
      // Status filter restricts.
      const open = await ftsParity(stores, "neuromancer", { statusFilter: "open" });
      expect(open.map((h) => h.item.status)).toEqual(["open"]);
    } finally {
      await stores.dispose();
    }
  });

  test("status:/ledger: qualifiers, OR-of-qualifiers, and limit behave identically", async () => {
    const stores = await parityStores([
      { name: WIDGETS, schema: widgetsSchema },
      { name: NOTES, schema: notesSchema },
    ]);
    try {
      await stores.both((s) => s.createMilestone({ title: "x" }));
      await stores.both((s) =>
        s.createItem(WIDGETS, "M1", {
          status: "open",
          fields: { severity: "minor", location: "a.ts", description: "falcon launch" },
        }),
      );
      await stores.both((s) =>
        s.createItem(WIDGETS, "M1", {
          status: "resolved",
          fields: { severity: "major", location: "b.ts", description: "falcon landing" },
        }),
      );
      await stores.both((s) =>
        s.createItem(NOTES, "M1", { status: "open", fields: { notes: "falcon notes" } }),
      );

      // Free text + status: qualifier.
      const open = await ftsParity(stores, "falcon status:open");
      expect(open.map((h) => h.item.status)).toEqual(["open", "open"]);
      // Free text + ledger: qualifier.
      const widgetsOnly = await ftsParity(stores, "falcon ledger:widgets");
      expect(widgetsOnly.map((h) => h.ledgerId)).toEqual([WIDGETS, WIDGETS]);
      // OR-of-qualifiers (structured evaluator, not the MiniSearch fast path).
      const orHits = await ftsParity(stores, "falcon (status:open OR status:resolved)");
      expect(orHits.length).toBe(3);
      // Pure-qualifier OR query (no free text) — matches ALL open/resolved
      // items in BOTH stores, canonical bootstrap items included.
      const pureOr = await ftsParity(stores, "(status:open OR status:resolved) ledger:widgets");
      expect(pureOr.length).toBe(2);
      // limit caps the ranked list identically.
      const limited = await ftsParity(stores, "falcon", { limit: 1 });
      expect(limited.length).toBe(1);
    } finally {
      await stores.dispose();
    }
  });

  test("milestone title is searchable; updateMilestone is reflected", async () => {
    const stores = await parityStores();
    try {
      await stores.both((s) => s.createMilestone({ title: "quasar migration" }));
      expect((await ftsParity(stores, "quasar")).map((h) => h.item.id)).toEqual(["M1"]);
      await stores.both((s) => s.updateMilestone("M1", { title: "pulsar migration" }));
      expect((await ftsParity(stores, "quasar")).length).toBe(0);
      expect((await ftsParity(stores, "pulsar")).map((h) => h.item.id)).toEqual(["M1"]);
    } finally {
      await stores.dispose();
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
      expect((await sq.ftsSearch("aardvark")).map((h) => h.item.id)).toEqual([it.id]);
      // Update swaps the searchable text.
      await sq.updateItem(WIDGETS, it.id, { fields: { description: "buffalo" } });
      expect((await sq.ftsSearch("aardvark")).length).toBe(0);
      expect((await sq.ftsSearch("buffalo")).map((h) => h.item.id)).toEqual([it.id]);
      // Terminal → reopen: the status: qualifier tracks each transition.
      await sq.updateItem(WIDGETS, it.id, { status: "resolved" });
      expect((await sq.ftsSearch("buffalo status:resolved")).length).toBe(1);
      await sq.reopenItem(WIDGETS, it.id, "in-progress");
      expect((await sq.ftsSearch("buffalo status:resolved")).length).toBe(0);
      expect((await sq.ftsSearch("buffalo status:in-progress")).length).toBe(1);
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
      expect((await b.ftsSearch("xylophone")).length).toBe(1);
      // …but A's derived index is in-memory and does NOT auto-observe the
      // peer commit (the row IS visible to A's row reads).
      expect((await a.ftsSearch("xylophone")).length).toBe(0);
      expect(a.search(WIDGETS, "xylophone").length).toBe(1);
      // invalidate — the T530 coherence watcher's trigger — rebuilds the
      // bucket from the committed rows.
      await a.invalidate(WIDGETS);
      const hits = await a.ftsSearch("xylophone");
      expect(hits.map((h) => h.item.fields["description"])).toEqual(["xylophone"]);
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
      expect((await a.ftsSearch("quokka")).length).toBe(0);
      await a.invalidate(NOTES);
      expect((await a.ftsSearch("quokka")).length).toBe(1);
      // Unknown ledger id: no throw, nothing surfaces.
      await a.invalidate("nope-not-here");
      expect(a.enumerate()).not.toContain("nope-not-here");
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });
});
