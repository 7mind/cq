/**
 * ledger-web CLI parsing: embedded by default (no --mcp-url), reverse-proxy
 * when --mcp-url is given, --cwd + embedded root precedence, host/port.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "../src/serve.js";

const savedEnv = process.env["LEDGER_ROOT"];
afterEach(() => {
  if (savedEnv === undefined) delete process.env["LEDGER_ROOT"];
  else process.env["LEDGER_ROOT"] = savedEnv;
});

describe("ledger-web parseArgs", () => {
  it("defaults to embedded (mcpUrl null) rooted at the process CWD", () => {
    delete process.env["LEDGER_ROOT"];
    const r = parseArgs([]);
    expect(r.mcpUrl).toBeNull();
    expect(r.cwd).toBe(process.cwd());
    expect(r.host).toBe("127.0.0.1");
    expect(r.port).toBe(5180);
  });

  it("--mcp-url selects reverse-proxy mode", () => {
    expect(parseArgs(["--mcp-url", "http://127.0.0.1:7777/mcp"]).mcpUrl).toBe(
      "http://127.0.0.1:7777/mcp",
    );
  });

  it("--cwd sets the embedded root (resolved absolute)", () => {
    const r = parseArgs(["--cwd", "rel/root"]);
    expect(r.mcpUrl).toBeNull();
    expect(r.cwd).toBe(path.resolve("rel/root"));
  });

  it("root precedence: --cwd over $LEDGER_ROOT over CWD", () => {
    process.env["LEDGER_ROOT"] = "/env/root";
    expect(parseArgs(["--cwd", "/flag/root"]).cwd).toBe("/flag/root");
    expect(parseArgs([]).cwd).toBe("/env/root");
  });

  it("honors --host and --port", () => {
    const r = parseArgs(["--host", "0.0.0.0", "--port", "8080"]);
    expect(r.host).toBe("0.0.0.0");
    expect(r.port).toBe(8080);
  });

  it("rejects an out-of-range port", () => {
    expect(() => parseArgs(["--port", "70000"])).toThrow(/--port must be 1\.\.65535/);
  });
});
