/**
 * T259 / D39 — STORE-API dual-adapter coverage of the handoffs write-time
 * invariant.
 *
 * T257 added `handoff-invariants.test.ts`, a DIRECT matrix against the pure
 * `assertHandoffInvariants` helper; T258 wired that helper into the store
 * layer's `applyCreateItem` / `applyUpdateItem`. This file does NOT duplicate
 * the direct-helper matrix — it exercises the SAME conditional invariant
 * through the public `LedgerStore` API (`createItem` / `updateItem`), and runs
 * every assertion against BOTH adapters per the package's DUAL-TESTS pattern:
 *
 *   - InMemoryLedgerStore (the in-memory dummy), and
 *   - FsLedgerStore over a TEMP dir (mkdtemp) — never the repo's live .cq/.
 *
 * The handoffs ledger is bootstrapped canonically on init() for both adapters;
 * each fixture seeds one active milestone and then writes handoffs items under
 * it.
 *
 * Invariant under test (status-conditional required fields the status-blind
 * HANDOFFS_SCHEMA cannot express): a `mixed` / `answers-required` handoff MUST
 * carry a non-empty `blockingQuestions`; a `user-action-required` handoff MUST
 * carry a non-empty `handoffReasons`. `drained` / `illness-detected` carry
 * neither (per-status, not blanket).
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  InMemoryLedgerStore,
  HANDOFFS_LEDGER,
  SchemaValidationError,
  type LedgerStore,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Cleanup of Fs temp roots
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs)
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

// ---------------------------------------------------------------------------
// Dual-adapter factories: each returns an inited store + an active milestone id
// to attach handoffs items to. Both adapters bootstrap the canonical handoffs
// ledger on init().
// ---------------------------------------------------------------------------

interface Fixture {
  readonly store: LedgerStore;
  readonly milestoneId: string;
}

async function buildInMemory(): Promise<Fixture> {
  const store = new InMemoryLedgerStore({});
  await store.init();
  const milestone = await store.createMilestone({ title: "handoffs write-time invariant" });
  return { store, milestoneId: milestone.id };
}

async function buildFs(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-ho-write-time-"));
  dirs.push(root);
  const store = new FsLedgerStore({ root });
  await store.init();
  const milestone = await store.createMilestone({ title: "handoffs write-time invariant" });
  return { store, milestoneId: milestone.id };
}

const ADAPTERS: ReadonlyArray<{ name: string; build: () => Promise<Fixture> }> = [
  { name: "InMemoryLedgerStore", build: buildInMemory },
  { name: "FsLedgerStore (temp dir)", build: buildFs },
];

// ---------------------------------------------------------------------------
// The matrix — every case runs against BOTH adapters.
// ---------------------------------------------------------------------------

for (const adapter of ADAPTERS) {
  describe(`handoffs write-time invariant — store API [${adapter.name}]`, () => {
    // ---- (a) HO26 REPRO --------------------------------------------------
    it("(a) HO26 repro: createItem(mixed, blockingQuestions:[]) THROWS SchemaValidationError", async () => {
      const { store, milestoneId } = await adapter.build();
      try {
        // NOTE: this EXACT write SUCCEEDED before the T257/T258 enforcement —
        // it is the D39 reproduction (the on-disk HO26 was a `mixed` handoff
        // whose blockingQuestions was empty). It now MUST be rejected at the
        // store write boundary.
        await expect(
          store.createItem(HANDOFFS_LEDGER, milestoneId, {
            status: "mixed",
            fields: { summary: "x", blockingQuestions: [] },
          }),
        ).rejects.toThrow(SchemaValidationError);
      } finally {
        await store.dispose();
      }
    });

    // ---- (b) all three status×empty-field combos THROW --------------------
    it("(b) createItem(mixed, blockingQuestions:[]) THROWS", async () => {
      const { store, milestoneId } = await adapter.build();
      try {
        await expect(
          store.createItem(HANDOFFS_LEDGER, milestoneId, {
            status: "mixed",
            fields: { summary: "x", blockingQuestions: [] },
          }),
        ).rejects.toThrow(SchemaValidationError);
      } finally {
        await store.dispose();
      }
    });

    it("(b) createItem(answers-required, blockingQuestions:[]) THROWS", async () => {
      const { store, milestoneId } = await adapter.build();
      try {
        await expect(
          store.createItem(HANDOFFS_LEDGER, milestoneId, {
            status: "answers-required",
            fields: { summary: "x", blockingQuestions: [] },
          }),
        ).rejects.toThrow(SchemaValidationError);
      } finally {
        await store.dispose();
      }
    });

    it("(b) createItem(user-action-required, handoffReasons:[]) THROWS", async () => {
      const { store, milestoneId } = await adapter.build();
      try {
        await expect(
          store.createItem(HANDOFFS_LEDGER, milestoneId, {
            status: "user-action-required",
            fields: { summary: "x", handoffReasons: [] },
          }),
        ).rejects.toThrow(SchemaValidationError);
      } finally {
        await store.dispose();
      }
    });

    // ---- (c) valid counterparts SUCCEED ----------------------------------
    it("(c) createItem(mixed, blockingQuestions:['Q1']) SUCCEEDS", async () => {
      const { store, milestoneId } = await adapter.build();
      try {
        const created = await store.createItem(HANDOFFS_LEDGER, milestoneId, {
          status: "mixed",
          fields: { summary: "x", blockingQuestions: ["Q1"] },
        });
        expect(created.status).toBe("mixed");
        expect(created.fields["blockingQuestions"]).toEqual(["Q1"]);
      } finally {
        await store.dispose();
      }
    });

    it("(c) createItem(answers-required, blockingQuestions:['Q1']) SUCCEEDS", async () => {
      const { store, milestoneId } = await adapter.build();
      try {
        const created = await store.createItem(HANDOFFS_LEDGER, milestoneId, {
          status: "answers-required",
          fields: { summary: "x", blockingQuestions: ["Q1"] },
        });
        expect(created.status).toBe("answers-required");
      } finally {
        await store.dispose();
      }
    });

    it("(c) createItem(user-action-required, handoffReasons:['re-activate env']) SUCCEEDS", async () => {
      const { store, milestoneId } = await adapter.build();
      try {
        const created = await store.createItem(HANDOFFS_LEDGER, milestoneId, {
          status: "user-action-required",
          fields: { summary: "x", handoffReasons: ["re-activate env"] },
        });
        expect(created.status).toBe("user-action-required");
        expect(created.fields["handoffReasons"]).toEqual(["re-activate env"]);
      } finally {
        await store.dispose();
      }
    });

    it("(c) createItem(drained, no blockingQuestions/handoffReasons) STILL SUCCEEDS", async () => {
      const { store, milestoneId } = await adapter.build();
      try {
        const created = await store.createItem(HANDOFFS_LEDGER, milestoneId, {
          status: "drained",
          fields: { summary: "x" },
        });
        expect(created.status).toBe("drained");
      } finally {
        await store.dispose();
      }
    });

    it("(c) createItem(illness-detected, no blockingQuestions/handoffReasons) STILL SUCCEEDS", async () => {
      const { store, milestoneId } = await adapter.build();
      try {
        const created = await store.createItem(HANDOFFS_LEDGER, milestoneId, {
          status: "illness-detected",
          fields: { summary: "x" },
        });
        expect(created.status).toBe("illness-detected");
      } finally {
        await store.dispose();
      }
    });

    // ---- (d) update path -------------------------------------------------
    it("(d) updateItem emptying blockingQuestions on a mixed handoff REJECTS", async () => {
      const { store, milestoneId } = await adapter.build();
      try {
        const created = await store.createItem(HANDOFFS_LEDGER, milestoneId, {
          status: "mixed",
          fields: { summary: "x", blockingQuestions: ["Q1"] },
        });
        await expect(
          store.updateItem(HANDOFFS_LEDGER, created.id, {
            fields: { blockingQuestions: [] },
          }),
        ).rejects.toThrow(SchemaValidationError);
      } finally {
        await store.dispose();
      }
    });

    it("(d) updateItem emptying handoffReasons on a user-action-required handoff REJECTS", async () => {
      const { store, milestoneId } = await adapter.build();
      try {
        const created = await store.createItem(HANDOFFS_LEDGER, milestoneId, {
          status: "user-action-required",
          fields: { summary: "x", handoffReasons: ["re-activate env"] },
        });
        await expect(
          store.updateItem(HANDOFFS_LEDGER, created.id, {
            fields: { handoffReasons: [] },
          }),
        ).rejects.toThrow(SchemaValidationError);
      } finally {
        await store.dispose();
      }
    });

    it("(d) updateItem that KEEPS a non-empty blockingQuestions on a mixed handoff SUCCEEDS", async () => {
      const { store, milestoneId } = await adapter.build();
      try {
        const created = await store.createItem(HANDOFFS_LEDGER, milestoneId, {
          status: "mixed",
          fields: { summary: "x", blockingQuestions: ["Q1"] },
        });
        const updated = await store.updateItem(HANDOFFS_LEDGER, created.id, {
          fields: { blockingQuestions: ["Q1", "Q2"] },
        });
        expect(updated.fields["blockingQuestions"]).toEqual(["Q1", "Q2"]);
      } finally {
        await store.dispose();
      }
    });
  });
}
