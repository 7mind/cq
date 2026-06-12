/**
 * ledger-mcp end-to-end test.
 *
 * Spawns the standalone stdio binary as a subprocess, drives it through the
 * `@modelcontextprotocol/sdk` Client + StdioClientTransport pair, and asserts:
 *   1. tools/list returns exactly the 26-tool ledger surface.
 *   2. enumerate_ledgers reflects the bootstrapped + seeded ledgers.
 *   3. A full create → read → update → search round-trip works through the
 *      transport and persists to disk (verified with a fresh store).
 *
 * The test seeds the .cq/ tree with the FsLedgerStore directly (so the
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
  it("lists exactly the 26 ledger tools (no cq ask/submit tools)", async () => {
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
      const ms = decode<{ milestone: { id: string } }>(
        await client.callTool({
          name: "create_milestone",
          arguments: { id: "M9", title: "ledger-mcp round-trip" },
        }),
      );
      expect(ms.milestone.id).toBe("M9");

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

      const updated = decode<{ item: { status: string } }>(
        await client.callTool({
          name: "update_item",
          arguments: { ledger_id: "xenos", item_id: itemId, status: "done" },
        }),
      );
      expect(updated.item.status).toBe("done");

      const fetched = decode<{ item: { id: string; status: string } }>(
        await client.callTool({
          name: "fetch_item",
          arguments: { ledger_id: "xenos", item_id: itemId },
        }),
      );
      expect(fetched.item.id).toBe(itemId);
      expect(fetched.item.status).toBe("done");

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

/**
 * End-to-end cq.toml config capability over the STDIO binary (T2 / G18).
 *
 * These assert the wiring lands on the SAME surface the standalone binary and
 * the embedded TUI/web hosts use (buildServer → registerLedgerStdioTools 4th
 * arg) — NOT merely on the in-process tool() factory. The binary is spawned
 * with `--cwd <root>`; the config root IS that ledger root (Q99), so the
 * capability reads `<root>/cq.toml` on each call.
 */
async function withClientAtRoot(
  root: string,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const { command, args } = resolveBinPath();
  const transport = new StdioClientTransport({
    command,
    args: [...args, "--cwd", root],
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

describe("ledger-mcp stdio config capability (cq.toml)", () => {
  it("surfaces get_reviewers + get_planners + get_config + get_agent_models on the stdio binary", async () => {
    // The default tmpRoot has no cq.toml, so the tools are still listed.
    await withClientAtRoot(tmpRoot, async (client) => {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      expect(names).toContain("get_reviewers");
      expect(names).toContain("get_planners");
      expect(names).toContain("get_config");
      expect(names).toContain("get_agent_models");
    });
  });

  it("returns configured:false when no cq.toml at the store root", async () => {
    const noCfgRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-mcp-nocfg-"));
    try {
      const store = new FsLedgerStore({ root: noCfgRoot });
      await store.init();
      await store.dispose();
      await withClientAtRoot(noCfgRoot, async (client) => {
        const reviewers = decode<{ configured: boolean; reviewers: unknown[] }>(
          await client.callTool({ name: "get_reviewers", arguments: {} }),
        );
        expect(reviewers.configured).toBe(false);
        expect(reviewers.reviewers).toEqual([]);

        const planners = decode<{ configured: boolean; planners: unknown[] }>(
          await client.callTool({ name: "get_planners", arguments: {} }),
        );
        expect(planners.configured).toBe(false);
        expect(planners.planners).toEqual([]);

        const config = decode<{
          configured: boolean;
          aliases: object;
          reviewers: unknown[];
          planners: unknown[];
        }>(await client.callTool({ name: "get_config", arguments: {} }));
        expect(config.configured).toBe(false);
        expect(config.aliases).toEqual({});
        expect(config.reviewers).toEqual([]);
        expect(config.planners).toEqual([]);
      });
    } finally {
      await fs.rm(noCfgRoot, { recursive: true, force: true });
    }
  });

  it("returns the resolved reviewer set when a fixture cq.toml is present", async () => {
    const cfgRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-mcp-cfg-"));
    try {
      const store = new FsLedgerStore({ root: cfgRoot });
      await store.init();
      await store.dispose();
      // Config root IS the ledger root: write cq.toml at <root>/cq.toml.
      await fs.writeFile(
        path.join(cfgRoot, "cq.toml"),
        [
          'reviewers = ["codex", "opus"]',
          'planners = ["opus"]',
          "",
          "[aliases]",
          '  codex = "pi:grok-build/grok-build"',
          '  opus = "claude:opus-4.8[1m]"',
          "",
        ].join("\n"),
        "utf8",
      );
      await withClientAtRoot(cfgRoot, async (client) => {
        const reviewers = decode<{
          configured: boolean;
          reviewers: Array<{ harness: string; model: string; provider: string | null; alias: string; effort: string | null }>;
        }>(await client.callTool({ name: "get_reviewers", arguments: {} }));
        expect(reviewers.configured).toBe(true);
        expect(reviewers.reviewers).toEqual([
          { harness: "pi", model: "grok-build", provider: "grok-build", alias: "codex", effort: null },
          { harness: "claude", model: "opus-4.8[1m]", provider: null, alias: "opus", effort: null },
        ]);

        const planners = decode<{
          configured: boolean;
          planners: Array<{ harness: string; model: string; provider: string | null; alias: string; effort: string | null }>;
        }>(await client.callTool({ name: "get_planners", arguments: {} }));
        expect(planners.configured).toBe(true);
        expect(planners.planners).toEqual([
          { harness: "claude", model: "opus-4.8[1m]", provider: null, alias: "opus", effort: null },
        ]);

        const config = decode<{
          configured: boolean;
          aliases: Record<string, { harness: string; model: string; provider: string | null; effort: string | null }>;
          reviewers: string[];
          planners: string[];
        }>(await client.callTool({ name: "get_config", arguments: {} }));
        expect(config.configured).toBe(true);
        expect(config.reviewers).toEqual(["codex", "opus"]);
        expect(config.planners).toEqual(["opus"]);
        expect(config.aliases).toEqual({
          codex: { harness: "pi", model: "grok-build", provider: "grok-build", effort: null },
          opus: { harness: "claude", model: "opus-4.8[1m]", provider: null, effort: null },
        });
      });
    } finally {
      await fs.rm(cfgRoot, { recursive: true, force: true });
    }
  });

  /**
   * T287: get_agent_models MCP tool — server-level tests via stdio binary.
   *
   * Asserts the wiring lands on the full stdio binary path:
   *  - with a fixture cq.toml: returns 19 agent entries (the full roster).
   *  - without a cq.toml: returns configured:false with 19 entries (not-configured
   *    for model-configurable roles, not-model-configurable for command roles).
   */
  it("get_agent_models returns 19 agent entries with a fixture cq.toml (T287)", async () => {
    const agentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-mcp-agents-"));
    try {
      const store = new FsLedgerStore({ root: agentRoot });
      await store.init();
      await store.dispose();
      await fs.writeFile(
        path.join(agentRoot, "cq.toml"),
        [
          'reviewers = ["opus"]',
          'planners  = ["opus"]',
          "",
          "[aliases]",
          '  opus = "claude:opus-4.8[1m]"',
          "",
          "[tiers]",
          '  "claude:opus-4.8[1m]" = "frontier"',
          "",
        ].join("\n"),
        "utf8",
      );
      await withClientAtRoot(agentRoot, async (client) => {
        const result = decode<{
          configured: boolean;
          agents: Array<{
            id: string;
            status: string;
            modelClass: string | null;
            modelMappings: Record<string, unknown>;
          }>;
        }>(await client.callTool({ name: "get_agent_models", arguments: {} }));
        expect(result.configured).toBe(true);
        // The fixed roster has exactly 19 roles.
        expect(result.agents).toHaveLength(19);
        // Every entry has the required fields.
        for (const agent of result.agents) {
          expect(typeof agent.id).toBe("string");
          expect(["resolved", "not-configured", "no-live-token", "not-model-configurable"]).toContain(
            agent.status,
          );
          expect(typeof agent.modelMappings).toBe("object");
        }
      });
    } finally {
      await fs.rm(agentRoot, { recursive: true, force: true });
    }
  });

  it("get_agent_models returns configured:false with 19 entries when no cq.toml (T287)", async () => {
    const noCfgRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-mcp-agents-nocfg-"));
    try {
      const store = new FsLedgerStore({ root: noCfgRoot });
      await store.init();
      await store.dispose();
      await withClientAtRoot(noCfgRoot, async (client) => {
        const result = decode<{
          configured: boolean;
          agents: Array<{ id: string; status: string }>;
        }>(await client.callTool({ name: "get_agent_models", arguments: {} }));
        expect(result.configured).toBe(false);
        expect(result.agents).toHaveLength(19);
        // Every model-configurable role is not-configured; orchestrator commands
        // remain not-model-configurable regardless of cq.toml presence.
        for (const agent of result.agents) {
          expect(["not-configured", "not-model-configurable"]).toContain(agent.status);
        }
      });
    } finally {
      await fs.rm(noCfgRoot, { recursive: true, force: true });
    }
  });
});
