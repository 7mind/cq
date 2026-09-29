/**
 * G192/T6628 — shared Behavioral-Active Blackbox memory-authoring transaction
 * contract.
 *
 * {@link runStoreAbstractSuite} invokes {@link runMemoryAuthoringTransactionContract}
 * inside its `LedgerStore (abstract suite, <backend>)` describe block, so the
 * same assertions run against InMemory, SQLite, and PostgreSQL. This module
 * registers no tests at load and is never passed to `bun test` directly.
 *
 * Every mutation goes through a generic-mutation gateway over the backend's
 * own adapter transaction: one surface bound to ordinary (observe-only)
 * authority, one bound to trusted management authority. A legacy record is a
 * stored memory payload that physically lacks `kind`.
 */

import { describe, expect, it } from "bun:test";
import { ledgerItemRevisionV1 } from "../src/itemRevision.js";
import {
  MILESTONES_AMBIENT_ID,
  MemoryManagementAuthorityRequiredError,
  UnsupportedMemoryKindError,
  buildBackupDump,
  createObserveOnlyWorksetInvocationAuthority,
  createWorksetGuardedLedger,
  createWorksetManagementLedger,
  parseBackupDump,
  type FieldValue,
  type Item,
  type LedgerStore,
  type WorksetGuardedLedger,
} from "../src/index.js";
import {
  exactArchiveOperation,
  memoryFields,
  physicalMemories,
  requireStore,
  rewriteMemoriesDump,
  withoutKind,
  type MemoryKindContractFactory,
  type StoredItemTarget,
} from "./memoryKindStoreContract.js";

const MEMORIES = "memories";
const DECISIONS = "decisions";
const KIND = "kind";
const FACT = "fact";
const AUTOMATIC_KINDS = ["rule", "environment"] as const;
const UNSUPPORTED_KIND = "opinion";
const LEGACY_TS = "2026-01-02T03:04:05.000Z";

interface AuthoritySurfaces {
  readonly ordinary: WorksetGuardedLedger;
  readonly management: WorksetGuardedLedger;
}

/** Both surfaces share the store's adapter transaction and workset store. */
function surfaces(store: LedgerStore): AuthoritySurfaces {
  const worksetStore = store.worksetStore?.();
  if (worksetStore === undefined) {
    throw new Error("memory authoring contract requires a workset store");
  }
  return {
    ordinary: createWorksetGuardedLedger({
      rawStore: store,
      worksetStore,
      invocationAuthority: createObserveOnlyWorksetInvocationAuthority(),
    }),
    management: createWorksetManagementLedger({ rawStore: store, worksetStore }),
  };
}

const active = (itemId: string): StoredItemTarget => ({ itemId, archived: false });
const archived = (itemId: string): StoredItemTarget => ({ itemId, archived: true });

export function runMemoryAuthoringTransactionContract(factory: MemoryKindContractFactory): void {
  const { fixture } = factory;
  const TIMEOUT = factory.timeoutMs;

  async function createMemory(
    store: LedgerStore,
    title: string,
    kind: string,
    status: "active" | "superseded",
  ): Promise<Item> {
    const created = await surfaces(store).management.mutations.createItem(
      MEMORIES,
      MILESTONES_AMBIENT_ID,
      { status: "active", fields: memoryFields(title, kind), author: "author-a", session: "session-a" },
    );
    if (status === "active") return created;
    return surfaces(store).management.mutations.updateItem(MEMORIES, created.id, {
      status: "superseded",
    });
  }

  /** A memory whose stored payload physically lacks `kind`. */
  async function legacyMemory(
    current: LedgerStore,
    title: string,
    placement: "active" | "superseded" | "archived",
  ): Promise<{ store: LedgerStore; item: Item }> {
    const item = await createMemory(current, title, FACT, placement === "active" ? "active" : "superseded");
    if (placement === "archived") {
      await surfaces(current).management.mutations.archiveTerminalItems(
        [MEMORIES],
        "archive before legacy rewrite",
        "fail-on-active-gate",
      );
    }
    const target = placement === "archived" ? archived(item.id) : active(item.id);
    const store = await fixture.writeStoredFields(current, target, withoutKind(item.fields));
    expect((await fixture.readStoredFields(store, target))[KIND]).toBeUndefined();
    return { store, item };
  }

  /**
   * A completed milestone carrying one imported terminal memory — the only way
   * a memory sits outside M-AMBIENT — with the given stored kind (null: legacy).
   */
  async function milestoneMemoryStore(
    itemId: string,
    kind: string | null,
  ): Promise<{ store: LedgerStore; milestoneId: string; item: Item }> {
    let store = await factory.build();
    try {
      const milestone = await store.createMilestone({ title: `memory milestone ${itemId}` });
      const decision = await store.createItem(DECISIONS, milestone.id, {
        status: "proposed",
        fields: { headline: `sibling decision ${itemId}` },
      });
      await store.updateItem(DECISIONS, decision.id, { status: "superseded" });
      await store.updateMilestone(milestone.id, { status: "done" });
      const item: Item = {
        id: itemId,
        milestoneId: milestone.id,
        status: "superseded",
        fields: memoryFields(`milestone memory ${itemId}`, kind),
        createdAt: LEGACY_TS,
        updatedAt: LEGACY_TS,
        author: "legacy-author",
        session: "legacy-session",
      };
      const dump = await rewriteMemoriesDump(store, (memories) => {
        memories.milestones.push({ id: milestone.id, title: "", description: "", items: [item] });
      });
      store = requireStore(await fixture.restoreInto(store, dump));
      return { store, milestoneId: milestone.id, item };
    } catch (error) {
      await factory.teardown(store);
      throw error;
    }
  }

  /**
   * Literal `fact` is durable: native storage, restart, physical export, and
   * the markdown backup all carry it. Returns the live post-restart store.
   */
  async function expectDurableFact(
    current: LedgerStore,
    target: StoredItemTarget,
  ): Promise<LedgerStore> {
    expect((await fixture.readStoredFields(current, target))[KIND]).toBe(FACT);
    const store = await fixture.restart(current);
    expect((await fixture.readStoredFields(store, target))[KIND]).toBe(FACT);
    const physical = await physicalMemories(store);
    const exported = (target.archived ? physical.archived : physical.active).find(
      (item) => item.id === target.itemId,
    );
    expect(exported?.fields[KIND]).toBe(FACT);
    const parsed = parseBackupDump(await buildBackupDump(store, null));
    const backedUp = target.archived
      ? [...(parsed.archives.get(MEMORIES)?.values() ?? [])].flatMap((content) =>
          content.kind === "group" ? content.milestone.items : [content.item],
        )
      : (parsed.ledgers.get(MEMORIES)?.milestones.flatMap((group) => group.items) ?? []);
    expect(backedUp.find((item) => item.id === target.itemId)?.fields[KIND]).toBe(FACT);
    return store;
  }

  async function expectRejectedWithoutEffect(
    store: LedgerStore,
    attempt: () => Promise<unknown>,
    error: typeof MemoryManagementAuthorityRequiredError | typeof UnsupportedMemoryKindError,
  ): Promise<void> {
    const before = await store.exportPhysicalLedgerState();
    await expect(attempt()).rejects.toThrow(error);
    expect(await store.exportPhysicalLedgerState()).toEqual(before);
  }

  describe("memory authoring transaction contract (G192/T6628)", () => {
    it("ordinary create of an omitted kind persists durable literal fact", async () => {
      let store = await factory.build();
      try {
        const created = await surfaces(store).ordinary.mutations.createItem(
          MEMORIES,
          MILESTONES_AMBIENT_ID,
          { status: "active", fields: memoryFields("omitted kind", null) },
        );
        expect(created.fields[KIND]).toBe(FACT);
        store = await expectDurableFact(store, active(created.id));
      } finally {
        await factory.teardown(store);
      }
    }, TIMEOUT);

    const updates: ReadonlyArray<readonly [string, Parameters<WorksetGuardedLedger["mutations"]["updateItem"]>[2]]> = [
      ["a field update", { fields: { tags: ["kept"] } }],
      ["an empty update", {}],
      ["a provenance-only update", { author: "author-b", session: "session-b" }],
    ];
    for (const [label, patch] of updates) {
      it(`ordinary ${label} of a legacy memory persists durable literal fact`, async () => {
        const built = await legacyMemory(await factory.build(), `legacy ${label}`, "active");
        let store = built.store;
        try {
          const updated = await surfaces(store).ordinary.mutations.updateItem(
            MEMORIES,
            built.item.id,
            patch,
          );
          expect(updated.fields[KIND]).toBe(FACT);
          expect(updated.updatedAt >= built.item.updatedAt).toBe(true);
          store = await expectDurableFact(store, active(built.item.id));
          if (patch.author !== undefined) {
            expect(store.fetchItem(MEMORIES, built.item.id)).toMatchObject({
              author: patch.author,
              session: patch.session,
            });
          }
        } finally {
          await factory.teardown(store);
        }
      }, TIMEOUT);
    }

    it("ordinary reopen of a legacy memory persists durable literal fact", async () => {
      const built = await legacyMemory(await factory.build(), "legacy reopen", "superseded");
      let store = built.store;
      try {
        const reopened = await surfaces(store).ordinary.mutations.reopenItem(
          MEMORIES,
          built.item.id,
          "active",
        );
        expect(reopened.status).toBe("active");
        store = await expectDurableFact(store, active(built.item.id));
      } finally {
        await factory.teardown(store);
      }
    }, TIMEOUT);

    it("ordinary unarchive of a legacy memory persists durable literal fact", async () => {
      const built = await legacyMemory(await factory.build(), "legacy unarchive", "archived");
      let store = built.store;
      try {
        const restored = await surfaces(store).ordinary.mutations.unarchiveItem(
          MEMORIES,
          MILESTONES_AMBIENT_ID,
          built.item.id,
        );
        expect(restored.fields[KIND]).toBe(FACT);
        store = await expectDurableFact(store, active(built.item.id));
      } finally {
        await factory.teardown(store);
      }
    }, TIMEOUT);

    it("ordinary bulk archive of a legacy memory persists durable literal fact", async () => {
      const built = await legacyMemory(await factory.build(), "legacy sweep", "superseded");
      let store = built.store;
      try {
        const result = await surfaces(store).ordinary.mutations.archiveTerminalItems(
          [MEMORIES],
          "sweep legacy memory",
          "fail-on-active-gate",
        );
        expect(result.archivedItems).toBe(1);
        store = await expectDurableFact(store, archived(built.item.id));
      } finally {
        await factory.teardown(store);
      }
    }, TIMEOUT);

    it("ordinary direct milestone archive of a legacy memory persists durable literal fact", async () => {
      const built = await milestoneMemoryStore("MEM93", null);
      let store = built.store;
      try {
        expect((await fixture.readStoredFields(store, active(built.item.id)))[KIND]).toBeUndefined();
        await surfaces(store).ordinary.mutations.archiveMilestone(built.milestoneId, "archive");
        store = await expectDurableFact(store, archived(built.item.id));
      } finally {
        await factory.teardown(store);
      }
    }, TIMEOUT);

    for (const kind of AUTOMATIC_KINDS) {
      it(`ordinary authority rejects creating or promoting to ${kind} atomically; management succeeds`, async () => {
        const store = await factory.build();
        try {
          const { ordinary, management } = surfaces(store);
          const fact = await createMemory(store, `promotable ${kind}`, FACT, "active");
          await expectRejectedWithoutEffect(
            store,
            () =>
              ordinary.mutations.createItem(MEMORIES, MILESTONES_AMBIENT_ID, {
                status: "active",
                fields: memoryFields(`ordinary ${kind}`, kind),
              }),
            MemoryManagementAuthorityRequiredError,
          );
          await expectRejectedWithoutEffect(
            store,
            () => ordinary.mutations.updateItem(MEMORIES, fact.id, { fields: { [KIND]: kind } }),
            MemoryManagementAuthorityRequiredError,
          );

          const created = await management.mutations.createItem(MEMORIES, MILESTONES_AMBIENT_ID, {
            status: "active",
            fields: memoryFields(`managed ${kind}`, kind),
          });
          expect((await fixture.readStoredFields(store, active(created.id)))[KIND]).toBe(kind);
          const promoted = await management.mutations.updateItem(MEMORIES, fact.id, {
            fields: { [KIND]: kind },
          });
          expect(promoted.fields[KIND]).toBe(kind);
        } finally {
          await factory.teardown(store);
        }
      }, TIMEOUT);

      it(`ordinary authority rejects every mutation of an existing ${kind} atomically; management succeeds`, async () => {
        const store = await factory.build();
        try {
          const { ordinary, management } = surfaces(store);
          const live = await createMemory(store, `live ${kind}`, kind, "active");
          const terminal = await createMemory(store, `terminal ${kind}`, kind, "superseded");
          const terminalFact = await createMemory(store, `terminal fact beside ${kind}`, FACT, "superseded");
          const rejected = MemoryManagementAuthorityRequiredError;

          for (const patch of [
            { fields: { tags: ["edited"] } },
            {},
            { author: "author-b", session: "session-b" },
            { fields: { [KIND]: FACT } },
            { status: "superseded" },
          ]) {
            await expectRejectedWithoutEffect(
              store,
              () => ordinary.mutations.updateItem(MEMORIES, live.id, patch),
              rejected,
            );
          }
          await expectRejectedWithoutEffect(
            store,
            () => ordinary.mutations.reopenItem(MEMORIES, terminal.id, "active"),
            rejected,
          );
          // One unauthorized record rejects the whole sweep: the fact stays active.
          await expectRejectedWithoutEffect(
            store,
            () =>
              ordinary.mutations.archiveTerminalItems([MEMORIES], "sweep", "fail-on-active-gate"),
            rejected,
          );
          const ref = `${MEMORIES}:${terminal.id}`;
          await expectRejectedWithoutEffect(
            store,
            () =>
              ordinary.mutations.executeFinalize([
                exactArchiveOperation(terminal, ledgerItemRevisionV1(ref, terminal)),
              ]),
            rejected,
          );
          expect(store.fetchItem(MEMORIES, terminalFact.id).status).toBe("superseded");

          await management.mutations.updateItem(MEMORIES, live.id, { fields: { tags: ["edited"] } });
          const swept = await management.mutations.archiveTerminalItems(
            [MEMORIES],
            "sweep",
            "fail-on-active-gate",
          );
          expect(swept.archivedItems).toBe(2);
          expect((await fixture.readStoredFields(store, archived(terminal.id)))[KIND]).toBe(kind);

          await expectRejectedWithoutEffect(
            store,
            () => ordinary.mutations.unarchiveItem(MEMORIES, MILESTONES_AMBIENT_ID, terminal.id),
            rejected,
          );
          await management.mutations.unarchiveItem(MEMORIES, MILESTONES_AMBIENT_ID, terminal.id);
          await management.mutations.reopenItem(MEMORIES, terminal.id, "active");
          expect(store.fetchItem(MEMORIES, terminal.id)).toMatchObject({
            status: "active",
            fields: { [KIND]: kind },
          });
        } finally {
          await factory.teardown(store);
        }
      }, TIMEOUT);

      it(`ordinary direct milestone archive of a ${kind} rejects atomically; management succeeds`, async () => {
        const built = await milestoneMemoryStore("MEM94", kind);
        const store = built.store;
        try {
          const { ordinary, management } = surfaces(store);
          await expectRejectedWithoutEffect(
            store,
            () => ordinary.mutations.archiveMilestone(built.milestoneId, "archive"),
            MemoryManagementAuthorityRequiredError,
          );
          expect(store.listMilestoneItems(built.milestoneId)[DECISIONS]).toHaveLength(1);
          await management.mutations.archiveMilestone(built.milestoneId, "archive");
          expect((await fixture.readStoredFields(store, archived(built.item.id)))[KIND]).toBe(kind);
        } finally {
          await factory.teardown(store);
        }
      }, TIMEOUT);
    }

    it("unsupported current or requested kinds reject before any mutation for every authority", async () => {
      let store = await factory.build();
      try {
        const fact = await createMemory(store, "unsupported target", FACT, "active");
        for (const surface of [surfaces(store).ordinary, surfaces(store).management]) {
          await expectRejectedWithoutEffect(
            store,
            () =>
              surface.mutations.createItem(MEMORIES, MILESTONES_AMBIENT_ID, {
                status: "active",
                fields: memoryFields("unsupported create", UNSUPPORTED_KIND),
              }),
            UnsupportedMemoryKindError,
          );
          await expectRejectedWithoutEffect(
            store,
            () =>
              surface.mutations.updateItem(MEMORIES, fact.id, {
                fields: { [KIND]: UNSUPPORTED_KIND },
              }),
            UnsupportedMemoryKindError,
          );
        }
        const unsupported: Record<string, FieldValue> = { ...fact.fields, [KIND]: UNSUPPORTED_KIND };
        store = await fixture.writeStoredFields(store, active(fact.id), unsupported);
        for (const surface of [surfaces(store).ordinary, surfaces(store).management]) {
          await expect(surface.mutations.updateItem(MEMORIES, fact.id, {})).rejects.toThrow(
            UnsupportedMemoryKindError,
          );
          expect(await fixture.readStoredFields(store, active(fact.id))).toEqual(unsupported);
        }
      } finally {
        await factory.teardown(store);
      }
    }, TIMEOUT);
  });
}
