/**
 * T1530 — relocate legacy active ideas onto the immortal ambient milestone.
 *
 * Constructive taxonomy: Behavioral / Active / Blackbox. The filesystem leg
 * crosses the durable adapter boundary; the dump leg crosses the pure import
 * boundary shared by SQLite and PostgreSQL restore.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  IDEAS_LEDGER,
  IDEAS_SCHEMA,
  InMemoryLedgerStore,
  LEDGER_STORAGE_DIRNAME,
  MILESTONES_AMBIENT_ID,
  buildBackupDump,
  parseBackupDump,
  parseLedger,
  reconcileImportedOwnershipDump,
  serializeLedger,
  type BackupDumpFile,
  type Item,
  type Ledger,
} from "../src/index.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { openPgPool } from "../src/store/postgres/connection.js";
import { PostgresLedgerStore } from "../src/store/postgres/PostgresLedgerStore.js";
import { ensureSchema as ensurePostgresSchema } from "../src/store/postgres/schema.js";

const NOW = "2026-08-14T17:00:00.000Z";
const LEGACY_MILESTONE = "M326";
const LEGACY_IDEA = "I16";
const dirs: string[] = [];

function legacyIdea(): Item {
  return {
    id: LEGACY_IDEA,
    milestoneId: LEGACY_MILESTONE,
    status: "open",
    fields: { title: "Legacy non-ambient idea", description: "Preserve this text" },
    createdAt: NOW,
    updatedAt: NOW,
    author: "legacy-author",
    session: "legacy-session",
  };
}

function existingAmbientIdea(): Item {
  return {
    id: "I29",
    milestoneId: MILESTONES_AMBIENT_ID,
    status: "postponed",
    fields: { title: "Existing ambient idea" },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function addLegacyIdea(ledger: Ledger): Ledger {
  ledger.counters.item = 29;
  ledger.milestones.push({
    id: MILESTONES_AMBIENT_ID,
    title: "",
    description: "",
    items: [existingAmbientIdea()],
  });
  ledger.milestones.push({
    id: LEGACY_MILESTONE,
    title: "Legacy work milestone",
    description: "",
    items: [legacyIdea()],
  });
  return ledger;
}

function assertAmbientOnly(ledger: Ledger): void {
  const items = ledger.milestones.flatMap((group) => group.items);
  expect(items).toHaveLength(2);
  expect(items.find((item) => item.id === LEGACY_IDEA)).toEqual({
    ...legacyIdea(),
    milestoneId: MILESTONES_AMBIENT_ID,
  });
  expect(items.find((item) => item.id === "I29")).toEqual(existingAmbientIdea());
  expect(ledger.milestones.some((group) => group.id === LEGACY_MILESTONE)).toBe(false);
  expect(
    ledger.milestones
      .find((group) => group.id === MILESTONES_AMBIENT_ID)
      ?.items.map((item) => item.id),
  ).toEqual(["I29", LEGACY_IDEA]);
}

function replaceIdeasFile(dump: readonly BackupDumpFile[]): BackupDumpFile[] {
  return dump.map((file) =>
    file.path === `${IDEAS_LEDGER}.md`
      ? {
          path: file.path,
          content: serializeLedger(
            addLegacyIdea(parseLedger(file.content, { schema: IDEAS_SCHEMA })),
          ),
        }
      : file,
  );
}

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("legacy idea ambient migration", () => {
  it("[BA/BG] relocates filesystem ideas on open and is byte-idempotent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cq-ideas-ambient-migration-"));
    dirs.push(root);
    const ideasPath = path.join(root, LEDGER_STORAGE_DIRNAME, `${IDEAS_LEDGER}.md`);

    const bootstrap = new FsLedgerStore({ root });
    await bootstrap.init();
    await bootstrap.dispose();

    const legacy = addLegacyIdea(
      parseLedger(await readFile(ideasPath, "utf8"), { schema: IDEAS_SCHEMA }),
    );
    await writeFile(ideasPath, serializeLedger(legacy), "utf8");

    const first = new FsLedgerStore({ root });
    await first.init();
    try {
      const fetched = first.fetchItem(IDEAS_LEDGER, LEGACY_IDEA);
      expect(fetched.milestoneId).toBe(MILESTONES_AMBIENT_ID);
      expect(fetched.fields).toEqual(legacyIdea().fields);
      assertAmbientOnly(
        parseLedger(await readFile(ideasPath, "utf8"), { schema: IDEAS_SCHEMA }),
      );
    } finally {
      await first.dispose();
    }

    const once = await readFile(ideasPath, "utf8");
    const second = new FsLedgerStore({ root });
    await second.init();
    await second.dispose();
    expect(await readFile(ideasPath, "utf8")).toBe(once);
  });

  it("[BA/BG] relocates SQLite ideas in one initialization transaction", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cq-ideas-ambient-sqlite-"));
    dirs.push(root);
    const dbPath = path.join(root, "ledger.db");

    const bootstrap = new SqliteLedgerStore({ dbPath });
    await bootstrap.init();
    await bootstrap.dispose();

    const seed = openLedgerDb(dbPath);
    try {
      seed
        .query("INSERT INTO groups (ledger, id, title, description) VALUES (?, ?, ?, '')")
        .run(IDEAS_LEDGER, LEGACY_MILESTONE, "Legacy work milestone");
      seed
        .query(
          `INSERT INTO items
             (ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          IDEAS_LEDGER,
          LEGACY_IDEA,
          LEGACY_MILESTONE,
          "open",
          JSON.stringify(legacyIdea().fields),
          NOW,
          NOW,
          "legacy-author",
          "legacy-session",
        );
      seed
        .query("UPDATE ledgers SET item_counter = 16 WHERE name = ?")
        .run(IDEAS_LEDGER);
    } finally {
      seed.close();
    }

    const first = new SqliteLedgerStore({ dbPath });
    await first.init();
    try {
      expect(first.fetchItem(IDEAS_LEDGER, LEGACY_IDEA)).toEqual({
        ...legacyIdea(),
        milestoneId: MILESTONES_AMBIENT_ID,
      });
    } finally {
      await first.dispose();
    }

    const inspect = openLedgerDb(dbPath);
    const once = JSON.stringify({
      groups: inspect
        .query("SELECT id, title, description FROM groups WHERE ledger = ? ORDER BY rowid")
        .all(IDEAS_LEDGER),
      items: inspect
        .query(
          "SELECT id, milestone_id, status, fields_json, created_at, updated_at, author, session FROM items WHERE ledger = ? ORDER BY rowid",
        )
        .all(IDEAS_LEDGER),
    });
    inspect.close();

    const second = new SqliteLedgerStore({ dbPath });
    await second.init();
    await second.dispose();

    const verify = openLedgerDb(dbPath);
    try {
      const twice = JSON.stringify({
        groups: verify
          .query("SELECT id, title, description FROM groups WHERE ledger = ? ORDER BY rowid")
          .all(IDEAS_LEDGER),
        items: verify
          .query(
            "SELECT id, milestone_id, status, fields_json, created_at, updated_at, author, session FROM items WHERE ledger = ? ORDER BY rowid",
          )
          .all(IDEAS_LEDGER),
      });
      expect(twice).toBe(once);
      expect(
        verify
          .query("SELECT milestone_id FROM items WHERE ledger = ? AND id = ?")
          .get(IDEAS_LEDGER, LEGACY_IDEA),
      ).toEqual({ milestone_id: MILESTONES_AMBIENT_ID });
      expect(
        verify
          .query("SELECT id FROM groups WHERE ledger = ? AND id = ?")
          .get(IDEAS_LEDGER, LEGACY_MILESTONE),
      ).toBeNull();
    } finally {
      verify.close();
    }
  });

  it("[BA] relocates ideas before a restore/import dump is materialized", async () => {
    const source = new InMemoryLedgerStore();
    await source.init();
    try {
      const legacyDump = replaceIdeasFile(await buildBackupDump(source, null));
      const reconciled = reconcileImportedOwnershipDump(legacyDump, "preserve");
      assertAmbientOnly(parseBackupDump(reconciled).ledgers.get(IDEAS_LEDGER)!);
    } finally {
      await source.dispose();
    }
  });
});

const pgUrl = process.env["CQ_TEST_PG_URL"];

if (pgUrl === undefined || pgUrl.length === 0) {
  describe.skip("legacy idea ambient migration — PostgreSQL", () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
} else {
  describe("legacy idea ambient migration — PostgreSQL", () => {
    it("[BA/BG] relocates durable tenant rows and remains idempotent", async () => {
      const setup = openPgPool(pgUrl);
      const projectKey = `t1530-${randomUUID()}`;
      await ensurePostgresSchema(setup);
      await setup`
        INSERT INTO projects (project_key, display_name)
        VALUES (${projectKey}, ${projectKey})
      `;
      await setup`
        INSERT INTO ledgers
          (project_key, name, schema_json, milestone_counter, item_counter)
        VALUES (${projectKey}, ${IDEAS_LEDGER}, ${JSON.stringify(IDEAS_SCHEMA)}, 0, 16)
      `;
      await setup`
        INSERT INTO groups (project_key, ledger, id, title, description)
        VALUES (${projectKey}, ${IDEAS_LEDGER}, ${LEGACY_MILESTONE}, 'Legacy work milestone', '')
      `;
      await setup`
        INSERT INTO items
          (project_key, ledger, id, milestone_id, status, fields_json,
           created_at, updated_at, author, session)
        VALUES
          (${projectKey}, ${IDEAS_LEDGER}, ${LEGACY_IDEA}, ${LEGACY_MILESTONE}, 'open',
           ${JSON.stringify(legacyIdea().fields)}, ${NOW}, ${NOW},
           'legacy-author', 'legacy-session')
      `;

      try {
        const first = new PostgresLedgerStore({
          pool: openPgPool(pgUrl),
          projectKey,
          displayName: projectKey,
        });
        await first.init();
        try {
          expect(first.fetchItem(IDEAS_LEDGER, LEGACY_IDEA)).toEqual({
            ...legacyIdea(),
            milestoneId: MILESTONES_AMBIENT_ID,
          });
        } finally {
          await first.dispose();
        }

        const rows = async () => ({
          groups: await setup`
            SELECT id, title, description FROM groups
            WHERE project_key = ${projectKey} AND ledger = ${IDEAS_LEDGER}
            ORDER BY seq
          `,
          items: await setup`
            SELECT id, milestone_id, status, fields_json, created_at, updated_at, author, session
            FROM items
            WHERE project_key = ${projectKey} AND ledger = ${IDEAS_LEDGER}
            ORDER BY seq
          `,
        });
        const once = JSON.stringify(await rows());

        const second = new PostgresLedgerStore({
          pool: openPgPool(pgUrl),
          projectKey,
          displayName: projectKey,
        });
        await second.init();
        await second.dispose();

        expect(JSON.stringify(await rows())).toBe(once);
        expect(
          await setup<Array<{ milestone_id: string }>>`
            SELECT milestone_id FROM items
            WHERE project_key = ${projectKey} AND ledger = ${IDEAS_LEDGER} AND id = ${LEGACY_IDEA}
          `,
        ).toEqual([{ milestone_id: MILESTONES_AMBIENT_ID }]);
        expect(
          await setup<Array<{ id: string }>>`
            SELECT id FROM groups
            WHERE project_key = ${projectKey} AND ledger = ${IDEAS_LEDGER} AND id = ${LEGACY_MILESTONE}
          `,
        ).toEqual([]);
      } finally {
        await setup.begin(async (tx) => {
          await tx`DELETE FROM workset_admissions WHERE project_key = ${projectKey}`;
          await tx`DELETE FROM workset_roots WHERE project_key = ${projectKey}`;
          await tx`DELETE FROM plan_operations WHERE project_key = ${projectKey}`;
          await tx`DELETE FROM plan_claims WHERE project_key = ${projectKey}`;
          await tx`DELETE FROM archived_items WHERE project_key = ${projectKey}`;
          await tx`DELETE FROM archive_pointers WHERE project_key = ${projectKey}`;
          await tx`DELETE FROM items WHERE project_key = ${projectKey}`;
          await tx`DELETE FROM groups WHERE project_key = ${projectKey}`;
          await tx`DELETE FROM ledgers WHERE project_key = ${projectKey}`;
          await tx`DELETE FROM logs WHERE project_key = ${projectKey}`;
          await tx`DELETE FROM mcp_usage_stats WHERE project_key = ${projectKey}`;
          await tx`DELETE FROM projects WHERE project_key = ${projectKey}`;
        });
        await setup.close();
      }
    });
  });
}
