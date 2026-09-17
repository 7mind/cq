import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { IMPLEMENTATION_COMPLETION_REVIEW_FIELD, materializeOperatorAction, recordProtectedImplementationCompletion, SqliteLedgerStore, supersedeOperatorAction } from "../src/index.js";
import { DIRECT_OPERATOR_INPUT, DIRECT_SUPERSEDE_INPUT, DIRECT_TASK_AUTHORITY, directCompletionRecord, runDirectOwnedLifecycleContract, seedDirectOwnedTasks } from "./directOwnedLifecycleContract.js";
import { LIFECYCLE_NOW, LIFECYCLE_PROVENANCE, sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";

runDirectOwnedLifecycleContract("real SQLite / GoodCommunication", sqlitePlanLifecycleFixture);

test("malformed, missing, substituted, foreign, and changed completion bindings fail closed without writes", async () => {
  const cases = [
    { name: "malformed", expected: "binding is malformed", mutate: "malformed" },
    { name: "missing review", expected: "binding is missing its review", mutate: "missing" },
    { name: "substituted review", expected: "belongs to different evidence", mutate: "substituted" },
    { name: "foreign review", expected: "belongs to different evidence", mutate: "foreign" },
    { name: "changed evidence", expected: "belongs to different evidence", mutate: "evidence" },
  ] as const;
  for (const scenario of cases) {
    const fixture = await sqlitePlanLifecycleFixture();
    try {
      await seedDirectOwnedTasks(fixture.store);
      const completion = await directCompletionRecord();
      await recordProtectedImplementationCompletion(fixture.store, DIRECT_TASK_AUTHORITY, completion, LIFECYCLE_PROVENANCE);
      if (scenario.mutate === "substituted") {
        const task = fixture.store.fetchItem("tasks", "T2345");
        await fixture.store.createItem("reviews", task.milestoneId, {
          id: "R2",
          status: "go-ahead",
          fields: { summary: "unrelated review", ledgerRefs: ["goals:G1"] },
        });
      }
      const targetLedger = scenario.mutate === "foreign" || scenario.mutate === "evidence" ? "reviews" : "tasks";
      const targetId = targetLedger === "reviews" ? "R1" : "T2345";
      const fields = { ...fixture.store.fetchItem(targetLedger, targetId).fields };
      if (scenario.mutate === "malformed") fields[IMPLEMENTATION_COMPLETION_REVIEW_FIELD] = "not-a-review-ref";
      if (scenario.mutate === "missing") fields[IMPLEMENTATION_COMPLETION_REVIEW_FIELD] = "reviews:R999";
      if (scenario.mutate === "substituted") fields[IMPLEMENTATION_COMPLETION_REVIEW_FIELD] = "reviews:R2";
      if (scenario.mutate === "foreign") fields["ledgerRefs"] = ["tasks:T999", "goals:G999"];
      if (scenario.mutate === "evidence") fields["implementationEvidence"] = "{}";
      fixture.db.query("UPDATE items SET fields_json = ? WHERE ledger = ? AND id = ?")
        .run(JSON.stringify(fields), targetLedger, targetId);
      const snapshot = () => ({
        ledgers: fixture.db.query("SELECT name, item_counter FROM ledgers ORDER BY name").all(),
        items: fixture.db.query("SELECT ledger, id, status, fields_json, updated_at FROM items ORDER BY ledger, id").all(),
      });
      const before = snapshot();
      await expect(
        recordProtectedImplementationCompletion(fixture.store, DIRECT_TASK_AUTHORITY, completion, LIFECYCLE_PROVENANCE),
        scenario.name,
      ).rejects.toThrow(scenario.expected);
      expect(snapshot(), scenario.name).toEqual(before);
    } finally { await fixture.dispose(); }
  }
});

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
