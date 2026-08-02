import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSupportedPlatform,
  parseLinuxProcessStartTime,
  readProcessIdentity,
  settleProcessGroups,
  type ProcessGroupOperations,
  type ProcessGroupRegistration,
} from "../src/index.js";

const REGISTRATION: ProcessGroupRegistration = {
  pgid: 41001,
  leader: { pid: 41001, startTime: "100" },
};

class ForkAfterTermOperations implements ProcessGroupOperations {
  readonly signals: NodeJS.Signals[] = [];
  private alive = true;

  async isAlive(): Promise<boolean> {
    return this.alive;
  }

  signal(_registration: ProcessGroupRegistration, signal: NodeJS.Signals): void {
    this.signals.push(signal);
    if (signal === "SIGKILL") this.alive = false;
  }

  async delay(): Promise<void> {}
}

describe("process-group settlement [BA]", () => {
  test("accepts Linux and Darwin and rejects unsupported platforms", () => {
    expect(assertSupportedPlatform("linux")).toBe("linux");
    expect(assertSupportedPlatform("darwin")).toBe("darwin");
    expect(() => assertSupportedPlatform("win32")).toThrow("unsupported platform");
  });

  test("parses Linux /proc start time after a parenthesized command", () => {
    const stat = "123 (worker (gate)) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 424242 20";
    expect(parseLinuxProcessStartTime(stat)).toBe("424242");
  });

  test("does not signal when the owned PGID set is empty", async () => {
    const operations = new ForkAfterTermOperations();
    const result = await settleProcessGroups([], { operations, termGraceMs: 0, killGraceMs: 0 });
    expect(result.signaled).toEqual([]);
    expect(operations.signals).toEqual([]);
  });

  test("rejects non-finite settlement windows", async () => {
    await expect(settleProcessGroups([], { termGraceMs: Number.POSITIVE_INFINITY })).rejects.toThrow(
      "finite",
    );
    await expect(settleProcessGroups([], { killGraceMs: Number.NaN })).rejects.toThrow("finite");
    await expect(settleProcessGroups([], { pollIntervalMs: Number.NaN })).rejects.toThrow("finite");
  });

  test("freezes and kills a same-group fork that remains after SIGTERM", async () => {
    const operations = new ForkAfterTermOperations();
    const result = await settleProcessGroups([REGISTRATION], {
      operations,
      termGraceMs: 0,
      killGraceMs: 0,
    });
    expect(operations.signals).toEqual(["SIGTERM", "SIGSTOP", "SIGKILL"]);
    expect(result.survivors).toEqual([]);
  });

  test("settles a production group whose leader forks after SIGTERM", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-process-group-"));
    const marker = join(root, "forked");
    const fixture = fileURLToPath(new URL("./processGroupFixture.ts", import.meta.url));
    const child = spawn(process.execPath, ["run", fixture, marker], {
      detached: true,
      stdio: "ignore",
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error("test process did not return a pid");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      const leader = await readProcessIdentity(pid);
      if (leader === null) throw new Error("test process exited before identity observation");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          await access(`${marker}.ready`);
          break;
        } catch {
          if (attempt === 99) throw new Error("test process did not become ready");
          await Bun.sleep(2);
        }
      }
      const result = await settleProcessGroups([{ pgid: pid, leader }], {
        termGraceMs: 100,
        killGraceMs: 1_000,
      });
      await exited;
      expect(await readFile(marker, "utf8")).toBe("forked-after-term");
      expect(result.survivors).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
