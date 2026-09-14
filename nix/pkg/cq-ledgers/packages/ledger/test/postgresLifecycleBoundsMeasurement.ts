import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { SQL } from "bun";
import { PostgresLedgerStore } from "../src/store/postgres/PostgresLedgerStore.js";
import { PostgresOperationQueries, type PostgresAccessRecord } from "../src/store/postgres/operationAccess.js";
import { postgresCoherenceVersion, readPostgresCoherence } from "../src/store/postgres/coherenceVector.js";
import { createWorkerSearchProjection } from "../src/search/WorkerSearchProjection.js";
import { SEARCH_PROJECTION_COMMAND_DEADLINE_MS, type SearchProjection, type SearchProjectionCommand } from "../src/search/SearchProjection.js";
import { postgresQueryPlanNodes, type ExplainNode } from "./postgresQueryPlan.js";
import { postgresKeyedFixture } from "./postgresKeyedFixture.js";
import { snapshotPostgresLifecycleRows } from "./postgresLifecycleSnapshot.js";
import { seedPostgresUnrelatedRows, seedPostgresUnrelatedPrivateRows } from "./postgresUnrelatedRows.js";
import { LIFECYCLE_NOW } from "./sqlitePlanLifecycleFixture.js";

export interface BoundsQueryPlan {
  readonly sql: string;
  readonly nodes: ReturnType<typeof postgresQueryPlanNodes>;
}

class BoundsQueryProbe {
  active = false;
  readonly plans: BoundsQueryPlan[] = [];

  wrap<Handle extends SQL>(sql: Handle): Handle {
    return new Proxy(sql, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === "begin" && typeof value === "function") return (...args: unknown[]) => {
          const index = typeof args[0] === "string" ? 1 : 0;
          const callback = args[index] as SQL.TransactionContextCallback<unknown>;
          args[index] = (transaction: Parameters<SQL.TransactionContextCallback<unknown>>[0]) => callback(this.wrap(transaction));
          return Reflect.apply(value, target, args);
        };
        if (property === "unsafe" && typeof value === "function") return async (...args: unknown[]) => {
          const statement = args[0];
          if (this.active && typeof statement === "string" && /^\s*SELECT\b/i.test(statement)) {
            const explain = await Reflect.apply(value, target, [`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`, ...args.slice(1)]) as Array<{ "QUERY PLAN": readonly { Plan: ExplainNode }[] }>;
            this.plans.push({ sql: statement.replace(/\s+/g, " ").trim(), nodes: postgresQueryPlanNodes(explain[0]!["QUERY PLAN"][0]!.Plan) });
          }
          return await Reflect.apply(value, target, args);
        };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}

class BoundsProjection implements SearchProjection {
  readonly commands: SearchProjectionCommand[] = [];
  private readonly delegate = createWorkerSearchProjection(SEARCH_PROJECTION_COMMAND_DEADLINE_MS);
  async execute(command: SearchProjectionCommand) {
    const acknowledgement = await this.delegate.execute(command);
    this.commands.push(structuredClone(command));
    return acknowledgement;
  }
  health() { return this.delegate.health(); }
}

function projectionKeys(commands: readonly SearchProjectionCommand[]): string[] {
  return commands.flatMap((command) => {
    assert.notEqual(command.kind, "snapshot", "ordinary operation rebuilt the entire search projection");
    if (command.kind !== "delta") return [];
    return command.changes.map((change) => {
      assert(change.kind === "upsert" || change.kind === "remove", "ordinary operation replaced an entire projection bucket");
      return `${change.archived ? "archived" : "active"}:${change.ledgerId}:${change.kind === "upsert" ? change.item.id : change.itemId}:${change.kind}`;
    });
  }).sort();
}

export async function postgresLifecycleBoundsFixture(unrelatedRows: number) {
  const database = await postgresKeyedFixture();
  const dsn = process.env.CQ_TEST_PG_URL;
  assert(dsn !== undefined && dsn.length > 0, "PostgreSQL bounds require a live DSN");
  const projectKey = "postgres-lifecycle-bounds";
  const accesses: PostgresAccessRecord[] = [];
  const probe = new BoundsQueryProbe();
  let writerProjection = new BoundsProjection();
  const peerProjection = new BoundsProjection();
  const createStore = () => new PostgresLedgerStore({ pool: probe.wrap(new SQL({ url: dsn, connection: { search_path: database.schema } })),
    projectKey, displayName: projectKey, now: () => LIFECYCLE_NOW,
    accessObserver: { record: (record) => accesses.push(record) }, searchProjectionFactory: () => writerProjection });
  let store = createStore();
  const peer = new PostgresLedgerStore({ pool: new SQL({ url: dsn, connection: { search_path: database.schema } }),
    projectKey, displayName: projectKey, now: () => LIFECYCLE_NOW, searchProjectionFactory: () => peerProjection });
  const queries = new PostgresOperationQueries(database.pool, projectKey, "bounds-evidence", null, () => performance.now(), null);
  const observations: {
    name: string; resultHash: string; committed: boolean; accesses: Omit<PostgresAccessRecord, "durationMs">[];
    coherence: { ledger: string; documentId: string; scope: string; kind: string }[]; projectedDocuments: string[]; versionIncrement: number;
  }[] = [];
  const diagnostics: { name: string; phases: PostgresAccessRecord[]; plans: BoundsQueryPlan[]; elapsedMs: number }[] = [];
  const dispose = async () => { await store.dispose(); await peer.dispose(); await database.dispose(); };
  try {
    await store.init();
    await store.createItem("goals", "M-AMBIENT", { id: "G1", status: "clarifying", fields: { title: "selected", description: "selected" } });
    await seedPostgresUnrelatedRows(database.pool, projectKey, unrelatedRows);
    await seedPostgresUnrelatedPrivateRows(database.pool, projectKey, unrelatedRows === 0 ? 0 : 2_000);
    if (unrelatedRows > 0) {
      await database.pool`INSERT INTO groups (project_key, ledger, id, title, description)
        SELECT ${projectKey}, 'tasks', 'M-bounds-' || n::text, '', '' FROM generate_series(1, ${unrelatedRows}::integer) AS n`;
      await database.pool`INSERT INTO archive_pointers (project_key, ledger, id, summary, title, status, archived_at)
        SELECT ${projectKey}, 'tasks', 'M-bounds-' || n::text, '', '', 'done', 'now' FROM generate_series(1, ${unrelatedRows}::integer) AS n`;
    }
    await store.reloadCommittedState();
    await peer.init();
    const warm = async () => {
      probe.active = false;
      for (const table of ["items", "groups", "archive_pointers", "archived_items", "item_references", "plan_claims", "plan_operations", "coherence_vector"]) {
        await database.pool.unsafe(`VACUUM (ANALYZE) ${table}`);
      }
      await store.reloadCommittedState();
      await peer.reloadCommittedState();
    };
    const capture = async <Result>(name: string, invoke: () => Promise<Result>, rejected: RegExp | null): Promise<Result> => {
      await peer.reconcileProjection();
      const durableBefore = rejected === null ? null : await snapshotPostgresLifecycleRows(database.pool, projectKey);
      const before = await postgresCoherenceVersion(queries);
      accesses.length = 0; probe.plans.length = 0; writerProjection.commands.length = 0; peerProjection.commands.length = 0;
      probe.active = true;
      const started = performance.now();
      let result: Result;
      try {
        result = await invoke();
        assert.equal(rejected, null, "expected operation to reject");
      } catch (error) {
        if (rejected === null) throw error;
        assert(error instanceof Error); assert.match(error.message, rejected);
        result = { name: error.name, message: error.message } as Result;
      } finally { probe.active = false; }
      const elapsedMs = performance.now() - started;
      const through = await postgresCoherenceVersion(queries);
      const entries = await readPostgresCoherence(queries, before, through);
      const coherence = entries.map(({ ledger, documentId, scope, kind }) => ({ ledger, documentId, scope, kind }));
      assert.equal(through - before, entries.length === 0 ? 0 : 1);
      assert(entries.every(({ version }) => version === through));
      if (durableBefore !== null) assert.deepEqual(await snapshotPostgresLifecycleRows(database.pool, projectKey), durableBefore, "rejected operation changed durable state");
      const privateWrites = accesses.filter(({ mode, table }) => mode === "write" && table.startsWith("plan_"))
        .flatMap(({ table, rowKeys }) => rowKeys.map((key) => `${table}:${key}`)).sort();
      assert.deepEqual(coherence.filter(({ scope, documentId }) => scope === "control" && documentId.startsWith("plan_"))
        .map(({ documentId }) => documentId).sort(), rejected === null ? privateWrites : []);
      const activeWrites = accesses.filter(({ mode, table }) => mode === "write" && table === "items").flatMap(({ rowKeys }) => rowKeys).sort();
      assert.deepEqual(coherence.filter(({ scope }) => scope === "active").map(({ ledger, documentId }) => `${ledger}:${documentId}`).sort(), rejected === null ? activeWrites : []);
      const projectedDocuments = projectionKeys(writerProjection.commands);
      const expectedDocuments = coherence.filter(({ scope }) => scope === "active" || scope === "archived").map(({ scope, ledger, documentId, kind }) => {
        const id = scope === "archived" ? (JSON.parse(documentId) as [string, string])[1] : documentId;
        return `${scope}:${ledger}:${id}:${kind === "delete" ? "remove" : "upsert"}`;
      }).sort();
      assert.deepEqual(projectedDocuments, expectedDocuments);
      await peer.reconcileProjection();
      assert.deepEqual(projectionKeys(peerProjection.commands), projectedDocuments);
      assert.equal(store.searchProjectionHealth().state, "current");
      assert.equal(peer.searchProjectionHealth().state, "current");
      const normalized = accesses.map(({ durationMs: _durationMs, ...access }) => access.table !== "workset_admissions" ? access : {
        ...access, keyedPredicate: { ...access.keyedPredicate, keys: ["current-admission"] }, rowKeys: access.rowKeys.length === 0 ? [] : ["current-admission"],
      });
      observations.push({ name, resultHash: createHash("sha256").update(JSON.stringify(result)).digest("hex"), committed: rejected === null,
        accesses: structuredClone(normalized), coherence, projectedDocuments, versionIncrement: through - before });
      diagnostics.push({ name, phases: structuredClone(accesses), plans: structuredClone(probe.plans), elapsedMs });
      return result;
    };
    return { ...database, projectKey, get store() { return store; }, peer, warm, capture, observations, diagnostics,
      restart: async () => { await store.dispose(); writerProjection = new BoundsProjection(); store = createStore(); await store.init(); }, dispose };
  } catch (error) { await dispose(); throw error; }
}

export type PostgresLifecycleBoundsFixture = Awaited<ReturnType<typeof postgresLifecycleBoundsFixture>>;
