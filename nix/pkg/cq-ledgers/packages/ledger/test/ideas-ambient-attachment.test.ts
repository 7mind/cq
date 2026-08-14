/**
 * T1528 — one shared Behavioral-Active contract for the idea attachment
 * invariant. The in-memory leg is Blackbox-Atomic; the SQLite leg is
 * Blackbox-GoodCommunication because it crosses the durable SQL boundary.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  BootstrapViolationError,
  IDEAS_LEDGER,
  InMemoryLedgerStore,
  MILESTONES_AMBIENT_ID,
  TASKS_LEDGER,
  type ArchivePointer,
  type Item,
  type Ledger,
  type LedgerStore,
  type Milestone,
  type UpdateItemPatch,
} from "../src/index.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";

const NOW = "2026-08-14T12:00:00.000Z";
const USER_MILESTONE = "M900";

interface IdeasAmbientFixture {
  readonly store: LedgerStore;
  seedArchive(
    ledgerId: string,
    pointerId: string,
    item: Item,
  ): Promise<void>;
  dispose(): Promise<void>;
}

interface IdeasAmbientFactory {
  readonly name: string;
  readonly classification:
    | "Behavioral-Active Blackbox-Atomic"
    | "Behavioral-Active Blackbox-GoodCommunication";
  build(): Promise<IdeasAmbientFixture>;
}

function archivePointer(ledgerId: string, id: string): ArchivePointer {
  return {
    id,
    path: `./archive/${ledgerId}/${id}.md`,
    summary: "legacy archive",
    title: "Legacy milestone",
    status: "done",
  };
}

function archivedItem(
  id: string,
  milestoneId: string,
  status: string,
  fields: Record<string, string>,
): Item {
  return {
    id,
    milestoneId,
    status,
    fields,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function expectAmbientViolation(operation: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BootstrapViolationError);
  expect((caught as Error).message).toContain(MILESTONES_AMBIENT_ID);
}

function runIdeasAmbientAttachmentContract(factory: IdeasAmbientFactory): void {
  describe(`${factory.name} ideas ambient attachment (${factory.classification})`, () => {
    it("creates ideas only under M-AMBIENT while other ledgers retain user milestones", async () => {
      const fixture = await factory.build();
      try {
        const milestone = await fixture.store.createMilestone({
          id: USER_MILESTONE,
          title: "User milestone",
        });
        expect(milestone.id).toBe(USER_MILESTONE);

        const ambient = await fixture.store.createItem(IDEAS_LEDGER, MILESTONES_AMBIENT_ID, {
          status: "open",
          fields: { title: "Ambient idea" },
        });
        expect(ambient.milestoneId).toBe(MILESTONES_AMBIENT_ID);

        await expectAmbientViolation(
          fixture.store.createItem(IDEAS_LEDGER, USER_MILESTONE, {
            status: "open",
            fields: { title: "Misattached idea" },
          }),
        );
        expect(
          fixture.store
            .fetch(IDEAS_LEDGER)
            .milestones.find((group) => group.id === USER_MILESTONE),
        ).toBeUndefined();

        const task = await fixture.store.createItem(TASKS_LEDGER, USER_MILESTONE, {
          status: "planned",
          fields: { headline: "Ordinary task" },
        });
        expect(task.milestoneId).toBe(USER_MILESTONE);
      } finally {
        await fixture.dispose();
      }
    });

    it("restores ideas only to M-AMBIENT without consuming rejected archives", async () => {
      const fixture = await factory.build();
      try {
        await fixture.store.createMilestone({
          id: USER_MILESTONE,
          title: "User milestone",
        });
        const rejected = archivedItem("I900", USER_MILESTONE, "planned", {
          title: "Legacy misattached idea",
        });
        const accepted = archivedItem("I901", MILESTONES_AMBIENT_ID, "planned", {
          title: "Legacy ambient idea",
        });
        const ordinaryTask = archivedItem("T900", USER_MILESTONE, "wip", {
          headline: "Legacy task",
        });
        await fixture.seedArchive(IDEAS_LEDGER, USER_MILESTONE, rejected);
        await fixture.seedArchive(IDEAS_LEDGER, MILESTONES_AMBIENT_ID, accepted);
        await fixture.seedArchive(TASKS_LEDGER, USER_MILESTONE, ordinaryTask);

        await expectAmbientViolation(
          fixture.store.unarchiveItem(IDEAS_LEDGER, USER_MILESTONE, rejected.id),
        );
        const preserved = await fixture.store.fetchArchive(IDEAS_LEDGER, USER_MILESTONE);
        expect(preserved.kind).toBe("group");
        if (preserved.kind !== "group") throw new Error("expected group archive");
        expect(preserved.milestone.id).toBe(USER_MILESTONE);
        expect(preserved.milestone.items).toEqual([rejected]);

        const restored = await fixture.store.unarchiveItem(
          IDEAS_LEDGER,
          MILESTONES_AMBIENT_ID,
          accepted.id,
        );
        expect(restored.milestoneId).toBe(MILESTONES_AMBIENT_ID);
        expect(fixture.store.fetchItem(IDEAS_LEDGER, accepted.id)).toEqual(restored);

        const restoredTask = await fixture.store.unarchiveItem(
          TASKS_LEDGER,
          USER_MILESTONE,
          ordinaryTask.id,
        );
        expect(restoredTask.milestoneId).toBe(USER_MILESTONE);
      } finally {
        await fixture.dispose();
      }
    });

    it("keeps item updates structurally incapable of milestone re-homing", () => {
      type PatchHasMilestoneId = "milestoneId" extends keyof UpdateItemPatch ? true : false;
      const patchHasMilestoneId: PatchHasMilestoneId = false;
      expect(patchHasMilestoneId).toBe(false);
    });
  });
}

runIdeasAmbientAttachmentContract({
  name: "InMemoryLedgerStore",
  classification: "Behavioral-Active Blackbox-Atomic",
  async build(): Promise<IdeasAmbientFixture> {
    const store = new InMemoryLedgerStore();
    await store.init();
    const internal = store as unknown as {
      ledgers: Map<string, Ledger>;
      archives: Map<string, Milestone>;
    };
    return {
      store,
      async seedArchive(ledgerId, pointerId, item): Promise<void> {
        const ledger = internal.ledgers.get(ledgerId);
        if (ledger === undefined) throw new Error(`missing ledger ${ledgerId}`);
        ledger.archivePointers.push(archivePointer(ledgerId, pointerId));
        internal.archives.set(`${ledgerId}/${pointerId}`, {
          id: pointerId,
          title: "Legacy milestone",
          description: "legacy archive",
          items: [structuredClone(item)],
        });
      },
      dispose: () => store.dispose(),
    };
  },
});

const sqliteDirs: string[] = [];

runIdeasAmbientAttachmentContract({
  name: "SqliteLedgerStore",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  async build(): Promise<IdeasAmbientFixture> {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-ideas-ambient-"));
    sqliteDirs.push(dir);
    const dbPath = path.join(dir, "ledger.db");
    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    return {
      store,
      async seedArchive(ledgerId, pointerId, item): Promise<void> {
        const db = openLedgerDb(dbPath);
        try {
          db.query(
            "INSERT INTO archive_pointers (ledger, id, summary, title, status, archived_at) VALUES (?, ?, ?, ?, ?, ?)",
          ).run(ledgerId, pointerId, "legacy archive", "Legacy milestone", "done", NOW);
          db.query(
            `INSERT INTO archived_items
               (ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            ledgerId,
            pointerId,
            item.id,
            item.milestoneId,
            item.status,
            JSON.stringify(item.fields),
            item.createdAt,
            item.updatedAt,
            item.author ?? null,
            item.session ?? null,
          );
        } finally {
          db.close();
        }
      },
      async dispose(): Promise<void> {
        await store.dispose();
      },
    };
  },
});

afterAll(async () => {
  for (const dir of sqliteDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});
