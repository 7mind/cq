/** Capture, read, render, and erase XDG logs without changing the working branch. */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { SqliteLedgerStore, ensureStateDir, resolveLogsDir, resolveStateDir, resolveProjectKey, XDG_DB_FILENAME, LEDGER_STORAGE_DIRNAME } from "@cq/ledger";
import { runLogPut, parseLogPutArgs, type LogPutIo } from "../src/logPut.js";
import { dispatch, type ConfirmIo, type DispatchIo } from "../src/main.js";
// The web log viewer's parser (T412) — browser-safe, no node: imports. Imported
// from the @cq/ledger-web source to feed the real read_log bytes through it.
import { parseRawLog, type ToolUseTurn, type ToolResultTurn } from "../../ledger-web/src/rawLog.js";

import { useIsolatedXdgState } from "./xdgFixture.js";

useIsolatedXdgState();
const exec = promisify(execFile);
const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const DEST = "logs/raw/2026-06-12T00-00-00-capstone.jsonl";
/** The public read_log path strips the storage-relative logs prefix. */
const READLOG_PATH = DEST.slice("logs/".length); // raw/...
/** On-disk path relative to root: .cq/logs/raw/... */
const STORAGE_PATH = path.join(LEDGER_STORAGE_DIRNAME, DEST); // .cq/logs/raw/...

/** A representative Claude-Code subagent transcript (strict JSONL). */
const SAMPLE_LINES = [
  { type: "user", message: { role: "user", content: "do the thing" } },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "I'll read the file." },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "/a/b.ts" } },
      ],
    },
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "line1\nline2" }],
    },
  },
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
  },
];
const SAMPLE_JSONL = SAMPLE_LINES.map((o) => JSON.stringify(o)).join("\n") + "\n";

const silentConfirm: ConfirmIo = {
  isTty: false,
  out: () => {},
  err: () => {},
  prompt: async () => "",
};

function recordingIo(): DispatchIo & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return { outs, errs, out: (l) => outs.push(l), err: (l) => errs.push(l), confirm: silentConfirm };
}

function makeLogPutIo(stdinContent: string): LogPutIo & { outs: string[]; errs: string[] } {
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

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await exec("git", args, { cwd, encoding: "utf8" });
  return r.stdout;
}

/** A scratch repository with one committed source file and an XDG primary. */
async function xdgRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cq-capstone-git-"));
  dirs.push(dir);
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@example.com");
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "commit.gpgsign", "false");
  // A tracked sibling — a stand-in for real project source that must stay
  // byte-identical through the whole log lifecycle and survive erase.
  await writeFile(path.join(dir, "README.md"), "# repo\n");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "-q", "-m", "init");
  await writeFile(path.join(dir, "cq.toml"), '[ledger]\nbackend = "xdg"\n', "utf8");
  return dir;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("T420 capstone — raw-log lifecycle under the XDG backend", () => {
  it("captures → read_log → web-parse → erase with NO working-branch leak", async () => {
    const root = await xdgRepo();
    const projectKey = await resolveProjectKey({ repoRoot: root, projectId: null });
    const logFile = path.join(resolveLogsDir(projectKey), READLOG_PATH);

    // ---- baseline: working tree / index / HEAD before any log activity -------
    const statusBefore = await git(root, "status", "--porcelain");
    const headBefore = (await git(root, "rev-parse", "HEAD")).trim();

    // =========================================================================
    // 1. CAPTURE — cq log put --stdin --dest logs/raw/<f>.jsonl (T413).
    // =========================================================================
    {
      const io = makeLogPutIo(SAMPLE_JSONL);
      const args = parseLogPutArgs(root, ["--stdin", "--dest", DEST]);
      const outcome = await runLogPut(args, io);
      expect(outcome.exitCode).toBe(0);
      expect(io.errs).toEqual([]);

      expect(await Bun.file(logFile).text()).toBe(SAMPLE_JSONL);
      expect(await exists(path.join(root, STORAGE_PATH))).toBe(false);

      // Out-of-tree: working tree + index + HEAD byte-identical (NO leak).
      const statusAfter = await git(root, "status", "--porcelain");
      const headAfter = (await git(root, "rev-parse", "HEAD")).trim();
      expect(statusAfter).toBe(statusBefore);
      expect(statusAfter.includes("logs/")).toBe(false);
      expect(statusAfter.includes(`${LEDGER_STORAGE_DIRNAME}/`)).toBe(false);
      expect(headAfter).toBe(headBefore);
      // The log is NOT tracked on the working branch.
      expect((await git(root, "ls-files", `${LEDGER_STORAGE_DIRNAME}/`)).trim()).toBe("");
    }

    // =========================================================================
    // 2. READ_LOG — a fresh SQLite instance reads the out-of-tree artifact.
    // =========================================================================
    let readBack = "";
    {
      await ensureStateDir(resolveStateDir(projectKey));
      const reader = new SqliteLedgerStore({ dbPath: path.join(resolveStateDir(projectKey), XDG_DB_FILENAME), logsDir: resolveLogsDir(projectKey) });
      await reader.init();
      const res = await reader.readLog(READLOG_PATH);
      expect(res.path).toBe(READLOG_PATH);
      expect(res.content).toBe(SAMPLE_JSONL); // byte-identical
      expect(res.truncated).toBeUndefined();
      readBack = res.content;
      await reader.dispose();
    }

    // =========================================================================
    // 3. WEB PARSE — feed the read_log bytes through parseRawLog (T412).
    // =========================================================================
    {
      const model = parseRawLog(readBack);
      expect(model.truncatedNotice).toBeNull();
      expect(model.turns.map((t) => t.kind)).toEqual([
        "user",
        "assistant",
        "tool_use",
        "tool_result",
        "assistant",
      ]);
      const toolUse = model.turns[2] as ToolUseTurn;
      expect(toolUse.toolName).toBe("Read");
      expect(toolUse.toolUseId).toBe("toolu_1");
      const toolResult = model.turns[3] as ToolResultTurn;
      expect(toolResult.toolUseId).toBe("toolu_1");
      expect(toolResult.pairedToolName).toBe("Read"); // paired by id
      expect(toolResult.resultPretty).toBe("line1\nline2");
    }

    // =========================================================================
    // 4. ERASE — project-local state and config disappear; tracked source survives.
    // =========================================================================
    {
      const ioErase = recordingIo();
      const outErase = await dispatch(["erase", "--cwd", root, "--yes"], ioErase);
      expect(outErase.exitCode).toBe(0);

      // cq.toml and the XDG log are deleted; no in-tree log existed.
      expect(await exists(path.join(root, "cq.toml"))).toBe(false);
      expect(await exists(path.join(root, LEDGER_STORAGE_DIRNAME))).toBe(false);

      // Bounded: the repository and tracked source survive.
      expect(await exists(root)).toBe(true);
      expect(await exists(path.join(root, "README.md"))).toBe(true);
      expect(await Bun.file(path.join(root, "README.md")).text()).toBe("# repo\n");
      expect(await exists(logFile)).toBe(false);
      expect((await git(root, "rev-parse", "HEAD")).trim()).toBe(headBefore);
    }
  }, 30_000);
});
