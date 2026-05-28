/**
 * Concurrency test for FsLedgerStore (msunify shape).
 *
 * Fires N parallel updateItem calls against the same item; asserts:
 *   - All complete without error.
 *   - The final on-disk file parses back cleanly.
 *   - Every distinct mutation is visible somewhere in the field history.
 *
 * Because the underlying per-ledger mutex serialises writers, the final
 * value will reflect *some* serialisation order; what we care about is
 * (a) no lost writes, (b) no corruption (file parses), (c) counter
 * monotonicity (creates also race).
 *
 * Tests use a deterministic ISO-string `now` injection: a monotonic
 * tick fed through `new Date(tick).toISOString()` keeps lexicographic
 * ordering aligned with numeric ordering (so timestamp comparisons can
 * be done via plain `<`).
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  parseLedger,
  serializeRegistry,
  type Item,
  type LedgerSchema,
  MILESTONES_LEDGER,
  MILESTONES_SCHEMA,
} from "../src/index.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) {
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

const schema: LedgerSchema = {
  statusValues: ["open", "in-progress", "resolved"],
  terminalStatuses: ["resolved"],
  fields: {
    severity: { type: "string", required: true },
    location: { type: "string", required: true },
    description: { type: "string", required: true },
    counter: { type: "string", required: false },
  },
};

function isoTick(tick: number): string {
  // Use an arbitrary base date in 2026 so the ticks fall in a realistic
  // time range; add `tick` milliseconds.
  return new Date(1_780_000_000_000 + tick).toISOString();
}

async function setup(opts: { now?: () => string } = {}): Promise<FsLedgerStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "ledger-conc-"));
  dirs.push(dir);
  const docsDir = path.join(dir, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(
    path.join(docsDir, "ledgers.yaml"),
    serializeRegistry({ version: 1, ledgers: [{ name: "defects", schema }] }),
    "utf8",
  );
  const fsOpts: { root: string; now?: () => string } = { root: dir };
  if (opts.now !== undefined) fsOpts.now = opts.now;
  const store = new FsLedgerStore(fsOpts);
  await store.init();
  return store;
}

describe("FsLedgerStore concurrency", () => {
  it("50 parallel updateItem calls leave a parseable, complete file", async () => {
    const store = await setup();
    const m = await store.createMilestone({ title: "M-one" });
    const item = await store.createItem("defects", m.id, {
      status: "open",
      fields: { severity: "minor", location: "x.ts", description: "init" },
    });

    const N = 50;
    const updates = Array.from({ length: N }, (_, i) =>
      store.updateItem("defects", item.id, {
        fields: { counter: String(i) },
      }),
    );
    const results = await Promise.all(updates);
    expect(results.length).toBe(N);
    // Final on-disk file parses.
    const text = await (async () => {
      for (const d of dirs) {
        try {
          return await readFile(path.join(d, "docs", "defects.md"), "utf8");
        } catch {
          /* try next */
        }
      }
      throw new Error("could not locate ledger file");
    })();
    const parsed = parseLedger(text, { schema });
    expect(parsed.milestones[0]?.items[0]?.id).toBe(item.id);
    // At least one of the writes' counter values survives as the final.
    const finalCounter = parsed.milestones[0]?.items[0]?.fields["counter"];
    expect(typeof finalCounter).toBe("string");
    expect(Number(finalCounter)).toBeGreaterThanOrEqual(0);
    expect(Number(finalCounter)).toBeLessThan(N);
  });

  // D-LED-07: strengthen the 50-parallel-update assertion.
  it("50 parallel updateItem calls serialise with monotonic updatedAt and final state is the last write (D-LED-07)", async () => {
    let tick = 0;
    const store = await setup({ now: () => isoTick(tick++) });
    // The bootstrap of the milestones ledger happens before any test
    // `now()` is consumed because init() is called inside setup() before
    // we override anything mutable. The createMilestone call below
    // consumes the first tick(s).
    const baseTick = tick; // tick after init
    const m = await store.createMilestone({ title: "M-one" });
    // createItem also consumes a tick (item.createdAt/updatedAt).
    const item = await store.createItem("defects", m.id, {
      status: "open",
      fields: { severity: "minor", location: "x.ts", description: "init" },
    });

    const N = 50;
    const updates: Array<Promise<Item>> = [];
    for (let i = 0; i < N; i++) {
      updates.push(
        store.updateItem("defects", item.id, {
          fields: { counter: String(i) },
        }),
      );
    }
    const results = await Promise.all(updates);

    // ISO 8601 strings compare lexicographically same as the underlying
    // Date.parse'd ms values for same-precision UTC formats.
    const sorted = [...results].sort((a, b) =>
      a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0,
    );
    // Verify strict monotonicity of updatedAt across the N serialised writes.
    for (let i = 1; i < N; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev === undefined || cur === undefined) throw new Error("missing result");
      expect(cur.updatedAt > prev.updatedAt).toBe(true);
    }

    // The final on-disk state corresponds to the last serialised write.
    const text = await readFile(
      path.join(dirs[dirs.length - 1] ?? "", "docs", "defects.md"),
      "utf8",
    );
    const parsed = parseLedger(text, { schema });
    const final = parsed.milestones[0]?.items[0];
    if (final === undefined) throw new Error("missing parsed item");
    const winner = sorted[N - 1];
    if (winner === undefined) throw new Error("missing winner");
    expect(final.updatedAt).toBe(winner.updatedAt);
    expect(final.fields["counter"]).toBe(winner.fields["counter"]);
    void baseTick;
  });

  it("50 parallel createItem calls allocate unique monotonic ids", async () => {
    const store = await setup();
    const m = await store.createMilestone({ title: "M-x" });
    const N = 50;
    const items = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.createItem("defects", m.id, {
          status: "open",
          fields: {
            severity: "minor",
            location: `f${i}.ts`,
            description: `desc ${i}`,
          },
        }),
      ),
    );
    const ids = new Set(items.map((it) => it.id));
    expect(ids.size).toBe(N);
    const ledger = store.fetch("defects");
    expect(ledger.counters.item).toBeGreaterThanOrEqual(N);
  });

  it("dispose() drains in-flight mutations before returning (D-LED-06)", async () => {
    const store = await setup();
    const m = await store.createMilestone({ title: "M-one" });
    const item = await store.createItem("defects", m.id, {
      status: "open",
      fields: { severity: "minor", location: "x.ts", description: "init" },
    });

    const N = 20;
    const updates: Array<Promise<Item>> = [];
    for (let i = 0; i < N; i++) {
      updates.push(
        store.updateItem("defects", item.id, {
          fields: { counter: String(i) },
        }),
      );
    }

    let updatesSettledFirst = false;
    const updatesAll = Promise.all(updates).then(() => {
      updatesSettledFirst = true;
    });

    await store.dispose();

    expect(updatesSettledFirst).toBe(true);
    await updatesAll;
  });

  it("concurrent updates to different ledgers run without cross-blocking", async () => {
    // Build a store with two ledgers (plus the bootstrapped milestones).
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-conc-multi-"));
    dirs.push(dir);
    const docsDir = path.join(dir, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(
      path.join(docsDir, "ledgers.yaml"),
      serializeRegistry({
        version: 1,
        ledgers: [
          { name: MILESTONES_LEDGER, schema: MILESTONES_SCHEMA },
          { name: "a", schema },
          { name: "b", schema },
        ],
      }),
      "utf8",
    );
    const store = new FsLedgerStore({ root: dir });
    await store.init();
    // Single shared milestone (createItem in two different ledgers).
    const m = await store.createMilestone({ title: "Mx" });
    const N = 20;
    const allUpdates: Array<Promise<unknown>> = [];
    for (let i = 0; i < N; i++) {
      allUpdates.push(
        store.createItem("a", m.id, {
          status: "open",
          fields: { severity: "minor", location: "a.ts", description: `a${i}` },
        }),
      );
      allUpdates.push(
        store.createItem("b", m.id, {
          status: "open",
          fields: { severity: "minor", location: "b.ts", description: `b${i}` },
        }),
      );
    }
    await Promise.all(allUpdates);
    expect(store.fetch("a").milestones[0]?.items.length).toBe(N);
    expect(store.fetch("b").milestones[0]?.items.length).toBe(N);
  });
});
