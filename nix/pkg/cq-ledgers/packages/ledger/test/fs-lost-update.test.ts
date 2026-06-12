/**
 * T426 / D61 parity test — FS-backend analogue of git-lost-update.test.ts.
 *
 * Scenario: two independently-constructed FsLedgerStore instances over ONE
 * shared docs directory with NO onMutation wired between them (no
 * cross-invalidation — simulating two processes). The T425 reload-under-lock
 * fix makes the fs backend correct: each store re-reads the on-disk file from
 * inside the write lock before allocating its counter, so no stale in-memory
 * snapshot can cause a lost write.
 *
 * The interleave is SEQUENTIAL awaited calls. All four milestones must survive.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  serializeRegistry,
  MILESTONES_LEDGER,
  MILESTONES_SCHEMA,
  MILESTONES_ACTIVE_GROUP_ID,
  LEDGER_STORAGE_DIRNAME,
} from "../src/index.js";

const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

/**
 * Create a fresh docs directory pre-seeded with ledgers.yaml (milestones only)
 * and return its parent root (passed as `root` to FsLedgerStore).
 */
async function seedDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "fs-lost-update-"));
  dirs.push(dir);
  const docsDir = path.join(dir, LEDGER_STORAGE_DIRNAME);
  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(
    path.join(docsDir, "ledgers.yaml"),
    serializeRegistry({
      version: 1,
      ledgers: [{ name: MILESTONES_LEDGER, schema: MILESTONES_SCHEMA }],
    }),
    "utf8",
  );
  return dir;
}

describe("T426 / D61 parity — two fs stores over one docs dir, no cross-invalidate", () => {
  test(
    "sequential interleave across two un-invalidated FsLedgerStore instances preserves all milestone writes",
    async () => {
      const root = await seedDir();

      // Two INDEPENDENT FsLedgerStore instances over the SAME docs directory.
      // NO onMutation wired between them → NO cross-invalidation (simulates the
      // two-process condition that caused D61). The T425 fix reloads the ledger
      // from disk inside the write lock, so the stale in-memory snapshot cannot
      // cause a lost write for the fs backend.
      const storeA = new FsLedgerStore({ root });
      const storeB = new FsLedgerStore({ root });
      await storeA.init();
      await storeB.init();

      try {
        // Sequential awaited interleave — the cross-process advisory file lock
        // serialises the writers; the T425 fix ensures each writer reloads the
        // affected ledger from disk after acquiring the lock so it never works
        // from a stale in-memory counter.
        const a1 = await storeA.createMilestone({ title: "W1" });
        const b1 = await storeB.createMilestone({ title: "W2" });
        const a2 = await storeA.createMilestone({ title: "W3" });
        const b2 = await storeB.createMilestone({ title: "W4" });

        const returned = [a1, b1, a2, b2];
        const expectedTitles = new Map(
          returned.map((m) => [m.id, m.fields["title"] as string]),
        );

        // THIRD fresh store: init() re-reads docs from disk — the authority of
        // record — not from any surviving in-memory map.
        const reader = new FsLedgerStore({ root });
        await reader.init();
        try {
          const ms = reader.fetch(MILESTONES_LEDGER);
          const activeGroup = ms.milestones.find((g) => g.id === MILESTONES_ACTIVE_GROUP_ID);
          if (activeGroup === undefined) throw new Error("active milestone group missing on disk");
          // Collect the four user milestones (exclude the immortal M-AMBIENT
          // bootstrap milestone that init() injects, which has no user title).
          const storedById = new Map(
            activeGroup.items
              .filter((it) => typeof it.fields["title"] === "string")
              .map((it) => [it.id, it.fields["title"] as string]),
          );

          // (b) The four returned ids are DISTINCT — no duplicate M<n>.
          const returnedIds = returned.map((m) => m.id);
          expect(new Set(returnedIds).size).toBe(4);

          // (a) All four titles W1..W4 are present in the stored docs.
          const storedTitles = new Set(storedById.values());
          for (const title of ["W1", "W2", "W3", "W4"]) {
            expect(storedTitles.has(title)).toBe(true);
          }

          // (c) Every returned id resolves to a stored milestone with its
          // expected title — no dropped/clobbered write.
          for (const [id, title] of expectedTitles) {
            expect(storedById.get(id)).toBe(title);
          }
        } finally {
          await reader.dispose();
        }
      } finally {
        await storeA.dispose();
        await storeB.dispose();
      }
    },
    30_000,
  );
});
