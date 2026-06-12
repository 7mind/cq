/**
 * D67 regression — minisearch background-vacuum vs. concurrent add() race.
 *
 * `LedgerSearchIndex` (../src/search/LedgerSearchIndex.ts) wraps the
 * `minisearch` library with its DEFAULT auto-vacuum behavior. minisearch
 * reclaims space from discarded documents by ASYNCHRONOUSLY vacuuming the
 * inverted index in batches of `batchSize` (1000) terms, yielding control via
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
 * This crashes `cq web`. This test reproduces the crash DETERMINISTICALLY via a
 * temporary `globalThis.setTimeout` seam that, on the vacuum's first batch-yield,
 * performs one `add()` whose term splits a not-yet-visited compressed edge that
 * the in-flight iterator has already snapshotted, then lets the timer proceed.
 * The vacuum's returned promise is awaited so the rejection is observed
 * deterministically (no reliance on `unhandledRejection`).
 *
 * The body asserts the DESIRED post-fix behavior — that the vacuum completes
 * with NO error. Today that assertion FAILS (the minisearch `child.keys`
 * TypeError is thrown), so wrapping in bun's `test.failing()` records it as an
 * EXPECTED failure and keeps the suite green. Removing `.failing` (plain
 * `test()`) surfaces the raw minisearch TypeError. Task T436 will fix
 * LedgerSearchIndex and flip this to a regular `test()`, at which point the
 * no-error assertion passes.
 */

import { test, expect, afterEach } from "bun:test";
// Import minisearch exactly as LedgerSearchIndex.ts does.
import MiniSearch from "minisearch";

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

/** Construct MiniSearch with OUR options (copied from LedgerSearchIndex.ts). */
function makeIndex(): MiniSearch<IndexDoc> {
  return new MiniSearch<IndexDoc>({
    idField: "docId",
    fields: ["headline", "body", "status"],
    storeFields: ["ledgerId", "itemId", "status", "archived"],
    // NOTE: do NOT pass autoVacuum — minisearch's DEFAULT vacuum behavior
    // (batchSize 1000, batchWait 10, minDirtCount 20, minDirtFactor 0.1) is
    // required to repro the defect.
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
 * not-yet-visited compressed edge. This is white-box on purpose: a guaranteed
 * split is far more reliable than a magic-string guess that could silently stop
 * reproducing.
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

test.failing(
  "D67: concurrent add() during minisearch background vacuum throws TypeError (T436 will fix)",
  async () => {
    const mini = makeIndex();

    // 1. Populate with enough documents that the index holds > ~1000 distinct
    //    terms. Each doc adds 3 unique terms (headline/body/status), so 600 docs
    //    yields ~1800 distinct terms — past one 1000-term vacuum batch, so the
    //    loop yields (setTimeout) mid-traversal.
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

    // 2. Remove > 10% of the documents (and at least 20) so the auto-vacuum
    //    conditions are met (minDirtCount 20, minDirtFactor 0.1). discardAll
    //    suppresses auto-vacuum internally; we trigger the vacuum explicitly
    //    below so the seam is installed BEFORE the batch traversal yields.
    const REMOVE_COUNT = 120; // 20% of 600
    const toRemove: string[] = [];
    for (let i = 0; i < REMOVE_COUNT; i++) toRemove.push(`led:${i}`);
    mini.discardAll(toRemove);

    // Capture the single suspended TreeIterator the vacuum for-of will use, so
    // the seam can read its descent stack.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const index = (mini as any)._index as SearchableMapInternals;
    const realIterator = index[Symbol.iterator].bind(index);
    let captured: (Iterator<[string, unknown]> & TreeIteratorInternals) | undefined;
    index[Symbol.iterator] = function (): Iterator<[string, unknown]> {
      captured = realIterator() as Iterator<[string, unknown]> & TreeIteratorInternals;
      return captured;
    };

    // 3 + 4. The deterministic setTimeout seam: on the vacuum's FIRST batch-yield
    //         (its only setTimeout call here), add ONE document whose term splits
    //         a not-yet-visited compressed edge in the iterator's snapshot, then
    //         forward to the real timer so the vacuum resumes onto the now-stale
    //         iterator node.
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
        if (deepest === undefined) {
          throw new Error("test setup invariant violated: empty vacuum iterator path");
        }
        // Reconstruct the prefix down to (but excluding) the deepest frame from
        // the keys currently being descended.
        let prefix = "";
        for (let f = 0; f < path.length - 1; f++) {
          const frame = path[f];
          if (frame === undefined) continue;
          const k = last(frame.keys);
          if (k !== undefined && k !== "") prefix += k;
        }
        // A multi-char compressed edge in the deepest frame that the iterator has
        // snapshotted but not yet visited (it is popped from the end later).
        const multiCharEdge = deepest.keys.find((k) => k.length > 1);
        if (multiCharEdge === undefined) {
          throw new Error(
            "test setup invariant violated: no multi-char compressed edge in the " +
              "vacuum iterator's deepest frame to split",
          );
        }
        const fullTerm = prefix + multiCharEdge;
        // Share all but the last char => createPath partial-matches the existing
        // edge, inserts an intermediate node, and DELETES the old (snapshotted)
        // edge key, corrupting the suspended iterator.
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
      // Forward to the real timer so the vacuum's await resolves and resumes.
      return originalSetTimeout(handler as (...a: unknown[]) => void, timeout, ...args);
    }) as unknown as typeof globalThis.setTimeout;

    let observedError: unknown = undefined;
    try {
      globalThis.setTimeout = seam;
      // vacuum() returns the ongoing/enqueued vacuum promise; awaiting it
      // surfaces any rejection deterministically. TODAY this rejects with the
      // minisearch `child.keys` TypeError (the D67 defect).
      await mini.vacuum();
    } catch (err) {
      observedError = err;
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      index[Symbol.iterator] = realIterator;
    }

    // 5. Assert the DESIRED post-fix behavior: the seam fired, and the vacuum
    //    completed with NO error. Under the defect this FAILS because the
    //    suspended TreeIterator dove onto a deleted edge — minisearch threw
    //    `TypeError: undefined is not an object (evaluating 'child.keys')`
    //    (stack: dive → next → performVacuuming). `test.failing()` therefore
    //    records this as an EXPECTED failure today; T436 fixes LedgerSearchIndex
    //    and flips this to a plain `test()` that passes.
    expect(injected).toBe(true);
    // Diagnostic on the path we currently take: confirm it is exactly the D67
    // crash and not some unrelated setup error.
    if (observedError !== undefined) {
      expect(observedError).toBeInstanceOf(TypeError);
      expect(String((observedError as Error).message)).toContain("child.keys");
    }
    expect(observedError).toBeUndefined();
  },
);
