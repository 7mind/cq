/**
 * Acceptance test for the core Q211(1) use case (T380 / G45):
 * TWO ledger-MCP servers co-resident in ONE process via `createLedgerMcpServer`
 * — one unprefixed (cq's own surface, `toolPrefix: ''`) and one prefixed
 * (`toolPrefix: 'myproj'`, a 3rd party) — each over its OWN
 * `InMemoryLedgerStore` (Q210: the 3rd party picks a non-conflicting store).
 *
 * Proves that the tool-prefix mechanism delivers process-level co-residency:
 *  (1) the two tools/list name sets are DISJOINT — zero collision;
 *  (2) the unprefixed set === `LEDGER_TOOL_NAMES` (27), the prefixed set ===
 *      `prefixedToolNames('myproj')`;
 *  (3) BOTH servers are functional end-to-end — a real `create_milestone` +
 *      `create_item` + `fetch_item` round-trip on EACH (the prefixed one via
 *      `myproj_*` names) returns a correct, non-error result, proving the
 *      prefixed server's handlers — not just its registrations — still work.
 *
 * Each server uses a DISTINCT in-memory store, so there is no shared state and
 * the test is deterministic across reruns.
 */

import { describe, it, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  InMemoryLedgerStore,
  LEDGER_TOOL_NAMES,
  prefixedToolNames,
  type LedgerStore,
} from "@cq/ledger";
import { createLedgerMcpServer } from "../src/main.js";

const MYPROJ_PREFIX = "myproj";

async function buildStore(): Promise<LedgerStore> {
  const store = new InMemoryLedgerStore();
  await store.init();
  return store;
}

/**
 * Build a server via the public factory over its own store, connect a `Client`
 * across a fresh in-memory linked transport pair, and return both. The caller
 * owns closing the client.
 */
async function connectServer(opts: {
  displayName: string;
  toolPrefix: string;
}): Promise<{ client: Client; store: LedgerStore }> {
  const store = await buildStore();
  const server = createLedgerMcpServer({
    store,
    displayName: opts.displayName,
    toolPrefix: opts.toolPrefix,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: `${opts.displayName}-test-client`, version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return { client, store };
}

/** Decode a tool result's single JSON text-content block, asserting non-error. */
function decode<T>(result: unknown): T {
  const r = result as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  expect(r.isError ?? false).toBe(false);
  const first = r.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected single text content block");
  }
  return JSON.parse(first.text) as T;
}

/** Maybe-prefix a bare tool name for a given prefix ('' → no prefix). */
function toolName(prefix: string, bare: string): string {
  return prefix === "" ? bare : `${prefix}_${bare}`;
}

/**
 * Drive a full create_milestone → create_item → fetch_item round-trip against
 * one server through its (possibly prefixed) tool names, asserting each step
 * returns a correct, non-error result. Proves the handlers are live.
 */
async function exerciseRoundTrip(client: Client, prefix: string): Promise<void> {
  const ms = decode<{ milestone: { id: string } }>(
    await client.callTool({
      name: toolName(prefix, "create_milestone"),
      arguments: { id: "M1", title: "co-resident round-trip" },
    }),
  );
  expect(ms.milestone.id).toBe("M1");

  const created = decode<{ item: { id: string; status: string } }>(
    await client.callTool({
      name: toolName(prefix, "create_item"),
      arguments: {
        ledger_id: "tasks",
        milestone_id: "M1",
        status: "planned",
        fields: { headline: "exercise the handlers" },
      },
    }),
  );
  expect(created.item.status).toBe("planned");
  const itemId = created.item.id;

  const fetched = decode<{ item: { id: string; status: string } }>(
    await client.callTool({
      name: toolName(prefix, "fetch_item"),
      arguments: { ledger_id: "tasks", item_id: itemId },
    }),
  );
  expect(fetched.item.id).toBe(itemId);
  expect(fetched.item.status).toBe("planned");
}

describe("two prefixed ledger-MCP servers in one process (T380 / Q211)", () => {
  it("registers disjoint tool-name sets and keeps both servers functional", async () => {
    // cq's own unprefixed server + a 3rd-party prefixed one, each over its OWN
    // store — two McpServers live in this single test process at once.
    const cqlike = await connectServer({ displayName: "cqlike", toolPrefix: "" });
    const thirdparty = await connectServer({
      displayName: "thirdparty",
      toolPrefix: MYPROJ_PREFIX,
    });
    try {
      const cqNames = (await cqlike.client.listTools()).tools
        .map((t) => t.name)
        .sort();
      const ppNames = (await thirdparty.client.listTools()).tools
        .map((t) => t.name)
        .sort();

      // (1) Zero collision: the two name sets are disjoint.
      const cqSet = new Set(cqNames);
      const intersection = ppNames.filter((n) => cqSet.has(n));
      expect(intersection).toEqual([]);

      // (2) Exact surfaces: unprefixed === LEDGER_TOOL_NAMES (27),
      //     prefixed === prefixedToolNames('myproj').
      expect(cqNames).toEqual([...LEDGER_TOOL_NAMES].sort());
      expect(cqNames.length).toBe(LEDGER_TOOL_NAMES.length);
      expect(ppNames).toEqual([...prefixedToolNames(MYPROJ_PREFIX)].sort());
      expect(ppNames.length).toBe(LEDGER_TOOL_NAMES.length);
      expect(ppNames.every((n) => n.startsWith(`${MYPROJ_PREFIX}_`))).toBe(true);

      // (3) Both functional end-to-end: a real create/create/fetch round-trip
      //     on each — the prefixed server answers through its myproj_* handlers.
      await exerciseRoundTrip(cqlike.client, "");
      await exerciseRoundTrip(thirdparty.client, MYPROJ_PREFIX);
    } finally {
      await cqlike.client.close();
      await thirdparty.client.close();
    }
  });
});
