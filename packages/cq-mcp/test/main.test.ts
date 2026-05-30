/**
 * cq-mcp end-to-end test (msunify shape).
 *
 * Spawns the stdio binary as a subprocess, drives it through the
 * @modelcontextprotocol/sdk Client + StdioClientTransport pair, and
 * asserts that:
 *   1. tools/list returns the 14-tool surface (msunify 13 + fts_search).
 *   2. enumerate_ledgers reflects the seeded list (incl. the
 *      bootstrapped milestones ledger).
 *   3. create_milestone mutates the docs/milestones.md file on disk.
 *
 * The test seeds the docs/ tree with a fixture registry + ledger
 * markdown using the FsLedgerStore directly (so the seeding format
 * stays in lockstep with the production reader), then closes the store
 * before spawning the binary so file locks don't collide.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FsLedgerStore, CANONICAL_LEDGERS } from "@cq/ledger";

const BOOTSTRAPPED = CANONICAL_LEDGERS.map((c) => c.name);

/** Resolve the binary path against the worktree's node_modules/.bin. */
function resolveBinPath(): { command: string; args: string[] } {
  const here = new URL(".", import.meta.url).pathname;
  const main = path.resolve(here, "..", "src", "main.ts");
  return { command: process.execPath, args: ["run", main] };
}

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cq-mcp-"));
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

async function withClient(
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const { command, args } = resolveBinPath();
  const transport = new StdioClientTransport({
    command,
    args: [...args, "--cwd", tmpRoot],
    stderr: "inherit",
  });
  const client = new Client(
    { name: "cq-mcp-test", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

describe("cq-mcp stdio binary", () => {
  it("lists the 14 ledger tools (msunify surface + fts_search)", async () => {
    await withClient(async (client) => {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          "archive_milestone",
          "create_item",
          "create_ledger",
          "create_milestone",
          "enumerate_ledgers",
          "fetch_item",
          "fetch_ledger",
          "fetch_ledger_archive",
          "fetch_milestone",
          "fts_search",
          "list_milestone_items",
          "search_items",
          "update_item",
          "update_milestone",
        ].sort(),
      );
    });
  });

  it("enumerate_ledgers returns the seeded list (incl. bootstrapped milestones)", async () => {
    await withClient(async (client) => {
      const result = await client.callTool({
        name: "enumerate_ledgers",
        arguments: {},
      });
      const block = (result.content as Array<{ type: string; text: string }>)[0];
      expect(block).toBeDefined();
      expect(block!.type).toBe("text");
      const decoded = JSON.parse(block!.text) as { ledgers: string[] };
      expect(decoded.ledgers).toEqual([...BOOTSTRAPPED, "xenos"].sort());
    });
  });

  it("create_milestone mutates the on-disk milestones ledger file", async () => {
    await withClient(async (client) => {
      await client.callTool({
        name: "create_milestone",
        arguments: {
          id: "M7",
          title: "Validate cq-mcp roundtrip",
        },
      });
    });
    // Re-read with a fresh store so in-memory state can't mask the write.
    const verify = new FsLedgerStore({ root: tmpRoot });
    await verify.init();
    const view = verify.fetchMilestone("M7");
    expect(view.milestone.id).toBe("M7");
    expect(view.resolved.title).toBe("Validate cq-mcp roundtrip");
    await verify.dispose();
  });
});
