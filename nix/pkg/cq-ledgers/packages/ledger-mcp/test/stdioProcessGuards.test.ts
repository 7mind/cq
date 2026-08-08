import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { acquireStdioSingletonLock } from "../src/stdioProcessGuards.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("stdioProcessGuards (D293/T2018)", () => {
  it("allows one holder and refuses a second live locker in-process", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-lock-"));
    dirs.push(dir);
    const first = acquireStdioSingletonLock(dir);
    expect(fs.existsSync(first.lockPath)).toBe(true);
    expect(() => acquireStdioSingletonLock(dir)).toThrow(/lock already held/);
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

  it("takeover: second acquire kills a live holder and gets the lock", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-takeover-"));
    dirs.push(dir);
    // Plain holder: only writes the lock file then spins — no TS import chain.
    const lockPath = path.join(dir, "mcp-stdio.lock");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const fs=require("fs");const p=${JSON.stringify(lockPath)};fs.writeFileSync(p,JSON.stringify({pid:process.pid}));setInterval(()=>{},500);`,
      ],
      { stdio: "ignore" },
    );
    try {
      await Bun.sleep(200);
      expect(child.pid).toBeTypeOf("number");
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(child.pid);
      const taken = acquireStdioSingletonLock(dir);
      expect(JSON.parse(fs.readFileSync(taken.lockPath, "utf8")).pid).toBe(process.pid);
      taken.release();
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }, 15_000);
});
