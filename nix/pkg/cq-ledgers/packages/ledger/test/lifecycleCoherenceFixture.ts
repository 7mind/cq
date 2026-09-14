import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { createWorksetGuardedPlanLifecycleStore } from "../src/worksetPlanLifecycle.js";
import { createTrustedWorksetManagementAuthority } from "../src/index.js";
import { coherenceVersion, openLedgerDb } from "../src/store/sqlite/connection.js";
import type { SearchProjectionCommand } from "../src/search/SearchProjection.js";
import { FaultableWorkerProjection } from "./searchProjectionFaultFixture.js";
import { LIFECYCLE_NOW } from "./sqlitePlanLifecycleFixture.js";

export function projectedDocumentRefs(commands: readonly SearchProjectionCommand[]): string[] {
  const refs: string[] = [];
  for (const command of commands) {
    if (command.kind === "snapshot") throw new Error("unexpected whole-store projection snapshot");
    if (command.kind !== "delta") continue;
    for (const change of command.changes) {
      if (change.kind !== "upsert") throw new Error(`unexpected lifecycle projection change: ${change.kind}`);
      expect(change.archived).toBe(false);
      refs.push(`${change.ledgerId}:${change.item.id}`);
    }
  }
  return refs.sort();
}

export function lifecycleCoherenceGuardedStore(store: SqliteLedgerStore) {
  return createWorksetGuardedPlanLifecycleStore({
    rawStore: store, worksetStore: store.worksetStore(), invocationAuthority: createTrustedWorksetManagementAuthority(),
    runOwnedTransaction: (mutate, context) => store.runAtomicOwnedMutation(mutate, context),
    runPlanLifecycleTransaction: (context, mutate) => store.runAtomicWorksetPlanLifecycleMutation(context, mutate),
  });
}

export async function lifecycleCoherenceFixture() {
  const root = await mkdtemp(join(tmpdir(), "sqlite-lifecycle-coherence-"));
  const dbPath = join(root, "ledger.db");
  const writerProjection = new FaultableWorkerProjection();
  const peerProjection = new FaultableWorkerProjection();
  const notifications: { writer: string[]; peer: string[] } = { writer: [], peer: [] };
  const store = new SqliteLedgerStore({ dbPath, now: () => LIFECYCLE_NOW, searchProjectionFactory: () => writerProjection.projection });
  const peer = new SqliteLedgerStore({ dbPath, now: () => LIFECYCLE_NOW, searchProjectionFactory: () => peerProjection.projection });
  await store.init();
  await store.createItem("goals", "M-AMBIENT", { id: "G1", status: "clarifying", fields: { title: "lifecycle", description: "coherent lifecycle" } });
  await peer.init();
  store.subscribeProjectionChanges((ledgerId) => notifications.writer.push(ledgerId));
  peer.subscribeProjectionChanges((ledgerId) => notifications.peer.push(ledgerId));
  const db = openLedgerDb(dbPath);
  const clear = (): void => {
    writerProjection.commands.length = 0; peerProjection.commands.length = 0;
    notifications.writer.length = 0; notifications.peer.length = 0;
  };
  const capture = async <T>(operation: () => Promise<T>, documents: readonly string[], privateKeys: readonly string[]): Promise<T> => {
    await peer.reconcileProjection();
    clear();
    const before = coherenceVersion(db);
    const result = await operation();
    const frame = store.readCoherenceChanges(before);
    expect(frame.version).toBe(before + (documents.length + privateKeys.length === 0 ? 0 : 1));
    expect(frame.entries.filter(({ scope }) => scope === "active").map(({ ledger, documentId }) => `${ledger}:${documentId}`).sort()).toEqual([...documents].sort());
    expect(frame.entries.filter(({ scope }) => scope === "control").map(({ documentId }) => documentId).sort()).toEqual([...privateKeys].sort());
    expect(frame.entries.every(({ version }) => version === frame.version)).toBe(true);
    await peer.reconcileProjection();
    expect(peer.readCoherenceChanges(before)).toEqual(frame);
    for (const projection of [writerProjection, peerProjection]) expect(projectedDocumentRefs(projection.commands)).toEqual([...documents].sort());
    const ledgers = [...new Set(documents.map((ref) => ref.slice(0, ref.indexOf(":"))).concat(privateKeys.length === 0 ? [] : ["goals"]))].sort();
    expect([...new Set(notifications.writer)].sort()).toEqual(ledgers);
    expect([...new Set(notifications.peer)].sort()).toEqual(ledgers);
    return result;
  };
  return {
    store, peer, db, writerProjection, peerProjection, notifications, clear, capture,
    dispose: async () => { db.close(); await store.dispose(); await peer.dispose(); await rm(root, { recursive: true, force: true }); },
  };
}

export interface LifecycleProjectionOperation {
  invoke(): Promise<unknown>;
  readonly documents: readonly string[];
  readonly privateKeys: readonly string[];
}

export function registerLifecycleProjectionFaults(
  label: string,
  prepare: (fixture: Awaited<ReturnType<typeof lifecycleCoherenceFixture>>) => Promise<LifecycleProjectionOperation>,
): void {
  for (const fault of ["crash", "exit", "timeout"] as const) {
    test(`${label}: ${fault} preserves commit and rebuilds before notification [T5547 GoodCommunication]`, async () => {
      const fixture = await lifecycleCoherenceFixture();
      try {
        const operation = await prepare(fixture);
        await fixture.peer.reconcileProjection();
        fixture.clear();
        const before = coherenceVersion(fixture.db);
        fixture.writerProjection.fault = fault;
        await operation.invoke();
        expect(coherenceVersion(fixture.db)).toBe(before + 1);
        const frame = fixture.store.readCoherenceChanges(before);
        expect(frame.entries.filter(({ scope }) => scope === "control").map(({ documentId }) => documentId).sort()).toEqual([...operation.privateKeys].sort());
        expect(fixture.notifications.writer).toEqual([]);
        expect(fixture.store.searchProjectionHealth().state).toBe("pending");
        await fixture.store.reconcileProjection();
        expect(fixture.store.searchProjectionHealth()).toMatchObject({ state: "current", generation: 2 });
        expect(fixture.writerProjection.commands.some(({ kind }) => kind === "snapshot")).toBe(true);
        expect(fixture.notifications.writer.length).toBeGreaterThan(0);
        await fixture.peer.reconcileProjection();
        expect(projectedDocumentRefs(fixture.peerProjection.commands)).toEqual([...operation.documents].sort());
        for (const ref of operation.documents) {
          const [ledgerId, itemId] = ref.split(":") as [string, string];
          expect(fixture.peer.fetchItem(ledgerId, itemId)).toEqual(fixture.store.fetchItem(ledgerId, itemId));
        }
      } finally { await fixture.dispose(); }
    });
  }
}
