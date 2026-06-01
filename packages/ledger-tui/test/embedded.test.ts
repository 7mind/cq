/**
 * McpLedgerClient.embedded round-trip test.
 *
 * Runs the ledger MCP server IN-PROCESS over an in-memory transport (no
 * subprocess, no socket) against a seeded temp FsLedgerStore, and exercises
 * every client method — the embedded counterpart to mcpClient.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FsLedgerStore } from "@cq/ledger";
import { McpLedgerClient, LedgerToolError } from "../src/mcpClient.js";

let tmpRoot: string;
let client: McpLedgerClient;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-tui-embedded-"));
  const seed = new FsLedgerStore({ root: tmpRoot });
  await seed.init();
  await seed.createLedger("bugs", {
    statusValues: ["open", "wip", "closed"],
    terminalStatuses: ["closed"],
    fields: { headline: { type: "string", required: true }, note: { type: "string", required: false } },
  });
  await seed.dispose();

  client = await McpLedgerClient.embedded(tmpRoot);
});

afterAll(async () => {
  await client.close(); // disposes the in-process store
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("McpLedgerClient.embedded (in-process, in-memory transport)", () => {
  it("exposes the embedded context (store + resolved cwd)", () => {
    expect(client.embedded).not.toBeNull();
    expect(client.embedded?.cwd).toBe(tmpRoot);
  });

  it("enumerates ledgers", async () => {
    const names = (await client.enumerateLedgers()).map((l) => l.name);
    expect(names).toContain("bugs");
    expect(names).toContain("milestones");
  });

  it("creates, updates, fetches and searches an item — no subprocess", async () => {
    await client.createMilestone({ id: "M30", title: "embedded coverage" });
    const created = await client.createItem("bugs", "M30", {
      status: "open",
      fields: { headline: "tachyon leak", note: "in-process" },
    });
    expect(created.fields["headline"]).toBe("tachyon leak");

    const updated = await client.updateItem("bugs", created.id, { status: "wip" });
    expect(updated.status).toBe("wip");

    const fetched = await client.fetchItem("bugs", created.id);
    expect(fetched.status).toBe("wip");

    const hits = await client.ftsSearch("tachyon");
    expect(hits.some((h) => h.item.id === created.id)).toBe(true);
  });

  it("surfaces server validation errors as LedgerToolError", async () => {
    let caught: unknown;
    try {
      await client.createItem("bugs", "M30", { status: "not-a-status", fields: { headline: "x" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LedgerToolError);
  });
});
