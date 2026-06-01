/**
 * McpLedgerClient integration test.
 *
 * Spawns the real `ledger-mcp --http` binary as a subprocess (the actual
 * deployment shape the TUI targets), connects McpLedgerClient over Streamable
 * HTTP, and exercises every client method end-to-end against a seeded ledger
 * tree. This proves the client layer + HTTP transport without any Ink UI.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FsLedgerStore } from "@cq/ledger";
import { McpLedgerClient, LedgerToolError } from "../src/mcpClient.js";

const here = new URL(".", import.meta.url).pathname;
const serverMain = path.resolve(here, "..", "..", "ledger-mcp", "src", "main.ts");

let tmpRoot: string;
let proc: Subprocess;
let client: McpLedgerClient;
const PORT = 7793;

/** Poll the server until it answers (or time out). */
async function waitForServer(url: string, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      // A bare GET to /mcp without a session returns 400 — proof it's up.
      const res = await fetch(url, { method: "GET" });
      await res.text();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`server did not come up at ${url}`);
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-tui-"));
  const seed = new FsLedgerStore({ root: tmpRoot });
  await seed.init();
  await seed.createLedger("bugs", {
    statusValues: ["open", "wip", "closed"],
    terminalStatuses: ["closed"],
    fields: { headline: { type: "string", required: true }, note: { type: "string", required: false } },
  });
  await seed.dispose();

  proc = spawn({
    cmd: [process.execPath, "run", serverMain, "--cwd", tmpRoot, "--http", String(PORT)],
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitForServer(`http://127.0.0.1:${PORT}/mcp`);
  client = await McpLedgerClient.connect(`http://127.0.0.1:${PORT}/mcp`);
});

afterAll(async () => {
  await client.close();
  proc.kill();
  await proc.exited;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("McpLedgerClient over HTTP", () => {
  it("enumerates ledgers", async () => {
    const ledgers = await client.enumerateLedgers();
    const names = ledgers.map((l) => l.name);
    expect(names).toContain("bugs");
    expect(names).toContain("milestones");
    // every summary carries a non-negative item count
    expect(ledgers.every((l) => l.itemCount >= 0)).toBe(true);
  });

  it("tolerates a server response without a counts map (version skew → itemCount 0)", async () => {
    // A server build predating the `counts` field returns just `{ ledgers }`.
    // The client must not dereference an undefined `counts` (regression: the
    // web UI crashed with "can't access property … r.counts is undefined").
    const stub = {
      callTool: async () => ({
        content: [{ type: "text", text: JSON.stringify({ ledgers: ["alpha", "beta"] }) }],
      }),
    };
    const c = new McpLedgerClient(stub as unknown as ConstructorParameters<typeof McpLedgerClient>[0]);
    expect(await c.enumerateLedgers()).toEqual([
      { name: "alpha", itemCount: 0 },
      { name: "beta", itemCount: 0 },
    ]);
  });

  it("creates a milestone and lists it via fetchLedger(milestones)", async () => {
    const ms = await client.createMilestone({ id: "M21", title: "client coverage" });
    expect(ms.id).toBe("M21");
    const milestones = await client.fetchLedger("milestones");
    const ids = milestones.milestones.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain("M21");
  });

  it("creates, updates, fetches and searches an item", async () => {
    const created = await client.createItem("bugs", "M21", {
      status: "open",
      fields: { headline: "warp drive overheats", note: "intermittent" },
    });
    expect(created.status).toBe("open");
    expect(created.fields["headline"]).toBe("warp drive overheats");

    const updated = await client.updateItem("bugs", created.id, { status: "wip" });
    expect(updated.status).toBe("wip");

    const fetched = await client.fetchItem("bugs", created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.status).toBe("wip");

    const ledger = await client.fetchLedger("bugs");
    const allItems = ledger.milestones.flatMap((g) => g.items);
    expect(allItems.some((i) => i.id === created.id)).toBe(true);

    const hits = await client.ftsSearch("warp");
    expect(hits.some((h) => h.item.id === created.id)).toBe(true);
  });

  it("updates a milestone's status", async () => {
    const updated = await client.updateMilestone("M21", { status: "done" });
    expect(updated.status).toBe("done");
  });

  it("surfaces server validation errors as LedgerToolError", async () => {
    let caught: unknown;
    try {
      await client.createItem("bugs", "M21", { status: "not-a-status", fields: { headline: "x" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LedgerToolError);
  });
});
