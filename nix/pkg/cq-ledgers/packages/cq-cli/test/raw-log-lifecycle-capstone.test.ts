/**
 * T420 (G49) — CAPSTONE end-to-end verification of the raw-log lifecycle under
 * the live git-object backend.
 *
 * This single scenario proves the seven G49 milestones COMPOSE on one throwaway
 * git-object fixture repo (NOT the real repo), driving the REAL primitives each
 * milestone shipped — no mocks of the cq machinery:
 *
 *   1. CAPTURE — `cq log put --stdin --dest logs/raw/<f>.jsonl` (runLogPut
 *      git-object branch, T413) lands the transcript at logs/raw/<f>.jsonl on
 *      the orphan ref (verified via GitPlumbing.catFile) while the working
 *      tree / index / HEAD stay byte-identical (git status clean — ref-only,
 *      NO leak onto the working branch).
 *   2. READ_LOG — the git-backed ReadLogCapability (GitObjectLedgerBackend.readLog,
 *      T408) serves the bytes back byte-identically from the ref tip.
 *   3. WEB PARSE — the web viewer parser (parseRawLog, T412) turns those bytes
 *      into a structured conversation model (ordered turns, tool_use↔tool_result
 *      pairing).
 *   4. MOVE-LEDGER ROUND-TRIP — `cq move-ledger --to local` materialises the ref
 *      tree to docs/logs/ (tracked), then `--to git` puts it back on the ref and
 *      untracks it; the log bytes survive the round trip (cat-file byte-identical)
 *      and the no-track-on-working-branch invariant holds under git-object
 *      (git ls-files docs/logs/ empty after --to git).
 *   5. ERASE — after a final `--to local` (logs on disk), `cq erase --yes` wipes
 *      docs/logs/ (the LEDGER_*_RUNTIME_DIRNAMES erase) and cq.toml; the repo
 *      root + sibling tracked files survive (bounded delete).
 *
 * Throughout, the working branch HEAD + working tree stay clean: the orphan-ref
 * lifecycle never leaks onto the working branch except where move-ledger
 * EXPLICITLY tracks (then untracks) docs/logs/.
 *
 * Reuses the harness patterns from log-put-git-object.test.ts (gitObjectRepo,
 * makeIo, plumbing/REF), gitObjectLedgerBackend.test.ts (readLog), and
 * move-ledger.test.ts (dispatch + recordingIo) — Blackbox-Atomic against real
 * git objects. Throwaway repos via mkdtemp; cleaned up in afterAll.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { GitPlumbing, GitObjectLedgerBackend } from "@cq/ledger";
import { runLogPut, parseLogPutArgs, type LogPutIo } from "../src/logPut.js";
import { dispatch, type ConfirmIo, type DispatchIo } from "../src/main.js";
// The web log viewer's parser (T412) — browser-safe, no node: imports. Imported
// from the @cq/ledger-web source to feed the real read_log bytes through it.
import { parseRawLog, type ToolUseTurn, type ToolResultTurn } from "../../ledger-web/src/rawLog.js";

const exec = promisify(execFile);
const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const REF = "refs/heads/cq-ledger";
const DEST = "logs/raw/2026-06-12T00-00-00-capstone.jsonl";
/** The ref tree path (logs/<rel>) and the read_log path (raw/<rel>). */
const TREE_PATH = DEST; // logs/raw/...
const READLOG_PATH = DEST.slice("logs/".length); // raw/...
const DOCS_PATH = path.join("docs", DEST); // docs/logs/raw/...

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

/** Real GitPlumbing bound to a repo root (production shape: scratch index under .git). */
function plumbing(root: string): GitPlumbing {
  return GitPlumbing.withCwd(root, path.join(root, ".git"));
}

/**
 * A throwaway git repo with one committed sibling file + a cq.toml selecting the
 * git-object backend — the fixture under which logs live in the orphan ref.
 */
async function gitObjectRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cq-capstone-git-"));
  dirs.push(dir);
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@example.com");
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "commit.gpgsign", "false");
  // A tracked sibling — a stand-in for real project source that must stay
  // byte-identical through the whole ref lifecycle and survive erase.
  await writeFile(path.join(dir, "README.md"), "# repo\n");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "-q", "-m", "init");
  await writeFile(path.join(dir, "cq.toml"), '[ledger]\nbackend = "git-object"\n', "utf8");
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

describe("T420 capstone — raw-log lifecycle under the git-object backend", () => {
  it("captures → read_log → web-parse → move-ledger round-trip → erase with NO working-branch leak", async () => {
    const root = await gitObjectRepo();

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

      // The transcript landed at the docs-relative tree path on the orphan ref.
      const onRef = await plumbing(root).catFile(REF, TREE_PATH);
      expect(onRef).toBe(SAMPLE_JSONL);

      // Ref-only: working tree + index + HEAD byte-identical (NO leak).
      const statusAfter = await git(root, "status", "--porcelain");
      const headAfter = (await git(root, "rev-parse", "HEAD")).trim();
      expect(statusAfter).toBe(statusBefore);
      expect(statusAfter.includes("logs/")).toBe(false);
      expect(statusAfter.includes("docs/")).toBe(false);
      expect(headAfter).toBe(headBefore);
      // The log is NOT tracked on the working branch.
      expect((await git(root, "ls-files", "docs/")).trim()).toBe("");
    }

    // =========================================================================
    // 2. READ_LOG — git-backed ReadLogCapability serves the bytes back (T408).
    //    A fresh backend instance forces a real read from the ref tip.
    // =========================================================================
    let readBack = "";
    {
      const reader = new GitObjectLedgerBackend({ repoRoot: root });
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
    // 4. MOVE-LEDGER ROUND-TRIP — ref → docs/ (--to local) → ref (--to git).
    // =========================================================================
    {
      // --to local: materialise the ref tree to docs/logs/ and TRACK it.
      const io1 = recordingIo();
      const out1 = await dispatch(["move-ledger", "--cwd", root, "--to", "local"], io1);
      expect(out1.exitCode).toBe(0);

      // The log bytes are on disk byte-identical, and TRACKED on the working
      // branch (move-ledger --to local deliberately re-tracks).
      expect(await Bun.file(path.join(root, DOCS_PATH)).text()).toBe(SAMPLE_JSONL);
      const trackedLocal = (await git(root, "ls-files", "docs/logs/")).trim();
      expect(trackedLocal.split("\n").filter(Boolean)).toContain(`docs/${DEST}`);

      // --to git (--force, docs/ non-empty after --to local): put it back on the
      // ref and UNTRACK — the no-track-on-working-branch invariant under git-object.
      const io2 = recordingIo();
      const out2 = await dispatch(["move-ledger", "--cwd", root, "--to", "git", "--force"], io2);
      expect(out2.exitCode).toBe(0);

      // Bytes preserved on the ref through the round trip (cat-file identical).
      expect(await plumbing(root).catFile(REF, TREE_PATH)).toBe(SAMPLE_JSONL);
      // No-track-on-working-branch invariant: docs/logs/ untracked again.
      expect((await git(root, "ls-files", "docs/logs/")).trim()).toBe("");
      // HEAD never moved on the working branch through capture + round trip.
      expect((await git(root, "rev-parse", "HEAD")).trim()).toBe(headBefore);
    }

    // =========================================================================
    // 5. ERASE — materialise once more so logs are on disk, then erase wipes
    //    docs/logs/ (LEDGER_*_RUNTIME_DIRNAMES) + cq.toml; siblings survive.
    // =========================================================================
    {
      // Bring the logs back onto disk so erase has a docs/logs/ to wipe.
      const ioLocal = recordingIo();
      expect(
        (await dispatch(["move-ledger", "--cwd", root, "--to", "local", "--force"], ioLocal)).exitCode,
      ).toBe(0);
      expect(await exists(path.join(root, "docs", "logs"))).toBe(true);

      const ioErase = recordingIo();
      const outErase = await dispatch(["erase", "--cwd", root, "--yes"], ioErase);
      expect(outErase.exitCode).toBe(0);

      // docs/logs/ wiped (the runtime-dir erase) AND cq.toml deleted.
      expect(await exists(path.join(root, "docs", "logs"))).toBe(false);
      expect(await exists(path.join(root, DOCS_PATH))).toBe(false);
      expect(await exists(path.join(root, "cq.toml"))).toBe(false);

      // Bounded: the repo root + the tracked sibling survive.
      expect(await exists(root)).toBe(true);
      expect(await exists(path.join(root, "README.md"))).toBe(true);
      expect(await Bun.file(path.join(root, "README.md")).text()).toBe("# repo\n");
    }
  }, 30_000);
});
