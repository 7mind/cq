#!/usr/bin/env bun
/**
 * concurrentWriterSmoke — T492 two-writer smoke (Q246 multi-process sharing).
 *
 * THROWAWAY. For each milestone-A prototype (sqlite, jsonl+index): seed one
 * store dir with N items, then spawn TWO Bun subprocesses that concurrently
 * mutate DISJOINT partitions (even / odd item ids) of that ONE store to "wip",
 * one single-item mutation at a time. Both processes contend on the same
 * store's cross-process write path (SQLite WAL + busy_timeout; JSONL advisory
 * lockfile). On join, assert:
 *   - zero read/write failures  — both children exited 0;
 *   - zero lost updates         — EVERY item's status is "wip" on a fresh read.
 *
 * A lost update (a writer's append/UPDATE clobbered the other's under
 * contention) surfaces as an item still "planned"; a torn write surfaces as a
 * corrupt-line throw in the reader. Prints one PASS/FAIL line per backend and
 * exits non-zero if any backend fails (fail-fast, for CI + the research doc).
 *
 * Usage: bun run bench/proto/concurrentWriterSmoke.ts  (from packages/ledger/)
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { seedSqliteItems, readSqliteStatuses } from "./sqliteProtoStore.js";
import { seedJsonlItems, readJsonlStatuses } from "./jsonlProtoStore.js";

/** Items per store — enough to force real interleaving without a long run. */
const SMOKE_SIZE = 500;

const WORKER = fileURLToPath(new URL("./concurrentWriterWorker.ts", import.meta.url));

interface BackendSpec {
  name: string;
  seed(root: string, milestoneId: string, size: number): Promise<string[]>;
  read(root: string): Promise<Map<string, string>>;
}

const BACKENDS: BackendSpec[] = [
  {
    name: "sqlite",
    seed: seedSqliteItems,
    read: async (root) => readSqliteStatuses(root),
  },
  {
    name: "jsonl+index",
    seed: seedJsonlItems,
    read: readJsonlStatuses,
  },
];

/** Spawn one worker; resolve with its exit code + captured stderr. */
function runWorker(backend: string, root: string, ids: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", WORKER, backend, root, ...ids], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

interface SmokeResult {
  name: string;
  pass: boolean;
  detail: string;
}

async function smokeBackend(spec: BackendSpec): Promise<SmokeResult> {
  const root = await fs.mkdtemp(path.join(tmpdir(), `smoke-${spec.name.replace(/\W/g, "")}-`));
  try {
    const ids = await spec.seed(root, "M1", SMOKE_SIZE);
    const even = ids.filter((_, i) => i % 2 === 0);
    const odd = ids.filter((_, i) => i % 2 === 1);

    // Two processes mutate disjoint partitions of the SAME store concurrently.
    const [a, b] = await Promise.all([
      runWorker(spec.name, root, even),
      runWorker(spec.name, root, odd),
    ]);

    if (a.code !== 0 || b.code !== 0) {
      return {
        name: spec.name,
        pass: false,
        detail: `writer exit A=${a.code} B=${b.code}; stderrA=${a.stderr.trim()} stderrB=${b.stderr.trim()}`,
      };
    }

    // Zero lost updates: every item must be "wip" on a fresh read.
    const statuses = await spec.read(root);
    const notWip = ids.filter((id) => statuses.get(id) !== "wip");
    if (notWip.length > 0) {
      return {
        name: spec.name,
        pass: false,
        detail: `${notWip.length}/${ids.length} lost updates (still !== "wip"), e.g. ${notWip.slice(0, 5).join(",")}`,
      };
    }
    return { name: spec.name, pass: true, detail: `${ids.length} items mutated by 2 processes, 0 lost, 0 read failures` };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const results: SmokeResult[] = [];
  for (const spec of BACKENDS) {
    console.log(`two-writer smoke: ${spec.name} @ ${SMOKE_SIZE} items, 2 processes...`);
    const result = await smokeBackend(spec);
    results.push(result);
    console.log(`  -> ${result.pass ? "PASS" : "FAIL"}: ${result.detail}`);
  }
  console.log("");
  for (const r of results) console.log(`${r.name.padEnd(12)} ${r.pass ? "PASS" : "FAIL"}  ${r.detail}`);
  if (results.some((r) => !r.pass)) process.exit(1);
}

await main();
