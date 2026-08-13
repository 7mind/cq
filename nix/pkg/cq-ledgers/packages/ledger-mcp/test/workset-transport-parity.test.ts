/** T1980 one byte-exact workset contract across every management transport. */

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  createManagementLedgerMcpTools,
  InMemoryLedgerStore,
  registerLedgerStdioManagementTools,
  RemoteLedgerClient,
  TASKS_LEDGER,
  type LedgerToolSpecification,
  type WorksetRequest,
} from "@cq/ledger";
import { attachMcpHttp } from "../src/main.js";

const MANAGEMENT_TOKEN = "workset-parity-management-token";

interface WorksetTransport {
  invoke(request: WorksetRequest): Promise<string>;
  close(): Promise<void>;
}

interface WorksetTransportFactory {
  readonly name: string;
  readonly classification: string;
  open(): Promise<WorksetTransport>;
}

async function seedStore(): Promise<InMemoryLedgerStore> {
  const store = new InMemoryLedgerStore();
  await store.init();
  await store.createMilestone({ id: "M1", title: "transport parity" });
  await store.createItem(TASKS_LEDGER, "M1", {
    id: "T1",
    status: "planned",
    fields: { headline: "transport parity task" },
  });
  return store;
}

function textOf(result: unknown): string {
  const first = (result as { content?: Array<{ type?: string; text?: string }> }).content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("workset transport returned no text result");
  }
  return first.text;
}

async function connectHttp(url: string): Promise<Client> {
  const client = new Client(
    { name: "workset-transport-parity", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url)) as unknown as Transport,
  );
  return client;
}

function runWorksetTransportContract(factory: WorksetTransportFactory): void {
  describe(`${factory.name} [${factory.classification}]`, () => {
    test("returns byte-exact get/fetch and nonempty/duplicate/identical/empty set DTOs", async () => {
      const transport = await factory.open();
      try {
        const cases: Array<{ request: WorksetRequest; expected: string }> = [
          {
            request: { op: "get", projection: "id" },
            expected:
              '{"op":"get","graph":{"roots":[],"inactiveRoots":[],"nodes":[],"edges":[],"restrictive":false,"projection":"id"}}',
          },
          {
            request: { op: "fetch", roots: ["T1"], projection: "id" },
            expected:
              '{"op":"fetch","graph":{"roots":["tasks:T1"],"inactiveRoots":[],"nodes":[{"ref":"tasks:T1"}],"edges":[],"restrictive":true,"projection":"id"}}',
          },
          {
            request: { op: "set", roots: ["T1", "tasks:T1", "T1"] },
            expected:
              '{"op":"set","acknowledgement":{"roots":["tasks:T1"],"epoch":1}}',
          },
          {
            request: { op: "set", roots: ["tasks:T1"] },
            expected:
              '{"op":"set","acknowledgement":{"roots":["tasks:T1"],"epoch":2}}',
          },
          {
            request: { op: "get", projection: "id" },
            expected:
              '{"op":"get","graph":{"roots":["tasks:T1"],"inactiveRoots":[],"nodes":[{"ref":"tasks:T1"}],"edges":[],"restrictive":true,"projection":"id"}}',
          },
          {
            request: { op: "set", roots: [] },
            expected:
              '{"op":"set","acknowledgement":{"roots":[],"epoch":3}}',
          },
        ];
        for (const { request, expected } of cases) {
          expect(await transport.invoke(request), JSON.stringify(request)).toBe(expected);
        }
      } finally {
        await transport.close();
      }
    });
  });
}

runWorksetTransportContract({
  name: "direct management",
  classification: "Behavioral-Active Blackbox-Group",
  async open() {
    const store = await seedStore();
    const tool = createManagementLedgerMcpTools(store).find(
      (candidate) => candidate.name === "workset",
    ) as LedgerToolSpecification | undefined;
    if (tool === undefined) throw new Error("direct workset tool missing");
    return {
      async invoke(request) {
        return textOf(await tool.handler(request as never, null));
      },
      close: async () => store.dispose(),
    };
  },
});

runWorksetTransportContract({
  name: "stdio management",
  classification: "Behavioral-Active Blackbox-Group",
  async open() {
    const store = await seedStore();
    const server = new McpServer({ name: "workset-stdio-parity", version: "0.0.1" });
    registerLedgerStdioManagementTools(server, store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "workset-stdio-parity", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
    return {
      invoke: async (request) =>
        textOf(await client.callTool({ name: "workset", arguments: { ...request } })),
      async close() {
        await client.close();
        await server.close();
        await store.dispose();
      },
    };
  },
});

runWorksetTransportContract({
  name: "HTTP management",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  async open() {
    const store = await seedStore();
    const handlers = attachMcpHttp(
      store,
      "workset-http-parity",
      "",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "full",
      undefined,
      undefined,
      "management",
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => handlers.handle(request),
    });
    const client = await connectHttp(`http://127.0.0.1:${String(server.port)}/mcp`);
    return {
      invoke: async (request) =>
        textOf(await client.callTool({ name: "workset", arguments: { ...request } })),
      async close() {
        await client.close();
        await server.stop(true);
        await store.dispose();
      },
    };
  },
});

runWorksetTransportContract({
  name: "RemoteLedgerClient management",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  async open() {
    const store = await seedStore();
    const handlers = attachMcpHttp(
      store,
      "workset-remote-parity",
      "",
      undefined,
      "project",
      undefined,
      undefined,
      undefined,
      "full",
      undefined,
      { ordinaryToken: null, managementToken: MANAGEMENT_TOKEN },
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => handlers.handle(request),
    });
    const remote = await RemoteLedgerClient.connectManagement({
      serverUrl: `http://127.0.0.1:${String(server.port)}`,
      projectKey: "project",
      managementToken: MANAGEMENT_TOKEN,
    });
    return {
      invoke: async (request) => JSON.stringify(await remote.workset(request)),
      async close() {
        await remote.close();
        await server.stop(true);
        await store.dispose();
      },
    };
  },
});
