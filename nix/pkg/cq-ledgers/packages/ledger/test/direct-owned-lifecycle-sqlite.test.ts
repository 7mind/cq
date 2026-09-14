import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { materializeOperatorAction, SqliteLedgerStore, supersedeOperatorAction } from "../src/index.js";
import { DIRECT_OPERATOR_INPUT, DIRECT_SUPERSEDE_INPUT, runDirectOwnedLifecycleContract, seedDirectOwnedTasks } from "./directOwnedLifecycleContract.js";
import { LIFECYCLE_NOW, sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";

runDirectOwnedLifecycleContract("real SQLite / GoodCommunication", sqlitePlanLifecycleFixture);

test("peer-process materialization and supersession commit one serial outcome [T5545 GoodCommunication]", async () => {
  const fixture = await sqlitePlanLifecycleFixture();
  const peerDeadlineMs = 10_000;
  await seedDirectOwnedTasks(fixture.store);
  const peer = spawn(process.execPath, [fileURLToPath(new URL("./directOwnedLifecyclePeer.ts", import.meta.url)),
    fixture.db.filename, JSON.stringify(DIRECT_OPERATOR_INPUT), LIFECYCLE_NOW], { env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
  const deadline = setTimeout(() => peer.kill("SIGKILL"), peerDeadlineMs);
  const lines = createInterface({ input: peer.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  let stderr = "";
  peer.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve, reject) => { peer.once("error", reject); peer.once("close", resolve); });
  try {
    expect((await iterator.next()).value).toBe("ready");
    peer.stdin.end("start\n");
    const superseded = await supersedeOperatorAction(fixture.store, DIRECT_SUPERSEDE_INPUT);
    const result = JSON.parse(String((await iterator.next()).value)) as { state: string; message?: string };
    expect(await exited, stderr).toBe(0);
    expect(superseded).toMatchObject({ task: { status: "abandoned" } });
    await fixture.store.dispose();
    await fixture.store.init();
    expect(fixture.store.fetchItem("tasks", "T1").status).toBe("abandoned");
    if (result.state === "materialized") {
      expect(fixture.store.fetchItem("operatorActions", "OA1").status).toBe("superseded");
      expect(fixture.store.fetchItem("handoffs", "HO1").status).toBe("user-action-required");
    } else {
      expect(result.state).toBe("rejected");
      expect(result.message).toContain("planned");
      expect(() => fixture.store.fetchItem("operatorActions", "OA1")).toThrow();
      expect(() => fixture.store.fetchItem("handoffs", "HO1")).toThrow();
    }
  } finally {
    clearTimeout(deadline);
    lines.close();
    if (peer.exitCode === null) peer.kill("SIGKILL");
    await exited;
    await fixture.dispose();
  }
}, 15_000);

for (const order of ["materialize-first", "supersede-first"] as const) {
  test(`materialization/supersession serialize without partial rows (${order}) [T5545]`, async () => {
    const fixture = await sqlitePlanLifecycleFixture();
    const second = new SqliteLedgerStore({ dbPath: fixture.db.filename, now: () => LIFECYCLE_NOW });
    await second.init();
    try {
      await seedDirectOwnedTasks(fixture.store);
      const materialize = () => materializeOperatorAction(fixture.store, DIRECT_OPERATOR_INPUT);
      const supersede = () => supersedeOperatorAction(second, DIRECT_SUPERSEDE_INPUT);
      const results = await Promise.allSettled(order === "materialize-first" ? [materialize(), supersede()] : [supersede(), materialize()]);
      expect(results[0]!.status).toBe("fulfilled");
      expect(results[1]!.status).toBe(order === "materialize-first" ? "fulfilled" : "rejected");
      await fixture.store.dispose();
      await fixture.store.init();
      expect(fixture.store.fetchItem("tasks", "T1").status).toBe("abandoned");
      if (order === "materialize-first") {
        expect(fixture.store.fetchItem("operatorActions", "OA1").status).toBe("superseded");
        expect(fixture.store.fetchItem("handoffs", "HO1").status).toBe("user-action-required");
      } else {
        expect(() => fixture.store.fetchItem("operatorActions", "OA1")).toThrow();
        expect(() => fixture.store.fetchItem("handoffs", "HO1")).toThrow();
      }
    } finally { await second.dispose(); await fixture.dispose(); }
  });
}
