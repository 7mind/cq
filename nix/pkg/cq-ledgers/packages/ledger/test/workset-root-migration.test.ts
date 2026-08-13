import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSchema,
  isPostgresTenantEmpty,
  isXdgPrimaryEmpty,
  openPgPool,
  SqliteLedgerStore,
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
  },
);
