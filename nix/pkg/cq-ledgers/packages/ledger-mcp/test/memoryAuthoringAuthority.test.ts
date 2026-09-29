/**
 * G192/T6628 — memory authoring authority through every public MCP surface.
 *
 * Direct tool handlers, the stdio server (over an in-memory transport), and
 * HTTP sessions (ordinary vs management bearer) each run the same cases over
 * one shared store: ordinary fact writes succeed, every rule/environment
 * operation under ordinary authority rejects with no observable effect, and
 * the management equivalents succeed.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "bun:test";
import {
  InMemoryLedgerStore,
  MEMORIES_LEDGER,
  MILESTONES_AMBIENT_ID,
  createLedgerMcpTools,
  createManagementLedgerMcpTools,
} from "@cq/ledger";
import {
  attachMcpHttp,
  createLedgerMcpServer,
  createManagementLedgerMcpServer,
} from "../src/main.js";

const MANAGEMENT_REQUIRED = "requires management authority";
const ORDINARY_TOKEN = "ordinary-memory-secret";
const MANAGEMENT_TOKEN = "management-memory-secret";

interface ToolOutcome {
  readonly isError: boolean;
  readonly text: string;
}

type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;

interface SurfacePair {
  readonly store: InMemoryLedgerStore;
  readonly ordinary: CallTool;
  readonly management: CallTool;
  close(): Promise<void>;
}

function outcomeOf(result: unknown): ToolOutcome {
  const response = result as { isError?: boolean; content: Array<{ type: string; text?: string }> };
  const text = response.content.find(({ type }) => type === "text")?.text;
  if (text === undefined) throw new Error("expected a text MCP response");
  return { isError: response.isError === true, text };
}

function clientCaller(client: Client): CallTool {
  return async (name, args) => outcomeOf(await client.callTool({ name, arguments: args }));
}

async function directPair(): Promise<SurfacePair> {
  const store = new InMemoryLedgerStore();
  await store.init();
  const caller = (tools: ReturnType<typeof createLedgerMcpTools>): CallTool => async (name, args) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`tool not found: ${name}`);
    try {
      return outcomeOf(await tool.handler(args as never, null));
    } catch (error) {
      return { isError: true, text: error instanceof Error ? error.message : String(error) };
    }
  };
  return {
    store,
    ordinary: caller(createLedgerMcpTools(store)),
    management: caller(createManagementLedgerMcpTools(store)),
    close: () => store.dispose(),
  };
}

async function stdioPair(): Promise<SurfacePair> {
  const store = new InMemoryLedgerStore();
  await store.init();
  const connect = async (server: ReturnType<typeof createLedgerMcpServer>): Promise<Client> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "memory-authority-stdio", version: "0.0.1" }, { capabilities: {} });
    await client.connect(clientTransport);
    return client;
  };
  const ordinary = await connect(createLedgerMcpServer({ store, displayName: "memory-authority" }));
  const management = await connect(
    createManagementLedgerMcpServer({ store, displayName: "memory-authority" }),
  );
  return {
    store,
    ordinary: clientCaller(ordinary),
    management: clientCaller(management),
    async close() {
      await ordinary.close();
      await management.close();
      await store.dispose();
    },
  };
}

async function httpPair(): Promise<SurfacePair> {
  const store = new InMemoryLedgerStore();
  await store.init();
  const handlers = attachMcpHttp(
    store,
    "memory-authority-http",
    "",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { ordinaryToken: ORDINARY_TOKEN, managementToken: MANAGEMENT_TOKEN },
  );
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handlers.handle(request) });
  const connect = async (token: string): Promise<Client> => {
    const client = new Client({ name: "memory-authority-http", version: "0.0.1" }, { capabilities: {} });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(server.port)}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }) as unknown as Transport,
    );
    return client;
  };
  const ordinary = await connect(ORDINARY_TOKEN);
  const management = await connect(MANAGEMENT_TOKEN);
  return {
    store,
    ordinary: clientCaller(ordinary),
    management: clientCaller(management),
    async close() {
      await ordinary.close();
      await management.close();
      await server.stop(true);
      await store.dispose();
    },
  };
}

async function expectOk(call: Promise<ToolOutcome>): Promise<{ item: { id: string; status: string } }> {
  const outcome = await call;
  if (outcome.isError) throw new Error(`expected success, got: ${outcome.text}`);
  return JSON.parse(outcome.text) as { item: { id: string; status: string } };
}

function createMemory(call: CallTool, title: string, kind: string | null) {
  return call("create_item", {
    ledger_id: MEMORIES_LEDGER,
    milestone_id: MILESTONES_AMBIENT_ID,
    status: "active",
    fields: { title, content: `${title} body`, ...(kind === null ? {} : { kind }) },
    author: "author-a",
    session: "session-a",
  });
}

const sweepArgs = {
  ledger_ids: [MEMORIES_LEDGER],
  summary: "sweep memories",
  gate_policy: "fail-on-active-gate",
};

const SURFACES: ReadonlyArray<readonly [string, () => Promise<SurfacePair>]> = [
  ["direct tools", directPair],
  ["stdio server", stdioPair],
  ["HTTP sessions", httpPair],
];

for (const [surfaceName, buildPair] of SURFACES) {
  describe(`memory authoring authority — ${surfaceName}`, () => {
    it("ordinary authority writes and maintains fact memories", async () => {
      const pair = await buildPair();
      try {
        const { ordinary, store } = pair;
        const { item } = await expectOk(createMemory(ordinary, "ordinary fact", null));
        expect(store.fetchItem(MEMORIES_LEDGER, item.id).fields["kind"]).toBe("fact");
        await expectOk(createMemory(ordinary, "explicit fact", "fact"));
        await expectOk(ordinary("update_item", { ledger_id: MEMORIES_LEDGER, item_id: item.id, fields: { tags: ["t"] } }));
        await expectOk(ordinary("update_item", { ledger_id: MEMORIES_LEDGER, item_id: item.id, status: "superseded" }));
        await expectOk(ordinary("archive_terminal_items", sweepArgs));
        await expectOk(
          ordinary("unarchive_item", { ledger_id: MEMORIES_LEDGER, milestone_id: MILESTONES_AMBIENT_ID, item_id: item.id }),
        );
        await expectOk(ordinary("reopen_item", { ledger_id: MEMORIES_LEDGER, item_id: item.id, to_status: "active" }));
        expect(store.fetchItem(MEMORIES_LEDGER, item.id)).toMatchObject({
          status: "active",
          fields: { kind: "fact", tags: ["t"] },
        });
      } finally {
        await pair.close();
      }
    }, 20_000);

    for (const kind of ["rule", "environment"] as const) {
      it(`ordinary authority rejects every ${kind} operation atomically; management succeeds`, async () => {
        const pair = await buildPair();
        try {
          const { ordinary, management, store } = pair;
          const fact = (await expectOk(createMemory(management, "promotable fact", "fact"))).item;
          const live = (await expectOk(createMemory(management, `live ${kind}`, kind))).item;
          const terminal = (await expectOk(createMemory(management, `terminal ${kind}`, kind))).item;
          await expectOk(
            management("update_item", { ledger_id: MEMORIES_LEDGER, item_id: terminal.id, status: "superseded" }),
          );

          const expectRejected = async (name: string, args: Record<string, unknown>): Promise<void> => {
            const before = await store.exportPhysicalLedgerState();
            const outcome = await ordinary(name, args);
            expect(outcome.isError).toBe(true);
            expect(outcome.text).toContain(MANAGEMENT_REQUIRED);
            expect(await store.exportPhysicalLedgerState()).toEqual(before);
          };
          const update = (itemId: string, patch: Record<string, unknown>) => ({
            ledger_id: MEMORIES_LEDGER,
            item_id: itemId,
            ...patch,
          });
          await expectRejected("create_item", {
            ledger_id: MEMORIES_LEDGER,
            milestone_id: MILESTONES_AMBIENT_ID,
            status: "active",
            fields: { title: `ordinary ${kind}`, content: "body", kind },
          });
          await expectRejected("update_item", update(fact.id, { fields: { kind } }));
          await expectRejected("update_item", update(live.id, { fields: { tags: ["edited"] } }));
          await expectRejected("update_item", update(live.id, {}));
          await expectRejected("update_item", update(live.id, { author: "author-b", session: "session-b" }));
          await expectRejected("update_item", update(live.id, { status: "superseded" }));
          await expectRejected("reopen_item", { ledger_id: MEMORIES_LEDGER, item_id: terminal.id, to_status: "active" });
          await expectRejected("archive_terminal_items", sweepArgs);

          await expectOk(management("update_item", update(live.id, { fields: { tags: ["edited"] } })));
          await expectOk(management("update_item", update(fact.id, { fields: { kind } })));
          await expectOk(management("archive_terminal_items", sweepArgs));
          const unarchive = { ledger_id: MEMORIES_LEDGER, milestone_id: MILESTONES_AMBIENT_ID, item_id: terminal.id };
          await expectRejected("unarchive_item", unarchive);
          await expectOk(management("unarchive_item", unarchive));
          await expectOk(management("reopen_item", { ledger_id: MEMORIES_LEDGER, item_id: terminal.id, to_status: "active" }));
          expect(store.fetchItem(MEMORIES_LEDGER, fact.id).fields["kind"]).toBe(kind);
          expect(store.fetchItem(MEMORIES_LEDGER, terminal.id)).toMatchObject({ status: "active", fields: { kind } });
        } finally {
          await pair.close();
        }
      }, 20_000);
    }
  });
}
