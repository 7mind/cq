import { registerDom } from "./helpers/dom.js";
registerDom();

import { expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryLedgerStore, SqliteLedgerStore, readCohortAdvanceStatusV1 } from "@cq/ledger";
import { createLedgerMcpServer } from "@cq/ledger-mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { observationFor } from "../../ledger/test/workCohortFixture.js";
import { CohortStatus } from "../src/CohortStatus.js";
import { McpLedgerClient } from "../src/mcpClient.js";
import type { WorksetCapableLedgerClient } from "../src/types.js";

for (const adapter of ["memory", "sqlite-mcp"] as const) {
  test(`web cohort metadata renders measured counts without acquiring authority ${adapter} [Behavioral-Active Blackbox-${adapter === "memory" ? "Group" : "GoodCommunication"}]`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-web-cohort-status-"));
    const store = adapter === "memory" ? new InMemoryLedgerStore()
      : new SqliteLedgerStore({ dbPath: join(directory, "ledger.db") });
    await store.init();
    const cohorts = store.workCohortStore();
    await cohorts.recordObservation("web-status", await observationFor([{ ref: "tasks:T1" }]));
    const before = await cohorts.snapshot();
    let server: ReturnType<typeof createLedgerMcpServer> | null = null;
    let remote: McpLedgerClient | null = null;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      let client: Pick<WorksetCapableLedgerClient, "getCohortStatus">;
      if (adapter === "memory") client = { getCohortStatus: async () => ({
        executor: "unavailable", status: await readCohortAdvanceStatusV1(cohorts), readyBoundaries: [],
      }) };
      else {
        server = createLedgerMcpServer({ store, displayName: "web-status" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        const sdk = new Client({ name: "web-cohort-status-contract", version: "1" }, {});
        await sdk.connect(clientTransport);
        remote = new McpLedgerClient(sdk);
        client = remote;
      }
      await act(async () => { root.render(createElement(CohortStatus, { client })); });
      const deadline = Date.now() + 5_000;
      while (!container.textContent?.includes("Measured cohort counters") && Date.now() < deadline) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      }
      expect(container.textContent).toContain("Executor: unavailable");
      expect(container.textContent).toContain("Measured cohort counters");
      const observation = [...container.querySelectorAll("dt")].find((element) => element.textContent === "observations");
      expect(observation?.nextElementSibling?.textContent).toBe("1");
      expect(container.querySelectorAll("button")).toHaveLength(1);
      expect(container.querySelector("button")?.textContent).toBe("Refresh cohort status");
      expect(await cohorts.snapshot()).toEqual(before);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      if (remote !== null) await remote.close();
      if (server !== null) await server.close();
      await store.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
