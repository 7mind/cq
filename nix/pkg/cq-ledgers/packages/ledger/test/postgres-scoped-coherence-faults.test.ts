import type { SQL } from "bun";
import { describe, expect, test, spyOn } from "bun:test";
import { ProjectionUnavailableError } from "../src/search/SearchProjectionRecovery.js";
import { postgresCoherenceFixture, postgresCoherenceFixtureWithPool } from "./postgresCoherenceFixture.js";
import { LIFECYCLE_CLAIM_INPUT } from "./sqlitePlanLifecycleFixture.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL committed projection recovery [T5924 Behavioral-Active Effectual-GoodCommunication]", () => {
  test("invalidation arriving during projection shutdown is a no-op", async () => {
    const fixture = await postgresCoherenceFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const execute = fixture.writerProjection.projection.execute.bind(fixture.writerProjection.projection);
    const spy = spyOn(fixture.writerProjection.projection, "execute").mockImplementation(async (command) => {
      if (command.kind === "close") { entered.resolve(); await release.promise; }
      return execute(command);
    });
    const closing = fixture.store.dispose();
    try {
      await entered.promise;
      await fixture.store.invalidate("goals");
    } finally { release.resolve(); await closing; spy.mockRestore(); await fixture.dispose(); }
  });

  test("a delayed projection cannot make the next raw update overwrite already committed fields", async () => {
    let armed = false;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    function wrap<Handle extends SQL>(sql: Handle): Handle {
      return new Proxy(sql, { get: (target, property) => {
        if (property === "begin") return <Result>(callback: SQL.TransactionContextCallback<Result>) => target.begin((tx) => callback(wrap(tx)));
        const value = Reflect.get(target, property, target) as unknown;
        if (property === "unsafe" && typeof value === "function") return (statement: string, ...args: unknown[]) => {
          const result = Reflect.apply(value, target, [statement, ...args]);
          if (!armed || !statement.startsWith("SELECT version FROM coherence_state")) return result;
          armed = false;
          return (async () => { const rows = await result; entered.resolve(); await release.promise; return rows; })();
        };
        return typeof value === "function" ? value.bind(target) : value;
      } });
    }
    const fixture = await postgresCoherenceFixtureWithPool(wrap);
    let first: Promise<unknown> | null = null;
    let second: Promise<unknown> | null = null;
    try {
      await fixture.store.createItem("ideas", "M-AMBIENT", { id: "I1", status: "open", fields: { title: "initial", description: "initial" } });
      armed = true;
      first = fixture.store.updateItem("ideas", "I1", { fields: { title: "committedfirst" } });
      await entered.promise;
      second = fixture.store.updateItem("ideas", "I1", { fields: { description: "committedsecond" } });
      const deadline = Date.now() + 3_000;
      let committed = false;
      while (Date.now() < deadline) {
        const rows = await fixture.pool<{ fields_json: string }[]>`SELECT fields_json FROM items
          WHERE project_key = ${fixture.projectKey} AND ledger = 'ideas' AND id = 'I1'`;
        if (rows[0] !== undefined && JSON.parse(rows[0].fields_json).description === "committedsecond") { committed = true; break; }
        await Bun.sleep(5);
      }
      expect(committed).toBe(true);
      release.resolve();
      await Promise.all([first, second]);
      expect(fixture.store.fetchItem("ideas", "I1").fields).toMatchObject({ title: "committedfirst", description: "committedsecond" });
    } finally { release.resolve(); await Promise.all([first, second]); await fixture.dispose(); }
  });

  for (const fault of ["crash", "exit", "timeout"] as const) test(`${fault} preserves the domain result and cache but defers notifications until recovery`, async () => {
    const fixture = await postgresCoherenceFixture();
    try {
      fixture.clear();
      const before = await fixture.version();
      fixture.writerProjection.fault = fault;
      expect((await fixture.store.claimPlan(LIFECYCLE_CLAIM_INPUT)).ok).toBe(true);
      expect(await fixture.version()).toBe(before + 1);
      expect(fixture.store.fetchItem("goals", "G1").status).toBe("planning");
      expect(fixture.notifications.writer).toEqual([]);
      expect(fixture.store.searchProjectionHealth().state).toBe("pending");
      await fixture.store.reconcileProjection();
      expect(fixture.store.searchProjectionHealth()).toMatchObject({ state: "current", generation: 2 });
      expect(fixture.writerProjection.commands.some(({ kind }) => kind === "snapshot")).toBe(true);
      expect(fixture.notifications.writer).toEqual(["goals"]);
      await fixture.peer.invalidate("goals");
      expect(fixture.peer.fetchItem("goals", "G1")).toEqual(fixture.store.fetchItem("goals", "G1"));
    } finally { await fixture.dispose(); }
  });

  test("a failed post-commit authoritative read preserves commit and refuses a stale synchronous cache", async () => {
    let rejectProjectionReads = false;
    function wrap<Handle extends SQL>(sql: Handle): Handle {
      return new Proxy(sql, { get: (target, property) => {
        if (property === "begin") return <Result>(callback: SQL.TransactionContextCallback<Result>) => target.begin((tx) => callback(wrap(tx)));
        const value = Reflect.get(target, property, target) as unknown;
        if (property === "unsafe" && typeof value === "function") return (statement: string, ...args: unknown[]) => {
          if (rejectProjectionReads && statement.startsWith("SELECT version FROM coherence_state")) throw new Error("injected authoritative projection read failure");
          return Reflect.apply(value, target, [statement, ...args]);
        };
        return typeof value === "function" ? value.bind(target) : value;
      } });
    }
    const fixture = await postgresCoherenceFixtureWithPool(wrap);
    try {
      fixture.clear();
      rejectProjectionReads = true;
      expect((await fixture.store.claimPlan(LIFECYCLE_CLAIM_INPUT)).ok).toBe(true);
      expect(fixture.notifications.writer).toEqual([]);
      expect(() => fixture.store.fetchItem("goals", "G1")).toThrow(ProjectionUnavailableError);
      await expect(fixture.store.ftsSearch("coherent")).rejects.toBeInstanceOf(ProjectionUnavailableError);
      rejectProjectionReads = false;
      await fixture.store.reconcileProjection();
      expect(fixture.store.fetchItem("goals", "G1").status).toBe("planning");
      expect(fixture.notifications.writer).toEqual(["goals"]);
      fixture.clear();
      rejectProjectionReads = true;
      expect((await fixture.store.updateItem("goals", "G1", { fields: { title: "rawcommitted" } })).fields.title).toBe("rawcommitted");
      expect(fixture.notifications.writer).toEqual([]);
      expect(() => fixture.store.fetchItem("goals", "G1")).toThrow(ProjectionUnavailableError);
      rejectProjectionReads = false;
      await fixture.store.reconcileProjection();
      expect(fixture.store.fetchItem("goals", "G1").fields.title).toBe("rawcommitted");
    } finally { rejectProjectionReads = false; await fixture.dispose(); }
  });
});
