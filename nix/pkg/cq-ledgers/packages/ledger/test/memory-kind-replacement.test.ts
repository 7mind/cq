/**
 * G192/T6627 — an unsupported memory kind rejects a parsed replacement before
 * any effect.
 *
 * Direct `InMemoryLedgerStore.replaceFromParsedDump` must leave ledgers,
 * archives, counters, plan-lifecycle state, workset roots, logs, the search
 * index, provenance, and timestamps unchanged; the SQLite import
 * (`restoreDumpToXdg`) must leave every table row unchanged.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  GOALS_LEDGER,
  InMemoryLedgerStore,
  MEMORIES_LEDGER,
  MILESTONES_AMBIENT_ID,
  SqliteLedgerStore,
  TASKS_LEDGER,
  UnsupportedMemoryKindError,
  buildBackupDump,
  createTrustedWorksetManagementAuthority,
  parseBackupDump,
  restoreDumpToXdg,
  serializeArchive,
  serializeLedger,
  type BackupDumpFile,
  type LedgerStore,
  type ParsedDump,
  type PlanClaimInput,
} from "../src/index.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";

const OWNER = "R".repeat(22);
const PROVENANCE = { author: "replacement-author", session: "replacement-session" } as const;
const ARCHIVED_GROUP_ID = "M90";
const UNSUPPORTED_KIND = "opinion";
const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** Populate every state class the replacement could disturb. */
async function populate(store: InMemoryLedgerStore): Promise<void> {
  await store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: "G1",
    status: "clarifying",
    fields: { title: "replacement target goal", description: "survives a rejected replacement" },
    ...PROVENANCE,
  });
  const claim: PlanClaimInput = {
    goalId: "G1",
    purpose: "initial",
    claimRequestId: "replacement-claim",
    ownerFenceToken: OWNER,
    expectedGeneration: null,
    ...PROVENANCE,
  };
  const claimed = await store.claimPlan(claim);
  if (!claimed.ok) throw new Error("plan claim failed");
  const milestone = await store.createMilestone({ title: "archived replacement group" });
  await store.createItem(TASKS_LEDGER, milestone.id, {
    status: "done",
    fields: { headline: "archived replacement task", description: "archived", suggestedModel: "x" },
    ...PROVENANCE,
  });
  await store.updateMilestone(milestone.id, { status: "done" });
  await store.archiveMilestone(milestone.id, "archived for the replacement fixture");
  await store.createItem(MEMORIES_LEDGER, MILESTONES_AMBIENT_ID, {
    status: "active",
    fields: { title: "replacement target memory", content: "target body", kind: "rule" },
    ...PROVENANCE,
  });
  await store.putLog("notes/replacement.md", "replacement target log\n");
  await store.replaceWorksetRoots(["goals:G1"]);
}

async function observe(store: InMemoryLedgerStore): Promise<unknown> {
  const logs: Array<{ path: string; content: string }> = [];
  for await (const entry of store.listLogs()) logs.push(entry);
  const fts = await store.ftsSearch("replacement", { includeArchived: true, limit: 100 });
  return {
    ledgers: store.enumerate().map((name) => store.fetch(name)),
    physical: await store.exportPhysicalLedgerState(),
    planLifecycle: store.exportPlanLifecycleState(),
    roots: await store.worksetStore().snapshot(),
    logs,
    // Equal-score hits carry no order guarantee; compare the hit set.
    fts: fts
      .map(({ ledgerId, item, matchedFields }) => ({ ledgerId, item, matchedFields }))
      .sort((a, b) => `${a.ledgerId}:${a.item.id}`.localeCompare(`${b.ledgerId}:${b.item.id}`)),
  };
}

/** A valid replacement source whose parsed memories carry an injected unsupported kind. */
async function poisonedReplacement(where: "active" | "archived"): Promise<ParsedDump> {
  const source = new InMemoryLedgerStore();
  await source.init();
  try {
    await source.createItem(MEMORIES_LEDGER, MILESTONES_AMBIENT_ID, {
      status: "active",
      fields: { title: "replacement source memory", content: "source body", kind: "fact" },
    });
    const parsed = parseBackupDump(await buildBackupDump(source, null));
    const memories = parsed.ledgers.get(MEMORIES_LEDGER);
    if (memories === undefined) throw new Error("source dump lacks memories");
    if (where === "active") {
      const item = memories.milestones.flatMap((group) => group.items)[0];
      if (item === undefined) throw new Error("source memory missing");
      item.fields = { ...item.fields, kind: UNSUPPORTED_KIND };
    } else {
      memories.archivePointers.push({
        id: ARCHIVED_GROUP_ID,
        path: `./archive/${MEMORIES_LEDGER}/${ARCHIVED_GROUP_ID}.md`,
        summary: "poisoned archive",
        title: "poisoned",
        status: "done",
      });
      parsed.archives.set(
        MEMORIES_LEDGER,
        new Map([
          [
            ARCHIVED_GROUP_ID,
            {
              kind: "group",
              milestone: {
                id: ARCHIVED_GROUP_ID,
                title: "",
                description: "",
                items: [
                  {
                    id: "MEM90",
                    milestoneId: ARCHIVED_GROUP_ID,
                    status: "superseded",
                    fields: { title: "archived", content: "archived", kind: UNSUPPORTED_KIND },
                    createdAt: "2026-01-02T03:04:05.000Z",
                    updatedAt: "2026-01-02T03:04:05.000Z",
                  },
                ],
              },
            },
          ],
        ]),
      );
    }
    return parsed;
  } finally {
    await source.dispose();
  }
}

/** Re-serialize a poisoned parsed memories ledger into an otherwise valid dump. */
function poisonedDumpFiles(base: readonly BackupDumpFile[], parsed: ParsedDump): BackupDumpFile[] {
  const memories = parsed.ledgers.get(MEMORIES_LEDGER);
  if (memories === undefined) throw new Error("parsed dump lacks memories");
  const files = base.filter(({ path: relPath }) => relPath !== `${MEMORIES_LEDGER}.md`);
  files.push({ path: `${MEMORIES_LEDGER}.md`, content: serializeLedger(memories) });
  for (const [pointerId, content] of parsed.archives.get(MEMORIES_LEDGER) ?? []) {
    if (content.kind !== "group") continue;
    files.push({
      path: `archive/${MEMORIES_LEDGER}/${pointerId}.md`,
      content: serializeArchive(content.milestone),
    });
  }
  return files;
}

describe("InMemoryLedgerStore.replaceFromParsedDump memory-kind validation", () => {
  for (const where of ["active", "archived"] as const) {
    it(`rejects an unsupported ${where} kind leaving every state class unchanged`, async () => {
      const store = new InMemoryLedgerStore();
      await store.init();
      try {
        await populate(store);
        expect(store.exportPlanLifecycleState()).not.toBeNull();
        expect((await store.worksetStore().snapshot()).roots).toEqual(["goals:G1"]);
        expect(store.fetch(TASKS_LEDGER).archivePointers).toHaveLength(1);
        const before = await observe(store);
        const replacement = await poisonedReplacement(where);
        await expect(store.replaceFromParsedDump(replacement)).rejects.toThrow(
          UnsupportedMemoryKindError,
        );
        expect(await observe(store)).toEqual(before);
      } finally {
        await store.dispose();
      }
    });
  }
});

function sqliteRows(dbPath: string): Record<string, unknown[]> {
  const db = openLedgerDb(dbPath);
  try {
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    return Object.fromEntries(
      tables.map(({ name }) => [name, db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all()]),
    );
  } finally {
    db.close();
  }
}

describe("restoreDumpToXdg memory-kind validation", () => {
  for (const where of ["active", "archived"] as const) {
    it(`rejects an unsupported ${where} kind before touching any SQLite row`, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "memory-kind-replacement-"));
      dirs.push(dir);
      const dbPath = path.join(dir, "ledger.db");
      const target: LedgerStore = new SqliteLedgerStore({ dbPath });
      await target.init();
      await target.createItem(MEMORIES_LEDGER, MILESTONES_AMBIENT_ID, {
        status: "active",
        fields: { title: "sqlite target memory", content: "target body", kind: "environment" },
        ...PROVENANCE,
      });
      await target.dispose();
      const before = sqliteRows(dbPath);

      const source = new InMemoryLedgerStore();
      await source.init();
      const base = await buildBackupDump(source, null);
      await source.dispose();
      const dump = poisonedDumpFiles(base, await poisonedReplacement(where));

      await expect(
        restoreDumpToXdg({
          dbPath,
          logsDir: null,
          dump,
          authority: createTrustedWorksetManagementAuthority(),
          overwriteAuthorized: true,
        }),
      ).rejects.toThrow(UnsupportedMemoryKindError);
      expect(sqliteRows(dbPath)).toEqual(before);
    });
  }
});
