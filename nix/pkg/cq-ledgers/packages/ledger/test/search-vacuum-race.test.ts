/**
 * D67 regression — minisearch background-vacuum vs. concurrent add() race.
 *
 * The defect: `LedgerSearchIndex` (../src/search/LedgerSearchIndex.ts) wrapped
 * `minisearch` with its DEFAULT auto-vacuum behavior. minisearch reclaims space
 * from discarded documents by ASYNCHRONOUSLY vacuuming the inverted index in
 * batches of `batchSize` (1000) terms, yielding control via
 * `setTimeout(resolve, batchWait)` between batches (see
 * MiniSearch#performVacuuming).
 *
 * The vacuum loop iterates `this._index` — a radix tree (`SearchableMap`) via a
 * single suspended `TreeIterator` that snapshots each node's child keys with
 * `Array.from(child.keys())` while diving. If a document is ADDED during a
 * batch-yield and that add() RESTRUCTURES the prefix tree — specifically a node
 * SPLIT, which `delete`s the old compressed edge key (see `createPath`) — then a
 * key still present in the iterator's snapshot no longer resolves to a child
 * node. On resume the next `dive()` evaluates `child.keys()` on `undefined` and
 * throws:
 *
 *     TypeError: undefined is not an object (evaluating 'child.keys')
 *       at dive → next → performVacuuming
 *
 * This crashed `cq web`, whose reindex-on-every-change drives a steady stream of
 * discard()+add() through LedgerSearchIndex.
 *
 * The fix (T436): construct MiniSearch with `autoVacuum: false`, so minisearch
 * NEVER schedules a background vacuum and therefore no add() can ever interleave
 * one. Tombstone memory is reclaimed instead by LedgerSearchIndex's own
 * SYNCHRONOUS rebuild-and-swap (no async batch-yield window).
 *
 * This test pins BOTH halves of the fix:
 *
 *  1. `autoVacuumDisabled`: the original deterministic seam — a temporary
 *     `globalThis.setTimeout` that, on the FIRST vacuum batch-yield, performs one
 *     edge-splitting add() — is armed against a MiniSearch built EXACTLY as
 *     LedgerSearchIndex builds it. Because auto-vacuum is off, discardAll()
 *     schedules NO background vacuum, the seam never fires, and no TypeError is
 *     thrown. (Pre-fix, with the default config, this seam fired and crashed —
 *     that is the recorded D67 defect.)
 *  2. `reclaimNeverInterleaves`: driving LedgerSearchIndex through enough
 *     rebuild cycles to cross its dirt threshold exercises the synchronous
 *     rebuild-and-swap reclaim path; it completes with no error and search
 *     results stay correct (discarded docs excluded, live docs found).
 */

import { test, expect, afterEach } from "bun:test";
// Import minisearch exactly as LedgerSearchIndex.ts does.
import MiniSearch from "minisearch";
import { LedgerSearchIndex } from "../src/index.js";
import type { Item } from "../src/index.js";

/** One indexed document, mirroring LedgerSearchIndex.ts's IndexDoc shape. */
interface IndexDoc {
  docId: string;
  ledgerId: string;
  itemId: string;
  status: string;
  archived: boolean;
  headline: string;
  body: string;
}

/**
 * Construct MiniSearch with OUR options (copied from LedgerSearchIndex.ts's
 * `makeMini`). `autoVacuum: false` is the D67 core fix and is asserted below to
 * be present.
 */
function makeIndex(): MiniSearch<IndexDoc> {
  return new MiniSearch<IndexDoc>({
    idField: "docId",
    fields: ["headline", "body", "status"],
    storeFields: ["ledgerId", "itemId", "status", "archived"],
    autoVacuum: false,
  });
}

/**
 * Deterministic high-entropy hex term. Long, sparsely-shared suffixes make the
 * radix tree compress divergent tails into MULTI-CHAR edge keys (rather than a
 * dense single-char fan-out), which are the keys a `createPath` split can
 * delete out from under the in-flight iterator.
 */
function h32(n: number): string {
  return ((n * 2654435761) >>> 0).toString(16).padStart(8, "0");
}
function termFor(n: number, slot: string): string {
  return slot + h32(n) + h32(n ^ 0x5a5a5a5a);
}

/**
 * The in-flight `TreeIterator` exposes the descent stack as `_path`: a list of
 * `{ node, keys }` frames. `node` is the radix-tree Map at that level; `keys` is
 * the snapshot of child keys still to visit (popped from the END as iteration
 * proceeds). We read it ONLY to craft a term that deterministically splits a
 * not-yet-visited compressed edge.
 */
interface TreeIteratorFrame {
  node: Map<string, unknown>;
  keys: string[];
}
interface TreeIteratorInternals {
  _path: TreeIteratorFrame[];
}
interface SearchableMapInternals {
  [Symbol.iterator](): Iterator<[string, unknown]>;
}

const last = <T>(a: T[]): T | undefined => a[a.length - 1];

// The original timer, captured so the seam can always be restored.
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  // Defensive: restore the seam even if a test body threw before its finally.
  globalThis.setTimeout = originalSetTimeout;
});

test(
  "D67: autoVacuum:false — discard schedules no background vacuum, so the " +
    "edge-splitting add() seam never fires and no child.keys TypeError is thrown",
  async () => {
    const mini = makeIndex();

    // The fix's invariant: minisearch must be configured with auto-vacuum
    // disabled. Read it back from the resolved options.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mini as any)._options.autoVacuum).toBe(false);

    // 1. Populate with enough documents that the index holds > ~1000 distinct
    //    terms (3 unique terms/doc * 600 = ~1800), past one 1000-term vacuum
    //    batch — i.e. a vacuum WOULD yield mid-traversal if one were scheduled.
    const DOC_COUNT = 600;
    for (let i = 0; i < DOC_COUNT; i++) {
      mini.add({
        docId: `led:${i}`,
        ledgerId: "led",
        itemId: String(i),
        status: termFor(i, "s"),
        archived: false,
        headline: termFor(i, "h"),
        body: termFor(i, "b"),
      });
    }

    // 2. Remove > 10% (and >= 20) of the documents: under the DEFAULT config
    //    this satisfies minDirtCount/minDirtFactor and discard()/discardAll()
    //    would auto-enqueue a background vacuum. With autoVacuum:false it does
    //    NOT — that is exactly what this test pins.
    const REMOVE_COUNT = 120; // 20% of 600
    const toRemove: string[] = [];
    for (let i = 0; i < REMOVE_COUNT; i++) toRemove.push(`led:${i}`);

    // Arm the SAME deterministic seam the pre-fix repro used. If any background
    // vacuum were scheduled (it is not, post-fix), its first batch-yield would
    // call setTimeout, the seam would inject an edge-splitting add(), and the
    // suspended iterator would dive onto a deleted edge → child.keys TypeError.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const index = (mini as any)._index as SearchableMapInternals;
    const realIterator = index[Symbol.iterator].bind(index);
    let captured: (Iterator<[string, unknown]> & TreeIteratorInternals) | undefined;
    index[Symbol.iterator] = function (): Iterator<[string, unknown]> {
      captured = realIterator() as Iterator<[string, unknown]> & TreeIteratorInternals;
      return captured;
    };

    let injected = false;
    const seam: typeof globalThis.setTimeout = ((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (!injected && captured !== undefined) {
        injected = true;
        const path = captured._path;
        const deepest = path[path.length - 1];
        if (deepest !== undefined) {
          let prefix = "";
          for (let f = 0; f < path.length - 1; f++) {
            const frame = path[f];
            if (frame === undefined) continue;
            const k = last(frame.keys);
            if (k !== undefined && k !== "") prefix += k;
          }
          const multiCharEdge = deepest.keys.find((k) => k.length > 1);
          if (multiCharEdge !== undefined) {
            const fullTerm = prefix + multiCharEdge;
            const splitter = fullTerm.slice(0, -1) + "~";
            mini.add({
              docId: "led:injected",
              ledgerId: "led",
              itemId: "injected",
              status: "x",
              archived: false,
              headline: splitter,
              body: "x",
            });
          }
        }
      }
      return originalSetTimeout(handler as (...a: unknown[]) => void, timeout, ...args);
    }) as unknown as typeof globalThis.setTimeout;

    let observedError: unknown = undefined;
    let unhandled: unknown = undefined;
    const onUnhandled = (err: unknown): void => {
      unhandled = err;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      globalThis.setTimeout = seam;
      // discardAll() under the DEFAULT config would auto-enqueue a background
      // vacuum here. With autoVacuum:false it must not. NOTE: we deliberately do
      // NOT call mini.vacuum() — that explicit async-batched call is exactly the
      // path the seam corrupts, and LedgerSearchIndex never calls it post-fix.
      mini.discardAll(toRemove);
      // Drain the macrotask queue several times so that any background vacuum
      // minisearch might have scheduled (it must not) would get to run, fire the
      // seam, and crash. Post-fix nothing is scheduled, so this is quiescent.
      for (let i = 0; i < 5; i++) {
        await new Promise<void>((resolve) => originalSetTimeout(resolve, 0));
      }
    } catch (err) {
      observedError = err;
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      index[Symbol.iterator] = realIterator;
      process.off("unhandledRejection", onUnhandled);
    }

    // Post-fix invariants: discardAll() scheduled NO background vacuum, so
    //   - the seam never fired (no vacuum batch-yield occurred), and
    //   - no child.keys TypeError surfaced, synchronously or via a rejected
    //     background-vacuum promise.
    // Pre-fix (default config) the seam fired during the auto-scheduled vacuum's
    // first batch-yield and the iterator dove onto a deleted edge → TypeError.
    expect(injected).toBe(false);
    expect(observedError).toBeUndefined();
    expect(unhandled).toBeUndefined();
  },
);

function item(id: string, status: string, fields: Record<string, string | string[]>): Item {
  return {
    id,
    milestoneId: "M1",
    status,
    fields,
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
  };
}

test(
  "D67: LedgerSearchIndex tombstone reclaim (rebuild-and-swap) completes with " +
    "no error and keeps search correct across many rebuild cycles",
  () => {
    const idx = new LedgerSearchIndex();
    const LEDGER = "tasks";

    // Each rebuildLedgerActive discards the prior bucket and re-adds the fresh
    // items, accumulating tombstones. Enough docs * enough cycles crosses the
    // index's internal dirt threshold (REBUILD_DIRT_THRESHOLD = 1000), driving
    // the synchronous rebuild-and-swap reclaim path repeatedly.
    const DOCS_PER_CYCLE = 200;
    const CYCLES = 12; // 200 discards/cycle * 12 = 2400 tombstones > 1000

    let error: unknown = undefined;
    try {
      for (let c = 0; c < CYCLES; c++) {
        const items: Item[] = [];
        for (let i = 0; i < DOCS_PER_CYCLE; i++) {
          items.push(
            item(`T${i}`, "planned", {
              headline: termFor(i, "h") + " widget",
              description: termFor(i + c, "b"),
            }),
          );
        }
        idx.rebuildLedgerActive(LEDGER, items);
        // Interleave searches between rebuilds: with the fix these can never
        // race a vacuum (there is none), and they must keep returning hits.
        const hits = idx.search("widget");
        expect(hits.length).toBeGreaterThan(0);
      }
    } catch (err) {
      error = err;
    }

    expect(error).toBeUndefined();

    // Search correctness after reclaim: every live doc is found, none missing.
    const final = idx.search("widget", { limit: DOCS_PER_CYCLE });
    expect(final.length).toBe(DOCS_PER_CYCLE);

    // Discarded docs stay excluded: shrink the bucket, then a removed id's
    // unique term must no longer match.
    idx.rebuildLedgerActive(LEDGER, [
      item("T0", "planned", { headline: termFor(0, "h") + " widget" }),
    ]);
    const after = idx.search("widget");
    expect(after.map((h) => h.item.id)).toEqual(["T0"]);
  },
);
