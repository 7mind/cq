/**
 * T504: the `cq migrate` subcommand — one-shot LEGACY (fs | git-object) → xdg
 * migration, per the acceptance:
 *
 *   - a seeded fs-backend repo and a seeded git-object-backend repo each
 *     migrate with FULL fetch parity: items, milestones, ARCHIVES, and logs
 *     (readable via the store's readLog surface) post-migrate;
 *   - the legacy `.cq/` files / orphan ref are BYTE-IDENTICAL before and
 *     after (migrate reads, never moves/deletes);
 *   - cq.toml's [ledger].backend flips to "xdg";
 *   - a second run without --yes refuses (backend is already xdg — no legacy
 *     source configured);
 *   - a NON-EMPTY xdg target without --yes refuses (non-TTY, the shared
 *     destructive-op policy) and writes NOTHING; --yes proceeds.
 *
 * Throwaway git repos + a per-test XDG_STATE_HOME override (mirrors
 * restore-cmd.test.ts).
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  createLedgerStore,
  ledgerTreePaths,
  resolveLedgerBackend,
  resolveLogsDir,
  resolveProjectKey,
  resolveStateDir,
  SqliteLedgerStore,
  LEDGER_STORAGE_DIRNAME,
  MILESTONES_LEDGER,
  TASKS_LEDGER,
  XDG_DB_FILENAME,
  type ArchiveContent,
  type Item,
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

const SESSION_LOG_REL = "20260714-1400-session.md";
const SESSION_LOG_BODY = "# session log\n\nmigrate notes.\n";
const RAW_LOG_REL = "raw/20260714-1400-cli.jsonl";
const RAW_LOG_BODY = '{"type":"turn","n":1}\n';

/** What the legacy seed produced — the parity baseline for post-migrate reads. */
interface SeededState {
  milestone: Item;
  item: Item;
  archivedMilestoneId: string;
  tasksArchive: ArchiveContent;
  milestonesArchive: ArchiveContent;
}

/**
 * Seed the LEGACY backend at `root` via its public store surface: an active
 * milestone + task, PLUS a fully archived milestone (a done task, milestone
 * done, archiveMilestone) so the migrate parity covers archives too. Logs are
 * seeded separately via `cq log put` (the same path a real session uses).
 */
async function seedLegacy(root: string): Promise<SeededState> {
  const seeded = await createLedgerStore(root);
  try {
    const milestone = await seeded.store.createMilestone({ title: "active work" });
    const item = await seeded.store.createItem(TASKS_LEDGER, milestone.id, {
      status: "planned",
      fields: { headline: "seeded task" },
      author: "tester[1m]",
      session: "sess-1",
    });

    const doneMilestone = await seeded.store.createMilestone({ title: "finished work" });
    const doneItem = await seeded.store.createItem(TASKS_LEDGER, doneMilestone.id, {
      status: "planned",
      fields: { headline: "finished task" },
    });
    await seeded.store.updateItem(TASKS_LEDGER, doneItem.id, { status: "done" });
    await seeded.store.updateMilestone(doneMilestone.id, { status: "done" });
    await seeded.store.archiveMilestone(doneMilestone.id, "finished for migrate test");

    const tasksArchive = await seeded.store.fetchArchive(TASKS_LEDGER, doneMilestone.id);
    const milestonesArchive = await seeded.store.fetchArchive(MILESTONES_LEDGER, doneMilestone.id);
    return {
      milestone,
      item,
      archivedMilestoneId: doneMilestone.id,
      tasksArchive,
      milestonesArchive,
    };
  } finally {
    await seeded.store.dispose();
  }
}

/** Seed both log artifacts through `cq log put` (backend-routed). */
async function seedLogs(root: string): Promise<void> {
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
}

/**
 * Full post-migrate parity assertions: cq.toml flipped to xdg, fetch parity
 * (item, milestone, BOTH archives), and readLog parity for both artifacts.
 */
async function assertMigratedParity(root: string, seed: SeededState): Promise<void> {
  expect(resolveLedgerBackend(root).backend).toBe("xdg");

  const migrated = await createLedgerStore(root);
  try {
    expect(migrated.backend).toBe("xdg");
    expect(migrated.store.fetchItem(TASKS_LEDGER, seed.item.id)).toEqual(seed.item);
    expect(migrated.store.fetchMilestone(seed.milestone.id).milestone).toEqual(seed.milestone);
    expect(await migrated.store.fetchArchive(TASKS_LEDGER, seed.archivedMilestoneId)).toEqual(
      seed.tasksArchive,
    );
    expect(await migrated.store.fetchArchive(MILESTONES_LEDGER, seed.archivedMilestoneId)).toEqual(
      seed.milestonesArchive,
    );

    // read_log parity — logsDir is resolved the SAME way `read_log` resolves
    // it (resolveLogsDir(projectKey)); a bare probe store reads it directly
    // (readLog is a concrete-backend surface, not on the LedgerStore
    // interface — mirrors restore-cmd.test.ts).
    const projectKey = await resolveProjectKey({ repoRoot: root, projectId: null });
    const probe = new SqliteLedgerStore({
      dbPath: path.join(resolveStateDir(projectKey), XDG_DB_FILENAME),
      logsDir: resolveLogsDir(projectKey),
    });
    const md = await probe.readLog(SESSION_LOG_REL);
    expect(md.content).toBe(SESSION_LOG_BODY);
    expect(md.truncated).toBeUndefined();
    const raw = await probe.readLog(RAW_LOG_REL);
    expect(raw.content).toBe(RAW_LOG_BODY);
    expect(raw.truncated).toBeUndefined();
  } finally {
    await migrated.store.dispose();
  }
}

describe("cq migrate (T504)", () => {
  let originalXdgStateHome: string | undefined;

  beforeEach(async () => {
    originalXdgStateHome = process.env["XDG_STATE_HOME"];
    const xdgHome = await fs.mkdtemp(path.join(tmpdir(), "cq-migrate-xdg-home-"));
    dirs.push(xdgHome);
    process.env["XDG_STATE_HOME"] = xdgHome;
  });

  afterEach(() => {
    if (originalXdgStateHome === undefined) {
      delete process.env["XDG_STATE_HOME"];
    } else {
      process.env["XDG_STATE_HOME"] = originalXdgStateHome;
    }
  });

  it("refuses when [ledger].backend is already 'xdg' (no legacy source)", async () => {
    const root = await gitRepo("cq-migrate-xdg-");
    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "xdg"\n');
    const io = recordingIo();
    const outcome = await dispatch(["migrate", "--cwd", root], io);
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(io.errs.join("\n")).toContain("already 'xdg'");
  });

  it("fs backend: migrates state + logs, leaves .cq/ byte-identical, second run refuses", async () => {
    const root = await gitRepo("cq-migrate-fs-");
    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "fs"\n');

    const seed = await seedLegacy(root);
    await seedLogs(root);

    // Snapshot every legacy ledger file's bytes (registry, ledgers, archives,
    // logs) BEFORE migrate.
    const docsDir = path.join(root, LEDGER_STORAGE_DIRNAME);
    const relsBefore = await ledgerTreePaths(docsDir);
    expect(relsBefore.length).toBeGreaterThan(0);
    const bytesBefore = new Map<string, string>();
    for (const rel of relsBefore) {
      bytesBefore.set(rel, await fs.readFile(path.join(docsDir, rel), "utf8"));
    }

    const io = recordingIo();
    const outcome = await dispatch(["migrate", "--cwd", root], io);
    expect(outcome.exitCode).toBe(0);
    expect(io.errs).toEqual([]);
    expect(io.outs.join("\n")).toContain("UNTOUCHED");

    await assertMigratedParity(root, seed);

    // The legacy .cq/ files are byte-identical: same file set, same bytes.
    const relsAfter = await ledgerTreePaths(docsDir);
    expect(relsAfter).toEqual(relsBefore);
    const bytesAfter = new Map<string, string>();
    for (const rel of relsAfter) {
      bytesAfter.set(rel, await fs.readFile(path.join(docsDir, rel), "utf8"));
    }
    expect(bytesAfter).toEqual(bytesBefore);

    // A second run without --yes refuses (the backend is already xdg).
    const second = await dispatch(["migrate", "--cwd", root], recordingIo());
    expect(second.exitCode).toBe(EXIT_USAGE);
  });

  it("git-object backend: migrates state + logs, leaves the orphan ref byte-identical, second run refuses", async () => {
    const root = await gitRepo("cq-migrate-git-");
    await fs.writeFile(
      path.join(root, "cq.toml"),
      '[ledger]\nbackend = "git-object"\nbranch = "cq-migrate-src"\n',
    );

    const seed = await seedLegacy(root);
    await seedLogs(root);

    // Snapshot the orphan ref's tip BEFORE migrate — byte-identity of the
    // whole legacy source (state + log CAS) reduces to the commit sha.
    const shaBefore = (
      await exec("git", ["rev-parse", "refs/heads/cq-migrate-src"], { cwd: root })
    ).stdout.trim();

    const io = recordingIo();
    const outcome = await dispatch(["migrate", "--cwd", root], io);
    expect(outcome.exitCode).toBe(0);
    expect(io.errs).toEqual([]);
    expect(io.outs.join("\n")).toContain("refs/heads/cq-migrate-src");

    await assertMigratedParity(root, seed);

    // The orphan ref never moved.
    const shaAfter = (
      await exec("git", ["rev-parse", "refs/heads/cq-migrate-src"], { cwd: root })
    ).stdout.trim();
    expect(shaAfter).toBe(shaBefore);

    // A second run without --yes refuses (the backend is already xdg).
    const second = await dispatch(["migrate", "--cwd", root], recordingIo());
    expect(second.exitCode).toBe(EXIT_USAGE);
  });

  it("refuses to clobber a non-empty xdg target without --yes, writing nothing; --yes proceeds", async () => {
    const root = await gitRepo("cq-migrate-nonempty-");

    // Seed the xdg TARGET first (backend = xdg), so it is non-empty.
    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "xdg"\n');
    const target = await createLedgerStore(root);
    const preMilestone = await target.store.createMilestone({ title: "pre-existing xdg work" });
    const preItem = await target.store.createItem(TASKS_LEDGER, preMilestone.id, {
      status: "planned",
      fields: { headline: "pre-existing xdg task" },
    });
    await target.store.dispose();

    // Now point cq.toml at the LEGACY fs backend and seed it (state + logs).
    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "fs"\n');
    const seed = await seedLegacy(root);
    await seedLogs(root);

    // Non-TTY, no --yes → refuse (exit EXIT_REFUSED), nothing written.
    const refusedIo = recordingIo();
    const refused = await dispatch(["migrate", "--cwd", root], refusedIo);
    expect(refused.exitCode).toBe(EXIT_REFUSED);

    // cq.toml still names the legacy backend; the xdg primary is untouched.
    expect(resolveLedgerBackend(root).backend).toBe("fs");
    const projectKey = await resolveProjectKey({ repoRoot: root, projectId: null });
    const probe = new SqliteLedgerStore({
      dbPath: path.join(resolveStateDir(projectKey), XDG_DB_FILENAME),
      logsDir: resolveLogsDir(projectKey),
    });
    await probe.init();
    try {
      expect(probe.fetchItem(TASKS_LEDGER, preItem.id)).toEqual(preItem);
    } finally {
      await probe.dispose();
    }

    // --yes proceeds: the target is overwritten with the legacy content.
    const forced = await dispatch(["migrate", "--cwd", root, "--yes"], recordingIo());
    expect(forced.exitCode).toBe(0);
    await assertMigratedParity(root, seed);
  });
});
