/**
 * G192/T6630 — Good-Communication interleavings for automatic-memory
 * authority across `executeFinalize` batches on PostgreSQL.
 *
 * Ordinary and management surfaces run on separate connections over one
 * tenant. A management peer promotes a swept fact after an ordinary finalize
 * batch was admitted (and its caller observed the fact) but before that batch
 * entered its tenant transaction; the transaction-local preflight must
 * re-resolve the kind and reject the stale batch before its close applies.
 *
 * Env-gated on CQ_TEST_PG_URL; `CQ_TEST_REQUIRE_PG=1` makes absence fatal.
 */

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import {
  DECISIONS_LEDGER,
  MEMORIES_LEDGER,
  MILESTONES_LEDGER,
  MemoryManagementAuthorityRequiredError,
  PostgresLedgerStore,
  UnsupportedMemoryKindError,
  buildBackupDump,
  createPostgresWorksetGuardedLedger,
  createPostgresWorksetManagementLedger,
  createTrustedWorksetManagementAuthority,
  ensureSchema,
  openPgPool,
  parseBackupDump,
  restoreDumpToPostgres,
  type FieldValue,
  type Item,
  type WorksetGuardedLedger,
} from "../src/index.js";
import type { FinalizeBatchOperation } from "../src/finalize.js";
import { memoryFields, physicalMemories, rewriteMemoriesDump } from "./memoryKindStoreContract.js";

const PG_URL = process.env.CQ_TEST_PG_URL;
if ((PG_URL === undefined || PG_URL.length === 0) && process.env.CQ_TEST_REQUIRE_PG === "1") {
  throw new Error("CQ_TEST_REQUIRE_PG=1 requires CQ_TEST_PG_URL to contain a PostgreSQL DSN");
}

const SUITE = "memory finalize authority — PostgresLedgerStore";
const KIND = "kind";
const FACT = "fact";
const AUTOMATIC_KINDS = ["rule", "environment"] as const;
const UNSUPPORTED_KIND = "opinion";
const LEGACY_TS = "2026-01-02T03:04:05.000Z";
const TIMEOUT_MS = 30_000;

if (PG_URL === undefined || PG_URL.length === 0) {
  describe.skip(SUITE, () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
} else {
  const dsn: string = PG_URL;
  const setupPool = openPgPool(dsn);
  const schemaReady = ensureSchema(setupPool);
  const disposables: Array<{ dispose(): Promise<void> }> = [];

  afterEach(async () => {
    while (disposables.length > 0) await disposables.pop()?.dispose();
  });

  afterAll(async () => {
    while (disposables.length > 0) await disposables.pop()?.dispose();
    await setupPool.close();
  });

  interface Tenant {
    readonly projectKey: string;
    readonly milestoneId: string;
    readonly ordinary: WorksetGuardedLedger;
    readonly management: WorksetGuardedLedger;
    /** Pause the next ordinary mutation after admission, before its transaction. */
    pauseNext(): { readonly admitted: Promise<void>; readonly resume: () => void };
    /** A fresh raw store whose init loads the committed tenant state. */
    observe(): Promise<PostgresLedgerStore>;
  }

  async function openRaw(projectKey: string): Promise<PostgresLedgerStore> {
    const store = new PostgresLedgerStore({ pool: new SQL({ url: dsn, max: 1 }), projectKey, displayName: projectKey });
    await store.init();
    disposables.push(store);
    return store;
  }

  /**
   * A tenant whose open milestone carries a terminal decision and the given
   * terminal memories (kind `null`: legacy physical absence), imported through
   * a dump — the only way a memory leaves M-AMBIENT.
   */
  type MemorySeed = ReadonlyArray<{ readonly id: string; readonly kind: string | null }>;

  /** `archived` seeds a memories archive the open milestone already owns. */
  async function tenant(memories: MemorySeed, archived: MemorySeed): Promise<Tenant> {
    await schemaReady;
    const projectKey = `t6630-finalize-${randomUUID()}`;
    const seed = await openRaw(projectKey);
    const milestone = await seed.createMilestone({ title: "finalize authority milestone" });
    const decision = await seed.createItem(DECISIONS_LEDGER, milestone.id, {
      status: "proposed",
      fields: { headline: "sibling decision" },
    });
    await seed.updateItem(DECISIONS_LEDGER, decision.id, { status: "superseded" });
    const items = (entries: MemorySeed): Item[] =>
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
    const dump = await rewriteMemoriesDump(seed, (ledger, archivedGroups) => {
      ledger.milestones.push({ id: milestone.id, title: "", description: "", items: items(memories) });
      if (archived.length > 0) {
        archivedGroups.push({ id: milestone.id, title: "", description: "", items: items(archived) });
      }
    });
    await restoreDumpToPostgres({
      pool: setupPool,
      projectKey,
      displayName: projectKey,
      dump,
      authority: createTrustedWorksetManagementAuthority(),
      overwriteAuthorized: true,
    });

    const management = await createPostgresWorksetManagementLedger({
      pool: new SQL({ url: dsn, max: 1 }),
      projectKey,
      displayName: projectKey,
    });
    disposables.push(management);
    let latch: { admitted: () => void; resume: Promise<void> } | null = null;
    const ordinary = await createPostgresWorksetGuardedLedger({
      pool: new SQL({ url: dsn, max: 1 }),
      projectKey,
      displayName: projectKey,
      afterGenericAdmit: async () => {
        const current = latch;
        if (current === null) return;
        latch = null;
        current.admitted();
        await current.resume;
      },
    });
    disposables.push(ordinary);
    return {
      projectKey,
      milestoneId: milestone.id,
      ordinary,
      management,
      pauseNext() {
        const admitted = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        latch = { admitted: admitted.resolve, resume: resume.promise };
        return { admitted: admitted.promise, resume: () => resume.resolve() };
      },
      observe: () => openRaw(projectKey),
    };
  }

  function closeThenArchive(milestoneId: string): FinalizeBatchOperation[] {
    return [
      { id: `close-milestone:${milestoneId}`, targetId: milestoneId, action: "close-milestone", targetStatus: "done" },
      { id: `archive-milestone:${milestoneId}`, targetId: milestoneId, action: "archive-milestone", summary: "finalized" },
    ];
  }

  async function storedKind(projectKey: string, itemId: string, archived: boolean): Promise<FieldValue | undefined> {
    const rows = archived
      ? await setupPool`
          SELECT fields_json FROM archived_items
          WHERE project_key = ${projectKey} AND ledger = ${MEMORIES_LEDGER} AND id = ${itemId}
        `
      : await setupPool`
          SELECT fields_json FROM items
          WHERE project_key = ${projectKey} AND ledger = ${MEMORIES_LEDGER} AND id = ${itemId}
        `;
    const row = (rows as Array<{ fields_json: string }>)[0];
    if (row === undefined) throw new Error(`PostgreSQL memory ${itemId} (archived=${String(archived)}) not found`);
    return (JSON.parse(row.fields_json) as Record<string, FieldValue>)[KIND];
  }

  describe(SUITE, () => {
    for (const kind of AUTOMATIC_KINDS) {
      it(`ordinary finalize with a close before a swept ${kind} rejects with no effect; management archives durably`, async () => {
        const { projectKey, milestoneId, ordinary, management, observe } = await tenant([
          { id: "MEM80", kind: null },
          { id: "MEM81", kind },
        ], []);
        const before = await (await observe()).exportPhysicalLedgerState();
        await expect(ordinary.mutations.executeFinalize(closeThenArchive(milestoneId))).rejects.toThrow(
          MemoryManagementAuthorityRequiredError,
        );
        const afterRejection = await observe();
        expect(await afterRejection.exportPhysicalLedgerState()).toEqual(before);
        expect(afterRejection.fetchItem(MILESTONES_LEDGER, milestoneId).status).toBe("open");
        expect(await storedKind(projectKey, "MEM80", false)).toBeUndefined();

        expect(await management.mutations.executeFinalize(closeThenArchive(milestoneId))).toEqual({ applied: 2 });
        expect(await storedKind(projectKey, "MEM80", true)).toBe(FACT);
        expect(await storedKind(projectKey, "MEM81", true)).toBe(kind);
        // Restart: a fresh instance's physical export and markdown backup keep the literal kinds.
        const restarted = await observe();
        const expected = { MEM80: FACT, MEM81: kind };
        const kinds = (items: readonly Item[]) =>
          Object.fromEntries(items.filter(({ id }) => id in expected).map((item) => [item.id, item.fields[KIND]]));
        expect(kinds((await physicalMemories(restarted)).archived)).toEqual(expected);
        const backup = parseBackupDump(await buildBackupDump(restarted, null));
        const backedUp = [...(backup.archives.get(MEMORIES_LEDGER)?.values() ?? [])].flatMap((content) =>
          content.kind === "group" ? content.milestone.items : [content.item],
        );
        expect(kinds(backedUp)).toEqual(expected);
      }, TIMEOUT_MS);

      it(`rejects an admitted ordinary finalize whose swept fact was promoted to ${kind} before its transaction`, async () => {
        const { projectKey, milestoneId, ordinary, management, pauseNext, observe } = await tenant([
          { id: "MEM82", kind: FACT },
        ], []);
        // The ordinary caller's pre-transaction decision: the swept memory is a fact.
        expect(ordinary.fetchItem(MEMORIES_LEDGER, "MEM82").fields[KIND]).toBe(FACT);

        const pause = pauseNext();
        const batch = ordinary.mutations.executeFinalize(closeThenArchive(milestoneId));
        await pause.admitted;
        const promoted = await management.mutations.updateItem(MEMORIES_LEDGER, "MEM82", {
          fields: { [KIND]: kind },
        });
        pause.resume();
        await expect(batch).rejects.toThrow(MemoryManagementAuthorityRequiredError);

        // Only the promotion committed: the close did not apply and nothing moved.
        const observer = await observe();
        expect(observer.fetchItem(MILESTONES_LEDGER, milestoneId).status).toBe("open");
        expect(observer.fetchItem(MEMORIES_LEDGER, "MEM82")).toEqual(promoted);
        expect(observer.listMilestoneItems(milestoneId)[DECISIONS_LEDGER]).toHaveLength(1);
        expect(observer.fetch(MEMORIES_LEDGER).archivePointers).toEqual([]);

        // Control: once demoted back to a fact, the same ordinary batch commits.
        await management.mutations.updateItem(MEMORIES_LEDGER, "MEM82", { fields: { [KIND]: FACT } });
        expect(await ordinary.mutations.executeFinalize(closeThenArchive(milestoneId))).toEqual({ applied: 2 });
        expect(await storedKind(projectKey, "MEM82", true)).toBe(FACT);
      }, TIMEOUT_MS);
    }

    it("an unsupported kind already archived under the milestone rejects the batch for every authority", async () => {
      const { projectKey, milestoneId, ordinary, management, observe } = await tenant(
        [{ id: "MEM83", kind: null }],
        [{ id: "MEM84", kind: FACT }],
      );
      const unsupported = { ...memoryFields("milestone memory MEM84", FACT), [KIND]: UNSUPPORTED_KIND };
      const updated = await setupPool`
        UPDATE archived_items SET fields_json = ${JSON.stringify(unsupported)}
        WHERE project_key = ${projectKey} AND ledger = ${MEMORIES_LEDGER} AND id = 'MEM84'
        RETURNING id
      `;
      expect(updated).toHaveLength(1);
      const before = await observe();
      const nonMemory = (store: PostgresLedgerStore) =>
        [MILESTONES_LEDGER, DECISIONS_LEDGER].map((ledgerId) => store.fetch(ledgerId));
      for (const surface of [ordinary, management]) {
        await expect(surface.mutations.executeFinalize(closeThenArchive(milestoneId))).rejects.toThrow(
          UnsupportedMemoryKindError,
        );
        const after = await observe();
        expect(nonMemory(after)).toEqual(nonMemory(before));
        expect(after.fetch(MEMORIES_LEDGER).milestones).toEqual(before.fetch(MEMORIES_LEDGER).milestones);
        expect(after.fetch(MEMORIES_LEDGER).archivePointers).toEqual(before.fetch(MEMORIES_LEDGER).archivePointers);
      }
      expect(await storedKind(projectKey, "MEM83", false)).toBeUndefined();
      expect(await storedKind(projectKey, "MEM84", true)).toBe(UNSUPPORTED_KIND);
    }, TIMEOUT_MS);

    it("ordinary finalize merges into a valid memories archive of the milestone", async () => {
      const { projectKey, milestoneId, ordinary } = await tenant(
        [{ id: "MEM85", kind: null }],
        [{ id: "MEM86", kind: FACT }],
      );
      expect(await ordinary.mutations.executeFinalize(closeThenArchive(milestoneId))).toEqual({ applied: 2 });
      expect(await storedKind(projectKey, "MEM85", true)).toBe(FACT);
      expect(await storedKind(projectKey, "MEM86", true)).toBe(FACT);
    }, TIMEOUT_MS);
  });
}
