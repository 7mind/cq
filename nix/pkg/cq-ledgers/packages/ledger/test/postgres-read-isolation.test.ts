/**
 * D149: PostgresLedgerStore multi-statement tenant reads run under REPEATABLE
 * READ so a concurrent archive/unarchive cannot tear active vs archived
 * surfaces (item simultaneously active AND archived, or pointer without content).
 *
 * Env-gated on CQ_TEST_PG_URL.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import type { LedgerSchema } from "../src/index.js";
import { openPgPool, readTransaction, writeTransaction } from "../src/store/postgres/connection.js";
import { ensureSchema } from "../src/store/postgres/schema.js";
import { PostgresLedgerStore } from "../src/store/postgres/PostgresLedgerStore.js";

const PG_URL = process.env.CQ_TEST_PG_URL;

const widgetsSchema: LedgerSchema = {
  statusValues: ["open", "in-progress", "resolved", "abandoned"],
  terminalStatuses: ["resolved", "abandoned"],
  fields: {
    severity: { type: "string", required: true },
    location: { type: "string", required: true },
    description: { type: "string", required: true },
  },
};

if (PG_URL === undefined || PG_URL.length === 0) {
  describe.skip("D149: Postgres tenant-read isolation", () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
} else {
  const setupPool = openPgPool(PG_URL);
  const schemaReady = ensureSchema(setupPool);

  afterAll(async () => {
    await setupPool.close();
  });

  describe("D149: Postgres tenant-read isolation (REPEATABLE READ)", () => {
    it("readTransaction reports repeatable read + read only", async () => {
      await schemaReady;
      const pool = openPgPool(PG_URL);
      try {
        const row = await readTransaction(pool, async (tx) => {
          const rows = await tx<
            Array<{ isolation: string; ro: boolean }>
          >`SELECT current_setting('transaction_isolation') AS isolation,
                   current_setting('transaction_read_only') = 'on' AS ro`;
          return rows[0];
        });
        expect(row?.isolation).toBe("repeatable read");
        expect(row?.ro).toBe(true);
      } finally {
        await pool.close();
      }
    });

    it("writeTransaction stays at read committed (parent-first lock protocol)", async () => {
      await schemaReady;
      const pool = openPgPool(PG_URL);
      try {
        const row = await writeTransaction(pool, async (tx) => {
          const rows = await tx<
            Array<{ isolation: string }>
          >`SELECT current_setting('transaction_isolation') AS isolation`;
          return rows[0];
        });
        // Writes must NOT raise isolation — RR breaks close-versus-create
        // (nonTerminalChildren misses post-lock child inserts).
        expect(row?.isolation).toBe("read committed");
      } finally {
        await pool.close();
      }
    });

    it(
      "invalidate/reload under concurrent archive never returns an item as both active and archived",
      async () => {
        await schemaReady;
        const projectKey = `d149-${randomUUID()}`;
        await setupPool`
          INSERT INTO projects (project_key, display_name) VALUES (${projectKey}, ${projectKey})
        `;
        await setupPool`
          INSERT INTO ledgers (project_key, name, schema_json, milestone_counter, item_counter)
          VALUES (${projectKey}, 'widgets', ${JSON.stringify(widgetsSchema)}, 0, 0)
        `;

        const writer = new PostgresLedgerStore({
          pool: openPgPool(PG_URL),
          projectKey,
          displayName: projectKey,
        });
        const reader = new PostgresLedgerStore({
          pool: openPgPool(PG_URL),
          projectKey,
          displayName: projectKey,
        });
        await writer.init();
        await reader.init();

        try {
          // Seed several terminal milestones with one resolved child each so
          // archive is legal; then race archive vs invalidate/reload.
          const ids: string[] = [];
          for (let i = 0; i < 8; i++) {
            const m = await writer.createMilestone({ title: `d149-m-${i}` });
            const w = await writer.createItem("widgets", m.id, {
              status: "open",
              fields: {
                severity: "low",
                location: `x${i}.ts`,
                description: `d149 child ${i}`,
              },
            });
            await writer.updateItem("widgets", w.id, { status: "resolved" });
            await writer.updateMilestone(m.id, { status: "done" });
            ids.push(m.id);
          }
          // Reader starts from the pre-archive snapshot.
          await reader.invalidate("widgets");
          await reader.invalidate("milestones");

          const tears: string[] = [];
          const archivePromises = ids.map((id) => writer.archiveMilestone(id, `arch-${id}`));
          const reloadPromises: Promise<void>[] = [];
          for (let i = 0; i < 40; i++) {
            reloadPromises.push(
              (async () => {
                await reader.invalidate("widgets");
                // After reload, every archive pointer must resolve; no active
                // item may also appear under ftsSearch(includeArchived) twice.
                const active = reader.search("widgets", "d149 child");
                const activeIds = new Set(active.map((it) => it.id));
                const hits = await reader.ftsSearch("d149 child", {
                  ledger: "widgets",
                  includeArchived: true,
                  limit: 200,
                });
                const seen = new Map<string, number>();
                for (const h of hits) {
                  seen.set(h.item.id, (seen.get(h.item.id) ?? 0) + 1);
                }
                for (const [id, n] of seen) {
                  if (n > 1) tears.push(`duplicate fts hit for ${id} (n=${n})`);
                  if (activeIds.has(id) && n >= 1) {
                    // Active + archived simultaneously: fts with includeArchived
                    // returns the same id from both buckets.
                    const archivedOnly = hits.filter((h) => h.item.id === id);
                    if (archivedOnly.length > 1) {
                      tears.push(`active+archived tear for ${id}`);
                    }
                  }
                }
                // Pointer-without-content: every advertised pointer must fetch.
                const view = reader.fetch("widgets");
                for (const ptr of view.archivePointers) {
                  try {
                    await reader.fetchArchive("widgets", ptr.id);
                  } catch (err) {
                    tears.push(
                      `pointer ${ptr.id} without content: ${
                        err instanceof Error ? err.message : String(err)
                      }`,
                    );
                  }
                }
              })(),
            );
          }
          await Promise.all([...archivePromises, ...reloadPromises]);
          expect(tears).toEqual([]);
        } finally {
          await writer.dispose();
          await reader.dispose();
        }
      },
      60_000,
    );
  });
}
