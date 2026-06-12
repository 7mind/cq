/**
 * Regression test for D16 / T110: FsLedgerStore.init() must backfill
 * title+status onto legacy ArchivePointers for NON-milestones ledgers (e.g.
 * tasks) by reading from the milestones-ledger's single-item archive
 * (.cq/archive/milestones/<id>.md), NOT from the per-ledger group archive
 * at ptr.path.
 *
 * Test strategy:
 * 1. Build a fixture dir whose .cq/tasks.md carries an `archives:` entry with
 *    ONLY id/path/summary (no title/status — the legacy shape). The ptr.path
 *    resolves to a tasks GROUP archive (.cq/archive/tasks/<id>.md) that begins
 *    with `## M<id>` and carries items, but NO milestone title — so naively
 *    parsing ptr.path via parseMilestoneItemArchive would fail/return title:''.
 * 2. Place .cq/archive/milestones/<id>.md with the real milestone title+status
 *    (the single-ITEM shape `### M<n> — <status>` + `- title: <title>`).
 * 3. After FsLedgerStore.init(), fetch('tasks').archivePointers[0] MUST have
 *    non-empty title and status.
 * 4. Verify the group archive file alone does NOT contain the title — ensuring
 *    the test would fail under the naive "parse ptr.path" approach.
 * 5. InMemory parity: no on-disk archive → titles remain empty (not tested
 *    here; InMemoryLedgerStore is unchanged per the spec).
 */

import { describe, it, expect, afterAll } from "bun:test";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  CANONICAL_LEDGERS,
  MILESTONES_LEDGER,
  TASKS_LEDGER,
  serializeRegistry,
  LEDGER_STORAGE_DIRNAME,
} from "../src/index.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs)
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal tasks.md with one legacy archive pointer (no title/status). */
function legacyTasksMd(archiveId: string, archivePath: string, summary: string): string {
  return [
    "---",
    "ledger: tasks",
    "counters:",
    "  milestone: 1",
    "  item: 2",
    "archives:",
    `  - id: ${archiveId}`,
    `    path: ${archivePath}`,
    `    summary: "${summary}"`,
    "---",
    "",
    "# tasks",
    "",
    "## M-AMBIENT",
    "",
  ].join("\n");
}

/**
 * A tasks-ledger GROUP archive file in the format written by serializeArchive.
 * Uses the bare-id `## M<id>` depth-2 heading (NO milestone title here) and
 * contains items. This is what parseMilestoneItemArchive would fail/parse-soft
 * on — proving the naive "parse ptr.path" approach cannot recover the title.
 */
function tasksGroupArchiveMd(milestoneId: string): string {
  const now = "2026-01-01T00:00:00.000Z";
  return [
    `## ${milestoneId}`,
    "",
    `### T50 — done`,
    "",
    `- createdAt: ${now}`,
    `- updatedAt: ${now}`,
    `- headline: Some task`,
    "",
  ].join("\n");
}

/** A milestone-item archive file (milestones ledger) in the format written by
 * serializeMilestoneItemArchive. Shape: `### M<n> — <status>` + field list. */
function milestoneItemArchiveMd(id: string, status: string, title: string): string {
  const now = "2026-01-01T00:00:00.000Z";
  return [
    `### ${id} — ${status}`,
    "",
    `- title: ${title}`,
    `- createdAt: ${now}`,
    `- updatedAt: ${now}`,
    "",
  ].join("\n");
}

async function makeFixture(opts: {
  archiveId: string;
  archiveTitle: string;
  archiveStatus: string;
  writeMilestoneArchive: boolean;
  writeGroupArchive: boolean;
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-backfill-nm-"));
  dirs.push(root);
  const docsDir = path.join(root, LEDGER_STORAGE_DIRNAME);
  const tasksArchiveDir = path.join(docsDir, "archive", TASKS_LEDGER);
  const msArchiveDir = path.join(docsDir, "archive", MILESTONES_LEDGER);
  await mkdir(docsDir, { recursive: true });
  await mkdir(tasksArchiveDir, { recursive: true });
  await mkdir(msArchiveDir, { recursive: true });

  await writeFile(
    path.join(docsDir, "ledgers.yaml"),
    serializeRegistry({
      version: 1,
      ledgers: CANONICAL_LEDGERS.map((c) => ({ name: c.name, schema: c.schema })),
    }),
    "utf8",
  );

  // Write milestones.md (no archive pointer; milestone is already gone to disk).
  const milestonesMd = [
    "---",
    "ledger: milestones",
    "counters:",
    "  milestone: 1",
    "  item: 1",
    "archives:",
    `  - id: ${opts.archiveId}`,
    `    path: ./archive/${MILESTONES_LEDGER}/${opts.archiveId}.md`,
    `    summary: "A legacy milestone from milestones ledger"`,
    `    title: ${opts.archiveTitle}`,
    `    status: ${opts.archiveStatus}`,
    "---",
    "",
    "# milestones",
    "",
    "## active",
    "",
  ].join("\n");
  await writeFile(path.join(docsDir, "milestones.md"), milestonesMd, "utf8");

  // Write legacy tasks.md — archive pointer has NO title/status.
  const relGroupPath = `./archive/${TASKS_LEDGER}/${opts.archiveId}.md`;
  await writeFile(
    path.join(docsDir, "tasks.md"),
    legacyTasksMd(opts.archiveId, relGroupPath, "A legacy milestone for tasks"),
    "utf8",
  );

  if (opts.writeGroupArchive) {
    // The GROUP archive contains items but NO milestone title.
    await writeFile(
      path.join(tasksArchiveDir, `${opts.archiveId}.md`),
      tasksGroupArchiveMd(opts.archiveId),
      "utf8",
    );
  }

  if (opts.writeMilestoneArchive) {
    // The milestones-ledger single-ITEM archive contains the real title.
    await writeFile(
      path.join(msArchiveDir, `${opts.archiveId}.md`),
      milestoneItemArchiveMd(opts.archiveId, opts.archiveStatus, opts.archiveTitle),
      "utf8",
    );
  }

  return root;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FsLedgerStore.init — legacy ArchivePointer backfill for NON-milestones ledgers (D16 / T110)", () => {
  it("backfills title+status on tasks ledger's archive pointer from milestones archive by id", async () => {
    const root = await makeFixture({
      archiveId: "M12",
      archiveTitle: "Big refactor milestone",
      archiveStatus: "done",
      writeMilestoneArchive: true,
      writeGroupArchive: true,
    });

    const store = new FsLedgerStore({ root });
    await store.init();
    try {
      const fetched = store.fetch(TASKS_LEDGER);
      expect(fetched.archivePointers).toHaveLength(1);
      const ptr = fetched.archivePointers[0];
      expect(ptr).toBeDefined();
      // These are the key assertions: the title must come from the milestones
      // archive, NOT from the tasks group archive (which has no title).
      expect(ptr!.title).toBe("Big refactor milestone");
      expect(ptr!.status).toBe("done");
      expect(ptr!.id).toBe("M12");
    } finally {
      await store.dispose();
    }
  });

  it("leaves title/status empty (fail-soft) when milestones archive is missing for a tasks pointer", async () => {
    const root = await makeFixture({
      archiveId: "M13",
      archiveTitle: "Ignored — no milestone archive",
      archiveStatus: "done",
      writeMilestoneArchive: false,
      writeGroupArchive: true,
    });

    const store = new FsLedgerStore({ root });
    await expect(store.init()).resolves.toBeUndefined();
    try {
      const fetched = store.fetch(TASKS_LEDGER);
      const ptr = fetched.archivePointers[0];
      expect(ptr).toBeDefined();
      // Fail-soft: no milestones archive file → empty title/status, no crash.
      expect(ptr!.title).toBe("");
      expect(ptr!.status).toBe("");
    } finally {
      await store.dispose();
    }
  });

  it("does NOT touch already-populated title/status on non-milestones pointers", async () => {
    // Write a tasks.md that already has title+status on the pointer.
    const root = await mkdtemp(path.join(tmpdir(), "ledger-backfill-nm-populated-"));
    dirs.push(root);
    const docsDir = path.join(root, LEDGER_STORAGE_DIRNAME);
    const tasksArchiveDir = path.join(docsDir, "archive", TASKS_LEDGER);
    const msArchiveDir = path.join(docsDir, "archive", MILESTONES_LEDGER);
    await mkdir(docsDir, { recursive: true });
    await mkdir(tasksArchiveDir, { recursive: true });
    await mkdir(msArchiveDir, { recursive: true });

    await writeFile(
      path.join(docsDir, "ledgers.yaml"),
      serializeRegistry({
        version: 1,
        ledgers: CANONICAL_LEDGERS.map((c) => ({ name: c.name, schema: c.schema })),
      }),
      "utf8",
    );

    // milestones.md (no archive pointers for milestones — kept simple).
    await writeFile(
      path.join(docsDir, "milestones.md"),
      [
        "---",
        "ledger: milestones",
        "counters:",
        "  milestone: 0",
        "  item: 0",
        "---",
        "",
        "# milestones",
        "",
        "## active",
        "",
      ].join("\n"),
      "utf8",
    );

    // tasks.md with already-populated title+status.
    const populatedTasksMd = [
      "---",
      "ledger: tasks",
      "counters:",
      "  milestone: 1",
      "  item: 0",
      "archives:",
      "  - id: M14",
      "    path: ./archive/tasks/M14.md",
      "    summary: A settled milestone",
      "    title: The correct title",
      "    status: done",
      "---",
      "",
      "# tasks",
      "",
      "## M-AMBIENT",
      "",
    ].join("\n");
    await writeFile(path.join(docsDir, "tasks.md"), populatedTasksMd, "utf8");

    // Write a milestones archive with a DIFFERENT title to detect overwrites.
    await writeFile(
      path.join(msArchiveDir, "M14.md"),
      milestoneItemArchiveMd("M14", "postponed", "Wrong title — must not overwrite"),
      "utf8",
    );
    // Write the tasks group archive.
    await writeFile(
      path.join(tasksArchiveDir, "M14.md"),
      tasksGroupArchiveMd("M14"),
      "utf8",
    );

    const store = new FsLedgerStore({ root });
    await store.init();
    try {
      const fetched = store.fetch(TASKS_LEDGER);
      const ptr = fetched.archivePointers[0];
      expect(ptr).toBeDefined();
      // The persisted values must be preserved — backfill must not overwrite.
      expect(ptr!.title).toBe("The correct title");
      expect(ptr!.status).toBe("done");
    } finally {
      await store.dispose();
    }
  });
});
