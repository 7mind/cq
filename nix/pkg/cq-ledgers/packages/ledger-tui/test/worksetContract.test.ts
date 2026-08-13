import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  DEFECTS_LEDGER,
  InMemoryLedgerStore,
  QUESTIONS_LEDGER,
  TASKS_LEDGER,
} from "@cq/ledger";
import {
  runWorksetClientContract,
  WORKSET_CLIENT_CONTRACT_SEED,
  type WorksetClientContractFixture,
} from "@cq/ledger/testing/worksetClientContract";
import { createManagementLedgerMcpServer } from "@cq/ledger-mcp";
import { McpLedgerClient } from "../src/mcpClient.js";
import { FakeClient } from "./fakeClient.js";

async function buildProductionClient(): Promise<WorksetClientContractFixture> {
  const store = new InMemoryLedgerStore();
  await store.init();
  const seed = WORKSET_CLIENT_CONTRACT_SEED;
  await store.createMilestone(seed.milestone);
  await store.createItem(TASKS_LEDGER, seed.milestone.id, {
    ...seed.dependency,
    fields: { ...seed.dependency.fields },
  });
  await store.createItem(TASKS_LEDGER, seed.milestone.id, {
    ...seed.task,
    fields: {
      ...seed.task.fields,
      tags: [...seed.task.fields.tags],
      dependsOn: [...seed.task.fields.dependsOn],
    },
  });
  await store.createItem(DEFECTS_LEDGER, seed.milestone.id, {
    ...seed.defect,
    fields: { ...seed.defect.fields },
  });
  await store.createItem(QUESTIONS_LEDGER, seed.milestone.id, {
    ...seed.question,
    fields: { ...seed.question.fields },
  });

  const server = createManagementLedgerMcpServer({
    store,
    displayName: "ledger-tui-workset-contract",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const rawClient = new Client(
    { name: "ledger-tui-workset-contract", version: "0.0.1" },
    { capabilities: {} },
  );
  await rawClient.connect(clientTransport);
  const client = new McpLedgerClient(rawClient);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
      await store.dispose();
    },
  };
}

runWorksetClientContract({
  name: "ledger-tui FakeClient",
  classification: "Behavioral-Active Blackbox-Atomic",
  async build() {
    const client = new FakeClient();
    const seed = WORKSET_CLIENT_CONTRACT_SEED;
    await client.createMilestone(seed.milestone);
    await client.createItem(TASKS_LEDGER, seed.milestone.id, {
      ...seed.task,
      fields: {
        ...seed.task.fields,
        tags: [...seed.task.fields.tags],
        dependsOn: [...seed.task.fields.dependsOn],
      },
    });
    await client.createItem(TASKS_LEDGER, seed.milestone.id, {
      ...seed.dependency,
      fields: { ...seed.dependency.fields },
    });
    await client.createItem("bugs", seed.milestone.id, {
      ...seed.defect,
      fields: { ...seed.defect.fields },
    });
    await client.createItem(QUESTIONS_LEDGER, seed.milestone.id, {
      ...seed.question,
      fields: { ...seed.question.fields },
    });
    return { client, close: async () => client.close() };
  },
});

runWorksetClientContract({
  name: "ledger-tui McpLedgerClient + production ledger-mcp",
  classification: "Behavioral-Active Blackbox-Group",
  build: buildProductionClient,
});
