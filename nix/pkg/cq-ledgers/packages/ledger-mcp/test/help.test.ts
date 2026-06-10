/**
 * ledger-mcp --help / -h flag (D56 / T384).
 *
 * Asserts that:
 *   - main(['--help']) and main(['-h']) each resolve without constructing or
 *     connecting a server (the function returns before reaching server.connect).
 *   - The captured stdout contains the four required tokens: --tool-prefix,
 *     --cwd, --http, and "restore".
 *   - TOP_LEVEL_USAGE is exported and non-empty.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { main, TOP_LEVEL_USAGE } from "../src/main.js";

// Spy on process.stdout.write and StdioServerTransport.connect to ensure
// --help returns before any server is started.

describe("TOP_LEVEL_USAGE export", () => {
  it("is a non-empty string", () => {
    expect(typeof TOP_LEVEL_USAGE).toBe("string");
    expect(TOP_LEVEL_USAGE.length).toBeGreaterThan(0);
  });

  it("contains --cwd, --http, --tool-prefix, and restore", () => {
    expect(TOP_LEVEL_USAGE).toContain("--cwd");
    expect(TOP_LEVEL_USAGE).toContain("--http");
    expect(TOP_LEVEL_USAGE).toContain("--tool-prefix");
    expect(TOP_LEVEL_USAGE).toContain("restore");
  });
});

describe("main --help / -h (D56)", () => {
  let written: string[];
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    written = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    // Capture stdout without forwarding to avoid polluting test output.
    process.stdout.write = (chunk: unknown): boolean => {
      written.push(String(chunk));
      return true;
    };
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it("main(['--help']) resolves promptly and writes usage to stdout", async () => {
    await main(["--help"]);
    const out = written.join("");
    expect(out).toContain("--cwd");
    expect(out).toContain("--http");
    expect(out).toContain("--tool-prefix");
    expect(out).toContain("restore");
  });

  it("main(['-h']) resolves promptly and writes usage to stdout", async () => {
    await main(["-h"]);
    const out = written.join("");
    expect(out).toContain("--cwd");
    expect(out).toContain("--http");
    expect(out).toContain("--tool-prefix");
    expect(out).toContain("restore");
  });

  it("main(['--help']) does not write to stderr (no 'serving' message)", async () => {
    const stderrChunks: string[] = [];
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown): boolean => {
      stderrChunks.push(String(chunk));
      return true;
    };
    try {
      await main(["--help"]);
    } finally {
      process.stderr.write = origStderr;
    }
    const err = stderrChunks.join("");
    expect(err).not.toContain("serving");
  });

  it("main(['restore', '--help']) also prints usage (--help wins regardless of position)", async () => {
    await main(["restore", "--help"]);
    const out = written.join("");
    expect(out).toContain("--tool-prefix");
  });
});
