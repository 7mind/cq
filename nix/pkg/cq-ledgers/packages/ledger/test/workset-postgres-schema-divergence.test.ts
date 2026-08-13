import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createTrustedWorksetManagementAuthority,
  GOALS_LEDGER,
  GOALS_SCHEMA,
} from "../src/index.js";
import { openPgPool } from "../src/store/postgres/connection.js";
import { PostgresLedgerStore } from "../src/store/postgres/PostgresLedgerStore.js";
import { ensureSchema } from "../src/store/postgres/schema.js";

const pgUrl = process.env["CQ_TEST_PG_URL"];
const setupPool = pgUrl === undefined ? undefined : openPgPool(pgUrl);

describe.skipIf(setupPool === undefined)(
  "workset roots across PostgreSQL schema divergence [T1960]",
  () => {
    beforeAll(async () => {
      if (setupPool === undefined) throw new Error("fixture: PostgreSQL pool missing");
      await ensureSchema(setupPool);
    });

    afterAll(async () => {
      await setupPool?.close();
    });

    it("preserves roots and epoch in the divergence shadow", async () => {
      if (setupPool === undefined || pgUrl === undefined) {
        throw new Error("fixture: PostgreSQL connection missing");
      }
      const projectKey = `t1960_divergence_${randomUUID().replaceAll("-", "")}`;
      const roots = ["goals:G-preserve", "tasks:T-preserve"];
      const divergentSchema = {
        ...GOALS_SCHEMA,
        statusValues: [...GOALS_SCHEMA.statusValues, "divergent-status"],
      };
      await setupPool`
      INSERT INTO projects (project_key, display_name) VALUES (${projectKey}, ${projectKey})
    `;
      await setupPool`
      INSERT INTO ledgers (project_key, name, schema_json, milestone_counter, item_counter)
      VALUES (${projectKey}, ${GOALS_LEDGER}, ${JSON.stringify(divergentSchema)}, 0, 0)
    `;
      await setupPool`
      INSERT INTO workset_roots (project_key, roots_json, epoch, admit_generation, updated_at)
      VALUES (${projectKey}, ${JSON.stringify(roots)}, 4, 0, ${new Date().toISOString()})
    `;

      const store = new PostgresLedgerStore({
        pool: openPgPool(pgUrl),
        projectKey,
        displayName: projectKey,
        onSchemaDivergence: "backup-reinit",
        worksetAuthority: createTrustedWorksetManagementAuthority(),
      });
      await store.init();
      await store.dispose();

      const shadowRows = await setupPool<Array<{ roots_json: string; epoch: string }>>`
      SELECT roots_json, epoch FROM workset_roots
      WHERE project_key LIKE ${`${projectKey}__divergence-backup-%`}
    `;
      expect(shadowRows).toHaveLength(1);
      expect(JSON.parse(shadowRows[0]!.roots_json)).toEqual(roots);
      expect(Number(shadowRows[0]!.epoch)).toBe(4);

      const liveRows = await setupPool<Array<{ roots_json: string; epoch: string }>>`
      SELECT roots_json, epoch FROM workset_roots WHERE project_key = ${projectKey}
    `;
      expect(liveRows).toHaveLength(1);
      expect(JSON.parse(liveRows[0]!.roots_json)).toEqual([]);
      expect(Number(liveRows[0]!.epoch)).toBe(0);
    });
  },
);
