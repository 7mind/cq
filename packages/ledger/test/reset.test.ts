/**
 * Unit tests for FsLedgerStore.reset() (T123).
 *
 * reset() is the public, operator-facing wipe-and-reinit: it snapshots the
 * current on-disk ledgers to docs/.backup/<ts>/ and rewrites the canonical
 * empty set, returning a summary of what was backed up. It reuses the private
 * backupAndReinit verbatim for the snapshot/reinit and adds only the pre-wipe
 * per-ledger item count + the returned summary.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  CANONICAL_LEDGERS,
  DEFECTS_LEDGER,
  TASKS_LEDGER,
} from "../src/index.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function makeStore(now?: () => string): Promise<{ store: FsLedgerStore; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-reset-"));
  dirs.push(root);
  const storeOpts: ConstructorParameters<typeof FsLedgerStore>[0] = { root };
  if (now !== undefined) storeOpts.now = now;
  const store = new FsLedgerStore(storeOpts);
  await store.init();
  return { store, root };
}

describe("FsLedgerStore.reset", () => {
  it("backs up prior state, reinitialises the canonical empty set, and returns matching counts", async () => {
    const fixedTs = "2026-06-01T12:34:56.000Z";
    const { store, root } = await makeStore(() => fixedTs);

    // Seed items across two ledgers under a real milestone.
    const m = await store.createMilestone({ title: "reset target" });
    await store.createItem(DEFECTS_LEDGER, m.id, {
      status: "open",
      fields: { headline: "d1", severity: "minor" },
    });
    await store.createItem(DEFECTS_LEDGER, m.id, {
      status: "open",
      fields: { headline: "d2", severity: "major" },
    });
    await store.createItem(TASKS_LEDGER, m.id, {
      status: "planned",
      fields: { headline: "t1" },
    });

    // Count seeded active items per ledger directly from the live store, so the
    // assertion does not hard-code the milestones-ledger seed (bootstrap +
    // M-AMBIENT + the new milestone).
    const beforeCounts = new Map<string, number>();
    for (const name of store.enumerate()) {
      const items = store.fetch(name).milestones.flatMap((g) => g.items);
      beforeCounts.set(name, items.length);
    }

    const summary = await store.reset();

    // (a) docs/.backup/<ts>/ exists and contains the prior registry + ledger files.
    const expectedDirName = fixedTs.replace(/:/g, "-");
    const expectedBackupDir = path.join(root, "docs", ".backup", expectedDirName);
    expect(summary.backupDir).toBe(expectedBackupDir);
    expect((await stat(expectedBackupDir)).isDirectory()).toBe(true);
    const backedUp = await readdir(expectedBackupDir);
    expect(backedUp).toContain("ledgers.yaml");
    expect(backedUp).toContain(`${DEFECTS_LEDGER}.md`);
    expect(backedUp).toContain(`${TASKS_LEDGER}.md`);

    // (c) summary counts match what the live store held before the wipe.
    expect(summary.ledgers.map((l) => l.name).sort()).toEqual(
      CANONICAL_LEDGERS.map((c) => c.name).sort(),
    );
    for (const { name, itemCount } of summary.ledgers) {
      expect(beforeCounts.has(name)).toBe(true);
      expect(itemCount).toBe(beforeCounts.get(name)!);
    }
    // Concretely: the two defects and the one task we seeded.
    const byName = new Map(summary.ledgers.map((l) => [l.name, l.itemCount]));
    expect(byName.get(DEFECTS_LEDGER)).toBe(2);
    expect(byName.get(TASKS_LEDGER)).toBe(1);

    // (b) live ledgers are back to the canonical empty set: no defects/tasks
    // items, and the milestones ledger holds only the bootstrap + M-AMBIENT.
    expect(store.enumerate().sort()).toEqual(CANONICAL_LEDGERS.map((c) => c.name).sort());
    expect(store.fetch(DEFECTS_LEDGER).milestones.flatMap((g) => g.items)).toHaveLength(0);
    expect(store.fetch(TASKS_LEDGER).milestones.flatMap((g) => g.items)).toHaveLength(0);

    // (d) the post-reset defects ledger carries the canonical (T116) status set,
    // proving the reinit reused CANONICAL_LEDGERS rather than a stale schema.
    expect(store.fetch(DEFECTS_LEDGER).schema.statusValues).toEqual([
      "open",
      "wip",
      "root-caused",
      "inconclusive",
      "resolved",
      "wontfix",
    ]);

    await store.dispose();
  });
});
