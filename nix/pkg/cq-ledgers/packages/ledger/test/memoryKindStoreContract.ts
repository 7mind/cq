/**
 * G192/T6627 — shared Behavioral-Active Blackbox memory-kind contract.
 *
 * Registered by {@link runStoreAbstractSuite} inside its
 * `LedgerStore (abstract suite, <backend>)` describe block, so the same
 * assertions run against InMemory, SQLite, and PostgreSQL. Each backend
 * supplies a {@link MemoryKindPhysicalFixture} over its native representation;
 * everything else goes through the public `LedgerStore` surface.
 *
 * A legacy record is produced the way it reaches production: through a
 * backup/restore of a dump whose memory payload physically lacks `kind`.
 */

import { describe, expect, it } from "bun:test";
import {
  MILESTONES_AMBIENT_ID,
  UnsupportedMemoryKindError,
  buildBackupDump,
  parseBackupDump,
  serializeArchive,
  serializeLedger,
  type BackupDumpFile,
  type FieldValue,
  type Item,
  type Ledger,
  type LedgerStore,
  type Milestone,
} from "../src/index.js";

const MEMORIES = "memories";
const KIND = "kind";
const ARCHIVED_GROUP_ID = "M90";
const ARCHIVED_ITEM_ID = "MEM90";
const LEGACY_TS = "2026-01-02T03:04:05.000Z";
const UNSUPPORTED_KIND = "opinion";

export interface StoredItemTarget {
  readonly itemId: string;
  readonly archived: boolean;
}

/** Outcome of a native restore; the store is always a live instance. */
export interface RestoreOutcome {
  readonly store: LedgerStore;
  readonly error: unknown;
}

/**
 * Backend-native physical access. Every method bypasses validation,
 * normalization, and mutation hooks. Methods that can invalidate an adapter's
 * read cache return the live store the caller must use afterwards.
 */
export interface MemoryKindPhysicalFixture {
  readStoredFields(store: LedgerStore, target: StoredItemTarget): Promise<Record<string, FieldValue>>;
  writeStoredFields(
    store: LedgerStore,
    target: StoredItemTarget,
    fields: Record<string, FieldValue>,
  ): Promise<LedgerStore>;
  /** Close and reopen over the same persistence. */
  restart(store: LedgerStore): Promise<LedgerStore>;
  /** Replace the store's state from `dump` through the backend's native import path. */
  restoreInto(store: LedgerStore, dump: readonly BackupDumpFile[]): Promise<RestoreOutcome>;
}

export interface MemoryKindContractFactory {
  build(): Promise<LedgerStore>;
  teardown(store: LedgerStore): Promise<void>;
  readonly fixture: MemoryKindPhysicalFixture;
  readonly timeoutMs: number;
}

function memoryFields(title: string, kind: string | null): Record<string, FieldValue> {
  const fields: Record<string, FieldValue> = {
    title,
    content: `durable memory body for ${title}`,
  };
  if (kind !== null) fields[KIND] = kind;
  return fields;
}

function withoutKind(fields: Readonly<Record<string, FieldValue>>): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = { ...fields };
  delete out[KIND];
  return out;
}

function legacyArchivedItem(kind: string | null): Item {
  return {
    id: ARCHIVED_ITEM_ID,
    milestoneId: ARCHIVED_GROUP_ID,
    status: "superseded",
    fields: memoryFields("archived legacy memory", kind),
    createdAt: LEGACY_TS,
    updatedAt: LEGACY_TS,
    author: "legacy-author",
    session: "legacy-session",
  };
}

/**
 * Export `store`, rewrite the memories ledger and its archive groups through
 * the real serializers, and return the rewritten dump. `mutate` edits the
 * parsed memories ledger and may append archived groups.
 */
async function rewriteMemoriesDump(
  store: LedgerStore,
  mutate: (memories: Ledger, archivedGroups: Milestone[]) => void,
): Promise<BackupDumpFile[]> {
  const dump = await buildBackupDump(store, null);
  const parsed = parseBackupDump(dump);
  const memories = parsed.ledgers.get(MEMORIES);
  if (memories === undefined) throw new Error("dump lacks the memories ledger");
  const archivedGroups: Milestone[] = [];
  mutate(memories, archivedGroups);
  const replaced = new Set([
    `${MEMORIES}.md`,
    ...archivedGroups.map((group) => `archive/${MEMORIES}/${group.id}.md`),
  ]);
  const files = dump.filter((file) => !replaced.has(file.path));
  for (const group of archivedGroups) {
    const relPath = `archive/${MEMORIES}/${group.id}.md`;
    memories.archivePointers.push({
      id: group.id,
      path: `./${relPath}`,
      summary: "legacy archived memories",
      title: "legacy",
      status: "done",
    });
    files.push({ path: relPath, content: serializeArchive(group) });
  }
  files.push({ path: `${MEMORIES}.md`, content: serializeLedger(memories) });
  return files;
}

function stripKindFromActive(memories: Ledger, itemId: string): void {
  for (const group of memories.milestones) {
    for (const item of group.items) {
      if (item.id === itemId) item.fields = withoutKind(item.fields);
    }
  }
}

function activeMemories(store: LedgerStore): Item[] {
  return store.fetch(MEMORIES).milestones.flatMap((group) => group.items);
}

async function physicalMemories(
  store: LedgerStore,
): Promise<{ active: Item[]; archived: Item[] }> {
  const state = await store.exportPhysicalLedgerState();
  const entry = state.ledgers.find(({ ledger }) => ledger.id === MEMORIES);
  if (entry === undefined) throw new Error("physical export lacks memories");
  const archived: Item[] = [];
  for (const content of entry.archives.values()) {
    if (content.kind === "group") archived.push(...content.milestone.items);
    else archived.push(content.item);
  }
  return { active: entry.ledger.milestones.flatMap((group) => group.items), archived };
}

function requireStore(outcome: RestoreOutcome): LedgerStore {
  if (outcome.error !== null) throw outcome.error;
  return outcome.store;
}

export function registerMemoryKindContract(factory: MemoryKindContractFactory): void {
  const { fixture } = factory;
  const TIMEOUT = factory.timeoutMs;

  /** One legacy active memory, one explicit `fact`, and one archived legacy memory. */
  async function legacyStore(): Promise<{ store: LedgerStore; legacy: Item; explicit: Item }> {
    let store = await factory.build();
    try {
      const legacy = await store.createItem(MEMORIES, MILESTONES_AMBIENT_ID, {
        status: "active",
        fields: memoryFields("legacy active memory", null),
        author: "author-a",
        session: "session-a",
      });
      const explicit = await store.createItem(MEMORIES, MILESTONES_AMBIENT_ID, {
        status: "active",
        fields: memoryFields("explicit fact memory", "fact"),
      });
      const dump = await rewriteMemoriesDump(store, (memories, groups) => {
        stripKindFromActive(memories, legacy.id);
        groups.push({
          id: ARCHIVED_GROUP_ID,
          title: "",
          description: "",
          items: [legacyArchivedItem(null)],
        });
      });
      store = requireStore(await fixture.restoreInto(store, dump));
      return { store, legacy, explicit };
    } catch (error) {
      await factory.teardown(store);
      throw error;
    }
  }

  describe("memory kinds (G192/T6627)", () => {
    it("stores literal fact for an omitted kind and persists every closed kind verbatim", async () => {
      const store = await factory.build();
      try {
        const omitted = await store.createItem(MEMORIES, MILESTONES_AMBIENT_ID, {
          status: "active",
          fields: memoryFields("omitted kind", null),
        });
        expect(omitted.fields[KIND]).toBe("fact");
        const rule = await store.createItem(MEMORIES, MILESTONES_AMBIENT_ID, {
          status: "active",
          fields: memoryFields("rule kind", "rule"),
        });
        const environment = await store.createItem(MEMORIES, MILESTONES_AMBIENT_ID, {
          status: "active",
          fields: memoryFields("environment kind", "environment"),
        });
        const target = (itemId: string): StoredItemTarget => ({ itemId, archived: false });
        expect((await fixture.readStoredFields(store, target(omitted.id)))[KIND]).toBe("fact");
        expect((await fixture.readStoredFields(store, target(rule.id)))[KIND]).toBe("rule");
        expect((await fixture.readStoredFields(store, target(environment.id)))[KIND]).toBe(
          "environment",
        );
      } finally {
        await factory.teardown(store);
      }
    }, TIMEOUT);

    it("rejects an unsupported kind on create and update without any effect", async () => {
      const store = await factory.build();
      try {
        const existing = await store.createItem(MEMORIES, MILESTONES_AMBIENT_ID, {
          status: "active",
          fields: memoryFields("existing", "rule"),
        });
        const before = store.fetch(MEMORIES);
        const physicalBefore = await store.exportPhysicalLedgerState();
        await expect(
          store.createItem(MEMORIES, MILESTONES_AMBIENT_ID, {
            status: "active",
            fields: memoryFields("unsupported", UNSUPPORTED_KIND),
          }),
        ).rejects.toThrow(UnsupportedMemoryKindError);
        await expect(
          store.updateItem(MEMORIES, existing.id, { fields: { [KIND]: UNSUPPORTED_KIND } }),
        ).rejects.toThrow(UnsupportedMemoryKindError);
        expect(store.fetch(MEMORIES)).toEqual(before);
        expect(await store.exportPhysicalLedgerState()).toEqual(physicalBefore);
      } finally {
        await factory.teardown(store);
      }
    }, TIMEOUT);

    it("materializes a legacy record as semantic fact on every named read without writing", async () => {
      const { store, legacy } = await legacyStore();
      try {
        const active: StoredItemTarget = { itemId: legacy.id, archived: false };
        const archived: StoredItemTarget = { itemId: ARCHIVED_ITEM_ID, archived: true };
        expect(await fixture.readStoredFields(store, active)).toEqual(withoutKind(legacy.fields));
        expect((await fixture.readStoredFields(store, archived))[KIND]).toBeUndefined();

        const fetched = activeMemories(store).find((item) => item.id === legacy.id);
        expect(fetched?.fields[KIND]).toBe("fact");
        const single = store.fetchItem(MEMORIES, legacy.id);
        expect(single.fields[KIND]).toBe("fact");
        expect(single.updatedAt).toBe(legacy.updatedAt);

        const archive = await store.fetchArchive(MEMORIES, ARCHIVED_GROUP_ID);
        if (archive.kind !== "group") throw new Error("memories archive must be a group");
        expect(archive.milestone.items.map((item) => item.fields[KIND])).toEqual(["fact"]);
        const generations = await store.fetchArchivedItems(MEMORIES, ARCHIVED_ITEM_ID);
        expect(generations.map(({ item }) => item.fields[KIND])).toEqual(["fact"]);

        const substring = store.search(MEMORIES, "legacy active memory");
        expect(substring.map((item) => [item.id, item.fields[KIND]])).toEqual([
          [legacy.id, "fact"],
        ]);

        const activeFts = await store.ftsSearch("kind:fact", { ledger: MEMORIES });
        expect(activeFts.map(({ item }) => item.id)).toContain(legacy.id);
        expect(activeFts.map(({ item }) => item.id)).not.toContain(ARCHIVED_ITEM_ID);
        const archivedFts = await store.ftsSearch("kind:fact", {
          ledger: MEMORIES,
          includeArchived: true,
        });
        const archivedHit = archivedFts.find(({ item }) => item.id === ARCHIVED_ITEM_ID);
        expect(archivedHit?.item.fields[KIND]).toBe("fact");

        const grouped = store.listMilestoneItems(MILESTONES_AMBIENT_ID)[MEMORIES] ?? [];
        expect(grouped.find((item) => item.id === legacy.id)?.fields[KIND]).toBe("fact");

        // No read wrote the materialized kind back.
        expect(await fixture.readStoredFields(store, active)).toEqual(withoutKind(legacy.fields));
        expect((await fixture.readStoredFields(store, archived))[KIND]).toBeUndefined();
        const physical = await physicalMemories(store);
        expect(physical.active.find((item) => item.id === legacy.id)?.fields[KIND]).toBeUndefined();
        expect(physical.archived.map((item) => item.fields[KIND])).toEqual([undefined]);
        expect(store.fetchItem(MEMORIES, legacy.id).updatedAt).toBe(legacy.updatedAt);
      } finally {
        await factory.teardown(store);
      }
    }, TIMEOUT);

    it("normalizes a legacy record to literal fact only on its next successful mutation", async () => {
      const { store, legacy } = await legacyStore();
      try {
        const target: StoredItemTarget = { itemId: legacy.id, archived: false };
        await expect(
          store.updateItem(MEMORIES, legacy.id, { status: "not-a-status" }),
        ).rejects.toThrow();
        expect((await fixture.readStoredFields(store, target))[KIND]).toBeUndefined();

        const updated = await store.updateItem(MEMORIES, legacy.id, { fields: { tags: ["kept"] } });
        expect(updated.fields[KIND]).toBe("fact");
        expect(await fixture.readStoredFields(store, target)).toEqual({
          ...withoutKind(legacy.fields),
          tags: ["kept"],
          [KIND]: "fact",
        });
      } finally {
        await factory.teardown(store);
      }
    }, TIMEOUT);

    it("preserves physical absence and presence across restart and backup/restore", async () => {
      const built = await legacyStore();
      let store = built.store;
      try {
        const legacy: StoredItemTarget = { itemId: built.legacy.id, archived: false };
        const explicit: StoredItemTarget = { itemId: built.explicit.id, archived: false };
        const archived: StoredItemTarget = { itemId: ARCHIVED_ITEM_ID, archived: true };
        const observe = async (): Promise<Array<FieldValue | undefined>> => [
          (await fixture.readStoredFields(store, legacy))[KIND],
          (await fixture.readStoredFields(store, explicit))[KIND],
          (await fixture.readStoredFields(store, archived))[KIND],
        ];
        expect(await observe()).toEqual([undefined, "fact", undefined]);

        store = await fixture.restart(store);
        expect(await observe()).toEqual([undefined, "fact", undefined]);

        const dump = await buildBackupDump(store, null);
        const parsed = parseBackupDump(dump);
        const dumped = parsed.ledgers.get(MEMORIES)?.milestones.flatMap((group) => group.items);
        expect(dumped?.find((item) => item.id === built.legacy.id)?.fields[KIND]).toBeUndefined();
        expect(dumped?.find((item) => item.id === built.explicit.id)?.fields[KIND]).toBe("fact");

        store = requireStore(await fixture.restoreInto(store, dump));
        expect(await observe()).toEqual([undefined, "fact", undefined]);
      } finally {
        await factory.teardown(store);
      }
    }, TIMEOUT);

    it("rejects unsupported active and archived kinds on reads and physical export", async () => {
      const built = await legacyStore();
      let store = built.store;
      try {
        const legacy = built.legacy;
        store = await fixture.writeStoredFields(
          store,
          { itemId: ARCHIVED_ITEM_ID, archived: true },
          memoryFields("archived legacy memory", UNSUPPORTED_KIND),
        );
        await expect(store.fetchArchive(MEMORIES, ARCHIVED_GROUP_ID)).rejects.toThrow(
          UnsupportedMemoryKindError,
        );
        await expect(store.fetchArchivedItems(MEMORIES, ARCHIVED_ITEM_ID)).rejects.toThrow(
          UnsupportedMemoryKindError,
        );
        await expect(store.exportPhysicalLedgerState()).rejects.toThrow(
          UnsupportedMemoryKindError,
        );
        await expect(buildBackupDump(store, null)).rejects.toThrow(UnsupportedMemoryKindError);

        store = await fixture.writeStoredFields(
          store,
          { itemId: legacy.id, archived: false },
          { ...withoutKind(legacy.fields), [KIND]: UNSUPPORTED_KIND },
        );
        expect(() => store.fetch(MEMORIES)).toThrow(UnsupportedMemoryKindError);
        expect(() => store.fetchItem(MEMORIES, legacy.id)).toThrow(UnsupportedMemoryKindError);
        expect(() => store.search(MEMORIES, "legacy")).toThrow(UnsupportedMemoryKindError);
        expect(() => store.listMilestoneItems(MILESTONES_AMBIENT_ID)).toThrow(
          UnsupportedMemoryKindError,
        );
        // Rejected reads never repair or normalize the stored payload.
        expect(
          (await fixture.readStoredFields(store, { itemId: legacy.id, archived: false }))[KIND],
        ).toBe(UNSUPPORTED_KIND);
      } finally {
        await factory.teardown(store);
      }
    }, TIMEOUT);

    it("rejects a restore carrying an unsupported active or archived kind atomically", async () => {
      const built = await legacyStore();
      let store = built.store;
      try {
        const legacyId = built.legacy.id;
        const before = await store.exportPhysicalLedgerState();
        const beforeCounters = store.fetch(MEMORIES).counters;

        const activeDump = await rewriteMemoriesDump(store, (memories) => {
          for (const group of memories.milestones) {
            for (const item of group.items) {
              if (item.id === legacyId) item.fields = { ...item.fields, [KIND]: UNSUPPORTED_KIND };
            }
          }
        });
        const activeOutcome = await fixture.restoreInto(store, activeDump);
        store = activeOutcome.store;
        expect(activeOutcome.error).toBeInstanceOf(UnsupportedMemoryKindError);
        expect(await store.exportPhysicalLedgerState()).toEqual(before);

        const archivedDump = await rewriteMemoriesDump(store, (memories, groups) => {
          memories.archivePointers = memories.archivePointers.filter(
            (pointer) => pointer.id !== ARCHIVED_GROUP_ID,
          );
          groups.push({
            id: ARCHIVED_GROUP_ID,
            title: "",
            description: "",
            items: [legacyArchivedItem(UNSUPPORTED_KIND)],
          });
        });
        const archivedOutcome = await fixture.restoreInto(store, archivedDump);
        store = archivedOutcome.store;
        expect(archivedOutcome.error).toBeInstanceOf(UnsupportedMemoryKindError);
        expect(await store.exportPhysicalLedgerState()).toEqual(before);
        expect(store.fetch(MEMORIES).counters).toEqual(beforeCounters);
      } finally {
        await factory.teardown(store);
      }
    }, TIMEOUT);
  });
}
