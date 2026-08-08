import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireStdioSingletonLock } from "../src/stdioProcessGuards.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("stdioProcessGuards (D293/T2018)", () => {
  it("allows one holder and refuses a second live locker", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-lock-"));
    dirs.push(dir);
    const first = acquireStdioSingletonLock(dir);
    expect(fs.existsSync(first.lockPath)).toBe(true);
    expect(() => acquireStdioSingletonLock(dir)).toThrow(
      /already holds|lock already held/,
    );
    first.release();
    const second = acquireStdioSingletonLock(dir);
    second.release();
  });

  it("replaces a stale lock from a dead pid", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-stale-"));
    dirs.push(dir);
    const lockPath = path.join(dir, "mcp-stdio.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2_000_000_000, startedAt: "x" }));
    const held = acquireStdioSingletonLock(dir);
    expect(fs.existsSync(held.lockPath)).toBe(true);
    held.release();
  });
});
