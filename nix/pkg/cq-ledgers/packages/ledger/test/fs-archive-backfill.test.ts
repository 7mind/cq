/**
 * Regression test for D12 / T109: FsLedgerStore.init() must backfill
 * title+status onto legacy ArchivePointers (pre-T91) that were persisted
 * without those fields.
 *
 * Test strategy:
 * 1. Build a fixture dir whose docs/milestones.md carries an `archives:` entry
 *    with ONLY id/path/summary (no title/status — the legacy shape).
 * 2. Place a corresponding docs/archive/milestones/<id>.md that carries:
 *      ### <id> — <status>   ← status
 *      - title: <title>       ← title
 *      - createdAt: ...
 *      - updatedAt: ...
 * 3. After FsLedgerStore.init(), fetch('milestones').archivePointers[0] must
 *    have non-empty title and status reconstructed from the archive file.
 * 4. A missing archive file must NOT throw — title/status stay empty (fail-soft).
 * 5. The InMemory adapter is NOT tested here; it has no on-disk archive path.
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

/** Minimal milestones.md with one legacy archive pointer (no title/status). */
function legacyMilestonesMd(archiveId: string, archivePath: string, summary: string): string {
  return [
    "---",
    "ledger: milestones",
    "counters:",
    "  milestone: 0",
    "  item: 1",
    "archives:",
    `  - id: ${archiveId}`,
    `    path: ${archivePath}`,
    `    summary: "${summary}"`,
    "---",
    "",
    "# milestones",
    "",
    "## active",
    "",
  ].join("\n");
}

/** A milestone-item archive file in the format written by serializeMilestoneItemArchive. */
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

async function makeFixtureRoot(opts: {
  archiveId: string;
  archiveTitle: string;
  archiveStatus: string;
  writeArchiveFile: boolean;
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-backfill-"));
  dirs.push(root);
  const docsDir = path.join(root, LEDGER_STORAGE_DIRNAME);
  const msArchiveDir = path.join(docsDir, "archive", MILESTONES_LEDGER);
  await mkdir(docsDir, { recursive: true });
  await mkdir(msArchiveDir, { recursive: true });

  // Write the canonical registry so every canonical ledger is known.
  await writeFile(
    path.join(docsDir, "ledgers.yaml"),
    serializeRegistry({
      version: 1,
      ledgers: CANONICAL_LEDGERS.map((c) => ({ name: c.name, schema: c.schema })),
    }),
    "utf8",
  );

  // Write a legacy milestones.md with no title/status in the archive entry.
  const relArchivePath = `./archive/${MILESTONES_LEDGER}/${opts.archiveId}.md`;
  const milestonesMd = legacyMilestonesMd(opts.archiveId, relArchivePath, "A legacy milestone");
  await writeFile(path.join(docsDir, "milestones.md"), milestonesMd, "utf8");

  if (opts.writeArchiveFile) {
    const archiveContent = milestoneItemArchiveMd(opts.archiveId, opts.archiveStatus, opts.archiveTitle);
    await writeFile(path.join(msArchiveDir, `${opts.archiveId}.md`), archiveContent, "utf8");
  }

  return root;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FsLedgerStore.init — legacy ArchivePointer backfill (D12 / T109)", () => {
  it("backfills title and status from the archive .md when persisted entry lacks them", async () => {
    const root = await makeFixtureRoot({
      archiveId: "M99",
      archiveTitle: "TUI + web UI improvements",
      archiveStatus: "done",
      writeArchiveFile: true,
    });
    const store = new FsLedgerStore({ root });
    await store.init();
    try {
      const fetched = store.fetch(MILESTONES_LEDGER);
      expect(fetched.archivePointers).toHaveLength(1);
      const ptr = fetched.archivePointers[0];
      expect(ptr).toBeDefined();
      // These are the key assertions — they fail before the fix, pass after.
      expect(ptr!.title).toBe("TUI + web UI improvements");
      expect(ptr!.status).toBe("done");
      expect(ptr!.id).toBe("M99");
      expect(ptr!.summary).toBe("A legacy milestone");
    } finally {
      await store.dispose();
    }
  });

  it("leaves title/status empty (no throw) when the archive .md is missing (fail-soft)", async () => {
    const root = await makeFixtureRoot({
      archiveId: "M88",
      archiveTitle: "Irrelevant — file not written",
      archiveStatus: "done",
      writeArchiveFile: false,
    });
    const store = new FsLedgerStore({ root });
    // Must NOT throw even though the archive .md is absent.
    await expect(store.init()).resolves.toBeUndefined();
    try {
      const fetched = store.fetch(MILESTONES_LEDGER);
      const ptr = fetched.archivePointers[0];
      expect(ptr).toBeDefined();
      // Fail-soft: no archive file → empty title/status, no crash.
      expect(ptr!.title).toBe("");
      expect(ptr!.status).toBe("");
    } finally {
      await store.dispose();
    }
  });

  it("does NOT overwrite title/status that were already persisted (T91+ archives)", async () => {
    // A post-T91 milestones.md carries title+status inline.  The backfill
    // must not re-read the archive file for those pointers (idempotency).
    const root = await mkdtemp(path.join(tmpdir(), "ledger-backfill-existing-"));
    dirs.push(root);
    const docsDir = path.join(root, LEDGER_STORAGE_DIRNAME);
    const msArchiveDir = path.join(docsDir, "archive", MILESTONES_LEDGER);
    await mkdir(docsDir, { recursive: true });
    await mkdir(msArchiveDir, { recursive: true });

    await writeFile(
      path.join(docsDir, "ledgers.yaml"),
      serializeRegistry({
        version: 1,
        ledgers: CANONICAL_LEDGERS.map((c) => ({ name: c.name, schema: c.schema })),
      }),
      "utf8",
    );

    // milestones.md with POPULATED title/status (post-T91 shape).
    const populatedMd = [
      "---",
      "ledger: milestones",
      "counters:",
      "  milestone: 0",
      "  item: 1",
      "archives:",
      "  - id: M77",
      "    path: ./archive/milestones/M77.md",
      "    summary: A settled milestone",
      "    title: The real title",
      "    status: done",
      "---",
      "",
      "# milestones",
      "",
      "## active",
      "",
    ].join("\n");
    await writeFile(path.join(docsDir, "milestones.md"), populatedMd, "utf8");

    // Write a DIFFERENT title in the archive file to detect any overwrite.
    await writeFile(
      path.join(msArchiveDir, "M77.md"),
      milestoneItemArchiveMd("M77", "postponed", "Wrong title — should not be read"),
      "utf8",
    );

    const store = new FsLedgerStore({ root });
    await store.init();
    try {
      const fetched = store.fetch(MILESTONES_LEDGER);
      const ptr = fetched.archivePointers[0];
      expect(ptr).toBeDefined();
      // The persisted values must be preserved; archive file must not override.
      expect(ptr!.title).toBe("The real title");
      expect(ptr!.status).toBe("done");
    } finally {
      await store.dispose();
    }
  });
});
