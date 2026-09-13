/**
 * T1959 — carry workset roots through dumps and destructive lifecycle ops.
 *
 * Proves:
 *  - backup dump exact roots/epoch preservation (sqlite)
 *  - older dumps without a workset section restore as unrestricted empty
 *  - SQLite backup-before-clear + explicit empty live roots
 *  - SQLite divergence artifact retains roots; live starts empty
 *  - restore waits for in-flight brokered effects (sqlite)
 *  - reset waits for / races set under exclusive admission (sqlite)
 *  - guarded-context denial with zero store access
 *  - peer snapshot observes restored/cleared roots after restore
 */

import { afterAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, mkdir } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  SqliteLedgerStore,
  WorksetAdmissionError,
  WORKSET_ROOTS_FILENAME,
  buildBackupDump,
  createInMemoryWorksetStore,
  createTrustedWorksetManagementAuthority,
  parseBackupDump,
  parseWorksetRootsDocument,
  restoreDumpToXdg,
  serializeRegistry,
  serializeWorksetRootsDocument,
  CANONICAL_LEDGERS,
  GOALS_LEDGER,
  type BackupDumpFile,
} from "../src/index.js";
import { injectSqliteSchemaDivergence, sqliteDivergenceBackupPath } from "./sqliteSchemaFixture.js";

const dirs: string[] = [];
const exec = promisify(execFile);
afterAll(async () => {
  for (const d of dirs) {
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("workset root lifecycle [T1959]", () => {
  it("buildBackupDump preserves ordered roots + epoch exactly (sqlite)", async () => {
    const root = await tmp("wrl-dump-");
    const dbPath = path.join(root, "ledger.db");
    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    try {
      const roots = ["goals:G-alpha", "tasks:T-beta"];
      const snap = await store.worksetStore().setRoots(roots);
      expect(snap.roots).toEqual(roots);
      expect(snap.epoch).toBe(1);

      const dump = await buildBackupDump(store, null);
      const entry = dump.find((f) => f.path === WORKSET_ROOTS_FILENAME);
      expect(entry).toBeDefined();
      const parsed = parseWorksetRootsDocument(entry!.content);
      expect(parsed).toEqual({ roots, epoch: 1 });
      expect(parseBackupDump(dump).worksetRoots).toEqual({ roots, epoch: 1 });
    } finally {
      await store.dispose();
    }
  });

  it("restore round-trips roots/epoch; missing section → unrestricted empty", async () => {
    const root = await tmp("wrl-restore-");
    const srcPath = path.join(root, "src.db");
    const dstPath = path.join(root, "dst.db");

    const src = new SqliteLedgerStore({ dbPath: srcPath });
    await src.init();
    const roots = ["milestones:M1", "goals:G1"];
    await src.worksetStore().setRoots(roots);
    const dump = await buildBackupDump(src, null);
    await src.dispose();

    await restoreDumpToXdg({
      dbPath: dstPath,
      logsDir: null,
      dump,
      authority: createTrustedWorksetManagementAuthority(),
      overwriteAuthorized: false,
    });
    const dst = new SqliteLedgerStore({ dbPath: dstPath });
    await dst.init();
    try {
      expect(await dst.worksetStore().snapshot()).toEqual({ roots, epoch: 1 });
    } finally {
      await dst.dispose();
    }

    // Older dump without workset section → unrestricted empty.
    const legacy = dump.filter((f) => f.path !== WORKSET_ROOTS_FILENAME);
    expect(parseBackupDump(legacy).worksetRoots).toBeNull();
    const legacyDst = path.join(root, "legacy.db");
    await restoreDumpToXdg({
      dbPath: legacyDst,
      logsDir: null,
      dump: legacy,
      authority: createTrustedWorksetManagementAuthority(),
      overwriteAuthorized: false,
    });
    const legacyStore = new SqliteLedgerStore({ dbPath: legacyDst });
    await legacyStore.init();
    try {
      expect(await legacyStore.worksetStore().snapshot()).toEqual({ roots: [], epoch: 0 });
    } finally {
      await legacyStore.dispose();
    }
  });

  it("guarded-context denial performs zero store access", async () => {
    const root = await tmp("wrl-deny-");
    const dbPath = path.join(root, "never-opened.db");
    const dump: BackupDumpFile[] = [
      {
        path: "ledgers.yaml",
        content: serializeRegistry({
          version: 1,
          ledgers: CANONICAL_LEDGERS.map((c) => ({ name: c.name, schema: c.schema })),
        }),
      },
    ];
    // Incomplete dump would fail parse AFTER authority — but forged authority
    // must fail first, so the db file is never created.
    try {
      await restoreDumpToXdg({
        dbPath,
        logsDir: null,
        dump,
        authority: { forged: true },
        overwriteAuthorized: false,
      });
      throw new Error("expected WorksetAdmissionError");
    } catch (e) {
      expect(e).toBeInstanceOf(WorksetAdmissionError);
      expect((e as WorksetAdmissionError).code).toBe("management-authority-required");
    }
    await expect(stat(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restore waits for an in-flight brokered effect before the destructive phase", async () => {
    const root = await tmp("wrl-race-restore-");
    const dbPath = path.join(root, "ledger.db");
    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    try {
      await store.worksetStore().setRoots(["goals:G-live"]);
      const effect = await store.worksetStore().admitExternalEffect({
        kind: "child-dispatch",
        targetRef: "goals:G-live",
      });
      await Promise.resolve(effect.registerProcessGroup({ pgid: 42, leaderPid: 42 }));

      const dump = await buildBackupDump(store, null);
      // Strip workset so restore writes unrestricted empty — proves wipe ran.
      const dumpEmptyRoots = dump.map((f) =>
        f.path === WORKSET_ROOTS_FILENAME
          ? { path: f.path, content: serializeWorksetRootsDocument({ roots: [], epoch: 0 }) }
          : f,
      );

      let destructiveRan = false;
      const beforeDestructive = deferred();
      // Second connection: restore must wait for the durable admission row.
      const restorePromise = (async () => {
        // Poll until exclusive is observed held isn't needed — restore's own
        // exclusive waits for admissions to drain.
        await restoreDumpToXdg({
          dbPath,
          logsDir: null,
          dump: dumpEmptyRoots,
          authority: createTrustedWorksetManagementAuthority(),
          overwriteAuthorized: true,
        });
        destructiveRan = true;
        beforeDestructive.resolve();
      })();

      await Promise.resolve();
      expect(destructiveRan).toBe(false);

      effect.markSettled();
      await Promise.resolve();
      expect(destructiveRan).toBe(false);

      await effect.releaseAfterSettlement();
      await beforeDestructive.promise;
      await restorePromise;
      expect(destructiveRan).toBe(true);

      // Peer (this store) observes cleared roots after restore wrote via second conn.
      expect(await store.worksetStore().snapshot()).toEqual({ roots: [], epoch: 0 });
    } finally {
      await store.dispose();
    }
  });

  it("restore holds administrative exclusion through filesystem log import", async () => {
    const root = await tmp("wrl-race-restore-logs-");
    const dbPath = path.join(root, "ledger.db");
    const logsDir = path.join(root, "logs");
    const fifoPath = path.join(logsDir, "raw", "blocked.md");
    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    try {
      const dump = [
        ...(await buildBackupDump(store, null)),
        { path: "logs/raw/blocked.md", content: "blocked log\n" },
      ];
      await mkdir(path.dirname(fifoPath), { recursive: true });
      await exec("mkfifo", [fifoPath]);

      const restorePromise = restoreDumpToXdg({
        dbPath,
        logsDir,
        dump,
        authority: createTrustedWorksetManagementAuthority(),
        overwriteAuthorized: false,
      });
      await Bun.sleep(50);

      let admittedBeforeLogFinished = false;
      let logFinished = false;
      const effectPromise = store
        .worksetStore()
        .admitExternalEffect({
          kind: "child-dispatch",
          targetRef: "goals:G-after-restore",
        })
        .then((effect) => {
          if (!logFinished) admittedBeforeLogFinished = true;
          return { effect };
        }, (error: unknown) => ({ error }));
      await Bun.sleep(50);

      const readPromise = readFile(fifoPath, "utf8");
      await restorePromise;
      expect(await readPromise).toBe("blocked log\n");
      logFinished = true;
      const effectResult = await effectPromise;
      if ("effect" in effectResult) {
        await Promise.resolve(
          effectResult.effect.registerProcessGroup({
            pgid: process.pid,
            leaderPid: process.pid,
          }),
        );
        await Promise.resolve(effectResult.effect.markSettled());
        await effectResult.effect.releaseAfterSettlement();
      }
      expect(admittedBeforeLogFinished).toBe(false);
    } finally {
      await store.dispose();
    }
  });

  it("reset-versus-set: exclusive reset blocks concurrent setRoots until completion", async () => {
    const root = await tmp("wrl-race-reset-");
    const store = new SqliteLedgerStore({ dbPath: path.join(root, "ledger.db") });
    await store.init();
    try {
      const ws = store.worksetStore();
      await ws.setRoots(["goals:G-keep"]);
      const entered = deferred();
      const release = deferred();

      const resetPromise = ws.runAdministrative({
        kind: "reset",
        authority: createTrustedWorksetManagementAuthority(),
        destructivePhase: async () => {
          entered.resolve();
          await release.promise;
          expect(ws.exclusiveHeld()).toBe(true);
          expect(ws.activeAdmissionCount()).toBe(0);
        },
      });

      await entered.promise;
      expect(ws.exclusiveHeld()).toBe(true);

      const setPromise = ws.setRoots(["goals:G-other"]);
      let setDone = false;
      void setPromise.then(
        () => {
          setDone = true;
        },
        () => undefined,
      );
      await Promise.resolve();
      expect(setDone).toBe(false);

      release.resolve();
      await resetPromise;
      // set may complete only after exclusive releases — never mid-destruction.
      await setPromise.catch(() => undefined);
      expect(ws.exclusiveHeld()).toBe(false);
    } finally {
      await store.dispose();
    }
  });

  it("in-memory admin denial never reaches destructive phase (parity with t3)", async () => {
    const c = createInMemoryWorksetStore();
    await c.setRoots(["goals:G1"]);
    let ran = false;
    try {
      await c.runAdministrative({
        kind: "restore",
        authority: { not: "trusted" },
        destructivePhase: () => {
          ran = true;
        },
      });
      throw new Error("expected denial");
    } catch (e) {
      expect(e).toBeInstanceOf(WorksetAdmissionError);
      expect((e as WorksetAdmissionError).code).toBe("management-authority-required");
    }
    expect(ran).toBe(false);
    expect(await c.snapshot()).toEqual({ roots: ["goals:G1"], epoch: 1 });
  });

  for (const epoch of [1, 3]) {
    it(`SQLite reinitialization retains ordered backup roots at epoch ${epoch} and clears live roots`, async () => {
      const root = await tmp("wrl-sqlite-reinit-");
      const dbPath = path.join(root, "ledger.db");
      const timestamp = "2026-08-10T12:00:00.000Z";
      const roots = ["goals:G-prior", "tasks:T-prior"];
      const source = new SqliteLedgerStore({ dbPath });
      await source.init();
      try {
        for (let index = 0; index < epoch; index += 1) await source.worksetStore().setRoots(roots);
        expect(await source.worksetStore().snapshot()).toEqual({ roots, epoch });
      } finally {
        await source.dispose();
      }
      injectSqliteSchemaDivergence(dbPath);
      const store = new SqliteLedgerStore({
        dbPath,
        now: () => timestamp,
        onSchemaDivergence: "backup-reinit",
        allowDestructiveReinitOfPopulatedStore: true,
        worksetAuthority: createTrustedWorksetManagementAuthority(),
      });
      try {
        await store.init();
        const backup = new Database(sqliteDivergenceBackupPath(dbPath, timestamp), { readonly: true });
        try {
          const row = backup.query<{ roots_json: string; epoch: number }, []>(
            "SELECT roots_json, epoch FROM workset_state WHERE id = 1",
          ).get();
          if (row === null) throw new Error("backed-up root state missing");
          expect({ roots: JSON.parse(row.roots_json), epoch: row.epoch }).toEqual({ roots, epoch });
        } finally {
          backup.close();
        }
        expect(await store.worksetStore().snapshot()).toEqual({ roots: [], epoch: 0 });
      } finally {
        await store.dispose();
      }
    });
  }

  it("SQLite backup export rejects malformed roots instead of silently dropping members", async () => {
    const root = await tmp("wrl-sqlite-invalid-backup-");
    const dbPath = path.join(root, "ledger.db");
    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    const malformed = JSON.stringify(["goals:G-valid", 42]);
    try {
      const fixture = new Database(dbPath, { readwrite: true, create: false });
      try {
        fixture.query("UPDATE workset_state SET roots_json = ?, epoch = 1 WHERE id = 1").run(malformed);
      } finally {
        fixture.close();
      }
      await expect(buildBackupDump(store, null)).rejects.toThrow("workset_state.roots_json must be a JSON string array");
      const unchanged = new Database(dbPath, { readonly: true });
      try {
        expect(unchanged.query("SELECT roots_json, epoch FROM workset_state WHERE id = 1").get()).toEqual({
          roots_json: malformed, epoch: 1,
        });
      } finally {
        unchanged.close();
      }
    } finally {
      await store.dispose();
    }
  });

  it("SQLite divergence backup begins only after administrative exclusion", async () => {
    const root = await tmp("wrl-sqlite-div-");
    const dbPath = path.join(root, "ledger.db");
    const timestamp = "2026-08-10T14:00:00.000Z";
    const backupPath = path.join(root, "ledger.backup-2026-08-10T14-00-00.000Z.db");
    const seed = new SqliteLedgerStore({ dbPath });
    await seed.init();
    await seed.worksetStore().setRoots(["goals:G-sqlite-div"]);
    await seed.dispose();

    const db = new Database(dbPath);
    const row = db
      .query("SELECT schema_json FROM ledgers WHERE name = ?")
      .get(GOALS_LEDGER) as { schema_json: string };
    const schema = JSON.parse(row.schema_json) as { statusValues: string[] };
    schema.statusValues.push("divergent-status");
    db.query("UPDATE ledgers SET schema_json = ? WHERE name = ?").run(
      JSON.stringify(schema),
      GOALS_LEDGER,
    );
    db.close();

    let administrativeBoundaryReached = false;
    let backupExistedBeforeDestructive = false;
    const store = new SqliteLedgerStore({
      dbPath,
      now: () => timestamp,
      onSchemaDivergence: "backup-reinit",
      allowDestructiveReinitOfPopulatedStore: true,
      worksetAuthority: createTrustedWorksetManagementAuthority(),
      workset: {
        hooks: {
          beforeAdministrativeDestructive: async () => {
            administrativeBoundaryReached = true;
            backupExistedBeforeDestructive = await stat(backupPath).then(
              () => true,
              () => false,
            );
          },
        },
      },
    });
    await store.init();
    try {
      expect(administrativeBoundaryReached).toBe(true);
      expect(backupExistedBeforeDestructive).toBe(false);
      const backup = new Database(backupPath, { readonly: true });
      const rootsRow = backup
        .query("SELECT roots_json, epoch FROM workset_state WHERE id = 1")
        .get() as { roots_json: string; epoch: number };
      backup.close();
      expect(JSON.parse(rootsRow.roots_json)).toEqual(["goals:G-sqlite-div"]);
      expect(rootsRow.epoch).toBe(1);
      expect(await store.worksetStore().snapshot()).toEqual({ roots: [], epoch: 0 });
    } finally {
      await store.dispose();
    }
  });
});
