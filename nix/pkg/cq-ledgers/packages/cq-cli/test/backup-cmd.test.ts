/**
 * T502: the `cq backup` subcommand — the explicit on-demand counterpart of the
 * debounced backup trigger:
 *
 *   - refuses (usage error) when `[ledger].backup` is "none"/absent — backups
 *     are OFF by default (Q244) and nothing is ever written;
 *   - refuses for a non-xdg backend (the exporter dumps the out-of-tree
 *     primary; fs/git-object already keep the .cq layout human-readable);
 *   - backup="in-tree": exports a parseable dump under `<root>/.cq/`
 *     including the primary log store's artifacts byte-identically (Q247);
 *   - backup="orphan-branch": commits the dump to refs/heads/<branch>.
 *
 * Throwaway git repos + a per-test XDG_STATE_HOME override.
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  GitPlumbing,
  parseRegistry,
  resolveLogsDir,
  resolveProjectKey,
  TASKS_LEDGER,
} from "@cq/ledger";
import { dispatch, EXIT_USAGE, type ConfirmIo, type DispatchIo } from "../src/main.js";

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

function recordingIo(): DispatchIo & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return { outs, errs, out: (l) => outs.push(l), err: (l) => errs.push(l), confirm: silentConfirm };
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

const RAW_REL = "raw/20260714-1300-cli.jsonl";
const RAW_BYTES = '{"type":"turn","n":1}\n';

async function seedPrimaryLogs(root: string): Promise<void> {
  const projectKey = await resolveProjectKey({ repoRoot: root, projectId: null });
  const logsDir = resolveLogsDir(projectKey);
  await fs.mkdir(path.join(logsDir, "raw"), { recursive: true });
  await fs.writeFile(path.join(logsDir, RAW_REL), RAW_BYTES);
}

describe("cq backup (T502)", () => {
  let originalXdgStateHome: string | undefined;

  beforeEach(async () => {
    originalXdgStateHome = process.env["XDG_STATE_HOME"];
    const xdgHome = await fs.mkdtemp(path.join(tmpdir(), "cq-backup-xdg-home-"));
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

  it('refuses with a usage error when [ledger].backup is "none"/absent, writing nothing', async () => {
    const root = await gitRepo("cq-backup-none-");
    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "xdg"\n');
    const io = recordingIo();
    const outcome = await dispatch(["backup", "--cwd", root], io);
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(io.errs.join("\n")).toContain('backup is "none"');
    await expect(fs.stat(path.join(root, ".cq"))).rejects.toThrow();
  });

  it("refuses for a non-xdg backend", async () => {
    const root = await gitRepo("cq-backup-fs-");
    await fs.writeFile(
      path.join(root, "cq.toml"),
      '[ledger]\nbackend = "fs"\nbackup = "in-tree"\n',
    );
    const io = recordingIo();
    const outcome = await dispatch(["backup", "--cwd", root], io);
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(io.errs.join("\n")).toContain("backend='fs'");
  });

  it('backup="in-tree": exports a parseable .cq/ dump including the log artifacts', async () => {
    const root = await gitRepo("cq-backup-intree-");
    await fs.writeFile(
      path.join(root, "cq.toml"),
      '[ledger]\nbackend = "xdg"\nbackup = "in-tree"\n',
    );
    await seedPrimaryLogs(root);

    const io = recordingIo();
    const outcome = await dispatch(["backup", "--cwd", root], io);
    expect(outcome.exitCode).toBe(0);
    expect(io.outs.join("\n")).toContain("cq backup: exported");

    const registry = parseRegistry(
      await fs.readFile(path.join(root, ".cq", "ledgers.yaml"), "utf8"),
    );
    expect(registry.ledgers.map((e) => e.name)).toContain(TASKS_LEDGER);
    expect(await fs.readFile(path.join(root, ".cq", "logs", RAW_REL), "utf8")).toBe(RAW_BYTES);
  });

  it('backup="orphan-branch": commits the dump to refs/heads/<branch>', async () => {
    const root = await gitRepo("cq-backup-orphan-");
    await fs.writeFile(
      path.join(root, "cq.toml"),
      '[ledger]\nbackend = "xdg"\nbackup = "orphan-branch"\nbranch = "cq-backup"\n',
    );
    await seedPrimaryLogs(root);

    const io = recordingIo();
    const outcome = await dispatch(["backup", "--cwd", root], io);
    expect(outcome.exitCode).toBe(0);
    expect(io.outs.join("\n")).toContain("refs/heads/cq-backup");

    const git = GitPlumbing.withCwd(root, path.join(root, ".git"));
    const ref = "refs/heads/cq-backup";
    expect(await git.readRef(ref)).not.toBeNull();
    const paths = await git.lsTree(ref);
    expect(paths).toContain(".cq/ledgers.yaml");
    expect(paths).toContain(`.cq/logs/${RAW_REL}`);
    expect(await git.catFile(ref, `.cq/logs/${RAW_REL}`)).toBe(RAW_BYTES);
    // Nothing lands in the work tree for the orphan-branch target.
    await expect(fs.stat(path.join(root, ".cq"))).rejects.toThrow();
  });
});
