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
        name: "defects",
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
      const it = await A.createItem("defects", m.id, {
        status: "open",
        fields: { note: "from-A" },
      });
      // BEFORE invalidate: B's cache is stale.
      expect(() => B.fetchItem("defects", it.id)).toThrow(/Item not found/);
      await B.invalidate("defects");
      // AFTER invalidate: B sees the row.
      const fetched = B.fetchItem("defects", it.id);
      expect(fetched.id).toBe(it.id);
      expect(fetched.fields["note"]).toBe("from-A");
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
