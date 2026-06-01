/**
 * ledger-tui CLI parsing: --mcp-url (remote) vs default embedded, --cwd, and
 * the embedded ledger-root precedence (--cwd > $LEDGER_ROOT > process CWD).
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as path from "node:path";
import { parseArgs, normalizeUrl, liveUrlFor } from "../src/main.js";

const savedEnv = process.env["LEDGER_ROOT"];
afterEach(() => {
  if (savedEnv === undefined) delete process.env["LEDGER_ROOT"];
  else process.env["LEDGER_ROOT"] = savedEnv;
});

describe("ledger-tui parseArgs", () => {
  it("defaults to embedded (mcpUrl null) rooted at the process CWD", () => {
    delete process.env["LEDGER_ROOT"];
    const { mcpUrl, cwd } = parseArgs([]);
    expect(mcpUrl).toBeNull();
    expect(cwd).toBe(process.cwd());
  });

  it("--mcp-url selects remote mode and normalizes the URL", () => {
    expect(parseArgs(["--mcp-url", "127.0.0.1:7777"]).mcpUrl).toBe("http://127.0.0.1:7777/mcp");
    expect(parseArgs(["--mcp-url=http://h:9/mcp"]).mcpUrl).toBe("http://h:9/mcp");
  });

  it("--cwd sets the embedded root (resolved absolute) and stays embedded", () => {
    const r = parseArgs(["--cwd", "some/rel"]);
    expect(r.mcpUrl).toBeNull();
    expect(r.cwd).toBe(path.resolve("some/rel"));
  });

  it("root precedence: --cwd over $LEDGER_ROOT over CWD", () => {
    process.env["LEDGER_ROOT"] = "/env/root";
    expect(parseArgs(["--cwd", "/flag/root"]).cwd).toBe("/flag/root");
    expect(parseArgs([]).cwd).toBe("/env/root");
  });

  it("the legacy --url flag is no longer recognized (treated as embedded)", () => {
    expect(parseArgs(["--url", "http://127.0.0.1:7777/mcp"]).mcpUrl).toBeNull();
  });
});

describe("normalizeUrl / liveUrlFor", () => {
  it("defaults scheme and /mcp path", () => {
    expect(normalizeUrl("127.0.0.1:7777")).toBe("http://127.0.0.1:7777/mcp");
  });
  it("derives the ws live URL from the mcp URL", () => {
    expect(liveUrlFor("http://127.0.0.1:7777/mcp")).toBe("ws://127.0.0.1:7777/ws");
    expect(liveUrlFor("https://h/mcp")).toBe("wss://h/ws");
  });
});
