#!/usr/bin/env bun
/**
 * concurrentWriterWorker — one writer process for the T492 two-writer smoke.
 *
 * THROWAWAY. Spawned by concurrentWriterSmoke.ts. Opens the SAME store dir as
 * its sibling and mutates a DISJOINT set of item ids (its `ids` argv) to "wip",
 * one single-item mutation at a time, so the two processes contend on the same
 * store's write path (SQLite file lock / JSONL advisory lockfile) while each
 * owning a distinct partition of the population — a lost update or a torn write
 * shows up as a missing/failed row when the coordinator re-reads.
 *
 * argv: <backend: sqlite|jsonl+index> <root> <id> <id> ...
 * Exits 0 on success; non-zero (with the error on stderr) on any mutation
 * failure — the coordinator treats a non-zero child as a smoke failure.
 */

import { SqliteProtoStore } from "./sqliteProtoStore.js";
import { JsonlProtoStore } from "./jsonlProtoStore.js";
import type { ProtoStore } from "./protoStore.js";

const [, , backend, root, ...ids] = process.argv;
if (backend === undefined || root === undefined || ids.length === 0) {
  throw new Error("concurrentWriterWorker: usage <backend> <root> <id>...");
}

function openStore(name: string, r: string): ProtoStore {
  if (name === "sqlite") return new SqliteProtoStore({ root: r });
  if (name === "jsonl+index") return new JsonlProtoStore({ root: r });
  throw new Error(`concurrentWriterWorker: unknown backend ${name}`);
}

const store = openStore(backend, root);
await store.init();
for (const id of ids) {
  await store.updateItem(id, "wip");
}
await store.dispose();
