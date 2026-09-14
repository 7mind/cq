import { SQL } from "bun";
import { describe, expect, test, spyOn } from "bun:test";
import { PostgresReadCache } from "../src/store/postgres/readCache.js";
import { PostgresLedgerStore } from "../src/index.js";
import { ownedLifecyclePostgresFixture } from "./ownedLifecyclePostgresFixture.js";
import { seedPostgresUnrelatedRows } from "./postgresUnrelatedRows.js";
import { LIFECYCLE_CLAIM_INPUT, LIFECYCLE_NOW, LIFECYCLE_PROVENANCE } from "./sqlitePlanLifecycleFixture.js";

interface ReadRows { readonly table: string; readonly count: number }

function observeDocumentReads<Handle extends SQL>(sql: Handle, reads: ReadRows[]): Handle {
  const observe = (statement: string, result: PromiseLike<readonly unknown[]>) => {
    const table = /\bFROM\s+(items|archived_items)\b/i.exec(statement)?.[1];
    if (table === undefined) return result;
    return (async () => {
      const rows = await result;
      reads.push({ table, count: rows.length });
      return rows;
    })();
  };
  return new Proxy(sql, {
    apply: (target, _thisArg, args) => observe((args[0] as readonly string[]).join("?"), Reflect.apply(target, target, args)),
    get: (target, property) => {
      if (property === "begin") return <Result>(callback: SQL.TransactionContextCallback<Result>) =>
        target.begin((transaction) => callback(observeDocumentReads(transaction, reads)));
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "unsafe" && typeof value === "function") return (statement: string, ...args: unknown[]) =>
        observe(statement, Reflect.apply(value, target, [statement, ...args]));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function coherenceScope(unrelated: number) {
  const fixture = await ownedLifecyclePostgresFixture();
  const dsn = process.env.CQ_TEST_PG_URL;
  if (dsn === undefined) throw new Error("PostgreSQL fixture DSN missing");
  const reads: ReadRows[] = [];
  const peer = new PostgresLedgerStore({ pool: observeDocumentReads(new SQL({ url: dsn, connection: { search_path: fixture.schema } }), reads),
    projectKey: fixture.projectKey, displayName: fixture.projectKey, now: () => LIFECYCLE_NOW });
  try {
    await seedPostgresUnrelatedRows(fixture.pool, fixture.projectKey, unrelated);
    await fixture.store.reloadCommittedState();
    await peer.init();
    const claim = await fixture.store.claimPlan(LIFECYCLE_CLAIM_INPUT);
    if (!claim.ok) throw new Error("coherence fixture claim failed");
    expect((await fixture.store.publishPlanDraft({ goalId: "G1", claimId: claim.acknowledgement.claimId, generation: 1,
      ownerFenceToken: LIFECYCLE_CLAIM_INPUT.ownerFenceToken, operationId: "coherent-publication", ...LIFECYCLE_PROVENANCE,
      manifest: { milestones: [{ key: "m", title: "coherent milestone" }], tasks: [{ key: "t", milestoneKey: "m", headline: "coherenttaskunique" }] },
    })).ok).toBe(true);
    reads.length = 0;
    await peer.invalidate("tasks");
    expect(peer.fetchItem("tasks", "T1").fields.headline).toBe("coherenttaskunique");
    expect((await peer.ftsSearch("coherenttaskunique")).map(({ item }) => item.id)).toEqual(["T1"]);
    return reads.reduce((count, read) => count + read.count, 0);
  } finally { await peer.dispose(); await fixture.dispose(); }
}

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL coherence scope [T5924 Behavioral-Active Effectual-GoodCommunication]", () => {
  test("a raw single-item update does not materialize whole cached ledgers [Glassbox-Group]", async () => {
    const fixture = await ownedLifecyclePostgresFixture();
    let restore = () => {};
    try {
      await fixture.store.createItem("ideas", "M-AMBIENT", { id: "I1", status: "open", fields: { title: "before" } });
      await seedPostgresUnrelatedRows(fixture.pool, fixture.projectKey, 20_000);
      await fixture.store.reloadCommittedState();
      const original = PostgresReadCache.prototype.ledger;
      const materialized: string[] = [];
      const spy = spyOn(PostgresReadCache.prototype, "ledger").mockImplementation(function (this: PostgresReadCache, ledgerId: string) {
        materialized.push(ledgerId);
        return original.call(this, ledgerId);
      });
      restore = () => spy.mockRestore();
      await fixture.store.updateItem("ideas", "I1", { fields: { title: "after" } });
      expect(fixture.store.fetchItem("ideas", "I1").fields.title).toBe("after");
      expect(materialized).toEqual([]);
    } finally { restore(); await fixture.dispose(); }
  }, 30_000);

  test("postgres lifecycle projection is invariant to unrelated volume", async () => {
    const small = await coherenceScope(0);
    const large = await coherenceScope(20_000);
    if (large !== small) console.info(`T5924 reproduced: peer invalidation reads ${small} documents in the small fixture and ${large} with unrelated volume`);
    expect(large).toBe(small);
  }, 30_000);
});
