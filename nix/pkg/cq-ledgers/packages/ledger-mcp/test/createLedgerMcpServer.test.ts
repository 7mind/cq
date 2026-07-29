/**
 * Public-builder tests for `createLedgerMcpServer` (T378 / G45 / Q209).
 *
 * `createLedgerMcpServer({ store, displayName, toolPrefix })` is the extracted
 * public factory that `buildServer` now wraps. These tests round-trip a real
 * `@modelcontextprotocol/sdk` `McpServer` over an in-memory transport with a
 * `Client.listTools()` call (mirroring T375's stdio-tool-prefix.test.ts) and
 * assert:
 *  - a non-empty `toolPrefix` registers exactly `prefixedToolNames(prefix)`;
 *  - an omitted `toolPrefix` registers exactly the unprefixed `LEDGER_TOOL_NAMES`
 *    (the 32-tool surface), matching the legacy `buildServer` default.
 */

import { describe, it, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  InMemoryLedgerStore,
  LEDGER_TOOL_NAMES,
  NON_DISPATCH_LEDGER_TOOL_NAMES,
  prefixedToolNames,
  type DispatchCapability,
  type LedgerStore,
} from "@cq/ledger";
import { createLedgerMcpServer, InMemoryPromptArtifactStore } from "../src/main.js";

const encoder = new TextEncoder();

async function buildStore(): Promise<LedgerStore> {
  const store = new InMemoryLedgerStore();
  await store.init();
  return store;
}

/**
 * Build the server via the public factory, round-trip a Client over an
 * in-memory transport, and return the sorted list of registered tool names.
 */
async function registeredNames(toolPrefix?: string): Promise<string[]> {
  const store = await buildStore();
  const unavailable = async (): Promise<never> => {
    throw new Error("unexpected dispatch operation");
  };
  const dispatchCapability: DispatchCapability = {
    prepare: unavailable,
    fetchInput: unavailable,
    storeResult: unavailable,
    confirmCompletion: unavailable,
    abort: unavailable,
    fetch: unavailable,
  };
  const server = createLedgerMcpServer(
    toolPrefix === undefined
      ? { store, displayName: "demo", dispatchCapability }
      : { store, displayName: "demo", toolPrefix, dispatchCapability },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "create-server-test-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

describe("createLedgerMcpServer — public builder", () => {
  it("registers prefixedToolNames(prefix) for a non-empty toolPrefix", async () => {
    const names = await registeredNames("myproj");
    expect(names).toEqual([...prefixedToolNames("myproj")].sort());
    expect(names.length).toBe(LEDGER_TOOL_NAMES.length);
    expect(names.every((n) => n.startsWith("myproj_"))).toBe(true);
  });

  it("registers the unprefixed LEDGER_TOOL_NAMES (32) when toolPrefix is omitted", async () => {
    const names = await registeredNames();
    expect(names).toEqual([...LEDGER_TOOL_NAMES].sort());
    expect(names.length).toBe(LEDGER_TOOL_NAMES.length);
    expect(names).not.toContain("validate_input");
  });

  it("omits lifecycle tools before registration when no durable capability exists", async () => {
    const store = await buildStore();
    const server = createLedgerMcpServer({ store, displayName: "unsupported" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "create-server-unsupported-client", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual([...NON_DISPATCH_LEDGER_TOOL_NAMES].sort());
      expect(names).not.toContain("prepare_dispatch");
      expect(names).not.toContain("fetch_dispatch_result");
    } finally {
      await client.close();
      await store.dispose();
    }
  });

  it("threads the server-scoped dispatch capability into the registered handlers", async () => {
    const unavailable = async (): Promise<never> => {
      throw new Error("unexpected dispatch operation");
    };
    const dispatchCapability: DispatchCapability = {
      prepare: unavailable,
      fetchInput: unavailable,
      storeResult: unavailable,
      confirmCompletion: unavailable,
      abort: unavailable,
      fetch: async (handle) => ({ state: "attestation-not-found", ...handle }),
    };
    const store = await buildStore();
    const server = createLedgerMcpServer({
      store,
      displayName: "demo",
      dispatchCapability,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "create-server-dispatch-test-client", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({
        name: "fetch_dispatch_result",
        arguments: { attestationId: "attestation-1", generation: 1 },
      })) as {
        content: Array<{ type: string; text?: string }>;
      };
      expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
        state: "attestation-not-found",
        attestationId: "attestation-1",
        generation: 1,
      });
    } finally {
      await client.close();
      await store.dispose();
    }
  });

  it("serves exact prompt bytes from the injected artifact store without a config root", async () => {
    const promptTemplate = "Keep {{cq:literal}} and $ARGUMENTS unchanged.\n";
    const promptArtifactStore = new InMemoryPromptArtifactStore(
      encoder.encode(
        JSON.stringify([
          {
            roleId: "plan-advance",
            roleKind: "dispatched-subagent",
            sidecar: { schemaRoleId: "plan-advance" },
          },
        ]),
      ),
      [{ roleId: "plan-advance", bytes: encoder.encode(promptTemplate) }],
    );
    const store = await buildStore();
    const server = createLedgerMcpServer({
      store,
      displayName: "demo",
      promptArtifactStore,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "create-server-prompt-test-client", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({
        name: "fetch_prompt",
        arguments: { roleId: "plan-advance" },
      })) as {
        isError?: boolean;
        content: Array<{ type: string; text?: string }>;
      };
      expect(result.isError ?? false).toBe(false);
      const text = result.content
        .filter((entry) => entry.type === "text")
        .map((entry) => entry.text ?? "")
        .join("");
      expect(JSON.parse(text)).toMatchObject({
        roleId: "plan-advance",
        kind: "dispatched-subagent",
        promptTemplate,
      });
    } finally {
      await client.close();
      await store.dispose();
    }
  });
});
