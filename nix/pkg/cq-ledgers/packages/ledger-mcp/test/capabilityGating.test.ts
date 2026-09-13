/**
 * Backend-independent MCP capabilities over an isolated SQLite store.
 * Configuration and prompt capabilities use the explicit repository root;
 * bounded log reads use the separate XDG log directory.
 */

import { describe, it, expect, afterAll, afterEach, beforeEach } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SqliteLedgerStore } from "@cq/ledger";
import { buildServer } from "../src/main.js";

const dirs: string[] = [];
const callerHarness = process.env["CQ_HARNESS"];

beforeEach(() => {
  delete process.env["CQ_HARNESS"];
});

afterEach(() => {
  if (callerHarness === undefined) {
    delete process.env["CQ_HARNESS"];
  } else {
    process.env["CQ_HARNESS"] = callerHarness;
  }
});

async function seedLog(dir: string, rel: string, content: string): Promise<void> {
  const file = path.join(dir, "data", "logs", rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

async function withSqliteClient(
  fn: (client: Client, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "capgate-"));
  dirs.push(dir);
  await fs.mkdir(path.join(dir, "data", "logs"), { recursive: true });
  await fs.writeFile(path.join(dir, "cq.toml"), 'reviewers = []\nplanners = []\n', "utf8");
  const store = new SqliteLedgerStore({
    dbPath: path.join(dir, "data", "ledger.db"),
    logsDir: path.join(dir, "data", "logs"),
  });
  await store.init();
  const server = buildServer(store, path.basename(dir), dir);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "capgate-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    await fn(client, dir);
  } finally {
    await client.close();
    await server.close();
    await store.dispose();
  }
}

/** Extract concatenated text content from a callTool result. */
function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("buildServer capability gating — SQLite backend", () => {
  it("read_log IS wired and returns seeded content byte-identical (T408)", async () => {
    await withSqliteClient(async (client, dir) => {
      await seedLog(dir, "raw/x.jsonl", '{"a":1}\n{"b":2}\n');
      const result = (await client.callTool({
        name: "read_log",
        arguments: { path: "raw/x.jsonl" },
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      expect(result.isError ?? false).toBe(false);
      const parsed = JSON.parse(textOf(result)) as {
        path: string;
        content: string;
        truncated?: boolean;
      };
      expect(parsed.content).toBe('{"a":1}\n{"b":2}\n');
      expect(parsed.truncated).toBeUndefined();
    });
  });

  it("read_log rejects a path escaping logs/ (../tasks.md)", async () => {
    await withSqliteClient(async (client) => {
      const result = (await client.callTool({
        name: "read_log",
        arguments: { path: "../tasks.md" },
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("escapes .cq/logs");
    });
  });

  it("read_log returns a clean not-found for a missing path", async () => {
    await withSqliteClient(async (client) => {
      const result = (await client.callTool({
        name: "read_log",
        arguments: { path: "nonexistent.jsonl" },
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).not.toContain("escapes .cq/logs");
      expect(text).toContain("no such file");
    });
  });

  it("get_config IS available (config capability is backend-independent)", async () => {
    await withSqliteClient(async (client) => {
      const result = (await client.callTool({
        name: "get_config",
        arguments: { section: "all" },
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      // The capability is WIRED for the SQLite backend: get_config runs loadConfig
      // and returns a structured payload (with a `configured` boolean) — NOT the
      // ConfigNotImplementedError an unwired capability throws.
      expect(result.isError ?? false).toBe(false);
      const text = textOf(result);
      expect(text).not.toContain("not implemented");
      const parsed = JSON.parse(text) as { configured: boolean; reviewers: unknown[] };
      expect(typeof parsed.configured).toBe("boolean");
      expect(Array.isArray(parsed.reviewers)).toBe(true);
    });
  });

  it("fetch_prompt IS available (prompt-catalog capability is backend-independent)", async () => {
    await withSqliteClient(async (client) => {
      // An unknown role reaches the WIRED capability and yields UnknownRoleError,
      // proving the capability is present — NOT the not-implemented error.
      const result = (await client.callTool({
        name: "fetch_prompt",
        arguments: { roleId: "definitely-not-a-real-role" },
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).not.toContain("not implemented for this store");
      expect(text).toContain("unknown role");
    });
  });
});
