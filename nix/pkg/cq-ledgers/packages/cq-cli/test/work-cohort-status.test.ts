import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../src/main.js";
import { useIsolatedXdgState, writeXdgConfig } from "./xdgFixture.js";
import { InMemoryLedgerStore, createLedgerStore, readCohortAdvanceStatusV1, RemoteLedgerClient } from "@cq/ledger";
import { attachMcpHttp } from "@cq/ledger-mcp";
import { observationFor } from "../../ledger/test/workCohortFixture.js";
import { queryCohortStatus, runCohortStatus, type CohortStatusQuery } from "../src/workCohortStatus.js";

useIsolatedXdgState();

test("cohort status is a read-only local CLI namespace [Behavioral-Active Blackbox-GoodCommunication]", async () => {
  const root = await mkdtemp(join(tmpdir(), "cq-cohort-status-"));
  try {
    await writeXdgConfig(root);
    const opened = await createLedgerStore(root);
    if (opened.store.workCohortStore === undefined) throw new Error("cohort state unavailable");
    const before = await opened.store.workCohortStore().snapshot();
    const out: string[] = []; const err: string[] = [];
    const result = await dispatch(["ledger", "cohort", "status", "--json", "--cwd", root], {
      out: (line) => out.push(line), err: (line) => err.push(line),
      confirm: { isTty: false, out: () => {}, err: () => {}, prompt: async () => { throw new Error("status cannot request confirmation"); } },
    });
    expect(err).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ executor: "unavailable", status: { definitions: [], resumeRequired: false } });
    expect(await opened.store.workCohortStore().snapshot()).toEqual(before);
    await opened.store.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const transport of ["memory", "http"] as const) {
  test(`cohort status preserves authoritative counters without granting effects ${transport} [Behavioral-Active Blackbox-${transport === "memory" ? "Group" : "GoodCommunication"}]`, async () => {
    const ledger = new InMemoryLedgerStore(); await ledger.init();
    const cohorts = ledger.workCohortStore();
    await cohorts.recordObservation("status-observation", await observationFor([{ ref: "tasks:T1" }]));
    const before = await cohorts.snapshot();
    const root = await mkdtemp(join(tmpdir(), "cq-cohort-remote-status-"));
    const previous = process.env["CQ_LEDGER_REMOTE_TOKEN"];
    let server: ReturnType<typeof Bun.serve> | null = null;
    let client: RemoteLedgerClient | null = null;
    try {
      let query: CohortStatusQuery;
      if (transport === "memory") query = async () => ({ executor: "unavailable", status: await readCohortAdvanceStatusV1(cohorts) });
      else {
        const handlers = attachMcpHttp(ledger, "cohort-status", "", undefined, undefined, undefined, undefined, undefined,
          "full", undefined, { ordinaryToken: "ordinary", managementToken: "management" });
        server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => {
          const url = new URL(request.url); url.pathname = "/mcp";
          return handlers.handle(new Request(url, request));
        } });
        await writeFile(join(root, "cq.toml"), `[ledger]\nbackend = "remote"\nserverUrl = "${server.url.origin}"\nprojectId = "cohort-status"\n`);
        process.env["CQ_LEDGER_REMOTE_TOKEN"] = "ordinary";
        query = queryCohortStatus;
        client = await RemoteLedgerClient.connect({ serverUrl: server.url.origin, projectKey: "cohort-status", token: "ordinary" });
        await expect(client.callToolRaw("cohort_advance", { operation: "observe", operation_id: "forbidden", plan: {} })).rejects.toThrow();
      }
      const out: string[] = []; const err: string[] = [];
      expect(await runCohortStatus(["cohort", "status", "--json", "--cwd", root],
        { out: (line) => out.push(line), err: (line) => err.push(line) }, "/unused", query)).toEqual({ exitCode: 0 });
      expect(err).toEqual([]);
      expect(JSON.parse(out[0]!)).toMatchObject({ executor: "unavailable", status: { counters: { observations: 1, admissions: 0, fullGateReceipts: 0 } } });
      expect(await cohorts.snapshot()).toEqual(before);
    } finally {
      if (client !== null) await client.close();
      if (server !== null) await server.stop(true);
      if (previous === undefined) delete process.env["CQ_LEDGER_REMOTE_TOKEN"]; else process.env["CQ_LEDGER_REMOTE_TOKEN"] = previous;
      await ledger.dispose(); await rm(root, { recursive: true, force: true });
    }
  });
}

test("cohort status rejects effect arguments and malformed service counters [Behavioral-Active Blackbox-Atomic]", async () => {
  for (const argv of [["cohort", "resume", "--json"], ["cohort", "status"],
    ["cohort", "status", "--json", "--execution-epoch", "caller"], ["cohort", "status", "--json", "--cwd"]]) {
    let queried = false; const errors: string[] = [];
    const outcome = await runCohortStatus(argv, { out: () => {}, err: (line) => errors.push(line) }, "/test",
      async () => { queried = true; return null; });
    expect(outcome.exitCode).toBe(2); expect(queried).toBe(false); expect(errors).toHaveLength(1);
  }
  const output: string[] = []; const errors: string[] = [];
  expect(await runCohortStatus(["cohort", "status", "--json"], { out: (line) => output.push(line), err: (line) => errors.push(line) },
    "/test", async () => ({ executor: "unavailable", status: { definitions: [], resumeRequired: false, counters: { gates: -1 } } }))).toEqual({ exitCode: 1 });
  expect(output).toEqual([]); expect(errors[0]).toContain("measured counters");
});
