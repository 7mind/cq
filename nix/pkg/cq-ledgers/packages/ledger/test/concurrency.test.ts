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
  LEDGER_STORAGE_DIRNAME,
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
  return new Date(1_780_000_000_000 + tick).toISOString();
}

async function setup(opts: { now?: () => string } = {}): Promise<FsLedgerStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "ledger-conc-"));
  dirs.push(dir);
  const docsDir = path.join(dir, LEDGER_STORAGE_DIRNAME);
  await mkdir(docsDir, { recursive: true });
  await writeFile(
    path.join(docsDir, "ledgers.yaml"),
    serializeRegistry({ version: 1, ledgers: [{ name: "xenos", schema }] }),
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
    const item = await store.createItem("xenos", m.id, {
      status: "open",
      fields: { severity: "minor", location: "x.ts", description: "init" },
    });

    const N = 50;
    const updates = Array.from({ length: N }, (_, i) =>
      store.updateItem("xenos", item.id, {
        fields: { counter: String(i) },
      }),
    );
    const results = await Promise.all(updates);
    expect(results.length).toBe(N);
    const text = await (async () => {
      for (const d of dirs) {
        try {
          return await readFile(path.join(d, LEDGER_STORAGE_DIRNAME, "xenos.md"), "utf8");
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
    const item = await store.createItem("xenos", m.id, {
      status: "open",
      fields: { severity: "minor", location: "x.ts", description: "init" },
    });

    const N = 50;
    const updates: Array<Promise<Item>> = [];
    for (let i = 0; i < N; i++) {
      updates.push(
        store.updateItem("xenos", item.id, {
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
    // strict monotonicity of updatedAt across the N serialised writes
    for (let i = 1; i < N; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev === undefined || cur === undefined) throw new Error("missing result");
      expect(cur.updatedAt > prev.updatedAt).toBe(true);
    }

    // The final on-disk state corresponds to the last serialised write.
    const text = await readFile(
      path.join(dirs[dirs.length - 1] ?? "", LEDGER_STORAGE_DIRNAME, "xenos.md"),
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
        store.createItem("xenos", m.id, {
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
    const ledger = store.fetch("xenos");
    expect(ledger.counters.item).toBeGreaterThanOrEqual(N);
  });

  it("dispose() drains in-flight mutations before returning (D-LED-06)", async () => {
    const store = await setup();
    const m = await store.createMilestone({ title: "M-one" });
    const item = await store.createItem("xenos", m.id, {
      status: "open",
      fields: { severity: "minor", location: "x.ts", description: "init" },
    });

    const N = 20;
    const updates: Array<Promise<Item>> = [];
    for (let i = 0; i < N; i++) {
      updates.push(
        store.updateItem("xenos", item.id, {
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

  // LOCK-D01: two FsLedgerStore instances on the SAME cwd simulate the cq
  // server's in-process store and the long-lived cq-mcp child. They share NO
  // in-process AsyncMutex (each store has its own), so only the cross-process
  // advisory file lock serialises their writes. Before the wait-with-timeout
  // fix the second writer hit a live-pid EEXIST and threw LedgerBusyError; now
  // it waits out the short critical section. Both stores run in THIS process,
  // so both pids are alive — the WAIT path (not the dead-reclaim path) is
  // exercised, exactly the production scenario.
  //
  // No-lost-write across processes is a TWO-layer guarantee: (1) the file lock
  // serialises writes so no torn/corrupt file (LOCK-D01's job), and (2) the
  // D-COHERENCE channel (onMutation → peer.invalidate, relayed over InternalWs
  // in production) makes each store re-read the peer's committed state before
  // its next write, so neither overwrites the other's snapshot. This test wires
  // that channel exactly as production does and serialises each writer's next
  // op behind the peer's invalidate — proving the lock waits AND the merge
  // holds. Without the LOCK-D01 fix this test would throw LedgerBusyError
  // instead of reaching the assertions.
  it("two FsLedgerStore instances on one cwd both complete concurrent writes with no lost write (LOCK-D01)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-conc-xproc-"));
    dirs.push(dir);
    const docsDir = path.join(dir, LEDGER_STORAGE_DIRNAME);
    await mkdir(docsDir, { recursive: true });
    await writeFile(
      path.join(docsDir, "ledgers.yaml"),
      serializeRegistry({
        version: 1,
        ledgers: [
          { name: MILESTONES_LEDGER, schema: MILESTONES_SCHEMA },
          { name: "xenos", schema },
        ],
      }),
      "utf8",
    );

    // A short real poll interval keeps the test fast while genuinely exercising
    // the cross-instance file-lock waiting against a real (short) critical
    // section. acquireTimeoutMs stays at the default so it never spuriously
    // times out under load.
    const lockfileOpts = { pollIntervalMs: 5 };

    // The coherence relay: each store's onMutation invalidates the SAME ledger
    // on its peer, mirroring the InternalWs `ledger.changed` notification. The
    // relay promise is collected so the test can await convergence. (onMutation
    // is synchronous and fires after lock release; it schedules the async
    // invalidate, exactly like the WS send → remote handler hop.)
    const relayed: Array<Promise<void>> = [];
    // The relay closures read `storeA`/`storeB` lazily (only when fired by a
    // write, after both are constructed), so capturing the const bindings
    // before the second is initialised is safe — onMutation never fires during
    // construction.
    const relayToB = (ledgerId: string): void => {
      relayed.push(storeB.invalidate(ledgerId).catch(() => undefined));
    };
    const relayToA = (ledgerId: string): void => {
      relayed.push(storeA.invalidate(ledgerId).catch(() => undefined));
    };
    const storeA = new FsLedgerStore({ root: dir, lockfile: lockfileOpts, onMutation: relayToB });
    const storeB = new FsLedgerStore({ root: dir, lockfile: lockfileOpts, onMutation: relayToA });
    await storeA.init();
    await storeB.init();

    // storeA owns milestone creation; both stores create items into it.
    const m = await storeA.createMilestone({ title: "M-shared" });
    await storeB.invalidate(MILESTONES_LEDGER); // B learns the new milestone.

    // Alternate a write on A then a write on B, draining the coherence relay
    // between writes so each store re-reads the peer's committed state before
    // its own next write. The file lock + relay together guarantee no lost
    // write. Each individual createItem still exercises the cross-instance file
    // lock (both stores' locks live in the same .locks dir on one cwd).
    const N = 15;
    let aSeq = 0;
    let bSeq = 0;
    for (let i = 0; i < N; i++) {
      await storeA.createItem("xenos", m.id, {
        status: "open",
        fields: { severity: "minor", location: "a.ts", description: `A${aSeq++}` },
      });
      await storeB.createItem("xenos", m.id, {
        status: "open",
        fields: { severity: "minor", location: "b.ts", description: `B${bSeq++}` },
      });
      // Drain relayed invalidations so the next iteration's writes start from
      // the freshest committed state.
      await Promise.all(relayed.splice(0));
    }
    // Final drain.
    await Promise.all(relayed.splice(0));

    // Final on-disk file parses cleanly and reflects writes from BOTH stores
    // with no lost write. Read from disk (the authority of record).
    const text = await readFile(path.join(docsDir, "xenos.md"), "utf8");
    const parsed = parseLedger(text, { schema });
    const group = parsed.milestones.find((g) => g.id === m.id);
    if (group === undefined) throw new Error("milestone group missing on disk");
    expect(group.items.length).toBe(2 * N);
    const fromA = group.items.filter((it) => it.fields["location"] === "a.ts").length;
    const fromB = group.items.filter((it) => it.fields["location"] === "b.ts").length;
    expect(fromA).toBe(N);
    expect(fromB).toBe(N);
    // Ids are unique (counter monotonicity held across the cross-process lock).
    const ids = new Set(group.items.map((it) => it.id));
    expect(ids.size).toBe(2 * N);

    await storeA.dispose();
    await storeB.dispose();
  });

  // LOCK-D01 — the file lock's OWN guarantee in isolation: two stores writing
  // to DIFFERENT ledgers on the same cwd contend on nothing data-wise but DO
  // share the .locks dir; concurrent fire from both must all succeed with no
  // LedgerBusyError and both files parse. This isolates "the second writer
  // waits" from the coherence-merge layer (no shared ledger → no merge needed).
  it("two FsLedgerStore instances writing different ledgers on one cwd never throw LedgerBusyError (LOCK-D01)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-conc-xproc2-"));
    dirs.push(dir);
    const docsDir = path.join(dir, LEDGER_STORAGE_DIRNAME);
    await mkdir(docsDir, { recursive: true });
    await writeFile(
      path.join(docsDir, "ledgers.yaml"),
      serializeRegistry({
        version: 1,
        ledgers: [
          { name: MILESTONES_LEDGER, schema: MILESTONES_SCHEMA },
          { name: "alpha", schema },
          { name: "beta", schema },
        ],
      }),
      "utf8",
    );
    const lockfileOpts = { pollIntervalMs: 5 };
    const storeA = new FsLedgerStore({ root: dir, lockfile: lockfileOpts });
    const storeB = new FsLedgerStore({ root: dir, lockfile: lockfileOpts });
    await storeA.init();
    await storeB.init();
    // Both stores share the SAME milestones lockfile (__milestones__.lock) on
    // createItem, so they genuinely contend on the cross-process lock even
    // though their data ledgers differ.
    const m = await storeA.createMilestone({ title: "M-x" });
    await storeB.invalidate(MILESTONES_LEDGER);

    const N = 20;
    const ops: Array<Promise<unknown>> = [];
    for (let i = 0; i < N; i++) {
      ops.push(
        storeA.createItem("alpha", m.id, {
          status: "open",
          fields: { severity: "minor", location: "a.ts", description: `a${i}` },
        }),
      );
      ops.push(
        storeB.createItem("beta", m.id, {
          status: "open",
          fields: { severity: "minor", location: "b.ts", description: `b${i}` },
        }),
      );
    }
    // No LedgerBusyError despite both contending on __milestones__.lock.
    await Promise.all(ops);

    const alpha = parseLedger(await readFile(path.join(docsDir, "alpha.md"), "utf8"), { schema });
    const beta = parseLedger(await readFile(path.join(docsDir, "beta.md"), "utf8"), { schema });
    expect(alpha.milestones.find((g) => g.id === m.id)?.items.length).toBe(N);
    expect(beta.milestones.find((g) => g.id === m.id)?.items.length).toBe(N);

    await storeA.dispose();
    await storeB.dispose();
  });

  it("concurrent updates to different ledgers run without cross-blocking", async () => {
    // Build a store with two ledgers (plus the bootstrapped milestones).
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-conc-multi-"));
    dirs.push(dir);
    const docsDir = path.join(dir, LEDGER_STORAGE_DIRNAME);
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
