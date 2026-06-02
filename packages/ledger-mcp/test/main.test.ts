/**
 * ledger-mcp end-to-end test.
 *
 * Spawns the standalone stdio binary as a subprocess, drives it through the
 * `@modelcontextprotocol/sdk` Client + StdioClientTransport pair, and asserts:
 *   1. tools/list returns exactly the 14-tool ledger surface.
 *   2. enumerate_ledgers reflects the bootstrapped + seeded ledgers.
 *   3. A full create → read → update → search round-trip works through the
 *      transport and persists to disk (verified with a fresh store).
 *
 * The test seeds the docs/ tree with the FsLedgerStore directly (so the
 * seeding format stays in lockstep with the production reader), then closes
 * the store before spawning the binary so file locks don't collide.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FsLedgerStore, CANONICAL_LEDGERS, LEDGER_TOOL_NAMES } from "@cq/ledger";
import { buildServer, projectInstructionLine } from "../src/main.js";

const BOOTSTRAPPED = CANONICAL_LEDGERS.map((c) => c.name);

/** Resolve the binary path against this package's src/main.ts. */
function resolveBinPath(): { command: string; args: string[] } {
  const here = new URL(".", import.meta.url).pathname;
  const main = path.resolve(here, "..", "src", "main.ts");
  return { command: process.execPath, args: ["run", main] };
}

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-mcp-"));
  const store = new FsLedgerStore({ root: tmpRoot });
  await store.init();
  await store.createLedger("xenos", {
    statusValues: ["open", "done"],
    terminalStatuses: ["done"],
    fields: { note: { type: "string", required: false } },
  });
  await store.dispose();
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function withClient(fn: (client: Client) => Promise<void>): Promise<void> {
  const { command, args } = resolveBinPath();
  const transport = new StdioClientTransport({
    command,
    args: [...args, "--cwd", tmpRoot],
    stderr: "inherit",
  });
  const client = new Client(
    { name: "ledger-mcp-test", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

function decode<T>(result: unknown): T {
  const content = (result as { content: Array<{ type: string; text: string }> })
    .content;
  const first = content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected single text content block");
  }
  return JSON.parse(first.text) as T;
}

describe("ledger-mcp stdio binary", () => {
  it("lists exactly the 14 ledger tools (no cq ask/submit tools)", async () => {
    await withClient(async (client) => {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toEqual([...LEDGER_TOOL_NAMES].sort());
      expect(names).not.toContain("ask_user_question");
      expect(names).not.toContain("submit_workflow_phase");
    });
  });

  it("enumerate_ledgers returns the bootstrapped + seeded ledgers", async () => {
    await withClient(async (client) => {
      const result = await client.callTool({ name: "enumerate_ledgers", arguments: {} });
      const decoded = decode<{ ledgers: string[] }>(result);
      expect(decoded.ledgers).toEqual([...BOOTSTRAPPED, "xenos"].sort());
    });
  });

  it("supports a full create → read → update → search round-trip that persists", async () => {
    await withClient(async (client) => {
      // Milestone to anchor the item under.
      const ms = decode<{ milestone: { id: string } }>(
        await client.callTool({
          name: "create_milestone",
          arguments: { id: "M9", title: "ledger-mcp round-trip" },
        }),
      );
      expect(ms.milestone.id).toBe("M9");

      // Create an item in the seeded `xenos` ledger.
      const created = decode<{ item: { id: string; status: string } }>(
        await client.callTool({
          name: "create_item",
          arguments: {
            ledger_id: "xenos",
            milestone_id: "M9",
            status: "open",
            fields: { note: "hello hive fleet" },
          },
        }),
      );
      const itemId = created.item.id;
      expect(created.item.status).toBe("open");

      // Update its status.
      const updated = decode<{ item: { status: string } }>(
        await client.callTool({
          name: "update_item",
          arguments: { ledger_id: "xenos", item_id: itemId, status: "done" },
        }),
      );
      expect(updated.item.status).toBe("done");

      // Fetch it back.
      const fetched = decode<{ item: { id: string; status: string } }>(
        await client.callTool({
          name: "fetch_item",
          arguments: { ledger_id: "xenos", item_id: itemId },
        }),
      );
      expect(fetched.item.id).toBe(itemId);
      expect(fetched.item.status).toBe("done");

      // Full-text search finds it cross-ledger.
      const hits = decode<{ results: Array<{ ledgerId: string }> }>(
        await client.callTool({
          name: "fts_search",
          arguments: { query: "hive" },
        }),
      );
      expect(hits.results.some((h) => h.ledgerId === "xenos")).toBe(true);
    });

    // Re-read with a fresh store so in-memory state can't mask the writes.
    const verify = new FsLedgerStore({ root: tmpRoot });
    await verify.init();
    const view = verify.fetchMilestone("M9");
    expect(view.resolved.title).toBe("ledger-mcp round-trip");
    await verify.dispose();
  });
});

describe("buildServer project display name", () => {
  it("exposes basename of cwd as serverInfo.title (name/version unchanged), with instructions fallback", async () => {
    // Project dir basename, e.g. the repo root 'cq1'.
    const displayName = "cq1";
    const store = new FsLedgerStore({ root: tmpRoot });
    await store.init();
    const server = buildServer(store, displayName);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "ledger-mcp-test", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
    try {
      // Primary carrier: serverInfo.title, read via getServerVersion().
      const info = client.getServerVersion();
      expect(info?.title).toBe(displayName);
      // name/version held stable.
      expect(info?.name).toBe("ledger-mcp");
      expect(info?.version).toBe("0.0.1");

      // Fallback carrier: leading instructions line.
      const instructions = client.getInstructions();
      expect(instructions?.startsWith(projectInstructionLine(displayName))).toBe(true);
    } finally {
      await client.close();
      await store.dispose();
    }
  });
});
