/**
 * Regression guard (T247) — an ADDITIVE statusValue in HANDOFFS_SCHEMA must
 * NOT destroy live handoff history at init().
 *
 * Background: T245 widened HANDOFFS_SCHEMA.statusValues with a 5th terminal
 * status, `user-action-required`. A store whose on-disk handoffs registry
 * entry already carries that widened shape (it was written by a build that
 * also had the widened canonical schema) must round-trip cleanly through
 * FsLedgerStore.init():
 *
 *   - because the on-disk schema EQUALS the canonical HANDOFFS_SCHEMA, init()
 *     detects NO divergence → no .cq/.backup/<ts>/ snapshot, no reinit; and
 *   - any pre-existing HO record (here an `HO1` with status `drained`) is
 *     still readable after init().
 *
 * If a future change makes init() treat the additive shape as divergent (and
 * therefore back up + empty the handoffs ledger), these assertions FAIL.
 *
 * The fixture depends ONLY on the committed schema (HANDOFFS_SCHEMA via the
 * library API) and a TEMP store — never on the live, gitignored .cq/. The
 * on-disk handoffs registry entry + the HO1 record are materialised by an
 * initial store whose canonical bootstrap schema is the widened shape, so the
 * seeded on-disk schema matches canon exactly and does NOT diverge. This
 * mirrors the §3 no-divergence harness in backup-reinit-init.test.ts (prime a
 * canonical store, dispose, re-init from those files).
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  HANDOFFS_LEDGER,
  HANDOFFS_SCHEMA,
  LEDGER_STORAGE_DIRNAME,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs)
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

/** The additive status that T245 appended to the canonical handoffs schema. */
const WIDENED_STATUS = "user-action-required";

/** Create a fresh tmpdir; .cq/ is created by the store on init(). */
async function makeTmpRoot(): Promise<{ root: string; docsDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-ho-additive-"));
  dirs.push(root);
  return { root, docsDir: path.join(root, LEDGER_STORAGE_DIRNAME) };
}

/**
 * Seed a temp store whose on-disk handoffs ledger + registry already carry the
 * WIDENED canonical schema, with one pre-existing HO record (`HO1`, status
 * `drained`). Returns the docs dir and the seeded item id.
 *
 * Sanity-precondition: the widened canonical schema actually contains the new
 * additive status — otherwise this fixture would not exercise the regression.
 */
async function seedWidenedHandoffsStore(
  root: string,
): Promise<{ handoffId: string }> {
  expect(HANDOFFS_SCHEMA.statusValues).toContain(WIDENED_STATUS);

  const seedStore = new FsLedgerStore({ root });
  await seedStore.init();
  const milestone = await seedStore.createMilestone({ title: "seed handoffs milestone" });
  const created = await seedStore.createItem(HANDOFFS_LEDGER, milestone.id, {
    status: "drained",
    fields: {
      summary: "pre-existing handoff that must survive additive schema widening",
      flow: "implement",
      handoffReasons: [],
    },
  });
  await seedStore.dispose();
  return { handoffId: created.id };
}

// ---------------------------------------------------------------------------
// Fixture preconditions — the on-disk schema carries the widened shape
// ---------------------------------------------------------------------------

describe("handoffs additive widening — fixture carries the widened on-disk schema", () => {
  it("the seeded on-disk ledgers.yaml registry includes user-action-required", async () => {
    const { root, docsDir } = await makeTmpRoot();
    await seedWidenedHandoffsStore(root);

    const registry = await readFile(path.join(docsDir, "ledgers.yaml"), "utf8");
    expect(registry).toContain(HANDOFFS_LEDGER);
    expect(registry).toContain(WIDENED_STATUS);
  });

  it("the seeded HO1 record is present on disk before re-init", async () => {
    const { root, docsDir } = await makeTmpRoot();
    const { handoffId } = await seedWidenedHandoffsStore(root);
    expect(handoffId).toBe("HO1");

    const handoffsMd = await readFile(path.join(docsDir, `${HANDOFFS_LEDGER}.md`), "utf8");
    expect(handoffsMd).toContain(handoffId);
    expect(handoffsMd).toContain("must survive additive schema widening");
  });
});

// ---------------------------------------------------------------------------
// The guard — init() against the widened canonical schema is a no-op for the
// additive shape: no backup, no reinit, the HO record survives.
// ---------------------------------------------------------------------------

describe("handoffs additive widening — init() preserves live handoff history", () => {
  it("init() does NOT create a .cq/.backup/ dir for the additive shape", async () => {
    const { root, docsDir } = await makeTmpRoot();
    await seedWidenedHandoffsStore(root);

    const store = new FsLedgerStore({ root });
    await store.init();
    await store.dispose();

    const backupParent = path.join(docsDir, ".backup");
    let backupExists = false;
    try {
      await stat(backupParent);
      backupExists = true;
    } catch {
      // ENOENT expected — no divergence, no backup.
    }
    expect(backupExists).toBe(false);
  });

  it("init() does NOT reset the handoffs ledger to fresh-canonical (empty)", async () => {
    const { root, docsDir } = await makeTmpRoot();
    const { handoffId } = await seedWidenedHandoffsStore(root);

    const store = new FsLedgerStore({ root });
    await store.init();
    await store.dispose();

    // A reinit would have rewritten handoffs.md as an empty fresh-canonical
    // ledger — the pre-seeded record would be gone from disk.
    const handoffsMd = await readFile(path.join(docsDir, `${HANDOFFS_LEDGER}.md`), "utf8");
    expect(handoffsMd).toContain(handoffId);
    expect(handoffsMd).toContain("must survive additive schema widening");
  });

  it("the pre-seeded HO record is readable after init()", async () => {
    const { root } = await makeTmpRoot();
    const { handoffId } = await seedWidenedHandoffsStore(root);

    const store = new FsLedgerStore({ root });
    await store.init();
    try {
      const fetched = store.fetchItem(HANDOFFS_LEDGER, handoffId);
      expect(fetched.id).toBe(handoffId);
      expect(fetched.status).toBe("drained");
      expect(fetched.fields["summary"]).toBe(
        "pre-existing handoff that must survive additive schema widening",
      );

      // And the live handoffs ledger still carries the widened schema in-memory.
      const handoffs = store.fetch(HANDOFFS_LEDGER);
      expect(handoffs.schema.statusValues).toEqual(HANDOFFS_SCHEMA.statusValues);
      expect(handoffs.schema.statusValues).toContain(WIDENED_STATUS);
    } finally {
      await store.dispose();
    }
  });
});
