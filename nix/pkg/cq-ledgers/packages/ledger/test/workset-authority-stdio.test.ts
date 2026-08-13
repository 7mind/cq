import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  InMemoryLedgerStore,
  WorksetInvocationAuthorityError,
  invokeWorksetFetch,
  invokeWorksetSet,
  registerLedgerStdioManagementTools,
  registerLedgerStdioTools,
} from "../src/index.js";

function server(name: string): McpServer {
  return new McpServer(
    { name, version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
}

describe("stdio workset management authority", () => {
  test("ordinary registration is observe-only; dedicated registration carries management", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const ordinary = server("ordinary-stdio");
    const management = server("management-stdio");
    registerLedgerStdioTools(ordinary, store);
    registerLedgerStdioManagementTools(management, store);
    let storeAccesses = 0;

    expect(
      await invokeWorksetFetch(ordinary, async () => {
        storeAccesses += 1;
        return "observed";
      }),
    ).toBe("observed");
    await expect(
      invokeWorksetSet(ordinary, () => {
        storeAccesses += 1;
      }),
    ).rejects.toBeInstanceOf(WorksetInvocationAuthorityError);
    await invokeWorksetSet(management, () => {
      storeAccesses += 1;
    });
    expect(storeAccesses).toBe(2);

    await ordinary.close();
    await management.close();
    await store.dispose();
  });
});
