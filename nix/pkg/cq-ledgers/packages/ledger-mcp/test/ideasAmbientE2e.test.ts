/**
 * T1533 — cross-package acceptance for ambient-only ideas.
 *
 * Constructive taxonomy: Behavioral / Active / Blackbox / Group. The test
 * crosses the durable filesystem store, initialization migration, production
 * MCP server, SDK transport, milestone listing, and global archive boundary.
 */

import { expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  FsLedgerStore,
  IDEAS_LEDGER,
  IDEAS_SCHEMA,
  LEDGER_STORAGE_DIRNAME,
  MILESTONES_AMBIENT_ID,
  parseLedger,
  serializeLedger,
  type Item,
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
  const ideasPath = path.join(root, LEDGER_STORAGE_DIRNAME, `${IDEAS_LEDGER}.md`);

  try {
    const bootstrap = new FsLedgerStore({ root });
    await bootstrap.init();
    await bootstrap.createMilestone({
      id: LEGACY_MILESTONE,
      title: "Completed work milestone",
    });
    await bootstrap.updateMilestone(LEGACY_MILESTONE, { status: "done" });
    await bootstrap.dispose();

    const ideas = parseLedger(await readFile(ideasPath, "utf8"), { schema: IDEAS_SCHEMA });
    const legacyIdea: Item = {
      id: LEGACY_IDEA,
      milestoneId: LEGACY_MILESTONE,
      status: "open",
      fields: { title: "Legacy idea must not block work archive" },
      createdAt: NOW,
      updatedAt: NOW,
    };
    ideas.counters.item = 16;
    ideas.milestones.push({
      id: LEGACY_MILESTONE,
      title: "Completed work milestone",
      description: "",
      items: [legacyIdea],
    });
    await writeFile(ideasPath, serializeLedger(ideas), "utf8");

    const store = new FsLedgerStore({ root });
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
