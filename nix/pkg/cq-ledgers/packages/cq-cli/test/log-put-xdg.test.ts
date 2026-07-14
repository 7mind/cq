/**
 * T499: `cq log put` — xdg backend write path + read_log round-trip.
 *
 * Q247 answer: logs move into the out-of-tree store for the xdg backend.
 * Covers the task acceptance directly:
 *  - `cq log put` a JSONL transcript containing a fake secret lands, redacted,
 *    under `resolveLogsDir(projectKey)/<dest with "logs/" stripped>` (the T495
 *    layout, sibling of the primary store's `state/`) — NOT under
 *    `<repo>/.cq/logs/`;
 *  - `read_log` (via the SAME MCP tool factory / call path the web viewer
 *    uses) returns that content byte-identical to what was written;
 *  - invalid JSONL is still rejected (exit non-zero, nothing written, nothing
 *    readable);
 *  - the redaction + strict-JSONL-validation guarantees are shared with the
 *    fs/git-object branches (covered in depth by log-put-fs.test.ts) — this
 *    file adds the backend-aware xdg-location assertions only.
 *
 * Throwaway git repo (for a stable projectKey) + a throwaway XDG_STATE_HOME;
 * cleaned up in afterAll.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  SqliteLedgerStore,
  createLedgerMcpTools,
  resolveLogsDir,
  type ReadLogResult,
} from "@cq/ledger";
import { runLogPut, parseLogPutArgs, type LogPutIo } from "../src/logPut.js";

const exec = promisify(execFile);
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

/** A throwaway initialised git repo (for a stable projectKey) with cq.toml selecting xdg. */
async function xdgRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cq-log-put-xdg-"));
  dirs.push(dir);
  await exec("git", ["init", "-q"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "# repo\n");
  await exec("git", ["add", "README.md"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  await writeFile(path.join(dir, "cq.toml"), '[ledger]\nbackend = "xdg"\n', "utf8");
  return dir;
}

async function projectKeyOf(dir: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-list", "--max-parents=0", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  });
  return stdout.trim();
}

function makeIo(stdinContent: string): LogPutIo & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return {
    outs,
    errs,
    out: (l) => outs.push(l),
    err: (l) => errs.push(l),
    readStdin: async () => stdinContent,
  };
}

function callTool(
  tools: ReturnType<typeof createLedgerMcpTools>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const t = tools.find((x) => x.name === name);
  if (t === undefined) throw new Error(`tool not found: ${name}`);
  return t.handler(args as never, null) as Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
}

function decode<T>(result: { content: Array<{ type: string; text: string }> }): T {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected single text content block");
  }
  return JSON.parse(first.text) as T;
}

describe("cq log put xdg — write path + read_log round-trip (T499)", () => {
  let originalXdgStateHome: string | undefined;

  beforeEach(() => {
    originalXdgStateHome = process.env["XDG_STATE_HOME"];
  });

  afterEach(() => {
    if (originalXdgStateHome === undefined) {
      delete process.env["XDG_STATE_HOME"];
    } else {
      process.env["XDG_STATE_HOME"] = originalXdgStateHome;
    }
  });

  it("writes redacted JSONL under resolveLogsDir(projectKey), NOT under <repo>/.cq/logs, and read_log returns it byte-identical", async () => {
    const root = await xdgRepo();
    const xdgHome = await mkdtemp(path.join(tmpdir(), "cq-log-put-xdg-home-"));
    dirs.push(xdgHome);
    process.env["XDG_STATE_HOME"] = xdgHome;

    const projectKey = await projectKeyOf(root);
    const logsDir = resolveLogsDir(projectKey);

    const realKey = "AKIAIOSFODNN7EXAMPLE";
    const rawInput =
      [`{"event":"start","ts":1}`, `{"event":"auth","key":"${realKey}"}`].join("\n") + "\n";
    const expectedRedacted =
      [`{"event":"start","ts":1}`, `{"event":"auth","key":"[REDACTED:aws-key]"}`].join("\n") +
      "\n";

    const io = makeIo(rawInput);
    const args = parseLogPutArgs(root, ["--stdin", "--dest", "logs/raw/20260101-abc.jsonl"]);
    const outcome = await runLogPut(args, io);

    expect(outcome.exitCode).toBe(0);
    expect(io.errs).toEqual([]);

    // Lands under the out-of-tree logs area, not the in-tree .cq/logs/.
    const destAbs = path.join(logsDir, "raw", "20260101-abc.jsonl");
    expect(io.outs).toEqual([destAbs]);
    const inTreeAbs = path.join(root, ".cq", "logs", "raw", "20260101-abc.jsonl");
    await expect(stat(inTreeAbs)).rejects.toThrow();

    // --- read_log round-trip, via the SAME MCP tool call path the web viewer
    // (a pure MCP client) uses (createLedgerMcpTools + the read_log capability).
    const store = new SqliteLedgerStore({
      dbPath: path.join(xdgHome, "probe-unused.db"),
      logsDir,
    });
    try {
      const tools = createLedgerMcpTools(store, (p) => store.readLog(p));
      const res = decode<ReadLogResult>(
        await callTool(tools, "read_log", { path: "raw/20260101-abc.jsonl" }),
      );
      expect(res.content).toBe(expectedRedacted);
      expect(res.truncated).toBeUndefined();

      // Also resolvable via the repo-relative ".cq/logs/<rel>" form stored in
      // sessionLogs/rawLogs fields (the strip-prefix convention is shared
      // across backends).
      const res2 = decode<ReadLogResult>(
        await callTool(tools, "read_log", { path: ".cq/logs/raw/20260101-abc.jsonl" }),
      );
      expect(res2.content).toBe(expectedRedacted);
    } finally {
      await store.dispose();
    }
  });

  it("rejects malformed JSONL: exits non-zero, writes NOTHING, nothing readable via read_log", async () => {
    const root = await xdgRepo();
    const xdgHome = await mkdtemp(path.join(tmpdir(), "cq-log-put-xdg-home-bad-"));
    dirs.push(xdgHome);
    process.env["XDG_STATE_HOME"] = xdgHome;

    const projectKey = await projectKeyOf(root);
    const logsDir = resolveLogsDir(projectKey);

    // Pretty-printed JSON is not valid JSONL (multi-line value).
    const prettyPrinted = '{\n  "event": "bad"\n}\n';
    const io = makeIo(prettyPrinted);
    const args = parseLogPutArgs(root, ["--stdin", "--dest", "logs/raw/bad.jsonl"]);
    const outcome = await runLogPut(args, io);

    expect(outcome.exitCode).not.toBe(0);
    expect(io.errs.join("\n")).toMatch(/line \d+/);
    expect(io.errs.join("\n")).toContain("malformed JSONL");

    const destAbs = path.join(logsDir, "raw", "bad.jsonl");
    await expect(stat(destAbs)).rejects.toThrow();

    const store = new SqliteLedgerStore({
      dbPath: path.join(xdgHome, "probe-unused.db"),
      logsDir,
    });
    try {
      const tools = createLedgerMcpTools(store, (p) => store.readLog(p));
      await expect(callTool(tools, "read_log", { path: "raw/bad.jsonl" })).rejects.toThrow();
    } finally {
      await store.dispose();
    }
  });
});
