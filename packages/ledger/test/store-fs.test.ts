/**
 * Runs the abstract LedgerStore suite against FsLedgerStore (real fs in tmp dir).
 *
 * Each test gets a fresh tmp dir; the registry is pre-seeded by writing the
 * yaml file before init().
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  serializeRegistry,
  type LedgerSchema,
  type LedgerStore,
} from "../src/index.js";
import { runStoreAbstractSuite } from "./store-abstract.js";

const dirs: string[] = [];

async function seedDir(seed: Array<{ name: string; schema: LedgerSchema }>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ledger-fs-"));
  dirs.push(dir);
  const docsDir = path.join(dir, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(
    path.join(docsDir, "ledgers.yaml"),
    serializeRegistry({ version: 1, ledgers: seed }),
    "utf8",
  );
  return dir;
}

runStoreAbstractSuite({
  name: "FsLedgerStore",
  async build(seed: Array<{ name: string; schema: LedgerSchema }>): Promise<LedgerStore> {
    const dir = await seedDir(seed);
    const store = new FsLedgerStore({ root: dir });
    await store.init();
    return store;
  },
  async buildWithHook(
    seed: Array<{ name: string; schema: LedgerSchema }>,
    onMutation: (ledgerId: string, op: "create" | "update" | "archive") => void,
  ): Promise<LedgerStore> {
    const dir = await seedDir(seed);
    const store = new FsLedgerStore({ root: dir, onMutation });
    await store.init();
    return store;
  },
  async teardown(store: LedgerStore): Promise<void> {
    await store.dispose();
  },
});

// Cleanup tmp dirs after the file finishes.
import { afterAll, describe, it, expect } from "bun:test";
afterAll(async () => {
  for (const d of dirs) {
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// D-COHERENCE — cross-instance invalidate (FS-only; no semantics in InMem)
// ---------------------------------------------------------------------------

describe("FsLedgerStore — cross-instance invalidate", () => {
  it("A.updateItem then B.invalidate exposes the fresh row to B", async () => {
    const dir = await seedDir([
      {
        name: "xenos",
        schema: {
          statusValues: ["open", "done"],
          terminalStatuses: ["done"],
          fields: { note: { type: "string", required: true } },
        },
      },
    ]);
    const A = new FsLedgerStore({ root: dir });
    const B = new FsLedgerStore({ root: dir });
    await A.init();
    await B.init();
    try {
      const m = await A.createMilestone({ title: "x" });
      // B must see the milestone before referencing it. (Real usage:
      // the WS notification would call B.invalidate(MILESTONES_LEDGER)
      // here; tests do it explicitly.)
      await B.invalidate("milestones");
      const it = await A.createItem("xenos", m.id, {
        status: "open",
        fields: { note: "from-A" },
      });
      // BEFORE invalidate: B's cache is stale.
      expect(() => B.fetchItem("xenos", it.id)).toThrow(/Item not found/);
      await B.invalidate("xenos");
      // AFTER invalidate: B sees the row.
      const fetched = B.fetchItem("xenos", it.id);
      expect(fetched.id).toBe(it.id);
      expect(fetched.fields["note"]).toBe("from-A");
    } finally {
      await A.dispose();
      await B.dispose();
    }
  });

  // FTS cross-process coherence: prove the derived index rebuilds on the
  // REMOTE path (invalidate), not only on a local mutation. Mirrors the
  // LOCK-D01 two-store-one-cwd pattern: A writes an item; before the relay
  // delivers, B's ftsSearch misses; after B.invalidate (the onMutation→peer
  // relay), B's ftsSearch finds A's item.
  it("A.createItem then B.invalidate makes A's item searchable in B's FTS index", async () => {
    const dir = await seedDir([
      {
        name: "xenos",
        schema: {
          statusValues: ["open", "done"],
          terminalStatuses: ["done"],
          fields: { headline: { type: "string", required: true } },
        },
      },
    ]);
    const A = new FsLedgerStore({ root: dir });
    const B = new FsLedgerStore({ root: dir });
    await A.init();
    await B.init();
    try {
      const m = await A.createMilestone({ title: "x" });
      await B.invalidate("milestones"); // B learns the milestone first.
      await A.createItem("xenos", m.id, {
        status: "open",
        fields: { headline: "quokka sighting" },
      });
      // BEFORE the relay delivers: B's index is stale — no hit.
      expect((await B.ftsSearch("quokka")).length).toBe(0);
      // The D-COHERENCE relay (onMutation→peer.invalidate) re-reads xenos and
      // MUST rebuild B's FTS docs for it.
      await B.invalidate("xenos");
      const hits = await B.ftsSearch("quokka");
      expect(hits.length).toBe(1);
      expect(hits[0]?.ledgerId).toBe("xenos");
      expect(hits[0]?.item.fields["headline"]).toBe("quokka sighting");
    } finally {
      await A.dispose();
      await B.dispose();
    }
  });

  // FTS coherence on the registry-reload (new-ledger) branch of invalidate
  // (F1): a ledger A creates is searchable in B only after B.invalidate(<new>)
  // reloads the registry AND indexes the freshly-loaded ledger.
  it("A.createLedger+createItem then B.invalidate(<new>) makes the item searchable in B", async () => {
    const dir = await seedDir([]);
    const A = new FsLedgerStore({ root: dir });
    const B = new FsLedgerStore({ root: dir });
    await A.init();
    await B.init();
    try {
      await A.createLedger("fresh", {
        statusValues: ["open"],
        terminalStatuses: [],
        idPrefix: "F",
        fields: { headline: { type: "string", required: true } },
      });
      const m = await A.createMilestone({ title: "x" });
      await A.createItem("fresh", m.id, {
        status: "open",
        fields: { headline: "narwhal pod" },
      });
      // B knows nothing about `fresh` yet — no hit.
      expect((await B.ftsSearch("narwhal")).length).toBe(0);
      // Registry-reload branch must index the new ledger (F1).
      await B.invalidate("milestones");
      await B.invalidate("fresh");
      const hits = await B.ftsSearch("narwhal");
      expect(hits.map((h) => h.ledgerId)).toEqual(["fresh"]);
    } finally {
      await A.dispose();
      await B.dispose();
    }
  });

  it("A.createLedger then B.invalidate(<new>) reloads the registry and exposes the new ledger", async () => {
    const dir = await seedDir([]);
    const A = new FsLedgerStore({ root: dir });
    const B = new FsLedgerStore({ root: dir });
    await A.init();
    await B.init();
    try {
      await A.createLedger("freshly-baked", {
        statusValues: ["open"],
        terminalStatuses: [],
        fields: { note: { type: "string", required: false } },
      });
      // B knows nothing yet.
      expect(B.enumerate()).not.toContain("freshly-baked");
      await B.invalidate("freshly-baked");
      expect(B.enumerate()).toContain("freshly-baked");
      // B can read it cleanly.
      const fetched = B.fetch("freshly-baked");
      expect(fetched.id).toBe("freshly-baked");
    } finally {
      await A.dispose();
      await B.dispose();
    }
  });
});
