import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { PostgresLedgerStore } from "../src/store/postgres/PostgresLedgerStore.js";
import { createDirectSearchProjection } from "../src/search/DirectSearchProjection.js";
import { createWorkerSearchProjection } from "../src/search/WorkerSearchProjection.js";
import type { SearchProjectionCommand } from "../src/search/SearchProjection.js";
import { postgresCoherenceFixture } from "./postgresCoherenceFixture.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL coherence snapshots [T5924 Behavioral-Active Effectual-GoodCommunication]", () => {
  for (const projectionFactory of [createDirectSearchProjection, createWorkerSearchProjection]) test(`cold snapshot high water catches a publication committed during the load (${projectionFactory.name})`, async () => {
    const fixture = await postgresCoherenceFixture();
    const dsn = process.env.CQ_TEST_PG_URL;
    if (dsn === undefined) throw new Error("snapshot race requires PostgreSQL DSN");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let armed = true;
    function wrap<Handle extends SQL>(sql: Handle): Handle {
      let readOnly = false;
      return new Proxy(sql, {
        apply: (target, _thisArg, args) => {
          const result = Reflect.apply(target, target, args);
          const statement = (args[0] as readonly string[]).join("?");
          if (!armed || !readOnly || !statement.includes("SELECT * FROM items")) return result;
          armed = false;
          return (async () => { const rows = await result; entered.resolve(); await release.promise; return rows; })();
        },
        get: (target, property) => {
          if (property === "begin") return <Result>(callback: SQL.TransactionContextCallback<Result>) => target.begin((tx) => callback(wrap(tx)));
          const value = Reflect.get(target, property, target) as unknown;
          if (property === "unsafe" && typeof value === "function") return (statement: string, ...args: unknown[]) => {
            if (statement.startsWith("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")) readOnly = true;
            return Reflect.apply(value, target, [statement, ...args]);
          };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
    const projection = projectionFactory(1_000);
    const commands: SearchProjectionCommand[] = [];
    const reader = new PostgresLedgerStore({ pool: wrap(new SQL({ url: dsn, connection: { search_path: fixture.schema } })),
      projectKey: fixture.projectKey, displayName: fixture.projectKey, searchProjectionFactory: () => ({
        execute: (command) => { commands.push(structuredClone(command)); return projection.execute(command); }, health: () => projection.health(),
      }) });
    const opening = reader.init();
    try {
      await entered.promise;
      await fixture.store.createItem("ideas", "M-AMBIENT", { id: "I1", status: "open", fields: { title: "publishedaftersnapshot" } });
      release.resolve();
      await opening;
      const first = commands[0];
      if (first === undefined || first.kind !== "snapshot") throw new Error("missing cold snapshot");
      expect(first.buckets.flatMap(({ items }) => items).some(({ id }) => id === "I1")).toBe(false);
      expect(reader.fetchItem("ideas", "I1").fields.title).toBe("publishedaftersnapshot");
      expect((await reader.ftsSearch("publishedaftersnapshot")).map(({ item }) => item.id)).toEqual(["I1"]);
      expect(commands.filter(({ kind }) => kind === "snapshot")).toHaveLength(1);
    } finally { release.resolve(); await opening; await reader.dispose(); await fixture.dispose(); }
  });
});
