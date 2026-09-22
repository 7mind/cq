import { expect, test } from "bun:test";
import { InMemoryLedgerStore, RemoteLedgerClient } from "@cq/ledger";
import { attachMcpHttp } from "../src/main.js";

test("remote cohort metadata is ordinary, investigation effects are management-only and executor-unavailable [Behavioral-Active Blackbox-GoodCommunication]", async () => {
  const store = new InMemoryLedgerStore();
  await store.init();
  const before = await store.workCohortStore().snapshot();
  const handlers = attachMcpHttp(store, "cohort-advance", "", undefined, undefined, undefined,
    undefined, undefined, "full", undefined, { ordinaryToken: "ordinary", managementToken: "management" });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => {
    const url = new URL(request.url); url.pathname = "/mcp";
    return handlers.handle(new Request(url, request));
  } });
  const clients: RemoteLedgerClient[] = [];
  try {
    for (const token of ["ordinary", "management"]) {
      const client = await RemoteLedgerClient.connect({ serverUrl: server.url.origin, projectKey: "cohort-advance", token });
      clients.push(client);
      const status = await client.callToolRaw("get_cohort_status", {});
      expect(status).toMatchObject({ executor: "unavailable", status: { counters: { observations: 0 } }, readyBoundaries: [] });
      const request = client.callToolRaw("cohort_investigation_advance", {
        input: { operation: "collect", planDigest: "0".repeat(64) },
      });
      if (token === "ordinary") await expect(request).rejects.toThrow();
      else expect(await request).toEqual({ state: "executor-unavailable" });
    }
    expect(await store.workCohortStore().snapshot()).toEqual(before);
  } finally {
    for (const client of clients) await client.close();
    await server.stop(true);
    await store.dispose();
  }
});
