#!/usr/bin/env bun
/**
 * multiWriterStressWriter — one writer process of the T497 multi-writer
 * stress harness (see multiWriterStressHarness.ts). Spawned by
 * `runMultiWriterStress` via `Bun.spawn`; NOT a test file, so `bun test` does
 * not collect it.
 *
 * Opens its OWN store (via the injected store module) over the SAME shared
 * location as its sibling writers and performs `ops` interleaved
 * createItem/updateItem cycles: create an item (`headline = w<idx>-i<i>`,
 * status `planned`), then update it to status `wip` with the token-derived
 * `note`. Every `readEvery`-th cycle it also invalidates + fetches the
 * ledger, forcing a re-read of the shared source so a torn write by a sibling
 * surfaces here as a parse failure.
 *
 * argv: <storeModule> <location> <milestoneId> <writerIndex> <ops> <readEvery>
 *
 * Exits 0 on success. ANY create/update/reload failure throws, printing to
 * stderr and exiting non-zero — the coordinator counts a non-zero writer as a
 * parse/read/write failure.
 */

import {
  STRESS_LEDGER,
  NOTE_SUFFIX,
  stressToken,
  type WriterStoreModule,
} from "./multiWriterStressHarness.js";

const [, , storeModule, location, milestoneId, writerIndexArg, opsArg, readEveryArg] = process.argv;
if (
  storeModule === undefined ||
  location === undefined ||
  milestoneId === undefined ||
  writerIndexArg === undefined ||
  opsArg === undefined ||
  readEveryArg === undefined
) {
  throw new Error(
    "multiWriterStressWriter: usage <storeModule> <location> <milestoneId> <writerIndex> <ops> <readEvery>",
  );
}
const writerIndex = Number(writerIndexArg);
const ops = Number(opsArg);
const readEvery = Number(readEveryArg);
if (!Number.isInteger(writerIndex) || !Number.isInteger(ops) || !Number.isInteger(readEvery)) {
  throw new Error("multiWriterStressWriter: writerIndex/ops/readEvery must be integers");
}

const imported: unknown = await import(storeModule);
const createStore = (imported as Partial<WriterStoreModule>).createStore;
if (typeof createStore !== "function") {
  throw new Error(`multiWriterStressWriter: ${storeModule} exports no createStore(location)`);
}

const store = await createStore(location);
try {
  for (let i = 0; i < ops; i++) {
    const token = stressToken(writerIndex, i);
    const item = await store.createItem(STRESS_LEDGER, milestoneId, {
      status: "planned",
      fields: { headline: token },
    });
    await store.updateItem(STRESS_LEDGER, item.id, {
      status: "wip",
      fields: { note: `${token}${NOTE_SUFFIX}` },
    });
    if (i % readEvery === 0) {
      // Force a re-read of the shared source: a torn sibling write must NOT
      // be observable — it surfaces here as a parse failure (non-zero exit).
      await store.invalidate(STRESS_LEDGER);
      store.fetch(STRESS_LEDGER);
    }
  }
} finally {
  await store.dispose();
}
