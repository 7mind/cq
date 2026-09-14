import { describe, expect, test } from "bun:test";
import { InMemoryLedgerStore, recordProtectedImplementationAdoption } from "../src/index.js";
import { sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";
import { ownedLifecyclePostgresFixture } from "./ownedLifecyclePostgresFixture.js";
import { publishAdoptionTask } from "./implementationAdoptionTestSupport.js";

const HEAD = "c".repeat(40);

test("adoption rejects changed task content even when timestamps coincide [Behavioral-Active Blackbox-GoodCommunication]", async () => {
  const fixture = await sqlitePlanLifecycleFixture();
  try {
    const { authority, record } = await publishAdoptionTask(fixture.store);
    await fixture.store.updateItem("tasks", "T1", { fields: { headline: "changed task requirements" } });
    const changed = fixture.store.fetchItem("tasks", "T1");
    expect(changed.updatedAt).toBe(record.expectedTaskUpdatedAt);
    await expect(recordProtectedImplementationAdoption(fixture.store, authority, record))
      .rejects.toThrow("task revision changed");
    expect(fixture.store.fetchItem("tasks", "T1")).toEqual(changed);
  } finally { await fixture.dispose(); }
});

for (const backend of ["memory", "sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !process.env.CQ_TEST_PG_URL)(
    `operator adoption task transaction — ${backend} [Behavioral-Active Blackbox-${backend === "memory" ? "Atomic" : "GoodCommunication"}]`, () => {
      test("CAS and replay bind the adopted task without manufacturing a review", async () => {
        const fixture = backend === "sqlite" ? await sqlitePlanLifecycleFixture()
          : backend === "postgres" ? await ownedLifecyclePostgresFixture()
            : await (async () => {
              const store = new InMemoryLedgerStore();
              await store.init();
              await store.createItem("goals", "M-AMBIENT", { id: "G1", status: "clarifying", fields: { title: "adoption", description: "adoption" } });
              return { store, dispose: async () => { await store.dispose(); } };
            })();
        try {
          const { store } = fixture;
          const { authority, record } = await publishAdoptionTask(store);
          const reviews = store.fetch("reviews");
          const before = store.fetchItem("tasks", "T1");
          await expect(recordProtectedImplementationAdoption(store, authority,
            { ...record, expectedTaskUpdatedAt: "2000-01-01T00:00:00.000Z" })).rejects.toThrow("task revision changed");
          expect(store.fetchItem("tasks", "T1")).toEqual(before);
          await expect(recordProtectedImplementationAdoption(store, authority,
            { ...record, finalizedManifest: "stale" })).rejects.toThrow("authority mismatch");
          await recordProtectedImplementationAdoption(store, authority, record);
          const adopted = store.fetchItem("tasks", "T1");
          expect(adopted).toMatchObject({ status: "done", fields: { resultCommit: HEAD,
            sourceRefs: [record.adoptionRef], sessionLogs: [record.validation.logPath] } });
          expect(store.fetch("reviews")).toEqual(reviews);
          await recordProtectedImplementationAdoption(store, authority, record);
          expect(store.fetchItem("tasks", "T1")).toEqual(adopted);
          await expect(recordProtectedImplementationAdoption(store, authority,
            { ...record, resultCommit: "f".repeat(40) })).rejects.toThrow("different operator adoption evidence");
          expect(store.fetch("reviews")).toEqual(reviews);
        } finally { await fixture.dispose(); }
      });
    },
  );
}
