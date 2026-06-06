/**
 * Tests for FsLedgerStore.reset() with non-canonical ledgers (D21 / T131).
 *
 * A ledger created via createLedger() is non-canonical. Prior to T131 fix,
 * reset() would leave:
 *   (a) an orphan docs/<name>.md file on disk,
 *   (b) a stale registry entry (name still returned by enumerate()),
 *   (c) stale FTS docs (ftsSearch returned hits from the wiped ledger).
 *
 * After the fix all three are eliminated.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  CANONICAL_LEDGERS,
} from "../src/index.js";
import type { LedgerSchema } from "../src/index.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function makeStore(now?: () => string): Promise<{ store: FsLedgerStore; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-reset-nc-"));
  dirs.push(root);
  const opts: ConstructorParameters<typeof FsLedgerStore>[0] = { root };
  if (now !== undefined) opts.now = now;
  const store = new FsLedgerStore(opts);
  await store.init();
  return { store, root };
}

const OPS_SCHEMA: LedgerSchema = {
  statusValues: ["open", "closed"],
  terminalStatuses: ["closed"],
  fields: { headline: { type: "string", required: true } },
};

describe("FsLedgerStore.reset with non-canonical ledger", () => {
  it("(a) no orphan docs/ops.md, (b) no ops registry entry, (c) no FTS hits after reset", async () => {
    const { store, root } = await makeStore();

    await store.createLedger("ops", OPS_SCHEMA);

    const milestone = await store.createMilestone({ title: "ops milestone" });
    await store.createItem("ops", milestone.id, {
      status: "open",
      fields: { headline: "ops-item-one" },
    });

    const beforeHits = await store.ftsSearch("ops-item-one");
    expect(beforeHits.length).toBeGreaterThan(0);

    const opsFilePath = path.join(root, "docs", "ops.md");
    expect((await stat(opsFilePath)).isFile()).toBe(true);

    expect(store.enumerate()).toContain("ops");

    await store.reset();

    // (a) No orphan docs/ops.md file on disk.
    let fileExists = false;
    try {
      await stat(opsFilePath);
      fileExists = true;
    } catch (e) {
      expect((e as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
    expect(fileExists).toBe(false);

    // (b) 'ops' must not appear in the registry / enumerate() after reset.
    expect(store.enumerate()).not.toContain("ops");
    expect(store.enumerate().sort()).toEqual(
      CANONICAL_LEDGERS.map((c) => c.name).sort(),
    );

    // (c) ftsSearch must return NO hits for the wiped non-canonical ledger.
    const afterHits = await store.ftsSearch("ops-item-one");
    expect(afterHits).toHaveLength(0);

    await store.dispose();
  });

  it("backed-up ops.md appears in the backup directory", async () => {
    const fixedTs = "2026-06-03T10:00:00.000Z";
    const { store } = await makeStore(() => fixedTs);

    await store.createLedger("ops", OPS_SCHEMA);

    const milestone = await store.createMilestone({ title: "ops milestone" });
    await store.createItem("ops", milestone.id, {
      status: "open",
      fields: { headline: "ops-backup-check" },
    });

    const summary = await store.reset();

    const { readdir } = await import("node:fs/promises");
    const backedUp = await readdir(summary.backupDir);
    expect(backedUp).toContain("ops.md");
    expect(backedUp).toContain("ledgers.yaml");

    await store.dispose();
  });
});
