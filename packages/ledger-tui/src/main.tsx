#!/usr/bin/env -S bun run
/**
 * ledger-tui — interactive terminal UI for exploring and editing ledgers
 * served by a running `ledger-mcp --http` server.
 *
 * CLI:
 *   ledger-tui --url http://127.0.0.1:7777/mcp
 *   ledger-tui --url 127.0.0.1:7777      # scheme + /mcp path defaulted
 *
 * The TUI is a pure MCP client: it never touches the ledger files directly,
 * so it works against any host running the ledger MCP Streamable HTTP
 * transport.
 */

import React from "react";
import { render } from "ink";
import { App } from "./app.js";
import { McpLedgerClient } from "./mcpClient.js";

const DEFAULT_URL = "http://127.0.0.1:7777/mcp";

export function parseArgs(argv: readonly string[]): { url: string } {
  let url: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") {
      i += 1;
      url = argv[i];
    } else if (a !== undefined && a.startsWith("--url=")) {
      url = a.slice("--url=".length);
    }
  }
  return { url: normalizeUrl(url ?? DEFAULT_URL) };
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

async function run(): Promise<void> {
  const { url } = parseArgs(process.argv.slice(2));
  let client: McpLedgerClient;
  try {
    client = await McpLedgerClient.connect(url);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ledger-tui: cannot connect to ${url}: ${msg}\n`);
    process.exit(1);
  }
  const app = render(<App client={client} liveUrl={liveUrlFor(url)} />);
  await app.waitUntilExit();
  await client.close();
}

const meta = import.meta as unknown as { main?: boolean };
if (meta.main === true) {
  void run();
}
