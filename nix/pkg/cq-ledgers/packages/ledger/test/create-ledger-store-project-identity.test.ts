import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  createLedgerStore,
  FsLedgerStore,
  GitObjectLedgerBackend,
  PostgresLedgerStore,
  RemoteLedgerClientNotWiredError,
  resolveDisplayName,
  SqliteLedgerStore,
  SqliteXdgProjectIdentityAccess,
  type ResolvedLedgerStore,
  type XdgProjectIdentity,
} from "../src/index.js";
import { dataVersion, openLedgerDb } from "../src/store/sqlite/connection.js";
import { PostgresDsnResolutionError } from "../src/store/postgres/dsn.js";

const exec = promisify(execFile);
const dirs: string[] = [];
const PG_URL = process.env.CQ_TEST_PG_URL;
const PG_ENV_VARS = [
  "CQ_LEDGER_PG_URL",
  "DATABASE_URL",
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGSERVICE",
  "PGSSLMODE",
  "PGOPTIONS",
  "PGPASSFILE",
  "PGAPPNAME",
] as const;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd, encoding: "utf8" });
}

async function gitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "cls-identity-git-"));
  dirs.push(dir);
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@example.com");
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(dir, "README.md"), `# ${randomUUID()}\n`, "utf8");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

async function plainDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function writeCqToml(dir: string, text: string): Promise<void> {
  await fs.writeFile(path.join(dir, "cq.toml"), text, "utf8");
}

function readIdentity(dbPath: string): XdgProjectIdentity | null {
  const db = openLedgerDb(dbPath);
  try {
    return new SqliteXdgProjectIdentityAccess(db).readProjectIdentity();
  } finally {
    db.close();
  }
}

async function openAndReadIdentity(root: string): Promise<{
  identity: XdgProjectIdentity | null;
  dbPath: string;
  projectKey: string;
}> {
  const resolved = await createLedgerStore(root);
  try {
    expect(resolved.backend).toBe("xdg");
    expect(resolved.store).toBeInstanceOf(SqliteLedgerStore);
    expect(resolved.dbPath).toBeDefined();
    expect(resolved.projectKey).toBeDefined();
    return {
      identity: readIdentity(resolved.dbPath!),
      dbPath: resolved.dbPath!,
      projectKey: resolved.projectKey!,
    };
  } finally {
    await resolved.store.dispose();
  }
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("createLedgerStore — repository-backed XDG identity (T829)", () => {
  let previousXdgStateHome: string | undefined;

  beforeEach(async () => {
    previousXdgStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = await plainDir("cls-identity-xdg-");
  });

  afterEach(() => {
    if (previousXdgStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previousXdgStateHome;
    }
  });

  it("persists the established display-name precedence on repository-backed opens", async () => {
    const namedRepo = await gitRepo();
    await writeCqToml(
      namedRepo,
      [
        "[ledger]",
        'backend = "xdg"',
        'projectId = "lower-priority-project-id"',
        "",
        "[project]",
        'name = "Configured Project Name"',
        "",
      ].join("\n"),
    );
    expect((await openAndReadIdentity(namedRepo)).identity).toEqual({
      repositoryPath: await fs.realpath(namedRepo),
      displayName: "Configured Project Name",
    });

    const identifiedRepo = await gitRepo();
    await writeCqToml(
      identifiedRepo,
      ['[ledger]', 'backend = "xdg"', 'projectId = "stable-project-id"', ""].join("\n"),
    );
    expect((await openAndReadIdentity(identifiedRepo)).identity).toEqual({
      repositoryPath: await fs.realpath(identifiedRepo),
      displayName: "stable-project-id",
    });

    const basenameRepo = await gitRepo();
    await writeCqToml(basenameRepo, '[ledger]\nbackend = "xdg"\n');
    const basenameResult = await openAndReadIdentity(basenameRepo);
    expect(basenameResult.identity).toEqual({
      repositoryPath: await fs.realpath(basenameRepo),
      displayName: path.basename(await fs.realpath(basenameRepo)),
    });
    expect(
      resolveDisplayName({
        projectName: null,
        projectId: null,
        repoBasename: "",
        projectKey: basenameResult.projectKey,
      }),
    ).toBe(basenameResult.projectKey);
  });

  it("persists the canonical path and refreshes path plus name after relocation", async () => {
    const repo = await gitRepo();
    await writeCqToml(
      repo,
      '[ledger]\nbackend = "xdg"\n\n[project]\nname = "Original Name"\n',
    );
    const aliasParent = await plainDir("cls-identity-alias-");
    const alias = path.join(aliasParent, "checkout-link");
    await fs.symlink(repo, alias, "dir");

    const first = await openAndReadIdentity(alias);
    expect(first.identity).toEqual({
      repositoryPath: await fs.realpath(repo),
      displayName: "Original Name",
    });

    const movedRepo = `${repo}-moved`;
    dirs.push(movedRepo);
    await fs.rename(repo, movedRepo);
    await fs.unlink(alias);
    await fs.symlink(movedRepo, alias, "dir");
    await writeCqToml(
      movedRepo,
      '[ledger]\nbackend = "xdg"\n\n[project]\nname = "Renamed Project"\n',
    );

    const reopened = await openAndReadIdentity(alias);
    expect(reopened.dbPath).toBe(first.dbPath);
    expect(reopened.identity).toEqual({
      repositoryPath: await fs.realpath(movedRepo),
      displayName: "Renamed Project",
    });
  });

  it("an unchanged reopen commits no additional identity mutation", async () => {
    const repo = await gitRepo();
    await writeCqToml(repo, '[ledger]\nbackend = "xdg"\n');

    const first = await createLedgerStore(repo);
    expect(first.dbPath).toBeDefined();
    expect(readIdentity(first.dbPath!)).toEqual({
      repositoryPath: await fs.realpath(repo),
      displayName: path.basename(await fs.realpath(repo)),
    });
    await first.store.dispose();

    const probe = openLedgerDb(first.dbPath!);
    try {
      const before = dataVersion(probe);
      const reopened = await createLedgerStore(repo);
      try {
        expect(dataVersion(probe)).toBe(before);
      } finally {
        await reopened.store.dispose();
      }
    } finally {
      probe.close();
    }
  });

  it("propagates an identity-write failure after disposing the initialized store", async () => {
    const repo = await gitRepo();
    await writeCqToml(repo, '[ledger]\nbackend = "xdg"\n');
    const writeFailure = new Error("simulated identity write failure");
    const upsertSpy = spyOn(
      SqliteXdgProjectIdentityAccess.prototype,
      "upsertProjectIdentity",
    ).mockImplementation(() => {
      throw writeFailure;
    });
    const disposeSpy = spyOn(SqliteLedgerStore.prototype, "dispose");
    let unexpected: ResolvedLedgerStore | undefined;
    let caught: unknown;
    try {
      try {
        unexpected = await createLedgerStore(repo);
      } catch (error) {
        caught = error;
      }
      if (unexpected !== undefined) await unexpected.store.dispose();
      expect(caught).toBe(writeFailure);
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    } finally {
      upsertSpy.mockRestore();
      disposeSpy.mockRestore();
    }
  });

  it("never writes XDG identity metadata for fs, git-object, remote, or offline Postgres", async () => {
    const upsertSpy = spyOn(
      SqliteXdgProjectIdentityAccess.prototype,
      "upsertProjectIdentity",
    );
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    const savedPgEnv = new Map(PG_ENV_VARS.map((name) => [name, process.env[name]]));
    try {
      const fsRepo = await gitRepo();
      await writeCqToml(fsRepo, '[ledger]\nbackend = "fs"\n');
      const fsResolved = await createLedgerStore(fsRepo);
      expect(fsResolved.store).toBeInstanceOf(FsLedgerStore);
      await fsResolved.store.dispose();

      const gitObjectRepo = await gitRepo();
      await writeCqToml(gitObjectRepo, '[ledger]\nbackend = "git-object"\n');
      const gitResolved = await createLedgerStore(gitObjectRepo);
      expect(gitResolved.store).toBeInstanceOf(GitObjectLedgerBackend);
      await gitResolved.store.dispose();

      const remoteRoot = await plainDir("cls-identity-remote-");
      await writeCqToml(
        remoteRoot,
        '[ledger]\nbackend = "remote"\nserverUrl = "https://ledger.example.test"\n',
      );
      await expect(createLedgerStore(remoteRoot)).rejects.toBeInstanceOf(
        RemoteLedgerClientNotWiredError,
      );

      for (const name of PG_ENV_VARS) delete process.env[name];
      const postgresRepo = await gitRepo();
      await writeCqToml(postgresRepo, '[ledger]\nbackend = "postgres"\n');
      await expect(createLedgerStore(postgresRepo)).rejects.toBeInstanceOf(
        PostgresDsnResolutionError,
      );

      expect(upsertSpy).not.toHaveBeenCalled();
    } finally {
      for (const [name, value] of savedPgEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      stderrSpy.mockRestore();
      upsertSpy.mockRestore();
    }
  });

  describe.skipIf(!PG_URL)("live PostgreSQL exclusion (CQ_TEST_PG_URL)", () => {
    it("does not write XDG identity metadata for a successful PostgreSQL open", async () => {
      const repo = await gitRepo();
      await writeCqToml(repo, '[ledger]\nbackend = "postgres"\n');
      const previousPgUrl = process.env.CQ_LEDGER_PG_URL;
      process.env.CQ_LEDGER_PG_URL = PG_URL;
      const upsertSpy = spyOn(
        SqliteXdgProjectIdentityAccess.prototype,
        "upsertProjectIdentity",
      );
      try {
        const resolved = await createLedgerStore(repo);
        try {
          expect(resolved.store).toBeInstanceOf(PostgresLedgerStore);
          expect(upsertSpy).not.toHaveBeenCalled();
        } finally {
          await resolved.store.dispose();
        }
      } finally {
        if (previousPgUrl === undefined) delete process.env.CQ_LEDGER_PG_URL;
        else process.env.CQ_LEDGER_PG_URL = previousPgUrl;
        upsertSpy.mockRestore();
      }
    });
  });
});
