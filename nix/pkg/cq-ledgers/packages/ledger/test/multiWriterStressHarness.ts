/**
 * multiWriterStressHarness — T497 store-factory-parameterized multi-process
 * stress harness for the multi-writer concurrency contract documented on
 * `LedgerPersistence` (src/store/LedgerPersistence.ts, "Multi-writer
 * concurrency contract").
 *
 * What it does: given an injected {@link MultiWriterStoreFactory} bound to a
 * store implementation, it
 *  1. creates ONE shared store location (a fresh temp dir), seeds it with a
 *     `stress` ledger + one open milestone,
 *  2. spawns >= 2 REAL Bun writer subprocesses (`Bun.spawn` of
 *     `multiWriterStressWriter.ts`), each opening its OWN store over the SAME
 *     location and performing N interleaved createItem/updateItem cycles
 *     (create an item, then update its status + a field), with periodic
 *     invalidate+fetch reads so a torn write surfaces as a subprocess parse
 *     failure,
 *  3. joins the writers and asserts, against a FRESH verification store:
 *      - zero parse/read failures — every writer exited 0 (a mutation or
 *        reload failure in a writer throws and exits non-zero);
 *      - zero lost updates — the final item count equals the sum of all
 *        writes (`writers * opsPerWriter`, all ids distinct), every created
 *        item is present exactly once, and every item carries its writer's
 *        SECOND write (status `wip` + the updated `note` field), so neither a
 *        clobbered create nor a clobbered update can pass.
 *
 * NO conforming store exists in M210 — decision K102 pins the mechanism
 * (bun:sqlite, WAL + busy_timeout) and the first conforming implementation
 * lands in T498, which wires its factory into this harness and owns the
 * PASSING run. `FsLedgerStore` gives no cross-process no-lost-update
 * guarantee, so it is deliberately not wired here. Until T498 the harness is
 * registered as an explicit `test.todo` in multi-writer-stress.test.ts.
 *
 * This module must stay importable OUTSIDE `bun test` (the writer fixture
 * imports the shared constants below from a plain `bun run` subprocess), so
 * it uses plain fail-fast throws instead of `bun:test`'s `expect`.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Item, LedgerSchema, LedgerStore } from "../src/index.js";

/** Ledger the stress writers create/update items in. */
export const STRESS_LEDGER = "stress";

/** Schema of the stress ledger (minimal: a required headline + a note). */
export const STRESS_SCHEMA: LedgerSchema = {
  statusValues: ["planned", "wip", "done"],
  terminalStatuses: ["done"],
  fields: {
    headline: { type: "string", required: true },
    note: { type: "string", required: false },
  },
  idPrefix: "SW",
};

/**
 * Deterministic per-write token: writer `w`'s op `i` creates an item with
 * `headline === stressToken(w, i)` and then updates it to status `wip` with
 * `note === stressToken(w, i) + NOTE_SUFFIX`. The verifier reconstructs the
 * full expected token set from (writers, opsPerWriter).
 */
export function stressToken(writer: number, op: number): string {
  return `w${writer}-i${op}`;
}

/** Suffix the update write appends to the token in the `note` field. */
export const NOTE_SUFFIX = "-updated";

/**
 * Contract of the module named by
 * {@link MultiWriterStoreFactory.writerStoreModule}: the writer SUBPROCESS
 * dynamically imports it and calls `createStore(location)` to open its own
 * store instance over the shared location. The returned store must already be
 * `init()`ed (mirroring `createLedgerStore`).
 */
export interface WriterStoreModule {
  createStore(location: string): Promise<LedgerStore>;
}

/**
 * The injected store factory the harness is parameterized by (T497). T498
 * wires the conforming K102 bun:sqlite store through this and flips the
 * pending registration live.
 *
 * Two slots because the writer processes cannot receive a closure: the
 * coordinator uses {@link createStore} in-process (seed + final verification
 * read), while each writer subprocess imports {@link writerStoreModule} and
 * calls ITS `createStore` — both must open the same store implementation over
 * the given shared location.
 */
export interface MultiWriterStoreFactory {
  /**
   * Absolute path of a module satisfying {@link WriterStoreModule}, imported
   * by each writer subprocess.
   */
  readonly writerStoreModule: string;
  /** Open an `init()`ed store over `location`, in the coordinator process. */
  createStore(location: string): Promise<LedgerStore>;
}

export interface MultiWriterStressOpts {
  /** Number of concurrent writer subprocesses. Default 2; must be >= 2. */
  writers?: number;
  /** createItem+updateItem cycles per writer. Default 20; must be >= 1. */
  opsPerWriter?: number;
  /**
   * Every `readEvery`-th cycle each writer also does invalidate+fetch, so a
   * torn on-store state surfaces as a reader parse failure. Default 5.
   */
  readEvery?: number;
}

const WRITER_SCRIPT = fileURLToPath(new URL("./multiWriterStressWriter.ts", import.meta.url));

function check(cond: boolean, message: () => string): void {
  if (!cond) throw new Error(`multi-writer stress: ${message()}`);
}

/**
 * Run the T497 multi-writer stress against `factory`'s store. Throws (fails
 * the calling test) on any contract violation; resolves on a clean pass.
 */
export async function runMultiWriterStress(
  factory: MultiWriterStoreFactory,
  opts: MultiWriterStressOpts = {},
): Promise<void> {
  const writers = opts.writers ?? 2;
  const opsPerWriter = opts.opsPerWriter ?? 20;
  const readEvery = opts.readEvery ?? 5;
  check(writers >= 2, () => `need >= 2 writer processes, got ${writers}`);
  check(opsPerWriter >= 1, () => `need >= 1 op per writer, got ${opsPerWriter}`);
  check(readEvery >= 1, () => `readEvery must be >= 1, got ${readEvery}`);

  const location = await fs.mkdtemp(path.join(tmpdir(), "multi-writer-stress-"));
  try {
    // --- Seed: one shared location with the stress ledger + an open milestone.
    const seed = await factory.createStore(location);
    let milestoneId: string;
    try {
      await seed.createLedger(STRESS_LEDGER, STRESS_SCHEMA);
      milestoneId = (await seed.createMilestone({ title: "T497 multi-writer stress" })).id;
    } finally {
      await seed.dispose();
    }

    // --- Spawn the concurrent writer subprocesses (real processes: the whole
    // point is contention ACROSS process boundaries, where the in-process
    // AsyncMutex cannot help).
    const procs = Array.from({ length: writers }, (_, w) =>
      Bun.spawn({
        cmd: [
          process.execPath,
          "run",
          WRITER_SCRIPT,
          factory.writerStoreModule,
          location,
          milestoneId,
          String(w),
          String(opsPerWriter),
          String(readEvery),
        ],
        stdout: "ignore",
        stderr: "pipe",
      }),
    );
    const outcomes = await Promise.all(
      procs.map(async (proc) => ({
        code: await proc.exited,
        stderr: await new Response(proc.stderr).text(),
      })),
    );

    // --- Zero parse/read (and write) failures: every writer exited 0.
    outcomes.forEach((outcome, w) => {
      check(
        outcome.code === 0,
        () => `writer ${w} failed (exit ${outcome.code}): ${outcome.stderr.trim()}`,
      );
    });

    // --- Zero lost updates: verify against a FRESH store over the location.
    const verifier = await factory.createStore(location);
    try {
      const fetched = verifier.fetch(STRESS_LEDGER);
      const items: Item[] = fetched.milestones.flatMap((group) => group.items);

      const expectedTotal = writers * opsPerWriter;
      check(
        items.length === expectedTotal,
        () => `expected ${expectedTotal} items (${writers} writers x ${opsPerWriter} ops), found ${items.length} — lost create(s)`,
      );
      check(
        new Set(items.map((it) => it.id)).size === expectedTotal,
        () => `duplicate item ids among ${expectedTotal} items — clobbered id allocation`,
      );

      const byHeadline = new Map(items.map((it) => [it.fields["headline"] as string, it]));
      check(
        byHeadline.size === expectedTotal,
        () => `duplicate headlines among ${expectedTotal} items — clobbered create`,
      );
      for (let w = 0; w < writers; w++) {
        for (let i = 0; i < opsPerWriter; i++) {
          const token = stressToken(w, i);
          const item = byHeadline.get(token);
          check(item !== undefined, () => `item for write ${token} missing — lost create`);
          check(
            item!.status === "wip",
            () => `item ${item!.id} (${token}) still "${item!.status}" — lost update`,
          );
          check(
            item!.fields["note"] === `${token}${NOTE_SUFFIX}`,
            () => `item ${item!.id} (${token}) has note "${String(item!.fields["note"])}" — lost update`,
          );
        }
      }
    } finally {
      await verifier.dispose();
    }
  } finally {
    await fs.rm(location, { recursive: true, force: true });
  }
}
