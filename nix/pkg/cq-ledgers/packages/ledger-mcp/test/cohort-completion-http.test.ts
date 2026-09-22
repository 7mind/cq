import { expect, test } from "bun:test";
import { InMemoryLedgerStore, createLedgerMcpToolSpecifications, createTrustedWorksetManagementAuthority } from "@cq/ledger";
import { attachMcpHttp } from "../src/main.js";

test("cohort completion exposes metadata status without pretending a local executor exists [Behavioral-Active Blackbox-Group]", async () => {
  const store = new InMemoryLedgerStore();
  await store.init();
  try {
    const tools = createLedgerMcpToolSpecifications(store);
    expect(tools.some(({ name }) => name === "get_cohort_completion_status")).toBe(true);
    expect(tools.some(({ name }) => name === "complete_cohort")).toBe(false);
    const management = createLedgerMcpToolSpecifications(store, undefined, undefined, undefined, undefined,
      undefined, undefined, createTrustedWorksetManagementAuthority());
    expect(management.some(({ name }) => name === "complete_cohort")).toBe(true);
  } finally { await store.dispose(); }
});

test("HTTP cohort status is ordinary metadata and metadata-only completion refuses effects [Behavioral-Active Blackbox-GoodCommunication]", async () => {
  const store = new InMemoryLedgerStore(); await store.init();
  const handlers = attachMcpHttp(store, "cohort-completion", "", undefined, undefined, undefined,
    undefined, undefined, "full", undefined, { ordinaryToken: "ordinary", managementToken: "management" });
  const sessions: { token: string; id: string }[] = [];
  async function rpc(token: string, method: string, params: Record<string, unknown>, sessionId: string | null) {
    const response = await handlers.handle(new Request("http://localhost/mcp", { method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json",
        authorization: `Bearer ${token}`, ...(sessionId === null ? {} : { "mcp-session-id": sessionId }) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
    const body = await response.text();
    const line = body.split("\n").find((value) => value.startsWith("data:"));
    return { response, payload: JSON.parse(line === undefined ? body : line.slice(5)) as Record<string, unknown> };
  }
  try {
    for (const token of ["ordinary", "management"]) {
      const initialized = await rpc(token, "initialize", { protocolVersion: "2025-03-26", capabilities: {},
        clientInfo: { name: "cohort-completion-contract", version: "1" } }, null);
      const id = initialized.response.headers.get("mcp-session-id");
      if (id === null) throw new Error("HTTP initialization omitted its session");
      sessions.push({ token, id });
      const listed = await rpc(token, "tools/list", {}, id);
      const tools = (listed.payload["result"] as { tools: { name: string }[] }).tools;
      expect(tools.some(({ name }) => name === "get_cohort_completion_status")).toBe(true);
      expect(tools.some(({ name }) => name === "complete_cohort")).toBe(token === "management");
      const called = await rpc(token, "tools/call", token === "management"
        ? { name: "complete_cohort", arguments: { batch: {} } }
        : { name: "get_cohort_completion_status", arguments: { operation_id: "not-started" } }, id);
      const content = (called.payload["result"] as { content: { text: string }[] }).content;
      expect(JSON.parse(content[0]!.text)).toEqual(token === "management" ? { state: "executor-unavailable" }
        : { executor: "unavailable", handoff: null });
    }
  } finally {
    for (const session of sessions) await handlers.handle(new Request("http://localhost/mcp", { method: "DELETE",
      headers: { "mcp-session-id": session.id, authorization: `Bearer ${session.token}` } }));
    await store.dispose();
  }
});
