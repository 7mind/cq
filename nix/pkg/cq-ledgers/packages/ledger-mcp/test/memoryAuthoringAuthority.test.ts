/**
 * G192/T6628 — memory authoring authority through every public MCP surface.
 *
 * Direct tool handlers, the stdio server (over an in-memory transport), and
 * HTTP sessions (ordinary vs management bearer) each run the same cases over
 * one shared store: ordinary fact writes succeed, every rule/environment
 * operation under ordinary authority rejects with no observable effect, and
 * the management equivalents succeed.
 *
 * G192/T6630 adds `execute_finalize`: an ordinary batch with a close before a
 * sweep carrying a rule or environment rejects with nothing applied, and the
 * management batch archives with its legacy fact normalized.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "bun:test";
import {
  DECISIONS_LEDGER,
  InMemoryLedgerStore,
  MEMORIES_LEDGER,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  buildBackupDump,
  createLedgerMcpTools,
  createManagementLedgerMcpTools,
  parseBackupDump,
  readWorksetRootsEpoch,
  type Item,
} from "@cq/ledger";
import { memoryFields, physicalMemories, rewriteMemoriesDump } from "../../ledger/test/memoryKindStoreContract.js";
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

const LEGACY_TS = "2026-01-02T03:04:05.000Z";

/**
 * An open milestone with a terminal decision, a legacy (kind-less) fact, and a
 * `kind` memory, imported through a dump: the only way a memory leaves M-AMBIENT.
 */
async function seedFinalizeMilestone(
  store: InMemoryLedgerStore,
  kind: string,
): Promise<{ milestoneId: string; legacyId: string; automaticId: string }> {
  const milestone = await store.createMilestone({ title: "finalize authority milestone" });
  const decision = await store.createItem(DECISIONS_LEDGER, milestone.id, {
    status: "proposed",
    fields: { headline: "sibling decision" },
  });
  await store.updateItem(DECISIONS_LEDGER, decision.id, { status: "superseded" });
  const memory = (id: string, memoryKind: string | null): Item => ({
    id,
    milestoneId: milestone.id,
    status: "superseded",
    fields: memoryFields(`milestone memory ${id}`, memoryKind),
    createdAt: LEGACY_TS,
    updatedAt: LEGACY_TS,
    author: "legacy-author",
    session: "legacy-session",
  });
  const dump = await rewriteMemoriesDump(store, (ledger) => {
    ledger.milestones.push({
      id: milestone.id,
      title: "",
      description: "",
      items: [memory("MEM70", null), memory("MEM71", kind)],
    });
  });
  await store.replaceFromParsedDump(parseBackupDump(dump));
  return { milestoneId: milestone.id, legacyId: "MEM70", automaticId: "MEM71" };
}

function closeThenArchive(milestoneId: string) {
  return {
    operations: [
      { id: `close-milestone:${milestoneId}`, target_id: milestoneId, action: "close-milestone", target_status: "done" },
      { id: `archive-milestone:${milestoneId}`, target_id: milestoneId, action: "archive-milestone", summary: "finalized" },
    ],
  };
}

const SEEDED_LOG = { path: "raw/20260929T000000Z-finalize-authority.jsonl", content: '{"turn":1}\n' };

async function storedLogs(store: InMemoryLedgerStore): Promise<Array<{ path: string; content: string }>> {
  const entries: Array<{ path: string; content: string }> = [];
  for await (const entry of store.listLogs()) entries.push(entry);
  return entries;
}

async function worksetRoots(store: InMemoryLedgerStore) {
  const worksetStore = store.worksetStore?.();
  if (worksetStore === undefined) throw new Error("expected a workset store");
  return readWorksetRootsEpoch(worksetStore);
}

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

      it(`ordinary execute_finalize with a swept ${kind} rejects the whole batch; management archives`, async () => {
        const pair = await buildPair();
        try {
          const { ordinary, management, store } = pair;
          const { milestoneId, legacyId, automaticId } = await seedFinalizeMilestone(store, kind);
          await store.putLog(SEEDED_LOG.path, SEEDED_LOG.content);
          const before = await store.exportPhysicalLedgerState();
          const rootsBefore = await worksetRoots(store);
          const logsBefore = await storedLogs(store);
          expect(logsBefore).toEqual([SEEDED_LOG]);

          const rejected = await ordinary("execute_finalize", closeThenArchive(milestoneId));
          expect(rejected.isError).toBe(true);
          expect(rejected.text).toContain(MANAGEMENT_REQUIRED);
          expect(rejected.text).toContain(automaticId);
          expect(await store.exportPhysicalLedgerState()).toEqual(before);
          expect(await worksetRoots(store)).toEqual(rootsBefore);
          expect(await storedLogs(store)).toEqual(logsBefore);
          expect(store.fetchItem(MILESTONES_LEDGER, milestoneId).status).toBe("open");

          await expectOk(management("execute_finalize", closeThenArchive(milestoneId)));
          const archived = (await physicalMemories(store)).archived;
          const kinds = Object.fromEntries(archived.map((item) => [item.id, item.fields["kind"]]));
          expect(kinds).toEqual({ [legacyId]: "fact", [automaticId]: kind });
          const backup = parseBackupDump(await buildBackupDump(store, null));
          const backedUp = [...(backup.archives.get(MEMORIES_LEDGER)?.values() ?? [])].flatMap((content) =>
            content.kind === "group" ? content.milestone.items : [content.item],
          );
          expect(Object.fromEntries(backedUp.map((item) => [item.id, item.fields["kind"]]))).toEqual(kinds);
        } finally {
          await pair.close();
        }
      }, 20_000);
    }
  });
}
