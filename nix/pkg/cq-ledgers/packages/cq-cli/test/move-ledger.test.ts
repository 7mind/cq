/**
 * T354: `cq move-ledger --to git|local` — lossless bidirectional migration of
 * the live ledger between the .cq/ working tree and the orphan ref.
 *
 * Acceptance (R418): in a throwaway git repo, seed .cq/ ledgers, then
 *   - `cq move-ledger --to git`  → the orphan ref carries identical ledger bytes,
 *     .cq/ ledger files UNTRACKED (`git ls-files .cq/` empty) but STILL PRESENT
 *     on disk (left-in-place), cq.toml backend=git-object;
 *   - `cq move-ledger --to local` → restores TRACKED .cq/*.md byte-identical to
 *     the orphan-ref content + backend=fs;
 *   - the round trip is provably LOSSLESS including on-disk file state (.cq/*.md
 *     bytes before --to git EQUAL the bytes after --to local) AND tracked-state
 *     (tracked → untracked → tracked);
 *   - refuses a non-empty target without --force; refuses without --to.
 *
 * Throwaway repos via mkdtemp; cleaned up in afterAll.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { LEDGER_STORAGE_DIRNAME } from "@cq/ledger";
import { dispatch, type ConfirmIo, type DispatchIo } from "../src/main.js";

const exec = promisify(execFile);
const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

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

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await exec("git", args, { cwd, encoding: "utf8" });
  return r.stdout;
}

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cq-move-"));
  dirs.push(dir);
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@example.com");
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "commit.gpgsign", "false");
  await writeFile(path.join(dir, "README.md"), "# repo\n");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** Seed .cq/ with a non-trivial ledger (fs backend), then tracked. */
async function seedDocs(root: string): Promise<Record<string, string>> {
  const storage = path.join(root, LEDGER_STORAGE_DIRNAME);
  await mkdir(path.join(storage, "archive", "tasks"), { recursive: true });
  const files: Record<string, string> = {
    [`${LEDGER_STORAGE_DIRNAME}/ledgers.yaml`]: "version: 1\nledgers:\n  - tasks\n",
    [`${LEDGER_STORAGE_DIRNAME}/tasks.md`]: "# tasks\n\n- [T1] seed task — non-empty body\n",
    [`${LEDGER_STORAGE_DIRNAME}/defects.md`]: "# defects\n\n- [D1] a seeded defect\n",
    [`${LEDGER_STORAGE_DIRNAME}/archive/tasks/M1.md`]: "# archived milestone M1\n\narchived content\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(path.join(root, rel), content, "utf8");
  }
  // Track them on the working branch (the pre-migration tracked state).
  await git(root, "add", LEDGER_STORAGE_DIRNAME);
  await git(root, "commit", "-q", "-m", "seed ledger");
  return files;
}

describe("cq move-ledger", () => {
  it("refuses without --to", async () => {
    const root = await gitRepo();
    await seedDocs(root);
    const io = recordingIo();
    const outcome = await dispatch(["move-ledger", "--cwd", root], io);
    expect(outcome.exitCode).toBe(2);
    expect(io.errs.join("\n")).toMatch(/--to <git\|local> is required/);
  });

  it("rejects an invalid --to value", async () => {
    const root = await gitRepo();
    await expect(dispatch(["move-ledger", "--cwd", root, "--to", "bogus"], recordingIo())).rejects.toThrow(
      /--to must be "git" or "local"/,
    );
  });

  it(`round-trips ${LEDGER_STORAGE_DIRNAME}/ ↔ orphan ref losslessly (bytes + tracked-state)`, async () => {
    const root = await gitRepo();
    const seeded = await seedDocs(root);

    // Capture the pre-migration on-disk bytes.
    const before: Record<string, string> = {};
    for (const rel of Object.keys(seeded)) {
      before[rel] = await readFile(path.join(root, rel), "utf8");
    }
    // `before` IS the seeded content (anchor for the before===after claim below).
    expect(before).toEqual(seeded);
    // Pre-migration: all storage files are TRACKED.
    const trackedBefore = (await git(root, "ls-files", `${LEDGER_STORAGE_DIRNAME}/`)).trim().split("\n").sort();
    expect(trackedBefore).toEqual([
      `${LEDGER_STORAGE_DIRNAME}/archive/tasks/M1.md`,
      `${LEDGER_STORAGE_DIRNAME}/defects.md`,
      `${LEDGER_STORAGE_DIRNAME}/ledgers.yaml`,
      `${LEDGER_STORAGE_DIRNAME}/tasks.md`,
    ]);

    // --- --to git ---
    const io1 = recordingIo();
    const out1 = await dispatch(["move-ledger", "--cwd", root, "--to", "git"], io1);
    expect(out1.exitCode).toBe(0);

    // The orphan ref carries identical ledger bytes (storage-relative tree paths).
    for (const [rel, content] of Object.entries(seeded)) {
      const treePath = rel.slice(`${LEDGER_STORAGE_DIRNAME}/`.length);
      const refBytes = await git(root, "cat-file", "-p", `cq-ledger:${treePath}`);
      expect(refBytes).toBe(content);
    }

    // storage ledger files UNTRACKED on the working branch.
    const trackedAfterGit = (await git(root, "ls-files", `${LEDGER_STORAGE_DIRNAME}/`)).trim();
    expect(trackedAfterGit).toBe("");

    // ... but STILL PRESENT on disk (left in place, R418), bytes unchanged.
    for (const [rel, content] of Object.entries(before)) {
      const onDisk = await readFile(path.join(root, rel), "utf8");
      expect(onDisk).toBe(content);
    }

    // cq.toml backend = git-object.
    const toml1 = await readFile(path.join(root, "cq.toml"), "utf8");
    expect(toml1).toMatch(/\[ledger\]/);
    expect(toml1).toMatch(/backend\s*=\s*"git-object"/);

    // .gitignore carries the git-backend block.
    const gi1 = await readFile(path.join(root, ".gitignore"), "utf8");
    expect(gi1).toMatch(/cq git-object ledger backend/);

    // --- --to local ---
    // R418 LEAVES the .cq/*.md on disk after --to git, so the local target is
    // "non-empty"; the round trip back uses --force (the realistic flow once the
    // operator round-trips a left-in-place tree).
    const io2 = recordingIo();
    const out2 = await dispatch(["move-ledger", "--cwd", root, "--to", "local", "--force"], io2);
    expect(out2.exitCode).toBe(0);

    // .cq/*.md restored byte-identical to the orphan-ref content — and, since
    // `seeded` IS the pre-migration on-disk content captured in `before`, this
    // proves LOSSLESS on-disk state (before === after).
    for (const [rel, content] of Object.entries(seeded)) {
      const onDisk = await readFile(path.join(root, rel), "utf8");
      expect(onDisk).toBe(content);
    }

    // TRACKED again (tracked → untracked → tracked).
    const trackedAfterLocal = (await git(root, "ls-files", `${LEDGER_STORAGE_DIRNAME}/`)).trim().split("\n").sort();
    expect(trackedAfterLocal).toEqual([
      `${LEDGER_STORAGE_DIRNAME}/archive/tasks/M1.md`,
      `${LEDGER_STORAGE_DIRNAME}/defects.md`,
      `${LEDGER_STORAGE_DIRNAME}/ledgers.yaml`,
      `${LEDGER_STORAGE_DIRNAME}/tasks.md`,
    ]);

    // cq.toml backend = fs.
    const toml2 = await readFile(path.join(root, "cq.toml"), "utf8");
    expect(toml2).toMatch(/backend\s*=\s*"fs"/);

    // .gitignore git-backend block removed (reversible).
    let gi2 = "";
    try {
      gi2 = await readFile(path.join(root, ".gitignore"), "utf8");
    } catch {
      gi2 = "";
    }
    expect(gi2).not.toMatch(/cq git-object ledger backend/);
  });

  it("refuses a non-empty git target without --force", async () => {
    const root = await gitRepo();
    await seedDocs(root);
    // First migration populates the orphan ref.
    expect((await dispatch(["move-ledger", "--cwd", root, "--to", "git"], recordingIo())).exitCode).toBe(0);

    // Re-seed storage so a second --to git has a source, then refuse (ref non-empty).
    await writeFile(path.join(root, LEDGER_STORAGE_DIRNAME, "tasks.md"), "# tasks\n\n- [T2] more\n", "utf8");
    const io = recordingIo();
    const outcome = await dispatch(["move-ledger", "--cwd", root, "--to", "git"], io);
    expect(outcome.exitCode).toBe(2);
    expect(io.errs.join("\n")).toMatch(/already holds a non-empty ledger/);
  });

  it("refuses a non-empty local target without --force", async () => {
    const root = await gitRepo();
    const seeded = await seedDocs(root);
    expect((await dispatch(["move-ledger", "--cwd", root, "--to", "git"], recordingIo())).exitCode).toBe(0);
    // .cq/*.md are still on disk (non-empty) → --to local refuses.
    const io = recordingIo();
    const outcome = await dispatch(["move-ledger", "--cwd", root, "--to", "local"], io);
    expect(outcome.exitCode).toBe(2);
    expect(io.errs.join("\n")).toMatch(/already holds a non-empty ledger/);

    // --force proceeds.
    const io2 = recordingIo();
    expect((await dispatch(["move-ledger", "--cwd", root, "--to", "local", "--force"], io2)).exitCode).toBe(0);
    for (const [rel, content] of Object.entries(seeded)) {
      expect(await readFile(path.join(root, rel), "utf8")).toBe(content);
    }
  });

  it(`logs-only ${LEDGER_STORAGE_DIRNAME}/ counts as EMPTY (docsLedgerNonEmpty skips logs/**)`, async () => {
    // Exercises docsLedgerNonEmpty: a .cq/ tree with ONLY logs/** (plus blank
    // ledger .md) must return false so --to local does NOT refuse without --force.
    // Without the fix, logs/summary.md has non-blank content and triggers a
    // false-positive "non-empty" refusal.
    const root = await gitRepo();

    // Seed .cq/ with a blank ledger + a non-blank logs summary .md.
    const storage = path.join(root, LEDGER_STORAGE_DIRNAME);
    await mkdir(path.join(storage, "logs"), { recursive: true });
    await writeFile(path.join(storage, "ledgers.yaml"), "version: 1\nledgers:\n  - tasks\n", "utf8");
    await writeFile(path.join(storage, "tasks.md"), "", "utf8"); // blank — empty ledger
    const logSummary = "2026-01-01T00:00:00.000Z.md";
    await writeFile(path.join(storage, "logs", logSummary), "# session log\n\nsummary content\n", "utf8");
    await git(root, "add", LEDGER_STORAGE_DIRNAME);
    await git(root, "commit", "-q", "-m", "seed logs-only storage");

    // Also seed the orphan ref so --to local has a source (otherwise it fails
    // with "ref does not exist").  Do --to git first (which works because the ref
    // is empty), giving us an orphan ref with logs content.
    const io1 = recordingIo();
    const out1 = await dispatch(["move-ledger", "--cwd", root, "--to", "git"], io1);
    expect(out1.exitCode).toBe(0);

    // The orphan ref carries the logs summary .md.
    const refTree = (await git(root, "ls-tree", "-r", "--name-only", "cq-ledger")).trim();
    expect(refTree).toContain(`logs/${logSummary}`);

    // Remove .cq/ so the target is truly absent — then restore it with
    // ONLY logs content to represent the docsLedgerNonEmpty scenario:
    // .cq/ exists, has non-blank logs .md, but blank ledger .md.
    await rm(storage, { recursive: true, force: true });
    await mkdir(path.join(storage, "logs"), { recursive: true });
    await writeFile(path.join(storage, "ledgers.yaml"), "version: 1\nledgers:\n  - tasks\n", "utf8");
    await writeFile(path.join(storage, "tasks.md"), "", "utf8");
    await writeFile(path.join(storage, "logs", logSummary), "# session log\n\nsummary content\n", "utf8");

    // --to local WITHOUT --force must succeed: .cq/ has only logs/** + blank
    // ledger .md → docsLedgerNonEmpty must return false (logs excluded).
    const io2 = recordingIo();
    const out2 = await dispatch(["move-ledger", "--cwd", root, "--to", "local"], io2);
    expect(out2.exitCode).toBe(0);

    // The logs file is materialised (byte-identical from the ref).
    const summaryContent = await readFile(path.join(storage, "logs", logSummary), "utf8");
    expect(summaryContent).toBe("# session log\n\nsummary content\n");
  });

  it("logs-only orphan ref counts as EMPTY (refLedgerNonEmpty skips logs/**)", async () => {
    // Exercises refLedgerNonEmpty: an orphan ref carrying ONLY logs/** (no real
    // ledger .md content) must return false so a second --to git does NOT refuse
    // without --force.
    // Without the fix, the ref's logs/summary.md has non-blank content and
    // triggers a false-positive "non-empty" refusal.
    const root = await gitRepo();
    const storage = path.join(root, LEDGER_STORAGE_DIRNAME);

    // Seed .cq/ with a blank ledger + a non-blank logs summary .md.
    await mkdir(path.join(storage, "logs"), { recursive: true });
    await writeFile(path.join(storage, "ledgers.yaml"), "version: 1\nledgers:\n  - tasks\n", "utf8");
    await writeFile(path.join(storage, "tasks.md"), "", "utf8"); // blank ledger
    const logSummary = "2026-01-01T12:00:00.000Z.md";
    await writeFile(path.join(storage, "logs", logSummary), "# session log\n\nlog body here\n", "utf8");
    await git(root, "add", LEDGER_STORAGE_DIRNAME);
    await git(root, "commit", "-q", "-m", "seed blank-ledger + logs storage");

    // First --to git: populates the orphan ref with blank ledger + logs/** .md.
    const io1 = recordingIo();
    expect((await dispatch(["move-ledger", "--cwd", root, "--to", "git"], io1)).exitCode).toBe(0);

    // Verify the ref carries the logs .md (non-blank content that would fool the
    // old non-empty check).
    const refContent = await git(root, "cat-file", "-p", `cq-ledger:logs/${logSummary}`);
    expect(refContent).toBe("# session log\n\nlog body here\n");

    // Now attempt a second --to git WITHOUT --force. The ref carries only
    // logs/** — refLedgerNonEmpty must return false → no refusal.
    const io2 = recordingIo();
    const out2 = await dispatch(["move-ledger", "--cwd", root, "--to", "git"], io2);
    expect(out2.exitCode).toBe(0);
  });

  it(`full git→local→git round-trip with logs preserves bytes and git ls-files ${LEDGER_STORAGE_DIRNAME}/logs/ is EMPTY on working branch after --to git`, async () => {
    const root = await gitRepo();
    const seeded = await seedDocs(root);

    // Add logs to the seeded storage.
    const storage = path.join(root, LEDGER_STORAGE_DIRNAME);
    await mkdir(path.join(storage, "logs", "raw"), { recursive: true });
    const logRaw = '{"event":"session_start","ts":1234567890}\n';
    const logSummaryName = "2026-01-01T00-00-00.md";
    await writeFile(path.join(storage, "logs", "raw", "x.jsonl"), logRaw, "utf8");
    await writeFile(path.join(storage, "logs", logSummaryName), "# log summary\n\ncontent here\n", "utf8");
    await git(root, "add", `${LEDGER_STORAGE_DIRNAME}/logs`);
    await git(root, "commit", "-q", "-m", "add logs");

    // --to git: logs land in the orphan ref tree AND git ls-files .cq/logs/ is EMPTY.
    const io1 = recordingIo();
    expect((await dispatch(["move-ledger", "--cwd", root, "--to", "git"], io1)).exitCode).toBe(0);

    // Verify logs are in the ref tree.
    const refJsonl = await git(root, "cat-file", "-p", `cq-ledger:logs/raw/x.jsonl`);
    expect(refJsonl).toBe(logRaw);
    const refSummary = await git(root, "cat-file", "-p", `cq-ledger:logs/${logSummaryName}`);
    expect(refSummary).toBe("# log summary\n\ncontent here\n");

    // git ls-files .cq/logs/ MUST be empty on the working branch.
    const trackedLogs = (await git(root, "ls-files", `${LEDGER_STORAGE_DIRNAME}/logs/`)).trim();
    expect(trackedLogs).toBe("");

    // --to local restores everything including logs, byte-identical.
    const io2 = recordingIo();
    expect(
      (await dispatch(["move-ledger", "--cwd", root, "--to", "local", "--force"], io2)).exitCode,
    ).toBe(0);

    // Ledger files restored.
    for (const [rel, content] of Object.entries(seeded)) {
      expect(await readFile(path.join(root, rel), "utf8")).toBe(content);
    }
    // Log files restored byte-identical.
    expect(await readFile(path.join(storage, "logs", "raw", "x.jsonl"), "utf8")).toBe(logRaw);
    expect(await readFile(path.join(storage, "logs", logSummaryName), "utf8")).toBe(
      "# log summary\n\ncontent here\n",
    );

    // Log files are git-tracked after --to local.
    const trackedLogsAfter = (await git(root, "ls-files", `${LEDGER_STORAGE_DIRNAME}/logs/`)).trim().split("\n").filter(Boolean).sort();
    expect(trackedLogsAfter).toContain(`${LEDGER_STORAGE_DIRNAME}/logs/raw/x.jsonl`);
    expect(trackedLogsAfter).toContain(`${LEDGER_STORAGE_DIRNAME}/logs/${logSummaryName}`);

    // --to git again: same invariant — logs in ref, .cq/logs/ untracked.
    const io3 = recordingIo();
    expect(
      (await dispatch(["move-ledger", "--cwd", root, "--to", "git", "--force"], io3)).exitCode,
    ).toBe(0);
    const trackedLogsAgain = (await git(root, "ls-files", `${LEDGER_STORAGE_DIRNAME}/logs/`)).trim();
    expect(trackedLogsAgain).toBe("");
    // Bytes preserved in ref.
    expect(await git(root, "cat-file", "-p", `cq-ledger:logs/raw/x.jsonl`)).toBe(logRaw);
  });

  it(`--to git leaves a NON-ledger ${LEDGER_STORAGE_DIRNAME}/*.md (not a registered ledger) tracked + out of the ref`, async () => {
    const root = await gitRepo();
    await seedDocs(root);
    // A user keeps an unrelated markdown file under .cq/ — NOT a registered
    // ledger. move-ledger must not claim, snapshot, or untrack it.
    await writeFile(path.join(root, LEDGER_STORAGE_DIRNAME, "notes.md"), "# design notes — not a ledger\n", "utf8");
    await git(root, "add", `${LEDGER_STORAGE_DIRNAME}/notes.md`);
    await git(root, "commit", "-q", "-m", "add user notes");

    expect((await dispatch(["move-ledger", "--cwd", root, "--to", "git"], recordingIo())).exitCode).toBe(0);

    // The real ledger files are untracked; the non-ledger notes.md stays TRACKED.
    const tracked = (await git(root, "ls-files", `${LEDGER_STORAGE_DIRNAME}/`)).trim().split("\n").filter(Boolean);
    expect(tracked).toEqual([`${LEDGER_STORAGE_DIRNAME}/notes.md`]);

    // notes.md is NOT carried into the orphan ref tree.
    await expect(git(root, "cat-file", "-p", "cq-ledger:notes.md")).rejects.toThrow();

    // It is still on disk, untouched.
    expect(await readFile(path.join(root, LEDGER_STORAGE_DIRNAME, "notes.md"), "utf8")).toBe(
      "# design notes — not a ledger\n",
    );
  });
});
