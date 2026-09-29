/**
 * G192/T6630 — automatic-memory authority across `executeFinalize` batches,
 * offline arms (InMemory and SQLite).
 *
 * Every `archive-milestone` operation of a finalize batch runs the same
 * transaction-local memory preflight as the direct `archiveMilestone`, and
 * that preflight completes before the batch's first ordered operation is
 * applied. A recording transaction proves the ordering: a rejected batch
 * invokes no write method at all, not merely one that later rolls back.
 *
 * A memory sits outside M-AMBIENT only through an imported dump, so each
 * fixture restores a completed milestone carrying terminal memories.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  DECISIONS_LEDGER,
  InMemoryLedgerStore,
  MEMORIES_LEDGER,
  MILESTONES_LEDGER,
  MemoryManagementAuthorityRequiredError,
  SqliteLedgerStore,
  UnsupportedMemoryKindError,
  buildBackupDump,
  createObserveOnlyWorksetInvocationAuthority,
  createTrustedWorksetManagementAuthority,
  createWorksetGuardedLedger,
  createWorksetManagementLedger,
  parseBackupDump,
  readWorksetRootsEpoch,
  restoreDumpToXdg,
  type BackupDumpFile,
  type FieldValue,
  type Item,
  type LedgerStore,
  type WorksetGenericMutationGatewayHost,
  type WorksetGuardedLedger,
} from "../src/index.js";
import type { FinalizeBatchOperation } from "../src/finalize.js";
import type { WorksetGenericMutationTx } from "../src/store/genericMutationTransaction.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { memoryFields, physicalMemories, rewriteMemoriesDump } from "./memoryKindStoreContract.js";

const KIND = "kind";
const FACT = "fact";
const AUTOMATIC_KINDS = ["rule", "environment"] as const;
const UNSUPPORTED_KIND = "opinion";
const LEGACY_TS = "2026-01-02T03:04:05.000Z";
const TIMEOUT_MS = 20_000;
const SEEDED_LOG = { path: "raw/20260929T000000Z-finalize-authority.jsonl", content: '{"turn":1}\n' };
const TX_WRITE_METHODS: ReadonlySet<string> = new Set([
  "updateMilestone",
  "updateItem",
  "createItem",
  "createMilestone",
  "createLedger",
  "reopenItem",
  "unarchiveItem",
  "archiveTerminalItems",
  "archiveMilestone",
]);

const directories: string[] = [];

afterAll(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** One backend's persistence plus the raw physical access the fixtures need. */
interface Persistence {
  readonly store: LedgerStore;
  readonly events: string[];
  /** Replace the state from `dump` through the backend's native import path. */
  restore(dump: readonly BackupDumpFile[]): Promise<Persistence>;
  /** Close and reopen over the same persistence. */
  restart(): Promise<Persistence>;
  /** Overwrite one active memory's stored fields, bypassing validation. */
  writeActiveFields(itemId: string, fields: Record<string, FieldValue>): Promise<void>;
  /** Overwrite one archived memory's stored fields, bypassing validation. */
  writeArchivedFields(itemId: string, fields: Record<string, FieldValue>): Promise<void>;
  /** Store one log artifact through the backend's own log writer. */
  putLog(relPath: string, content: string): Promise<void>;
  /** Every stored log artifact with its content, sorted by path. */
  logs(): Promise<ReadonlyArray<{ readonly path: string; readonly content: string }>>;
  /** The stored `kind` of one memory, physical absence as `undefined`. */
  storedKind(itemId: string, archived: boolean): Promise<FieldValue | undefined>;
  dispose(): Promise<void>;
}

interface Backend {
  readonly name: string;
  open(): Promise<Persistence>;
}

function inMemoryPersistence(store: InMemoryLedgerStore, events: string[]): Persistence {
  const native = store as unknown as {
    readonly ledgers: Map<string, { milestones: Array<{ items: Item[] }> }>;
    readonly archives: Map<string, { items: Item[] }>;
  };
  const find = (itemId: string, archived: boolean): Item => {
    const groups = archived
      ? [...native.archives].filter(([key]) => key.startsWith(`${MEMORIES_LEDGER}/`)).map(([, group]) => group)
      : (native.ledgers.get(MEMORIES_LEDGER)?.milestones ?? []);
    const item = groups.flatMap((group) => group.items).find((candidate) => candidate.id === itemId);
    if (item === undefined) throw new Error(`in-memory memory ${itemId} (archived=${String(archived)}) not found`);
    return item;
  };
  const persistence: Persistence = {
    store,
    events,
    async restore(dump) {
      await store.replaceFromParsedDump(parseBackupDump(dump));
      return persistence;
    },
    // The dummy has no persistence boundary; its only restart keeps its state.
    async restart() {
      return persistence;
    },
    async writeActiveFields(itemId, fields) {
      find(itemId, false).fields = structuredClone(fields);
    },
    async writeArchivedFields(itemId, fields) {
      find(itemId, true).fields = structuredClone(fields);
    },
    putLog: (relPath, content) => store.putLog(relPath, content),
    async logs() {
      const entries: Array<{ path: string; content: string }> = [];
      for await (const entry of store.listLogs()) entries.push(entry);
      return entries;
    },
    async storedKind(itemId, archived) {
      return find(itemId, archived).fields[KIND];
    },
    dispose: () => store.dispose(),
  };
  return persistence;
}

const IN_MEMORY: Backend = {
  name: "InMemoryLedgerStore",
  async open() {
    const events: string[] = [];
    const store = new InMemoryLedgerStore({ onMutation: (ledgerId, op) => events.push(`${ledgerId}/${op}`) });
    await store.init();
    return inMemoryPersistence(store, events);
  },
};

async function openSqlite(dbPath: string, logsDir: string, events: string[]): Promise<Persistence> {
  const store = new SqliteLedgerStore({
    dbPath,
    logsDir,
    onMutation: (ledgerId, op) => events.push(`${ledgerId}/${op}`),
  });
  await store.init();
  const withDb = <T>(use: (db: ReturnType<typeof openLedgerDb>) => T): T => {
    const db = openLedgerDb(dbPath);
    try {
      return use(db);
    } finally {
      db.close();
    }
  };
  return {
    store,
    events,
    async restore(dump) {
      await store.dispose();
      await restoreDumpToXdg({
        dbPath,
        logsDir: null,
        dump,
        authority: createTrustedWorksetManagementAuthority(),
        overwriteAuthorized: true,
      });
      return openSqlite(dbPath, logsDir, events);
    },
    async restart() {
      await store.dispose();
      return openSqlite(dbPath, logsDir, events);
    },
    async writeActiveFields(itemId, fields) {
      withDb((db) => {
        const result = db
          .query("UPDATE items SET fields_json = ? WHERE ledger = ? AND id = ?")
          .run(JSON.stringify(fields), MEMORIES_LEDGER, itemId);
        if (result.changes !== 1) throw new Error(`SQLite memory ${itemId} row not updated`);
      });
    },
    async writeArchivedFields(itemId, fields) {
      withDb((db) => {
        const result = db
          .query("UPDATE archived_items SET fields_json = ? WHERE ledger = ? AND id = ?")
          .run(JSON.stringify(fields), MEMORIES_LEDGER, itemId);
        if (result.changes !== 1) throw new Error(`SQLite archived memory ${itemId} row not updated`);
      });
    },
    putLog: (relPath, content) => store.putLog(relPath, content),
    async logs() {
      const files = (await readdir(logsDir, { recursive: true, withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(logsDir, path.join(entry.parentPath, entry.name)))
        .sort();
      return Promise.all(files.map(async (file) => ({ path: file, content: await readFile(path.join(logsDir, file), "utf8") })));
    },
    async storedKind(itemId, archived) {
      return withDb((db) => {
        const row = db
          .query<{ fields_json: string }, [string, string]>(
            `SELECT fields_json FROM ${archived ? "archived_items" : "items"} WHERE ledger = ? AND id = ?`,
          )
          .get(MEMORIES_LEDGER, itemId);
        if (row === null) throw new Error(`SQLite memory ${itemId} row not found`);
        return (JSON.parse(row.fields_json) as Record<string, FieldValue>)[KIND];
      });
    },
    dispose: () => store.dispose(),
  };
}

const SQLITE: Backend = {
  name: "SqliteLedgerStore",
  async open() {
    const directory = await mkdtemp(path.join(tmpdir(), "memory-finalize-authority-"));
    directories.push(directory);
    return openSqlite(path.join(directory, "ledger.db"), path.join(directory, "logs"), []);
  },
};

/** Ordinary and management gateways whose transactions record every tx method call. */
interface Surfaces {
  readonly ordinary: WorksetGuardedLedger;
  readonly management: WorksetGuardedLedger;
  readonly calls: string[];
}

function surfaces(
  store: LedgerStore,
  afterGenericAdmit?: () => Promise<void>,
): Surfaces {
  const worksetStore = store.worksetStore?.();
  if (worksetStore === undefined) throw new Error("finalize authority fixture requires a workset store");
  const atomic = store as unknown as {
    runAtomicGenericMutation: (...args: unknown[]) => Promise<unknown>;
  };
  const calls: string[] = [];
  const record = (tx: WorksetGenericMutationTx): WorksetGenericMutationTx =>
    new Proxy(tx, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push(String(property));
          return (value as (...inner: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  const runGenericTransaction: NonNullable<WorksetGenericMutationGatewayHost["runGenericTransaction"]> = (
    mutate,
    measurement,
    accessScope,
    context,
    binding,
  ) =>
    atomic.runAtomicGenericMutation(
      (tx: WorksetGenericMutationTx, roots: Parameters<typeof mutate>[1]) => mutate(record(tx), roots),
      () => readWorksetRootsEpoch(worksetStore),
      measurement,
      accessScope,
      context,
      binding,
    ) as Promise<never>;
  const host = { rawStore: store, worksetStore, runGenericTransaction };
  return {
    ordinary: createWorksetGuardedLedger({
      ...host,
      invocationAuthority: createObserveOnlyWorksetInvocationAuthority(),
      ...(afterGenericAdmit === undefined ? {} : { afterGenericAdmit }),
    }),
    management: createWorksetManagementLedger(host),
    calls,
  };
}

interface MilestoneFixture {
  readonly persistence: Persistence;
  readonly milestoneId: string;
  readonly decisionId: string;
}

type MemorySeed = ReadonlyArray<{ readonly id: string; readonly kind: string | null }>;

/**
 * An open milestone with a terminal decision and the given terminal memories
 * (kind `null`: the legacy physical absence), imported through a dump.
 */
function milestoneWithMemories(backend: Backend, memories: MemorySeed): Promise<MilestoneFixture> {
  return milestoneWithMemoryArchive(backend, memories, []);
}

/**
 * {@link milestoneWithMemories} whose milestone also already owns a memories
 * archive holding `archived`, which its milestone archive must merge into.
 */
async function milestoneWithMemoryArchive(
  backend: Backend,
  memories: MemorySeed,
  archived: MemorySeed,
): Promise<MilestoneFixture> {
  const opened = await backend.open();
  try {
    const milestone = await opened.store.createMilestone({ title: "finalize authority milestone" });
    const decision = await opened.store.createItem(DECISIONS_LEDGER, milestone.id, {
      status: "proposed",
      fields: { headline: "sibling decision" },
    });
    await opened.store.updateItem(DECISIONS_LEDGER, decision.id, { status: "superseded" });
    const seed = (entries: MemorySeed): Item[] =>
      entries.map(({ id, kind }) => ({
        id,
        milestoneId: milestone.id,
        status: "superseded",
        fields: memoryFields(`milestone memory ${id}`, kind),
        createdAt: LEGACY_TS,
        updatedAt: LEGACY_TS,
        author: "legacy-author",
        session: "legacy-session",
      }));
    const dump = await rewriteMemoriesDump(opened.store, (ledger, archivedGroups) => {
      ledger.milestones.push({ id: milestone.id, title: "", description: "", items: seed(memories) });
      if (archived.length > 0) {
        archivedGroups.push({ id: milestone.id, title: "", description: "", items: seed(archived) });
      }
    });
    const persistence = await opened.restore(dump);
    await persistence.putLog(SEEDED_LOG.path, SEEDED_LOG.content);
    persistence.events.length = 0;
    return { persistence, milestoneId: milestone.id, decisionId: decision.id };
  } catch (error) {
    await opened.dispose();
    throw error;
  }
}

/** The ordinary finalize shape: a successful-looking close before the sweep. */
function closeThenArchive(milestoneId: string): FinalizeBatchOperation[] {
  return [
    { id: `close-milestone:${milestoneId}`, targetId: milestoneId, action: "close-milestone", targetStatus: "done" },
    { id: `archive-milestone:${milestoneId}`, targetId: milestoneId, action: "archive-milestone", summary: "finalized" },
  ];
}

interface Observation {
  /** Physical export; `null` when a stored unsupported kind makes it (correctly) refuse. */
  readonly physical: Awaited<ReturnType<LedgerStore["exportPhysicalLedgerState"]>> | null;
  readonly nonMemoryLedgers: ReadonlyArray<ReturnType<LedgerStore["fetch"]>>;
  readonly roots: Awaited<ReturnType<typeof readWorksetRootsEpoch>>;
  readonly milestone: Item;
  readonly logs: Awaited<ReturnType<Persistence["logs"]>>;
}

async function observe(persistence: Persistence, milestoneId: string, physical = true): Promise<Observation> {
  const { store } = persistence;
  const worksetStore = store.worksetStore?.();
  if (worksetStore === undefined) throw new Error("finalize authority fixture requires a workset store");
  return {
    physical: physical ? await store.exportPhysicalLedgerState() : null,
    nonMemoryLedgers: [MILESTONES_LEDGER, DECISIONS_LEDGER].map((ledgerId) => store.fetch(ledgerId)),
    roots: await readWorksetRootsEpoch(worksetStore),
    milestone: store.fetchItem(MILESTONES_LEDGER, milestoneId),
    logs: await persistence.logs(),
  };
}

/**
 * The batch rejects with `error` and leaves every observable unchanged:
 * statuses, fields, provenance, timestamps, counters, archive placement
 * (physical export), workset roots, stored logs, and mutation notifications. The recorded
 * transaction invoked no write method before the rejection.
 */
async function expectBatchRejectedBeforeAnyWrite(
  fixture: MilestoneFixture,
  surface: WorksetGuardedLedger,
  calls: string[],
  error: typeof MemoryManagementAuthorityRequiredError | typeof UnsupportedMemoryKindError,
): Promise<void> {
  const { persistence, milestoneId } = fixture;
  const physical = error === MemoryManagementAuthorityRequiredError;
  const before = await observe(persistence, milestoneId, physical);
  expect(before.logs).toEqual([SEEDED_LOG]);
  calls.length = 0;
  await expect(surface.mutations.executeFinalize(closeThenArchive(milestoneId))).rejects.toThrow(error);
  expect(calls.filter((method) => TX_WRITE_METHODS.has(method))).toEqual([]);
  // An authority rejection comes from the in-transaction preflight; an
  // unsupported stored kind already fails the pre-admission sweep read.
  if (physical) expect(calls).toContain("collectArchiveSweepRefs");
  expect(await observe(persistence, milestoneId, physical)).toEqual(before);
  expect(before.milestone.status).toBe("open");
  expect(persistence.events).toEqual([]);
}

for (const backend of [IN_MEMORY, SQLITE]) {
  describe(`memory finalize authority — ${backend.name}`, () => {
    for (const kind of AUTOMATIC_KINDS) {
      it(`ordinary finalize with a swept ${kind} rejects before its close applies; management archives`, async () => {
        const fixture = await milestoneWithMemories(backend, [
          { id: "MEM60", kind: null },
          { id: "MEM61", kind },
        ]);
        let persistence = fixture.persistence;
        try {
          const { ordinary, management, calls } = surfaces(persistence.store);
          await expectBatchRejectedBeforeAnyWrite(fixture, ordinary, calls, MemoryManagementAuthorityRequiredError);
          expect(await persistence.storedKind("MEM60", false)).toBeUndefined();

          const result = await management.mutations.executeFinalize(closeThenArchive(fixture.milestoneId));
          expect(result).toEqual({ applied: 2 });
          expect(persistence.store.listMilestoneItems(fixture.milestoneId)[DECISIONS_LEDGER] ?? []).toEqual([]);
          persistence = await expectArchivedDurably(persistence, { MEM60: FACT, MEM61: kind });
        } finally {
          await persistence.dispose();
        }
      }, TIMEOUT_MS);

      it(`the direct archive and the finalize archive share one ${kind} preflight`, async () => {
        const fixture = await milestoneWithMemories(backend, [{ id: "MEM62", kind }]);
        const { persistence, milestoneId } = fixture;
        try {
          const { ordinary, calls } = surfaces(persistence.store);
          await persistence.store.updateMilestone(milestoneId, { status: "done" });
          const batch = ordinary.mutations.executeFinalize([
            { id: `archive-milestone:${milestoneId}`, targetId: milestoneId, action: "archive-milestone", summary: "s" },
          ]);
          const finalizeError = await batch.then(() => null, (error: unknown) => error);
          const direct = await ordinary.mutations.archiveMilestone(milestoneId, "s").then(() => null, (error: unknown) => error);
          expect(finalizeError).toBeInstanceOf(MemoryManagementAuthorityRequiredError);
          expect(direct).toBeInstanceOf(MemoryManagementAuthorityRequiredError);
          const [finalizeRejection, directRejection] = [finalizeError, direct] as MemoryManagementAuthorityRequiredError[];
          expect([finalizeRejection?.itemId, directRejection?.itemId]).toEqual(["MEM62", "MEM62"]);
          expect([finalizeRejection?.operation, directRejection?.operation]).toEqual(["execute-finalize", "archive-milestone"]);
          expect(calls.filter((method) => TX_WRITE_METHODS.has(method))).toEqual([]);
        } finally {
          await persistence.dispose();
        }
      }, TIMEOUT_MS);

      it(`a swept fact promoted to ${kind} after admission cannot commit the stale ordinary batch`, async () => {
        const fixture = await milestoneWithMemories(backend, [{ id: "MEM63", kind: FACT }]);
        const { persistence, milestoneId } = fixture;
        try {
          let promote: (() => Promise<void>) | null = null;
          const { ordinary, management, calls } = surfaces(persistence.store, async () => {
            const pending = promote;
            promote = null;
            if (pending !== null) await pending();
          });
          // The ordinary caller's decision before admission: the swept memory is a fact.
          expect(persistence.store.fetchItem(MEMORIES_LEDGER, "MEM63").fields[KIND]).toBe(FACT);
          let promoted: Item | undefined;
          promote = async () => {
            promoted = await management.mutations.updateItem(MEMORIES_LEDGER, "MEM63", { fields: { [KIND]: kind } });
          };
          const before = await observe(persistence, milestoneId);
          calls.length = 0;
          await expect(ordinary.mutations.executeFinalize(closeThenArchive(milestoneId))).rejects.toThrow(
            MemoryManagementAuthorityRequiredError,
          );
          expect(promoted?.fields[KIND]).toBe(kind);
          // Only the promotion committed; the stale batch applied nothing.
          const after = await observe(persistence, milestoneId);
          expect(after.milestone).toEqual(before.milestone);
          expect(after.roots).toEqual(before.roots);
          expect(after.logs).toEqual(before.logs);
          expect(persistence.store.fetchItem(MEMORIES_LEDGER, "MEM63")).toEqual(promoted as Item);
          expect(persistence.store.listMilestoneItems(milestoneId)[DECISIONS_LEDGER]).toHaveLength(1);
          expect((await physicalMemories(persistence.store)).archived).toEqual([]);
        } finally {
          await persistence.dispose();
        }
      }, TIMEOUT_MS);
    }

    it("an unsupported swept kind rejects the batch before any write for every authority", async () => {
      const fixture = await milestoneWithMemories(backend, [{ id: "MEM64", kind: FACT }]);
      const { persistence } = fixture;
      try {
        const unsupported = { ...memoryFields("milestone memory MEM64", FACT), [KIND]: UNSUPPORTED_KIND };
        await persistence.writeActiveFields("MEM64", unsupported);
        const { ordinary, management, calls } = surfaces(persistence.store);
        for (const surface of [ordinary, management]) {
          await expectBatchRejectedBeforeAnyWrite(fixture, surface, calls, UnsupportedMemoryKindError);
        }
        expect(await persistence.storedKind("MEM64", false)).toBe(UNSUPPORTED_KIND);
        await expect(persistence.storedKind("MEM64", true)).rejects.toThrow("not found");
      } finally {
        await persistence.dispose();
      }
    }, TIMEOUT_MS);

    it("an unsupported kind already archived under the milestone rejects before any write for every authority", async () => {
      const fixture = await milestoneWithMemoryArchive(
        backend,
        [{ id: "MEM66", kind: null }],
        [{ id: "MEM67", kind: FACT }],
      );
      const { persistence, milestoneId } = fixture;
      try {
        const unsupported = { ...memoryFields("milestone memory MEM67", FACT), [KIND]: UNSUPPORTED_KIND };
        await persistence.writeArchivedFields("MEM67", unsupported);
        const { ordinary, management, calls } = surfaces(persistence.store);
        for (const surface of [ordinary, management]) {
          await expectBatchRejectedBeforeAnyWrite(fixture, surface, calls, UnsupportedMemoryKindError);
          // The pre-admission sweep reads only active rows; the archive is
          // validated by the in-transaction preflight.
          expect(calls).toContain("collectArchivedItemIds");
        }
        await persistence.store.updateMilestone(milestoneId, { status: "done" });
        persistence.events.length = 0;
        for (const surface of [ordinary, management]) {
          calls.length = 0;
          await expect(surface.mutations.archiveMilestone(milestoneId, "s")).rejects.toThrow(UnsupportedMemoryKindError);
          expect(calls.filter((method) => TX_WRITE_METHODS.has(method))).toEqual([]);
        }
        expect(persistence.events).toEqual([]);
        expect(await persistence.storedKind("MEM66", false)).toBeUndefined();
        expect(await persistence.storedKind("MEM67", true)).toBe(UNSUPPORTED_KIND);
      } finally {
        await persistence.dispose();
      }
    }, TIMEOUT_MS);

    it("ordinary finalize merges into a valid memories archive of the milestone", async () => {
      const fixture = await milestoneWithMemoryArchive(
        backend,
        [{ id: "MEM68", kind: null }],
        [{ id: "MEM69", kind: FACT }],
      );
      let persistence = fixture.persistence;
      try {
        const { ordinary } = surfaces(persistence.store);
        expect(await ordinary.mutations.executeFinalize(closeThenArchive(fixture.milestoneId))).toEqual({ applied: 2 });
        persistence = await expectArchivedDurably(persistence, { MEM68: FACT, MEM69: FACT });
      } finally {
        await persistence.dispose();
      }
    }, TIMEOUT_MS);

    it("ordinary finalize archives a legacy fact as a durable literal fact", async () => {
      const fixture = await milestoneWithMemories(backend, [{ id: "MEM65", kind: null }]);
      let persistence = fixture.persistence;
      try {
        expect(await persistence.storedKind("MEM65", false)).toBeUndefined();
        const { ordinary } = surfaces(persistence.store);
        expect(await ordinary.mutations.executeFinalize(closeThenArchive(fixture.milestoneId))).toEqual({ applied: 2 });
        persistence = await expectArchivedDurably(persistence, { MEM65: FACT });
      } finally {
        await persistence.dispose();
      }
    }, TIMEOUT_MS);
  });
}

/**
 * Each archived memory carries `expected` in native storage, after a restart,
 * in the physical export, and in the markdown backup. Returns the live store.
 */
async function expectArchivedDurably(
  current: Persistence,
  expected: Readonly<Record<string, string>>,
): Promise<Persistence> {
  const ids = Object.keys(expected);
  for (const id of ids) expect(await current.storedKind(id, true)).toBe(expected[id]);
  const persistence = await current.restart();
  const kinds = (items: readonly Item[]) =>
    Object.fromEntries(items.filter((item) => ids.includes(item.id)).map((item) => [item.id, item.fields[KIND]]));
  for (const id of ids) expect(await persistence.storedKind(id, true)).toBe(expected[id]);
  const physical = await physicalMemories(persistence.store);
  expect(physical.active.filter((item) => ids.includes(item.id))).toEqual([]);
  expect(kinds(physical.archived)).toEqual(expected);
  const backup = parseBackupDump(await buildBackupDump(persistence.store, null));
  const backedUp = [...(backup.archives.get(MEMORIES_LEDGER)?.values() ?? [])].flatMap((content) =>
    content.kind === "group" ? content.milestone.items : [content.item],
  );
  expect(kinds(backedUp)).toEqual(expected);
  return persistence;
}
