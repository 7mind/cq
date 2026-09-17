import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { materializeOperatorAction, recordProtectedImplementationCompletion, schemaCompatible, SqliteLedgerStore, supersedeOperatorAction, TASKS_SCHEMA, type LedgerSchema } from "../src/index.js";
import { DIRECT_OPERATOR_INPUT, DIRECT_SUPERSEDE_INPUT, DIRECT_TASK_AUTHORITY, directCompletionRecord, runDirectOwnedLifecycleContract, seedDirectOwnedTasks } from "./directOwnedLifecycleContract.js";
import { LIFECYCLE_NOW, LIFECYCLE_PROVENANCE, sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";

runDirectOwnedLifecycleContract("real SQLite / GoodCommunication", sqlitePlanLifecycleFixture);

test("D492 rollout: a candidate-created SQLite ledger remains reopenable by the previous runtime", async () => {
  const fixture = await sqlitePlanLifecycleFixture();
  try {
    const row = fixture.db.query("SELECT schema_json FROM ledgers WHERE name = 'tasks'").get() as {
      schema_json: string;
    } | null;
    expect(row).not.toBeNull();
    const persisted = JSON.parse(row!.schema_json) as LedgerSchema;
    const previousRuntimeSchema = structuredClone(TASKS_SCHEMA);
    delete previousRuntimeSchema.fields["implementationCompletionReview"];
    expect(schemaCompatible(persisted, previousRuntimeSchema)).toBe(true);
  } finally { await fixture.dispose(); }
});

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
      if (scenario.mutate === "malformed" || scenario.mutate === "missing" || scenario.mutate === "substituted") {
        const reviewRef = scenario.mutate === "malformed" ? "not-a-review-ref" :
          scenario.mutate === "missing" ? "reviews:R999" : "reviews:R2";
        fixture.db.query("UPDATE implementation_completion_bindings SET review_ref = ? WHERE task_id = ?")
          .run(reviewRef, "T2345");
      } else {
        const fields = { ...fixture.store.fetchItem("reviews", "R1").fields };
        if (scenario.mutate === "foreign") fields["ledgerRefs"] = ["tasks:T999", "goals:G999"];
        if (scenario.mutate === "evidence") fields["implementationEvidence"] = "{}";
        fixture.db.query("UPDATE items SET fields_json = ? WHERE ledger = 'reviews' AND id = 'R1'")
          .run(JSON.stringify(fields));
      }
      const snapshot = () => ({
        ledgers: fixture.db.query("SELECT name, item_counter FROM ledgers ORDER BY name").all(),
        items: fixture.db.query("SELECT ledger, id, status, fields_json, updated_at FROM items ORDER BY ledger, id").all(),
        bindings: fixture.db.query("SELECT task_id, review_ref FROM implementation_completion_bindings ORDER BY task_id").all(),
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
