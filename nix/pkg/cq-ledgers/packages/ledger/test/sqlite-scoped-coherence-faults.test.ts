import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { FaultableWorkerProjection } from "./searchProjectionFaultFixture.js";

test("sqlite projection recovery preserves committed mutation success and converges", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sqlite-projection-recovery-"));
  const dbPath = path.join(root, "ledger.db");
  const writer = new SqliteLedgerStore({ dbPath });
  const reader = new SqliteLedgerStore({ dbPath });
  try {
    await writer.init();
    const milestone = await writer.createMilestone({ title: "recovery" });
    const task = await writer.createItem("tasks", milestone.id, {
      status: "planned",
      fields: { headline: "before" },
    });
    await reader.init();
    const committed = await writer.updateItem("tasks", task.id, {
      fields: { headline: "committedafter" },
    });
    expect(committed.fields.headline).toBe("committedafter");
    expect(reader.fetchItem("tasks", task.id).fields.headline).toBe("committedafter");
    expect((await reader.ftsSearch("committedafter")).map((hit) => hit.item.id)).toEqual([task.id]);
    expect(await reader.ftsSearch("before")).toEqual([]);
  } finally {
    await writer.dispose();
    await reader.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const fault of ["crash", "exit", "timeout"] as const) {
  test(`local ${fault} preserves COMMIT, suppresses notification, and rebuilds before publishing [Blackbox-GoodCommunication]`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), `sqlite-local-${fault}-`));
    const injection = new FaultableWorkerProjection();
    const notifications: string[] = [];
    const store = new SqliteLedgerStore({
      dbPath: path.join(root, "ledger.db"),
      searchProjectionFactory: () => injection.projection,
      onMutation: (ledgerId) => {
        notifications.push(ledgerId);
      },
    });
    try {
      await store.init();
      const milestone = await store.createMilestone({ title: "fault" });
      const task = await store.createItem("tasks", milestone.id, {
        status: "planned",
        fields: { headline: "old" },
      });
      notifications.length = 0;
      injection.fault = fault;
      const committed = await store.updateItem("tasks", task.id, {
        fields: { headline: "afterfault" },
      });
      expect(committed.fields.headline).toBe("afterfault");
      expect(store.fetchItem("tasks", task.id).fields.headline).toBe("afterfault");
      expect(notifications).toEqual([]);
      expect(store.searchProjectionHealth().state).toBe("pending");
      if (fault === "exit")
        expect(store.searchProjectionHealth().failure).toBe("Search projection worker exited");
      expect((await store.ftsSearch("afterfault")).map((hit) => hit.item.id)).toEqual([task.id]);
      expect(notifications).toEqual(["tasks"]);
      expect(store.searchProjectionHealth()).toMatchObject({ state: "current", generation: 2 });
    } finally {
      await store.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("peer projection failure exposes a typed unavailable result, then converges before notification [Blackbox-GoodCommunication]", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sqlite-peer-projection-"));
  const dbPath = path.join(root, "ledger.db");
  const injection = new FaultableWorkerProjection();
  const writer = new SqliteLedgerStore({ dbPath });
  const reader = new SqliteLedgerStore({
    dbPath,
    searchProjectionFactory: () => injection.projection,
  });
  const notifications: string[] = [];
  try {
    await writer.init();
    const milestone = await writer.createMilestone({ title: "peer" });
    const task = await writer.createItem("tasks", milestone.id, {
      status: "planned",
      fields: { headline: "old" },
    });
    await reader.init();
    reader.subscribeProjectionChanges((ledgerId) => {
      notifications.push(ledgerId);
    });
    await writer.updateItem("tasks", task.id, { fields: { headline: "peercommitted" } });
    injection.fault = "crash";
    await expect(reader.ftsSearch("peercommitted")).rejects.toMatchObject({
      name: "ProjectionUnavailableError",
    });
    expect(reader.fetchItem("tasks", task.id).fields.headline).toBe("peercommitted");
    expect(notifications).toEqual([]);
    expect((await reader.ftsSearch("peercommitted")).map((hit) => hit.item.id)).toEqual([task.id]);
    expect(notifications).toEqual(["tasks"]);
  } finally {
    await writer.dispose();
    await reader.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("closing during a hung local projection settles the committed write without restarting [Blackbox-GoodCommunication]", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sqlite-close-projection-"));
  const dbPath = path.join(root, "ledger.db");
  const injection = new FaultableWorkerProjection();
  const store = new SqliteLedgerStore({
    dbPath,
    searchProjectionFactory: () => injection.projection,
  });
  const reopened = new SqliteLedgerStore({ dbPath });
  try {
    await store.init();
    const milestone = await store.createMilestone({ title: "close" });
    const task = await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: { headline: "old" },
    });
    injection.fault = "timeout";
    const update = store.updateItem("tasks", task.id, { fields: { headline: "survivesclose" } });
    await injection.injected.promise;
    await store.dispose();
    expect((await update).fields.headline).toBe("survivesclose");
    expect(injection.projection.health().state).toBe("closed");
    expect(injection.projection.health().generation).toBe(1);
    await reopened.init();
    expect((await reopened.ftsSearch("survivesclose")).map((hit) => hit.item.id)).toEqual([
      task.id,
    ]);
  } finally {
    await store.dispose();
    await reopened.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("notification rejection retains committed success and retries publication [Blackbox-GoodCommunication]", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sqlite-notification-retry-"));
  let reject = false;
  const notifications: string[] = [];
  const store = new SqliteLedgerStore({
    dbPath: path.join(root, "ledger.db"),
    onMutation: (ledgerId) => {
      if (reject) throw new Error("injected notification rejection");
      notifications.push(ledgerId);
    },
  });
  try {
    await store.init();
    const milestone = await store.createMilestone({ title: "notify" });
    const task = await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: { headline: "old" },
    });
    notifications.length = 0;
    reject = true;
    expect(
      (await store.updateItem("tasks", task.id, { fields: { headline: "notifiedlater" } })).fields
        .headline,
    ).toBe("notifiedlater");
    expect(notifications).toEqual([]);
    reject = false;
    expect((await store.ftsSearch("notifiedlater")).map((hit) => hit.item.id)).toEqual([task.id]);
    expect(notifications).toEqual(["tasks"]);
  } finally {
    await store.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
