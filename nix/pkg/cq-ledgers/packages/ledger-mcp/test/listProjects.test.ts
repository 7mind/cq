/**
 * list_projects tool-surface tests (T585 / Q284).
 *
 * `createLedgerMcpServer` ALWAYS wires a `list_projects` capability — never
 * leaves it undefined — via `listProjectsOf` (see main.ts's doc): the store's
 * own genuine multi-tenant query when it advertises one (postgres only,
 * covered separately in ledger/test/postgres-list-projects.test.ts), else a
 * synthesized single-project fallback. These tests cover:
 *  - the in-memory fallback (no `projectKey` option — keys off `displayName`);
 *  - the in-memory fallback WITH an explicit `projectKey` option;
 *  - a REAL xdg-backed server (via `createLedgerStore`) returning exactly one
 *    project matching its resolved projectKey + display name.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryLedgerStore, createLedgerStore, type LedgerStore } from "@cq/ledger";
import { createLedgerMcpServer } from "../src/main.js";

async function buildInMemoryStore(): Promise<LedgerStore> {
  const store = new InMemoryLedgerStore();
  await store.init();
  return store;
}

interface ProjectEntry {
  key: string;
  displayName: string;
  createdAt?: string;
}

function decode<T>(result: unknown): T {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  const first = content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected single text content block");
  }
  return JSON.parse(first.text) as T;
}

async function callListProjects(server: McpServer): Promise<{ projects: ProjectEntry[] }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "list-projects-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return decode<{ projects: ProjectEntry[] }>(
      await client.callTool({ name: "list_projects", arguments: {} }),
    );
  } finally {
    await client.close();
  }
}

describe("list_projects — single-project fallback (in-memory store)", () => {
  it("synthesizes one entry keyed off displayName when projectKey is omitted", async () => {
    const store = await buildInMemoryStore();
    const server = createLedgerMcpServer({ store, displayName: "demo" });
    const result = await callListProjects(server);
    expect(result.projects).toEqual([{ key: "demo", displayName: "demo" }]);
  });

  it("synthesizes one entry using the explicit projectKey option", async () => {
    const store = await buildInMemoryStore();
    const server = createLedgerMcpServer({
      store,
      displayName: "demo",
      projectKey: "resolved-project-key",
    });
    const result = await callListProjects(server);
    expect(result.projects).toEqual([{ key: "resolved-project-key", displayName: "demo" }]);
  });
});

describe("list_projects — real xdg embedded server", () => {
  let tmpRoot: string;
  let prevXdgStateHome: string | undefined;

  beforeAll(async () => {
    prevXdgStateHome = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = await fs.mkdtemp(
      path.join(os.tmpdir(), "list-projects-xdg-home-"),
    );
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "list-projects-"));
    await fs.writeFile(
      path.join(tmpRoot, "cq.toml"),
      `[ledger]\n  backend = "xdg"\n  projectId = "${path.basename(tmpRoot)}"\n`,
      "utf8",
    );
  });

  afterAll(async () => {
    const xdgHome = process.env["XDG_STATE_HOME"];
    if (prevXdgStateHome === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = prevXdgStateHome;
    if (xdgHome !== undefined) await fs.rm(xdgHome, { recursive: true, force: true });
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns exactly one project matching the resolved projectKey + display name", async () => {
    const resolved = await createLedgerStore(tmpRoot);
    try {
      expect(resolved.projectKey).toBe(path.basename(tmpRoot));
      const server = createLedgerMcpServer({
        store: resolved.store,
        displayName: "xdg demo project",
        configRoot: resolved.configRoot,
        ...(resolved.projectKey !== undefined ? { projectKey: resolved.projectKey } : {}),
      });
      const result = await callListProjects(server);
      expect(result.projects).toEqual([
        { key: path.basename(tmpRoot), displayName: "xdg demo project" },
      ]);
    } finally {
      await resolved.store.dispose();
    }
  });
});
