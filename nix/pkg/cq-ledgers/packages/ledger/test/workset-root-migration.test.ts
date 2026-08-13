import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBackupDump,
  createPostgresWorksetStore,
  ensureSchema,
  InMemoryLedgerStore,
  isPostgresTenantEmpty,
  isXdgPrimaryEmpty,
  createTrustedWorksetManagementAuthority,
  openPgPool,
  restoreDumpToPostgres,
  RestoreTargetChangedError,
  SqliteLedgerStore,
  TASKS_LEDGER,
} from "../src/index.js";

describe("workset root migration target guards [T1960]", () => {
  it("treats an otherwise-bootstrap SQLite target with roots as non-empty", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "cq-t1960-xdg-target-")), "ledger.db");
    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    expect(await isXdgPrimaryEmpty(store)).toBe(true);
    await store.worksetStore().setRoots(["goals:G-root"]);
    expect(await isXdgPrimaryEmpty(store)).toBe(false);
    await store.dispose();
  });
});

const pgUrl = process.env["CQ_TEST_PG_URL"];
const pgPool = pgUrl === undefined ? undefined : openPgPool(pgUrl);

describe.skipIf(pgPool === undefined)(
  "workset root migration PostgreSQL target guard [T1960]",
  () => {
    afterAll(async () => {
      await pgPool?.close();
    });

    it("treats a tenant carrying only roots as non-empty", async () => {
      if (pgPool === undefined) throw new Error("fixture: PostgreSQL pool missing");
      await ensureSchema(pgPool);
      const projectKey = `t1960_target_${crypto.randomUUID().replaceAll("-", "")}`;
      await pgPool`
      INSERT INTO projects (project_key, display_name) VALUES (${projectKey}, ${projectKey})
    `;
      await pgPool`
      INSERT INTO workset_roots (project_key, roots_json, epoch, admit_generation, updated_at)
      VALUES (${projectKey}, ${JSON.stringify(["tasks:T-root"])}, 3, 0, ${new Date().toISOString()})
    `;
      expect(await isPostgresTenantEmpty(pgPool, projectKey)).toBe(false);
    });

    it("treats a bootstrap root row with epoch zero as empty", async () => {
      if (pgPool === undefined) throw new Error("fixture: PostgreSQL pool missing");
      await ensureSchema(pgPool);
      const projectKey = `t1960_empty_${crypto.randomUUID().replaceAll("-", "")}`;
      await pgPool`
        INSERT INTO projects (project_key, display_name) VALUES (${projectKey}, ${projectKey})
      `;
      await pgPool`
        INSERT INTO workset_roots (project_key, roots_json, epoch, admit_generation, updated_at)
        VALUES (${projectKey}, ${"[]"}, 0, 0, ${new Date().toISOString()})
      `;
      expect(await isPostgresTenantEmpty(pgPool, projectKey)).toBe(true);
    });

    it("refuses a tenant mutation that commits after the initial emptiness check", async () => {
      if (pgPool === undefined) throw new Error("fixture: PostgreSQL pool missing");
      await ensureSchema(pgPool);
      const projectKey = `t1960_race_${crypto.randomUUID().replaceAll("-", "")}`;
      await pgPool`
        INSERT INTO projects (project_key, display_name) VALUES (${projectKey}, ${projectKey})
      `;
      await pgPool`
        INSERT INTO workset_roots (project_key, roots_json, epoch, admit_generation, updated_at)
        VALUES (${projectKey}, ${"[]"}, 0, 0, ${new Date().toISOString()})
      `;
      const targetWorkset = createPostgresWorksetStore({ pool: pgPool, projectKey });
      const mutation = await targetWorkset.admitLedgerMutation({
        kind: "generic-write",
        targets: [],
      });
      const source = new InMemoryLedgerStore();
      await source.init();
      const taskSchema = source.fetch(TASKS_LEDGER).schema;
      const dump = await buildBackupDump(source, null);
      const restore = restoreDumpToPostgres({
        pool: pgPool,
        projectKey,
        dump,
        authority: createTrustedWorksetManagementAuthority(),
        overwriteAuthorized: false,
        administrativeKind: "backend-migration",
      });
      let outcome: "pending" | "resolved" | "rejected" = "pending";
      void restore.then(
        () => {
          outcome = "resolved";
        },
        () => {
          outcome = "rejected";
        },
      );

      let exclusiveObserved = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const rows = await pgPool<Array<{ present: number }>>`
          SELECT 1 AS present FROM workset_admissions
          WHERE project_key = ${projectKey} AND form = 'exclusive-administrative'
        `;
        if (rows.length === 1) {
          exclusiveObserved = true;
          break;
        }
        if (outcome !== "pending") throw new Error("restore settled before acquiring target exclusion");
        await Bun.sleep(5);
      }
      expect(exclusiveObserved).toBe(true);

      await pgPool`
        INSERT INTO ledgers (project_key, name, schema_json, milestone_counter, item_counter)
        VALUES (${projectKey}, ${"late_target"}, ${JSON.stringify(taskSchema)}, 0, 0)
      `;
      await mutation.acknowledge();
      await expect(restore).rejects.toBeInstanceOf(RestoreTargetChangedError);
      const surviving = await pgPool<Array<{ name: string }>>`
        SELECT name FROM ledgers WHERE project_key = ${projectKey} AND name = 'late_target'
      `;
      expect(surviving).toHaveLength(1);
      targetWorkset.close();
      await source.dispose();
    });
  },
);
