/**
 * I20/G155, T1512 — the `cq stats` UNCONDITIONAL MCP usage-counters emitter
 * contract, mirroring counts.test.ts (T533 / G76).
 *
 * `cq stats` mirrors `cq counts` exactly: NO session resolution and NO marker
 * check — it ALWAYS reads the primary store via `store.fetchMcpUsageStats()`
 * (the same read the `get_usage_stats` MCP tool performs) and ALWAYS prints
 * `{ endpoints, totals }`, exiting 0. CLI direct reads do not increment the
 * counters; only MCP tool invocations do.
 */

import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runStats, type StatsIo } from "../src/stats.js";
import { createLedgerStore, type UsageStatsSnapshot } from "@cq/ledger";
import { USAGE } from "../src/main.js";

const dirs: string[] = [];
let prevXdgStateHome: string | undefined;
beforeAll(async () => {
  // The runtime store is the out-of-tree xdg primary (T505): point
  // XDG_STATE_HOME at a temp dir so seeded state never touches the host.
  prevXdgStateHome = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = await makeTmpDir("cq-stats-xdg-");
});
afterAll(async () => {
  if (prevXdgStateHome === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = prevXdgStateHome;
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * Seed a fresh xdg-backed ledger root and record known usage counters via the
 * store API, so the emitted snapshot is non-trivial. The cq.toml pins
 * backend='xdg' with an explicit projectId (the temp root has no git
 * identity) so the seed and runStats resolve the same store.
 */
async function seedLedgerWithUsage(): Promise<string> {
  const root = await makeTmpDir("cq-stats-ledger-");
  await writeFile(
    path.join(root, "cq.toml"),
    `[ledger]\nbackend = "xdg"\nprojectId = "${path.basename(root)}"\n`,
    "utf8",
  );
  const { store } = await createLedgerStore(root);
  await store.recordMcpUsage("fetch_item", 40, 120);
  await store.recordMcpUsage("fetch_item", 41, 121);
  await store.recordMcpUsage("create_item", 200, 60);
  await store.dispose();
  return root;
}

/** A capturing StatsIo recording every stdout line. */
function recordingIo(): StatsIo & { outs: string[] } {
  const outs: string[] = [];
  return { outs, out: (l) => outs.push(l), err: () => {} };
}

describe("cq stats — unconditional MCP usage-counters emitter (T1512)", () => {
  it("emits the recorded snapshot as single-line JSON and exits 0", async () => {
    const root = await seedLedgerWithUsage();
    const io = recordingIo();
    const outcome = await runStats({ cwd: root }, io);
    expect(outcome.exitCode).toBe(0);
    expect(io.outs).toHaveLength(1);
    const parsed = JSON.parse(io.outs[0]!) as UsageStatsSnapshot;
    const fetchItem = parsed.endpoints.find((e) => e.name === "fetch_item");
    const createItem = parsed.endpoints.find((e) => e.name === "create_item");
    expect(fetchItem).toEqual({ name: "fetch_item", callCount: 2, bytesIn: 81, bytesOut: 241 });
    expect(createItem).toEqual({ name: "create_item", callCount: 1, bytesIn: 200, bytesOut: 60 });
    expect(parsed.totals).toEqual({ name: "totals", callCount: 3, bytesIn: 281, bytesOut: 301 });
  });

  it("an empty store yields empty endpoints and zero totals, still exit 0", async () => {
    const root = await makeTmpDir("cq-stats-empty-");
    await writeFile(
      path.join(root, "cq.toml"),
      `[ledger]\nbackend = "xdg"\nprojectId = "${path.basename(root)}"\n`,
      "utf8",
    );
    const io = recordingIo();
    const outcome = await runStats({ cwd: root }, io);
    expect(outcome.exitCode).toBe(0);
    const parsed = JSON.parse(io.outs[0]!) as UsageStatsSnapshot;
    expect(parsed.endpoints).toEqual([]);
    expect(parsed.totals).toEqual({ name: "totals", callCount: 0, bytesIn: 0, bytesOut: 0 });
  });

  it("USAGE documents the stats subcommand", () => {
    expect(USAGE).toContain("  stats       [--cwd <path>]");
  });
});
