import { SQL } from "bun";
import { expect } from "bun:test";
import { PostgresLedgerStore } from "../src/store/postgres/PostgresLedgerStore.js";
import { PostgresOperationQueries } from "../src/store/postgres/operationAccess.js";
import { postgresCoherenceVersion, readPostgresCoherence } from "../src/store/postgres/coherenceVector.js";
import { postgresKeyedFixture } from "./postgresKeyedFixture.js";
import { FaultableWorkerProjection } from "./searchProjectionFaultFixture.js";
import { projectedDocumentRefs } from "./lifecycleCoherenceFixture.js";
import { LIFECYCLE_NOW } from "./sqlitePlanLifecycleFixture.js";

export async function postgresCoherenceFixture() {
  return postgresCoherenceFixtureWithPool((pool) => pool);
}

export async function postgresCoherenceFixtureWithPool(wrapPool: (pool: SQL) => SQL) {
  const database = await postgresKeyedFixture();
  const dsn = process.env.CQ_TEST_PG_URL;
  if (dsn === undefined) throw new Error("PostgreSQL coherence fixture requires its DSN");
  const projectKey = "postgres-coherence";
  const writerProjection = new FaultableWorkerProjection();
  const peerProjection = new FaultableWorkerProjection();
  const store = new PostgresLedgerStore({ pool: wrapPool(database.pool), projectKey, displayName: projectKey,
    now: () => LIFECYCLE_NOW, searchProjectionFactory: () => writerProjection.projection });
  const peer = new PostgresLedgerStore({ pool: new SQL({ url: dsn, connection: { search_path: database.schema } }), projectKey,
    displayName: projectKey, now: () => LIFECYCLE_NOW, searchProjectionFactory: () => peerProjection.projection });
  const dispose = async () => { await store.dispose(); await peer.dispose(); await database.dispose(); };
  try {
    await store.init();
    await store.createItem("goals", "M-AMBIENT", { id: "G1", status: "clarifying", fields: { title: "coherent", description: "coherent" } });
    await peer.init();
    const notifications = { writer: [] as string[], peer: [] as string[] };
    store.subscribeProjectionChanges((ledgerId) => notifications.writer.push(ledgerId));
    peer.subscribeProjectionChanges((ledgerId) => notifications.peer.push(ledgerId));
    const queries = new PostgresOperationQueries(database.pool, projectKey, "test-coherence", null, () => performance.now(), null);
    const version = () => postgresCoherenceVersion(queries);
    const frame = async (after: number) => { const through = await version(); return { version: through, entries: await readPostgresCoherence(queries, after, through) }; };
    const clear = () => { writerProjection.commands.length = 0; peerProjection.commands.length = 0; notifications.writer.length = 0; notifications.peer.length = 0; };
    const capture = async <T>(invoke: () => Promise<T>, documents: readonly string[], privateKeys: readonly string[]): Promise<T> => {
      await peer.reconcileProjection(); clear();
      const before = await version();
      const result = await invoke();
      const changed = await frame(before);
      expect(changed.version).toBe(before + (documents.length + privateKeys.length === 0 ? 0 : 1));
      expect(changed.entries.filter(({ scope }) => scope === "active").map(({ ledger, documentId }) => `${ledger}:${documentId}`).sort()).toEqual([...documents].sort());
      expect(changed.entries.filter(({ scope, documentId }) => scope === "control" && documentId.startsWith("plan_")).map(({ documentId }) => documentId).sort()).toEqual([...privateKeys].sort());
      expect(changed.entries.every(({ version }) => version === changed.version)).toBe(true);
      await peer.reconcileProjection();
      for (const projection of [writerProjection, peerProjection]) expect(projectedDocumentRefs(projection.commands)).toEqual([...documents].sort());
      const ledgers = [...new Set(documents.map((ref) => ref.slice(0, ref.indexOf(":"))))].sort();
      expect([...new Set(notifications.writer)].sort()).toEqual(ledgers);
      expect([...new Set(notifications.peer)].sort()).toEqual(ledgers);
      for (const ref of documents) {
        const [ledgerId, itemId] = ref.split(":") as [string, string];
        expect(peer.fetchItem(ledgerId, itemId)).toEqual(store.fetchItem(ledgerId, itemId));
      }
      return result;
    };
    return { ...database, projectKey, store, peer, writerProjection, peerProjection, notifications, version, frame, clear, capture, dispose };
  } catch (error) { await dispose(); throw error; }
}
