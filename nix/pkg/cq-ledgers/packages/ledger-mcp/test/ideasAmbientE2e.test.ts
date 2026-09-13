/**
 * T1533 — cross-package acceptance for ambient-only ideas.
 *
 * Constructive taxonomy: Behavioral / Active / Blackbox / Group. The test
 * crosses the durable SQLite store, initialization migration, production
 * MCP server, SDK transport, milestone listing, and global archive boundary.
 */

import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  SqliteLedgerStore,
  IDEAS_LEDGER,
  MILESTONES_AMBIENT_ID,
} from "@cq/ledger";
import { createLedgerMcpServer } from "../src/main.js";

const LEGACY_MILESTONE = "M326";
const LEGACY_IDEA = "I16";
const NOW = "2026-08-14T17:00:00.000Z";

function decode<T>(result: unknown): T {
  const response = result as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  const first = response.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected one text response");
  }
  if (response.isError === true) throw new Error(first.text);
  return JSON.parse(first.text) as T;
}

it("[BA/BG] migrates stray ideas before MCP listing and work-milestone archive", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cq-ideas-ambient-e2e-"));
  const dbPath = path.join(root, "ledger.db");

  try {
    const bootstrap = new SqliteLedgerStore({ dbPath });
    await bootstrap.init();
    await bootstrap.createMilestone({
      id: LEGACY_MILESTONE,
      title: "Completed work milestone",
    });
    await bootstrap.updateMilestone(LEGACY_MILESTONE, { status: "done" });
    await bootstrap.dispose();

    const db = new Database(dbPath, { readwrite: true, create: false });
    try {
      db.transaction(() => {
        db.query("INSERT INTO groups (ledger, id, title, description) VALUES (?, ?, ?, '')")
          .run(IDEAS_LEDGER, LEGACY_MILESTONE, "Completed work milestone");
        db.query(
          "INSERT INTO items (ledger, id, milestone_id, status, fields_json, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?)",
        ).run(
          IDEAS_LEDGER, LEGACY_IDEA, LEGACY_MILESTONE,
          JSON.stringify({ title: "Legacy idea must not block work archive" }), NOW, NOW,
        );
        db.query("UPDATE ledgers SET item_counter = 16 WHERE name = ?").run(IDEAS_LEDGER);
      })();
    } finally {
      db.close();
    }

    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    const server = createLedgerMcpServer({ store, displayName: "ideas-ambient-e2e" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "ideas-ambient-e2e", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      const created = decode<{ item: { id: string; milestoneId: string } }>(
        await client.callTool({
          name: "create_item",
          arguments: {
            ledger_id: IDEAS_LEDGER,
            status: "open",
            fields: { title: "New ambient idea" },
          },
        }),
      );
      expect(created.item.milestoneId).toBe(MILESTONES_AMBIENT_ID);

      const listed = decode<{ items: Record<string, Array<{ id: string }>> }>(
        await client.callTool({
          name: "list_milestone_items",
          arguments: { milestone_id: LEGACY_MILESTONE, projection: "full" },
        }),
      );
      expect(listed.items[IDEAS_LEDGER]).toBeUndefined();

      const archived = decode<{ pointer: { id: string; status: string } }>(
        await client.callTool({
          name: "archive_milestone",
          arguments: { milestone_id: LEGACY_MILESTONE, summary: "work complete" },
        }),
      );
      expect(archived.pointer).toMatchObject({ id: LEGACY_MILESTONE, status: "done" });

      for (const ideaId of [LEGACY_IDEA, created.item.id]) {
        const fetched = decode<{ item: { status: string; milestoneId: string } }>(
          await client.callTool({
            name: "fetch_item",
            arguments: { ledger_id: IDEAS_LEDGER, item_id: ideaId, projection: "full" },
          }),
        );
        expect(fetched.item).toMatchObject({
          status: "open",
          milestoneId: MILESTONES_AMBIENT_ID,
        });
      }
    } finally {
      await client.close();
      await server.close();
      await store.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
