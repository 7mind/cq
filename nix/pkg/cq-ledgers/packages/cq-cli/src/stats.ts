/**
 * `cq stats` (I20/G155, T1512) — the read-only, UNCONDITIONAL MCP
 * usage-counters emitter, mirroring `cq counts` exactly.
 *
 * Like `cq counts`, this subcommand has NO session resolution and NO marker
 * check: it ALWAYS reads the primary store via `store.fetchMcpUsageStats()`
 * (the same read the `get_usage_stats` MCP tool performs) and ALWAYS prints
 * the resulting `{ endpoints, totals }` object, ALWAYS exiting 0.
 *
 * Two telemetry caveats, by design:
 * (1) counters accumulate only from MCP tool invocations against this project
 *     store — direct CLI reads (counts, predicates, stats itself) do not
 *     increment them;
 * (2) stats are primary-store-local telemetry and are OUTSIDE cq
 *     backup/restore (they do not round-trip through BackupDumpFile).
 *
 * The store is built IN-PROCESS via `createLedgerStore(cwd)` (exactly like
 * `runCounts`) and disposed in a `finally`.
 */

import { createLedgerStore, resolveLedgerBackend, type UsageStatsSnapshot } from "@cq/ledger";
import { withRemoteClient } from "./remoteClient.js";

/** Exit code for `cq stats` — ALWAYS success (it never blocks). */
export const EXIT_STATS = 0;

/** Inputs the emitter needs: just the resolved ledger root. */
export interface StatsArgs {
  /** Resolved ledger root (--cwd > $LEDGER_ROOT > CWD, absolute). */
  readonly cwd: string;
}

/** IO seam so tests can capture stdout (mirrors CountsIo). */
export interface StatsIo {
  out(line: string): void;
  err(line: string): void;
}

/** The dispatcher's outcome — the exit code main() propagates. */
export interface StatsOutcome {
  exitCode: number;
}

/**
 * `cq stats`: build the ledger-backed store in-process, read the MCP usage
 * counters, dispose the store (try/finally), and print `{ endpoints, totals }`
 * to stdout UNCONDITIONALLY. ALWAYS exits 0 — no session, no marker, no block.
 */
export async function runStats(
  args: StatsArgs,
  io: StatsIo,
): Promise<StatsOutcome> {
  let snapshot: UsageStatsSnapshot;
  if (resolveLedgerBackend(args.cwd).backend === "remote") {
    snapshot = await withRemoteClient(args.cwd, (client) => client.getUsageStats());
  } else {
    const { store } = await createLedgerStore(args.cwd);
    try {
      snapshot = await store.fetchMcpUsageStats();
    } finally {
      await store.dispose();
    }
  }
  io.out(JSON.stringify(snapshot));
  return { exitCode: EXIT_STATS };
}
