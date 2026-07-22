#!/usr/bin/env -S bun run
/**
 * ledger-tui — interactive terminal UI for exploring and editing ledgers.
 *
 * Two modes:
 *   - EMBEDDED (default, no `--mcp-url`): runs the ledger MCP server in-process
 *     over an in-memory transport, backed by a file-store rooted at
 *     `--cwd` > `$LEDGER_ROOT` > the process CWD. No server to start.
 *   - REMOTE (`--mcp-url`): connects to an already-running `ledger-mcp --http`
 *     server over Streamable HTTP.
 *
 * CLI:
 *   ledger-tui                                  # embedded, root = CWD
 *   ledger-tui --cwd /path/to/repo              # embedded, explicit root
 *   ledger-tui --mcp-url http://127.0.0.1:7777/mcp
 *   ledger-tui --mcp-url 127.0.0.1:7777         # scheme + /mcp path defaulted
 *
 * The TUI is a pure MCP client: even embedded, it talks to the MCP server (now
 * co-located in-process) and never reads the ledger files directly.
 */

import * as path from "node:path";
import React from "react";
import { render } from "ink";
import type { RenderOptions } from "ink";
import { startLedgerCoherenceWatcher } from "@cq/ledger-mcp";
import { App } from "./app.js";
import { McpLedgerClient } from "./mcpClient.js";

/**
 * D13/T132: ink render options for the TUI. `incrementalRendering` (ink 7.0.5,
 * default off) line-diffs and rewrites only changed lines; the default standard
 * renderer erases+rewrites the WHOLE frame each change, so a cursor move pays a
 * full-frame redraw of the newly-selected item's detail. The rendered frame
 * STRING is identical either way (only the terminal-write encoding differs), so
 * no visual/behavioural change for a settled cursor. Exported so the T133 guard
 * can assert the flag is wired.
 *
 * Measured (distinct long descriptions, N=60, NAV=25): ~5839 → ~2737 B/move
 * (~53% reduction).
 */
export const TUI_RENDER_OPTIONS: RenderOptions = {
  incrementalRendering: true,
};

export interface TuiArgs {
  /** Remote MCP URL, or null to run the server embedded in-process. */
  mcpUrl: string | null;
  /** Resolved ledger root for embedded mode (--cwd > $LEDGER_ROOT > CWD). */
  cwd: string;
}

export function parseArgs(argv: readonly string[]): TuiArgs {
  let url: string | undefined;
  let cwd: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mcp-url") {
      i += 1;
      url = argv[i];
    } else if (a !== undefined && a.startsWith("--mcp-url=")) {
      url = a.slice("--mcp-url=".length);
    } else if (a === "--cwd") {
      i += 1;
      cwd = argv[i];
    } else if (a !== undefined && a.startsWith("--cwd=")) {
      cwd = a.slice("--cwd=".length);
    }
  }
  // Embedded ledger root, in priority order: --cwd, then $LEDGER_ROOT, else the
  // process CWD (mirrors ledger-mcp). A relative value resolves against the CWD.
  const fromArg = cwd !== undefined && cwd !== "" ? cwd : undefined;
  const fromEnv = process.env["LEDGER_ROOT"];
  const chosen = fromArg ?? (fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined);
  const resolvedCwd = chosen !== undefined ? path.resolve(chosen) : process.cwd();
  return {
    mcpUrl: url !== undefined && url !== "" ? normalizeUrl(url) : null,
    cwd: resolvedCwd,
  };
}

/** Default the scheme to http:// and the path to /mcp when omitted. */
export function normalizeUrl(raw: string): string {
  let u = raw;
  if (!/^https?:\/\//.test(u)) u = `http://${u}`;
  const parsed = new URL(u);
  if (parsed.pathname === "" || parsed.pathname === "/") parsed.pathname = "/mcp";
  return parsed.toString();
}

/** Live-change WS URL for the same server: http→ws, https→wss, /mcp→/ws. */
export function liveUrlFor(mcpUrl: string): string {
  const u = new URL(mcpUrl);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${u.host}/ws`;
}

/**
 * The ledger-tui entry point. Parses `argv` (the args after the program name),
 * connects to a remote MCP server (`--mcp-url`) or co-locates an embedded one
 * (its absence selects embedded mode), and renders the Ink app until exit.
 *
 * Exported so in-process hosts (the unified `cq tui …` dispatcher) can delegate
 * with a verbatim post-mode argv slice WITHOUT mutating `process.argv`. The
 * standalone bin self-runs via `main(process.argv.slice(2))` below.
 */
export async function main(argv: readonly string[]): Promise<void> {
  const { mcpUrl, cwd } = parseArgs(argv);
  let client: McpLedgerClient;
  let liveUrl: string | null;
  if (mcpUrl !== null) {
    try {
      client = await McpLedgerClient.connect(mcpUrl);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`ledger-tui: cannot connect to ${mcpUrl}: ${msg}\n`);
      process.exit(1);
    }
    liveUrl = liveUrlFor(mcpUrl);
  } else {
    try {
      client = await McpLedgerClient.embedded(cwd);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`ledger-tui: cannot open ledger at ${cwd}: ${msg}\n`);
      process.exit(1);
    }
    liveUrl = null;
  }
  // Embedded mode has no WebSocket: wire live refresh to the in-process
  // backend-selecting coherence watcher so external edits (the agent's stdio
  // server, git, a second UI) refresh the view. Self-edits already refetch
  // post-mutation. startLedgerCoherenceWatcher selects the file-watch under the
  // fs backend (behaviour unchanged) and the orphan-ref-sha poll under the
  // git-object backend, mirroring ledger-web/src/serve.ts (D51).
  const ctx = client.embedded;
  const onSubscribe =
    ctx !== null
      ? (onChange: () => void): (() => void) => {
          const watcher = startLedgerCoherenceWatcher(ctx.resolved, ctx.cwd, () => onChange());
          return () => watcher.close();
        }
      : null;
  const app = render(
    <App client={client} liveUrl={liveUrl} onSubscribe={onSubscribe} mcpUrl={mcpUrl} />,
    TUI_RENDER_OPTIONS,
  );
  await app.waitUntilExit();
  await client.close();
}

const meta = import.meta as unknown as { main?: boolean };
if (meta.main === true) {
  void main(process.argv.slice(2));
}
