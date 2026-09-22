import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  GOALS_LEDGER,
  SqliteLedgerStore,
  recordProtectedImplementationCompletion,
} from "../src/index.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { runImplementationCompletionFixReconciliationContract } from "./implementationCompletionFixReconciliationContract.js";
import { DIRECT_TASK_AUTHORITY, directCompletionRecord } from "./directOwnedLifecycleContract.js";
import { LIFECYCLE_PROVENANCE } from "./sqlitePlanLifecycleFixture.js";

runImplementationCompletionFixReconciliationContract("SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "cq-completion-fixes-sqlite-"));
  const store = new SqliteLedgerStore({ dbPath: join(root, "ledger.db") });
  await store.init();
  return {
    store,
    dispose: async () => {
      await store.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
});

test("SQLite malformed and missing required fix tasks retain root-caused authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "cq-completion-fixes-sqlite-controls-"));
  const dbPath = join(root, "ledger.db");
  const store = new SqliteLedgerStore({ dbPath });
  await store.init();
  try {
    const milestone = await store.createMilestone({ title: "missing fix controls" });
    await store.createItem(GOALS_LEDGER, milestone.id, {
      id: "G1", status: "building", fields: { title: "implementation", description: "implementation" },
    });
    await store.createItem("tasks", milestone.id, {
      id: "T2345", status: "wip", fields: { headline: "completion", ledgerRefs: ["defects:D1", "defects:D2"] },
    });
    await store.createItem("tasks", milestone.id, {
      id: "T9", status: "planned", fields: { headline: "malformed status" },
    });
    await store.createItem("defects", "M-AMBIENT", {
      id: "D1", status: "root-caused", fields: { headline: "missing", severity: "high", dependsOn: ["tasks:T2345"] },
    });
    await store.createItem("defects", "M-AMBIENT", {
      id: "D2", status: "root-caused", fields: { headline: "malformed", severity: "high", dependsOn: ["tasks:T2345", "tasks:T9"] },
    });
    const db = openLedgerDb(dbPath);
    try {
      db.query("UPDATE items SET fields_json = ? WHERE ledger = 'defects' AND id = 'D1'")
        .run(JSON.stringify({ headline: "missing", severity: "high", dependsOn: ["tasks:T2345", "tasks:T404"] }));
      db.query("UPDATE items SET status = 'malformed' WHERE ledger = 'tasks' AND id = 'T9'").run();
    } finally {
      db.close();
    }
    const completion = await directCompletionRecord();
    await recordProtectedImplementationCompletion(
      store,
      DIRECT_TASK_AUTHORITY,
      completion,
      LIFECYCLE_PROVENANCE,
    );
    expect(store.fetchItem("defects", "D1").status).toBe("root-caused");
    expect(store.fetchItem("defects", "D2").status).toBe("root-caused");
  } finally {
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
