/**
 * McpLedgerClient.embedded round-trip test.
 *
 * Runs the ledger MCP server IN-PROCESS over an in-memory transport (no
 * subprocess, no socket) against a seeded temp xdg store (T505). Transport
 * calls exercise the explicit read projections and fixed mutation acks.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLedgerStore } from "@cq/ledger";
import { buildServer } from "@cq/ledger-mcp";
import { McpLedgerClient, LedgerToolError } from "../src/mcpClient.js";

let tmpRoot: string;
let xdgHome: string;
let prevXdgStateHome: string | undefined;
let prevPromptRoot: string | undefined;
let prevPromptSurface: string | undefined;
let promptRoot: string;
let client: McpLedgerClient;
let rawClient: Client;
const PROMPT_BYTES = "tui codex {{cq:literal}} and $ARGUMENTS\n";

beforeAll(async () => {
  // The runtime store is the out-of-tree xdg primary (T505): point
  // XDG_STATE_HOME at a temp dir and pin the backend with a projectId.
  prevXdgStateHome = process.env["XDG_STATE_HOME"];
  prevPromptRoot = process.env["CQ_PROMPT_ROOT"];
  prevPromptSurface = process.env["CQ_PROMPT_SURFACE"];
  xdgHome = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-tui-embedded-xdg-"));
  process.env["XDG_STATE_HOME"] = xdgHome;
  promptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-tui-prompts-"));
  await fs.mkdir(path.join(promptRoot, "roles"));
  await fs.writeFile(path.join(promptRoot, "surface.json"), '{"surface":"codex"}');
  await fs.writeFile(
    path.join(promptRoot, "catalog.json"),
    JSON.stringify([
      {
        roleId: "plan-advance",
        roleKind: "dispatched-subagent",
        canonicalSource: "agents/plan-advance.md",
        surfaces: ["claude", "codex", "pi"],
        sharedSourceBlock: {
          classification: "shared-prose",
          sourceBlock: "all prose outside the classified surface-sensitive blocks",
          targetFragment: null,
        },
        fragmentBindings: [],
        dispatchRelations: [],
        intentionalDifferences: [],
        sidecar: { schemaRoleId: "plan-advance" },
      },
    ]),
  );
  await fs.writeFile(path.join(promptRoot, "roles", "plan-advance.md"), PROMPT_BYTES);
  process.env["CQ_PROMPT_ROOT"] = promptRoot;
  process.env["CQ_PROMPT_SURFACE"] = "codex";

  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-tui-embedded-"));
  await fs.writeFile(
    path.join(tmpRoot, "cq.toml"),
    `[ledger]\nbackend = "xdg"\nprojectId = "${path.basename(tmpRoot)}"\n`,
    "utf8",
  );
  const { store: seed } = await createLedgerStore(tmpRoot);
  await seed.createLedger("bugs", {
    statusValues: ["open", "wip", "closed"],
    terminalStatuses: ["closed"],
    fields: {
      headline: { type: "string", required: true },
      note: { type: "string", required: false },
      dependsOn: { type: "id[]", required: false },
    },
  });
  await seed.dispose();

  client = await McpLedgerClient.embedded(tmpRoot);
  const embedded = client.embedded;
  if (embedded === null) {
    throw new Error("expected embedded ledger context");
  }
  const server = buildServer(embedded.store, path.basename(tmpRoot));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  rawClient = new Client(
    { name: "ledger-tui-embedded-contract-test", version: "0.0.1" },
    { capabilities: {} },
  );
  await rawClient.connect(clientTransport);
});

afterAll(async () => {
  await rawClient.close();
  await client.close(); // disposes the in-process store
  if (prevXdgStateHome === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = prevXdgStateHome;
  if (prevPromptRoot === undefined) delete process.env["CQ_PROMPT_ROOT"];
  else process.env["CQ_PROMPT_ROOT"] = prevPromptRoot;
  if (prevPromptSurface === undefined) delete process.env["CQ_PROMPT_SURFACE"];
  else process.env["CQ_PROMPT_SURFACE"] = prevPromptSurface;
  await fs.rm(xdgHome, { recursive: true, force: true });
  await fs.rm(promptRoot, { recursive: true, force: true });
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function decode<T>(result: unknown): T {
  const response = result as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  expect(response.isError ?? false).toBe(false);
  const first = response.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected single text content block");
  }
  return JSON.parse(first.text) as T;
}

describe("McpLedgerClient.embedded (in-process, in-memory transport)", () => {
  it("exposes the embedded context (store + cwd + resolved backend descriptor)", () => {
    expect(client.embedded).not.toBeNull();
    expect(client.embedded?.cwd).toBe(tmpRoot);
    // D51: the resolved backend descriptor is exposed so main.tsx can select
    // the matching coherence watcher. cq.toml pins the xdg backend (T505).
    expect(client.embedded?.resolved.backend).toBe("xdg");
    expect(client.embedded?.resolved.store).toBe(client.embedded?.store);
  });

  it("enumerates ledgers", async () => {
    const names = (await client.enumerateLedgers()).map((l) => l.name);
    expect(names).toContain("bugs");
    expect(names).toContain("milestones");
  });

  it("fetches exact bytes from the selected prompt root over the embedded transport", async () => {
    expect(await client.fetchPrompt("plan-advance")).toBe(PROMPT_BYTES);
    const result = await client.fetchPromptResult("plan-advance");
    expect(result.promptSurface).toBe("codex");
    expect(result.sourcePath).toBe("agents/plan-advance.md");
    expect(result.requiredCapabilities).toEqual([]);
  });

  it("round-trips fixed acks plus compact and full reads — no subprocess", async () => {
    decode<{ milestone: { id: string } }>(
      await rawClient.callTool({
        name: "create_milestone",
        arguments: { id: "M30", title: "embedded coverage" },
      }),
    );
    const dependency = decode<{
      item: { id: string; status: string; fields: Record<string, never> };
    }>(
      await rawClient.callTool({
        name: "create_item",
        arguments: {
          ledger_id: "tasks",
          milestone_id: "M30",
          status: "planned",
          fields: { headline: "embedded dependency" },
        },
      }),
    );
    const created = decode<{
      item: { id: string; status: string; fields: Record<string, unknown> };
    }>(
      await rawClient.callTool({
        name: "create_item",
        arguments: {
          ledger_id: "bugs",
          milestone_id: "M30",
          status: "open",
          fields: {
            headline: "tachyon leak",
            note: "in-process",
            dependsOn: [dependency.item.id],
          },
        },
      }),
    );
    expect(created.item.status).toBe("open");
    expect(created.item.fields).toEqual({
      dependsOn: [`tasks:${dependency.item.id}`],
    });

    const updated = decode<{
      item: { status: string; fields: Record<string, unknown> };
    }>(
      await rawClient.callTool({
        name: "update_item",
        arguments: {
          ledger_id: "bugs",
          item_id: created.item.id,
          status: "wip",
        },
      }),
    );
    expect(updated.item.status).toBe("wip");
    expect(updated.item.fields).toEqual({
      dependsOn: [`tasks:${dependency.item.id}`],
    });

    const compact = decode<{
      item: { fields: Record<string, unknown> };
    }>(
      await rawClient.callTool({
        name: "fetch_item",
        arguments: {
          ledger_id: "bugs",
          item_id: created.item.id,
          projection: "compact",
        },
      }),
    );
    expect(compact.item.fields["headline"]).toBe("tachyon leak");
    expect(compact.item.fields["note"]).toBeUndefined();
    expect(compact.item.fields["dependsOn"]).toEqual([`tasks:${dependency.item.id}`]);

    const full = decode<{
      item: { status: string; fields: Record<string, unknown> };
    }>(
      await rawClient.callTool({
        name: "fetch_item",
        arguments: {
          ledger_id: "bugs",
          item_id: created.item.id,
          projection: "full",
        },
      }),
    );
    expect(full.item.status).toBe("wip");
    expect(full.item.fields["note"]).toBe("in-process");
    expect(full.item.fields["dependsOn"]).toEqual([`tasks:${dependency.item.id}`]);

    const hits = await client.ftsSearch("tachyon", "compact");
    expect(hits.some((hit) => hit.item.id === created.item.id)).toBe(true);
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
