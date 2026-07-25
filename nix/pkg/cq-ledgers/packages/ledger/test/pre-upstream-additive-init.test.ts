/**
 * T796 — stores created before the canonical `upstream` ledger existed gain it
 * additively on their next init. The shared assertions are Behavioral-Active
 * Blackbox; backend fixtures use the narrowest available persistence seam to
 * construct and compare the previous-release state.
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  buildBackupDump,
  CANONICAL_LEDGERS,
  FsLedgerStore,
  GitObjectLedgerBackend,
  GitPlumbing,
  GOALS_LEDGER,
  InMemoryLedgerStore,
  LEDGER_STORAGE_DIRNAME,
  ledgerTreePaths,
  parseRegistry,
  PostgresLedgerStore,
  removeLedgerArtifacts,
  restoreDumpToXdg,
  serializeRegistry,
  SqliteLedgerStore,
  TASKS_LEDGER,
  UPSTREAM_LEDGER,
  UPSTREAM_SCHEMA,
  type FetchedLedger,
  type LedgerStore,
} from "../src/index.js";
import { openPgPool } from "../src/store/postgres/connection.js";
import { ensureSchema as ensurePostgresSchema } from "../src/store/postgres/schema.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";

const exec = promisify(execFile);
const FIXED_NOW = "2026-07-25T06:00:00.000Z";
const now = (): string => FIXED_NOW;
const GIT_REF = "refs/heads/cq-ledger";
const PG_URL = process.env.CQ_TEST_PG_URL;

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const PRE_UPSTREAM_CANONICAL = CANONICAL_LEDGERS.filter(({ name }) => name !== UPSTREAM_LEDGER);
const PRE_UPSTREAM_NAMES = PRE_UPSTREAM_CANONICAL.map(({ name }) => name).sort();
const CURRENT_NAMES = CANONICAL_LEDGERS.map(({ name }) => name).sort();

type PublicSnapshot = Record<string, FetchedLedger>;

function publicSnapshot(store: LedgerStore, names: readonly string[]): PublicSnapshot {
  return Object.fromEntries(names.map((name) => [name, structuredClone(store.fetch(name))]));
}

async function seedPriorState(store: LedgerStore): Promise<PublicSnapshot> {
  const milestone = await store.createMilestone({
    title: "pre-upstream milestone",
  });
  await store.createItem(GOALS_LEDGER, milestone.id, {
    status: "clarifying",
    fields: {
      title: "pre-upstream goal",
      description: "must survive additive canonical-ledger initialization",
    },
    author: "t796",
    session: "pre-upstream",
  });
  await store.createItem(TASKS_LEDGER, milestone.id, {
    status: "planned",
    fields: {
      headline: "pre-upstream task",
      description: "must preserve its item counter and bytes",
    },
    author: "t796",
    session: "pre-upstream",
  });
  return publicSnapshot(store, PRE_UPSTREAM_NAMES);
}

function assertAdditivePublicState(store: LedgerStore, expectedPriorState: PublicSnapshot): void {
  expect(store.enumerate()).toEqual(CURRENT_NAMES);
  expect(publicSnapshot(store, PRE_UPSTREAM_NAMES)).toEqual(expectedPriorState);

  const upstream = store.fetch(UPSTREAM_LEDGER);
  expect(upstream.schema).toEqual(UPSTREAM_SCHEMA);
  expect(upstream.counters).toEqual({ milestone: 0, item: 0 });
  expect(upstream.milestones).toEqual([]);
  expect(upstream.archivePointers).toEqual([]);
}

interface PersistentFixture {
  readonly expectedPriorState: PublicSnapshot;
  open(): LedgerStore;
  capturePriorRawState(): Promise<string>;
  captureCompleteRawState(): Promise<string>;
  assertNoDivergenceBackup(): Promise<void>;
}

async function runPersistentContract(fixture: PersistentFixture): Promise<void> {
  const rawBefore = await fixture.capturePriorRawState();

  const first = fixture.open();
  await first.init();
  try {
    assertAdditivePublicState(first, fixture.expectedPriorState);
  } finally {
    await first.dispose();
  }

  expect(await fixture.capturePriorRawState()).toBe(rawBefore);
  await fixture.assertNoDivergenceBackup();
  const completeAfterFirst = await fixture.captureCompleteRawState();

  const second = fixture.open();
  await second.init();
  try {
    assertAdditivePublicState(second, fixture.expectedPriorState);
  } finally {
    await second.dispose();
  }

  expect(await fixture.captureCompleteRawState()).toBe(completeAfterFirst);
  await fixture.assertNoDivergenceBackup();
}

async function freshRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function captureFileSet(storageDir: string, names: readonly string[]): Promise<string> {
  const registry = parseRegistry(await readFile(path.join(storageDir, "ledgers.yaml"), "utf8"));
  const registryEntries = registry.ledgers.filter(({ name }) => names.includes(name));
  const ledgers = await Promise.all(
    names.map(async (name) => [
      `${name}.md`,
      await readFile(path.join(storageDir, `${name}.md`), "utf8"),
    ]),
  );
  return JSON.stringify({ registryEntries, ledgers });
}

async function capturePortableFileSet(storageDir: string): Promise<string> {
  const files = await ledgerTreePaths(storageDir);
  const contents = await Promise.all(
    files.map(async (file) => [file, await readFile(path.join(storageDir, file), "utf8")]),
  );
  return JSON.stringify(contents);
}

async function prepareFsFixture(): Promise<PersistentFixture & { root: string }> {
  const root = await freshRoot("t796-fs-");
  const storageDir = path.join(root, LEDGER_STORAGE_DIRNAME);
  const seeded = new FsLedgerStore({ root, now });
  await seeded.init();
  const expectedPriorState = await seedPriorState(seeded);
  await seeded.dispose();

  const registryPath = path.join(storageDir, "ledgers.yaml");
  const registry = parseRegistry(await readFile(registryPath, "utf8"));
  await writeFile(
    registryPath,
    serializeRegistry({
      version: registry.version,
      ledgers: registry.ledgers.filter(({ name }) => name !== UPSTREAM_LEDGER),
    }),
    "utf8",
  );
  await rm(path.join(storageDir, `${UPSTREAM_LEDGER}.md`));

  expect(
    parseRegistry(await readFile(registryPath, "utf8"))
      .ledgers.map(({ name }) => name)
      .sort(),
  ).toEqual(PRE_UPSTREAM_NAMES);

  return {
    root,
    expectedPriorState,
    open: () => new FsLedgerStore({ root, now }),
    capturePriorRawState: () => captureFileSet(storageDir, PRE_UPSTREAM_NAMES),
    captureCompleteRawState: () => capturePortableFileSet(storageDir),
    async assertNoDivergenceBackup() {
      await expect(stat(path.join(storageDir, ".backup"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  };
}

async function initGitRepository(): Promise<string> {
  const root = await freshRoot("t796-git-");
  await exec("git", ["init", "-q", root], { encoding: "utf8" });
  return root;
}

async function captureGitState(git: GitPlumbing, includeUpstream: boolean): Promise<string> {
  const registry = parseRegistry(await git.catFile(GIT_REF, "ledgers.yaml"));
  const registryEntries = registry.ledgers.filter(
    ({ name }) => includeUpstream || name !== UPSTREAM_LEDGER,
  );
  const paths = (await git.lsTree(GIT_REF))
    .filter((entry) => entry !== "ledgers.yaml")
    .filter((entry) => includeUpstream || entry !== `${UPSTREAM_LEDGER}.md`)
    .sort();
  const contents = await Promise.all(
    paths.map(async (entry) => [entry, await git.catFile(GIT_REF, entry)]),
  );
  const ref = includeUpstream ? await git.readRef(GIT_REF) : null;
  return JSON.stringify({ registryEntries, contents, ref });
}

async function prepareGitFixture(): Promise<PersistentFixture> {
  const root = await initGitRepository();
  const git = GitPlumbing.withCwd(root, path.join(root, ".git"));
  const seeded = new GitObjectLedgerBackend({ repoRoot: root, now });
  await seeded.init();
  const expectedPriorState = await seedPriorState(seeded);
  await seeded.dispose();

  const parent = await git.readRef(GIT_REF);
  if (parent === null) throw new Error("expected seeded cq-ledger ref");
  const registry = parseRegistry(await git.catFile(GIT_REF, "ledgers.yaml"));
  const registryBlob = await git.hashObject(
    serializeRegistry({
      version: registry.version,
      ledgers: registry.ledgers.filter(({ name }) => name !== UPSTREAM_LEDGER),
    }),
  );
  const entries = (await git.lsTreeEntries(GIT_REF)).filter(
    ({ path: entry }) => entry !== "ledgers.yaml" && entry !== `${UPSTREAM_LEDGER}.md`,
  );
  entries.push({ mode: "100644", sha: registryBlob, path: "ledgers.yaml" });
  const tree = await git.writeTree(entries);
  const commit = await git.commitTree(tree, parent, "fixture: pre-upstream store");
  await git.updateRef(GIT_REF, commit, parent);

  expect(
    parseRegistry(await git.catFile(GIT_REF, "ledgers.yaml"))
      .ledgers.map(({ name }) => name)
      .sort(),
  ).toEqual(PRE_UPSTREAM_NAMES);

  return {
    expectedPriorState,
    open: () => new GitObjectLedgerBackend({ repoRoot: root, now }),
    capturePriorRawState: () => captureGitState(git, false),
    captureCompleteRawState: () => captureGitState(git, true),
    async assertNoDivergenceBackup() {
      const { stdout } = await exec(
        "git",
        ["for-each-ref", "--format=%(refname)", "refs/tags/cq-ledger-backup-"],
        { cwd: root, encoding: "utf8" },
      );
      expect(stdout.trim()).toBe("");
    },
  };
}

const SQLITE_TABLES = ["groups", "items", "archive_pointers", "archived_items", "meta"] as const;

function captureSqliteState(dbPath: string, includeUpstream: boolean): string {
  const db = openLedgerDb(dbPath);
  try {
    const ledgers = includeUpstream
      ? db
          .query(
            "SELECT name, schema_json, milestone_counter, item_counter FROM ledgers ORDER BY name",
          )
          .all()
      : db
          .query(
            "SELECT name, schema_json, milestone_counter, item_counter FROM ledgers WHERE name <> ? ORDER BY name",
          )
          .all(UPSTREAM_LEDGER);
    const tables = Object.fromEntries(
      SQLITE_TABLES.map((table) => [
        table,
        db.query(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
    return JSON.stringify({ ledgers, tables });
  } finally {
    db.close();
  }
}

async function prepareSqliteFixture(): Promise<PersistentFixture> {
  const root = await freshRoot("t796-sqlite-");
  const dbPath = path.join(root, "ledger.db");
  const seeded = new SqliteLedgerStore({ dbPath, now });
  await seeded.init();
  const expectedPriorState = await seedPriorState(seeded);
  await seeded.dispose();

  const db = openLedgerDb(dbPath);
  try {
    db.query("DELETE FROM ledgers WHERE name = ?").run(UPSTREAM_LEDGER);
    const names = (
      db.query("SELECT name FROM ledgers ORDER BY name").all() as Array<{ name: string }>
    ).map(({ name }) => name);
    expect(names).toEqual(PRE_UPSTREAM_NAMES);
  } finally {
    db.close();
  }

  return {
    expectedPriorState,
    open: () => new SqliteLedgerStore({ dbPath, now }),
    capturePriorRawState: async () => captureSqliteState(dbPath, false),
    captureCompleteRawState: async () => captureSqliteState(dbPath, true),
    async assertNoDivergenceBackup() {
      expect((await readdir(root)).filter((name) => name.includes(".backup-"))).toEqual([]);
    },
  };
}

async function capturePostgresState(
  pool: SQL,
  projectKey: string,
  includeUpstream: boolean,
): Promise<string> {
  const projects = await pool<Array<Record<string, unknown>>>`
    SELECT project_key, display_name, created_at::text, updated_at::text
    FROM projects WHERE project_key = ${projectKey}
  `;
  const ledgers = includeUpstream
    ? await pool<Array<Record<string, unknown>>>`
        SELECT name, schema_json, milestone_counter, item_counter
        FROM ledgers WHERE project_key = ${projectKey} ORDER BY name
      `
    : await pool<Array<Record<string, unknown>>>`
        SELECT name, schema_json, milestone_counter, item_counter
        FROM ledgers
        WHERE project_key = ${projectKey} AND name <> ${UPSTREAM_LEDGER}
        ORDER BY name
      `;
  const groups = await pool<Array<Record<string, unknown>>>`
    SELECT seq::text, ledger, id, title, description
    FROM groups WHERE project_key = ${projectKey} ORDER BY seq
  `;
  const items = await pool<Array<Record<string, unknown>>>`
    SELECT seq::text, ledger, id, milestone_id, status, fields_json,
           created_at, updated_at, author, session
    FROM items WHERE project_key = ${projectKey} ORDER BY seq
  `;
  const pointers = await pool<Array<Record<string, unknown>>>`
    SELECT seq::text, ledger, id, summary, title, status, archived_at
    FROM archive_pointers WHERE project_key = ${projectKey} ORDER BY seq
  `;
  const archived = await pool<Array<Record<string, unknown>>>`
    SELECT seq::text, ledger, pointer_id, id, milestone_id, status, fields_json,
           created_at, updated_at, author, session
    FROM archived_items WHERE project_key = ${projectKey} ORDER BY seq
  `;
  const logs = await pool<Array<Record<string, unknown>>>`
    SELECT path, content, created_at::text
    FROM logs WHERE project_key = ${projectKey} ORDER BY path
  `;
  return JSON.stringify({ projects, ledgers, groups, items, pointers, archived, logs });
}

async function preparePostgresFixture(
  setupPool: SQL,
  postgresUrl: string,
): Promise<PersistentFixture> {
  await ensurePostgresSchema(setupPool);
  const projectKey = `t796-${randomUUID()}`;
  const seeded = new PostgresLedgerStore({
    pool: openPgPool(postgresUrl),
    projectKey,
    displayName: projectKey,
    now,
  });
  await seeded.init();
  const expectedPriorState = await seedPriorState(seeded);
  await seeded.dispose();

  await setupPool`
    DELETE FROM ledgers
    WHERE project_key = ${projectKey} AND name = ${UPSTREAM_LEDGER}
  `;
  const names = await setupPool<Array<{ name: string }>>`
    SELECT name FROM ledgers WHERE project_key = ${projectKey} ORDER BY name
  `;
  expect(names.map(({ name }) => name)).toEqual(PRE_UPSTREAM_NAMES);

  return {
    expectedPriorState,
    open: () =>
      new PostgresLedgerStore({
        pool: openPgPool(postgresUrl),
        projectKey,
        displayName: projectKey,
        now,
      }),
    capturePriorRawState: () => capturePostgresState(setupPool, projectKey, false),
    captureCompleteRawState: () => capturePostgresState(setupPool, projectKey, true),
    async assertNoDivergenceBackup() {
      const shadows = await setupPool<Array<{ project_key: string }>>`
        SELECT project_key FROM projects
        WHERE project_key LIKE ${`${projectKey}__divergence-backup-%`}
      `;
      expect(shadows).toEqual([]);
    },
  };
}

describe("pre-upstream canonical-ledger initialization", () => {
  test("FsLedgerStore adds only an empty upstream ledger and a second init is idempotent", async () => {
    await runPersistentContract(await prepareFsFixture());
  });

  test("GitObjectLedgerBackend adds only an empty upstream ledger without a divergence tag", async () => {
    await runPersistentContract(await prepareGitFixture());
  }, 30_000);

  test("SqliteLedgerStore adds only an empty upstream row transactionally", async () => {
    await runPersistentContract(await prepareSqliteFixture());
  });

  test("InMemoryLedgerStore applies the same missing-ledger contract", async () => {
    const store = new InMemoryLedgerStore({ now });
    await store.init();
    const expectedPriorState = await seedPriorState(store);

    const fixtureState = store as unknown as {
      ledgers: Map<string, unknown>;
      initialised: boolean;
    };
    const priorBytes = JSON.stringify(expectedPriorState);
    fixtureState.ledgers.delete(UPSTREAM_LEDGER);
    fixtureState.initialised = false;
    expect(fixtureState.ledgers.has(UPSTREAM_LEDGER)).toBe(false);

    await store.init();
    assertAdditivePublicState(store, expectedPriorState);
    expect(JSON.stringify(publicSnapshot(store, PRE_UPSTREAM_NAMES))).toBe(priorBytes);
    const afterFirst = JSON.stringify(publicSnapshot(store, CURRENT_NAMES));

    await store.init();
    assertAdditivePublicState(store, expectedPriorState);
    expect(JSON.stringify(publicSnapshot(store, CURRENT_NAMES))).toBe(afterFirst);
    await store.dispose();
  });
});

describe.skipIf(!PG_URL)("pre-upstream PostgreSQL tenant initialization", () => {
  const setupPool = PG_URL === undefined ? undefined : openPgPool(PG_URL);

  afterAll(async () => {
    await setupPool?.close();
  });

  test("PostgresLedgerStore adds only an empty tenant-scoped upstream row", async () => {
    await runPersistentContract(await preparePostgresFixture(setupPool!, PG_URL!));
  }, 30_000);
});

describe("pre-upstream lifecycle acceptance states", () => {
  test("portable backup and XDG restore round-trip the upgraded upstream schema", async () => {
    const fixture = await prepareFsFixture();
    const source = fixture.open();
    await source.init();
    assertAdditivePublicState(source, fixture.expectedPriorState);
    const expected = publicSnapshot(source, CURRENT_NAMES);
    const dump = await buildBackupDump(source, null);
    await source.dispose();

    const registryFile = dump.find(({ path: file }) => file === "ledgers.yaml");
    if (registryFile === undefined) {
      throw new Error("Portable backup omitted ledgers.yaml");
    }
    const dumpedRegistry = parseRegistry(registryFile.content);
    expect(dumpedRegistry.ledgers).toContainEqual(
      expect.objectContaining({ name: UPSTREAM_LEDGER, schema: UPSTREAM_SCHEMA }),
    );
    expect(dump.map(({ path: file }) => file)).toContain(`${UPSTREAM_LEDGER}.md`);

    const destinationRoot = await freshRoot("t796-restore-");
    const dbPath = path.join(destinationRoot, "ledger.db");
    await restoreDumpToXdg({ dbPath, logsDir: null, dump });
    const restored = new SqliteLedgerStore({ dbPath, now });
    await restored.init();
    try {
      expect(publicSnapshot(restored, CURRENT_NAMES)).toEqual(expected);
      const next = await restored.createItem(UPSTREAM_LEDGER, "M1", {
        status: "open",
        fields: {
          headline: "post-restore upstream report",
          package: "@cq/example",
        },
      });
      expect(next.id).toBe("U1");
    } finally {
      await restored.dispose();
    }
  });

  test("reset retains empty upstream canon and erase removes its artifact", async () => {
    const fixture = await prepareFsFixture();
    const store = fixture.open();
    await store.init();
    await store.createItem(UPSTREAM_LEDGER, "M1", {
      status: "open",
      fields: {
        headline: "reset target",
        package: "@cq/example",
      },
    });

    if (!(store instanceof FsLedgerStore)) {
      throw new Error("expected FsLedgerStore fixture");
    }
    const summary = await store.reset();
    expect(summary.ledgers).toContainEqual(
      expect.objectContaining({ name: UPSTREAM_LEDGER, itemCount: 1 }),
    );
    expect(store.enumerate()).toEqual(CURRENT_NAMES);
    expect(store.fetch(UPSTREAM_LEDGER).counters).toEqual({ milestone: 0, item: 0 });
    expect(store.fetch(UPSTREAM_LEDGER).milestones).toEqual([]);
    await store.dispose();

    const storageDir = path.join(fixture.root, LEDGER_STORAGE_DIRNAME);
    expect(await readFile(path.join(summary.backupDir, `${UPSTREAM_LEDGER}.md`), "utf8")).toContain(
      "# upstream",
    );
    const erased = await removeLedgerArtifacts(storageDir);
    expect(erased.removed.some((entry) => entry.endsWith(`${UPSTREAM_LEDGER}.md`))).toBe(true);
    await expect(stat(storageDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(fixture.root)).sort()).toEqual([]);
  });
});
