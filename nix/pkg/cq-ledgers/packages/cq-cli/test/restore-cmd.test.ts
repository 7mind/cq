/**
 * T503: the `cq restore` subcommand — the explicit one-way IMPORT counterpart
 * of `cq backup` (T502):
 *
 *   - round-trip: seed the xdg primary (items + a milestone + a `.md` session
 *     log + a raw `.jsonl` log via `cq log put`), `cq backup`, wipe the
 *     primary out-of-tree dir, `cq restore --yes` — then fetch_ledger /
 *     fetch_item parity with the pre-wipe snapshot AND read_log parity for
 *     every pre-wipe log artifact;
 *   - refuses to overwrite a NON-EMPTY primary without `--yes` (non-TTY, the
 *     shared destructive-op policy), exits non-zero, and writes NOTHING (the
 *     pre-existing item survives untouched).
 *
 * Throwaway git repos + a per-test XDG_STATE_HOME override (mirrors
 * backup-cmd.test.ts).
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  createLedgerStore,
  resolveProjectKey,
  resolveStateDirBase,
  resolveLogsDir,
  SqliteLedgerStore,
  TASKS_LEDGER,
} from "@cq/ledger";
import { dispatch, EXIT_USAGE, type ConfirmIo, type DispatchIo } from "../src/main.js";
import { EXIT_REFUSED } from "../src/confirm.js";

const exec = promisify(execFile);
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

const silentConfirm: ConfirmIo = {
  isTty: false,
  out: () => {},
  err: () => {},
  prompt: async () => "",
};

function recordingIo(stdin = ""): DispatchIo & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return {
    outs,
    errs,
    out: (l) => outs.push(l),
    err: (l) => errs.push(l),
    confirm: silentConfirm,
    readStdin: async () => stdin,
  };
}

/** A throwaway initialised git repo with one commit (the xdg identity key). */
async function gitRepo(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  await exec("git", ["init", "-q"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await fs.writeFile(path.join(dir, "README.md"), `# repo ${prefix}\n`);
  await exec("git", ["add", "README.md"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

async function xdgProjectDirOf(root: string): Promise<string> {
  const projectKey = await resolveProjectKey({ repoRoot: root, projectId: null });
  return resolveStateDirBase(projectKey);
}

const SESSION_LOG_REL = "20260714-1300-session.md";
const SESSION_LOG_BODY = "# session log\n\nsome notes.\n";
const RAW_LOG_REL = "raw/20260714-1300-cli.jsonl";
const RAW_LOG_BODY = '{"type":"turn","n":1}\n';

describe("cq restore (T503)", () => {
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

  it('refuses with a usage error when [ledger].backup is "none"/absent', async () => {
    const root = await gitRepo("cq-restore-none-");
    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "xdg"\n');
    const outcome = await dispatch(["restore", "--cwd", root], recordingIo());
    expect(outcome.exitCode).toBe(EXIT_USAGE);
  });

  it("refuses for a non-xdg backend", async () => {
    const root = await gitRepo("cq-restore-fs-");
    await fs.writeFile(
      path.join(root, "cq.toml"),
      '[ledger]\nbackend = "fs"\nbackup = "in-tree"\n',
    );
    const outcome = await dispatch(["restore", "--cwd", root], recordingIo());
    expect(outcome.exitCode).toBe(EXIT_USAGE);
  });

  /**
   * The full backup -> wipe -> restore --yes round-trip, parameterised by the
   * dump SOURCE (`[ledger].backup` target). Both sources MUST satisfy the same
   * acceptance: (a) fetch_ledger/fetch_item parity with the pre-wipe snapshot
   * AND (b) read_log parity for every pre-wipe log artifact. The only
   * difference between the two is where `cq backup` writes the dump (in-tree
   * `.cq/` vs the orphan ref) and thus where `cq restore` reads it from — the
   * store/log wipe + parity assertions are identical.
   */
  async function roundTrip(opts: { prefix: string; cqToml: string }): Promise<void> {
    const root = await gitRepo(opts.prefix);
    const xdgHome = await fs.mkdtemp(path.join(tmpdir(), "cq-restore-xdg-home-"));
    dirs.push(xdgHome);
    process.env["XDG_STATE_HOME"] = xdgHome;
    await fs.writeFile(path.join(root, "cq.toml"), opts.cqToml);

    // --- Seed: a milestone + a task item directly against the xdg primary.
    const seeded = await createLedgerStore(root);
    const milestone = await seeded.store.createMilestone({ title: "restore round-trip" });
    const item = await seeded.store.createItem(TASKS_LEDGER, milestone.id, {
      status: "planned",
      fields: { headline: "seeded task" },
      author: "tester[1m]",
      session: "sess-1",
    });
    await seeded.store.dispose();

    // --- Seed logs via `cq log put` (the same path a real session uses).
    const putMd = await dispatch(
      ["log", "put", "--stdin", "--dest", `logs/${SESSION_LOG_REL}`, "--cwd", root],
      recordingIo(SESSION_LOG_BODY),
    );
    expect(putMd.exitCode).toBe(0);
    const putRaw = await dispatch(
      ["log", "put", "--stdin", "--dest", `logs/${RAW_LOG_REL}`, "--cwd", root],
      recordingIo(RAW_LOG_BODY),
    );
    expect(putRaw.exitCode).toBe(0);

    // --- Export.
    const backupIo = recordingIo();
    const backupOutcome = await dispatch(["backup", "--cwd", root], backupIo);
    expect(backupOutcome.exitCode).toBe(0);

    // --- Wipe the out-of-tree primary (state/ + logs/) entirely.
    const xdgProjectDir = await xdgProjectDirOf(root);
    await fs.rm(xdgProjectDir, { recursive: true, force: true });
    await expect(fs.stat(xdgProjectDir)).rejects.toThrow();

    // --- Restore.
    const restoreIo = recordingIo();
    const restoreOutcome = await dispatch(["restore", "--cwd", root, "--yes"], restoreIo);
    expect(restoreOutcome.exitCode).toBe(0);
    expect(restoreIo.errs).toEqual([]);

    // --- (a) fetch_ledger/fetch_item parity.
    const restored = await createLedgerStore(root);
    try {
      const restoredItem = restored.store.fetchItem(TASKS_LEDGER, item.id);
      expect(restoredItem).toEqual(item);

      const restoredMilestone = restored.store.fetchMilestone(milestone.id);
      expect(restoredMilestone.milestone).toEqual(milestone);

      const fetchedLedger = restored.store.fetch(TASKS_LEDGER);
      const group = fetchedLedger.milestones.find((g) => g.id === milestone.id);
      expect(group?.items).toEqual([item]);
    } finally {
      // --- (b) read_log parity — every pre-wipe log artifact is readable
      // with content equal to its pre-wipe content. logsDir is resolved the
      // SAME way `read_log` resolves it (resolveLogsDir(projectKey)); a bare
      // probe store (readLog needs no init()/schema) reads it directly.
      const projectKey = await resolveProjectKey({ repoRoot: root, projectId: null });
      const logsDir = resolveLogsDir(projectKey);
      const probe = new SqliteLedgerStore({ dbPath: path.join(xdgHome, "probe-unused.db"), logsDir });
      const md = await probe.readLog(SESSION_LOG_REL);
      expect(md.content).toBe(SESSION_LOG_BODY);
      expect(md.truncated).toBeUndefined();
      const raw = await probe.readLog(RAW_LOG_REL);
      expect(raw.content).toBe(RAW_LOG_BODY);
      expect(raw.truncated).toBeUndefined();

      await restored.store.dispose();
    }
  }

  it("in-tree source: round-trips items + a milestone + logs through backup -> wipe -> restore --yes", async () => {
    await roundTrip({
      prefix: "cq-restore-roundtrip-intree-",
      cqToml: '[ledger]\nbackend = "xdg"\nbackup = "in-tree"\n',
    });
  });

  it("orphan-branch source: round-trips items + a milestone + logs through backup -> wipe -> restore --yes", async () => {
    await roundTrip({
      prefix: "cq-restore-roundtrip-orphan-",
      cqToml: '[ledger]\nbackend = "xdg"\nbackup = "orphan-branch"\nbranch = "cq-restore-dump"\n',
    });
  });

  it("orphan-branch source: fails loud without touching the primary when the ref does not exist", async () => {
    const root = await gitRepo("cq-restore-orphan-missing-");
    const xdgHome = await fs.mkdtemp(path.join(tmpdir(), "cq-restore-xdg-home-missing-"));
    dirs.push(xdgHome);
    process.env["XDG_STATE_HOME"] = xdgHome;
    await fs.writeFile(
      path.join(root, "cq.toml"),
      '[ledger]\nbackend = "xdg"\nbackup = "orphan-branch"\nbranch = "cq-never-written"\n',
    );

    // Seed a primary but NEVER `cq backup` — the orphan ref does not exist.
    const seeded = await createLedgerStore(root);
    const milestone = await seeded.store.createMilestone({ title: "untouched" });
    const item = await seeded.store.createItem(TASKS_LEDGER, milestone.id, {
      status: "planned",
      fields: { headline: "must survive" },
    });
    await seeded.store.dispose();

    const restoreIo = recordingIo();
    const restoreOutcome = await dispatch(["restore", "--cwd", root, "--yes"], restoreIo);
    expect(restoreOutcome.exitCode).toBe(EXIT_USAGE);
    expect(restoreIo.errs.join("\n")).toContain("does not exist");

    // The primary is untouched — the pre-existing item survives.
    const survivor = await createLedgerStore(root);
    try {
      expect(survivor.store.fetchItem(TASKS_LEDGER, item.id)).toEqual(item);
    } finally {
      await survivor.store.dispose();
    }
  });

  it("refuses to restore onto a non-empty primary without --yes, writing nothing", async () => {
    const root = await gitRepo("cq-restore-nonempty-");
    const xdgHome = await fs.mkdtemp(path.join(tmpdir(), "cq-restore-xdg-home-nonempty-"));
    dirs.push(xdgHome);
    process.env["XDG_STATE_HOME"] = xdgHome;
    await fs.writeFile(
      path.join(root, "cq.toml"),
      '[ledger]\nbackend = "xdg"\nbackup = "in-tree"\n',
    );

    const seeded = await createLedgerStore(root);
    const milestone = await seeded.store.createMilestone({ title: "still here" });
    const item = await seeded.store.createItem(TASKS_LEDGER, milestone.id, {
      status: "planned",
      fields: { headline: "pre-existing task" },
    });
    await seeded.store.dispose();

    const backupOutcome = await dispatch(["backup", "--cwd", root], recordingIo());
    expect(backupOutcome.exitCode).toBe(0);

    // Non-TTY, no --yes → refuse (exit EXIT_REFUSED), nothing written.
    const restoreIo = recordingIo();
    const restoreOutcome = await dispatch(["restore", "--cwd", root], restoreIo);
    expect(restoreOutcome.exitCode).toBe(EXIT_REFUSED);

    const stillThere = await createLedgerStore(root);
    try {
      expect(stillThere.store.fetchItem(TASKS_LEDGER, item.id)).toEqual(item);
    } finally {
      await stillThere.store.dispose();
    }
  });
});
