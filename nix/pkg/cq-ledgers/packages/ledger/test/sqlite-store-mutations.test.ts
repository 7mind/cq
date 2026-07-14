/**
 * SqliteLedgerStore T527 acceptance — mutation parity with FsLedgerStore over
 * a shared scenario matrix: every scenario op runs against BOTH stores and
 * must produce the same success value OR the same error type + message
 * (InvalidTransitionError, DuplicateIdError, BootstrapViolationError,
 * LedgerNotFoundError, milestone-not-active, …). Plus the in-process
 * two-connection createItem smoke (distinct sequential ids — the REAL
 * cross-process race is T531's subprocess stress) and the post-commit
 * onMutation contract. The BEGIN IMMEDIATE / busy-retry / module-graph
 * invariants live in sqlite-write-txn.test.ts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  BootstrapViolationError,
  CrossPrefixIdError,
  DuplicateIdError,
  DuplicatePrefixError,
  GoalPreconditionError,
  InvalidStatusError,
  InvalidTransitionError,
  ItemNotFoundError,
  LedgerError,
  LedgerNotFoundError,
  MilestoneItemNotFoundError,
  MissingRequiredFieldError,
  SchemaValidationError,
  type LedgerSchema,
} from "../src/types.js";
import { MILESTONES_AMBIENT_ID } from "../src/constants.js";
import type { LedgerMutationOp, LedgerStore } from "../src/store/LedgerStore.js";
import { FsLedgerStore } from "../src/store/FsLedgerStore.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";
const now = (): string => FIXED_NOW;

const dirs: string[] = [];

async function freshDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function freshDbPath(): Promise<string> {
  return path.join(await freshDir("ledger-sqlite-mut-"), "ledger.db");
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// Parity harness — run one op against both stores, demand identical outcomes.
// ---------------------------------------------------------------------------

interface ParityStores {
  fs: FsLedgerStore;
  sq: SqliteLedgerStore;
}

async function parityStores(): Promise<ParityStores & { dispose: () => Promise<void> }> {
  const fs = new FsLedgerStore({ root: await freshDir("ledger-fs-mut-"), now });
  await fs.init();
  const sq = new SqliteLedgerStore({ dbPath: await freshDbPath(), now });
  await sq.init();
  return {
    fs,
    sq,
    dispose: async (): Promise<void> => {
      await fs.dispose();
      await sq.dispose();
    },
  };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; err: unknown };

async function settle<T>(op: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await op() };
  } catch (err: unknown) {
    return { ok: false, err };
  }
}

/** Comparable projection: value on success, `Class: message` on rejection. */
function describeOutcome(o: Outcome<unknown>): unknown {
  if (o.ok) return { ok: true, value: o.value };
  const err = o.err as Error;
  return { ok: false, error: `${err.constructor.name}: ${err.message}` };
}

/**
 * Run `op` against BOTH stores and assert the outcomes are identical (deep-
 * equal value, or same error class + message). Returns the sqlite outcome so
 * scenarios can additionally pin the concrete error class / result shape.
 */
async function parity<T>(
  stores: ParityStores,
  op: (s: LedgerStore) => Promise<T>,
): Promise<Outcome<T>> {
  const fsOutcome = await settle(() => op(stores.fs));
  const sqOutcome = await settle(() => op(stores.sq));
  expect(describeOutcome(sqOutcome)).toEqual(describeOutcome(fsOutcome));
  return sqOutcome;
}

function value<T>(o: Outcome<T>): T {
  if (!o.ok) throw new Error(`expected success, got: ${String(o.err)}`);
  return o.value;
}

function expectError(o: Outcome<unknown>, cls: new (...args: never[]) => Error): void {
  if (o.ok) throw new Error(`expected ${cls.name}, got success`);
  expect(o.err).toBeInstanceOf(cls);
}

/** Full read-surface sweep: both stores must expose identical state. */
function expectStoreParity({ fs, sq }: ParityStores): void {
  expect(sq.enumerate()).toEqual(fs.enumerate());
  for (const name of fs.enumerate()) {
    expect(sq.fetch(name)).toEqual(fs.fetch(name));
  }
  expect(sq.snapshot()).toEqual(fs.snapshot());
}

const NOTES_SCHEMA: LedgerSchema = {
  statusValues: ["open", "closed"],
  terminalStatuses: ["closed"],
  idPrefix: "N",
  fields: { text: { type: "string", required: true } },
};

// ---------------------------------------------------------------------------
// Scenario matrix
// ---------------------------------------------------------------------------

describe("SqliteLedgerStore mutation parity (shared scenario matrix)", () => {
  test("createMilestone / createItem: ids, counters, group auto-create, guard errors", async () => {
    const stores = await parityStores();
    try {
      const p = <T>(op: (s: LedgerStore) => Promise<T>): Promise<Outcome<T>> =>
        parity(stores, op);

      // Auto milestone id.
      const m1 = value(
        await p((s) =>
          s.createMilestone({ title: "m one", description: "d1", dependsOn: [MILESTONES_AMBIENT_ID] }),
        ),
      );
      expect(m1.id).toBe("M1");
      // Caller-supplied id jumps the counter; next auto id follows the fs
      // counter semantics EXACTLY (parity asserts whatever fs produces).
      expect(value(await p((s) => s.createMilestone({ id: "M5", title: "m five" }))).id).toBe("M5");
      await p((s) => s.createMilestone({ title: "m after five" }));
      expectError(await p((s) => s.createMilestone({ id: "M5", title: "dup" })), DuplicateIdError);
      expectError(await p((s) => s.createMilestone({ id: "X9", title: "cross" })), CrossPrefixIdError);

      // Items: auto id, provenance, group auto-create under M1 and M-AMBIENT.
      const t1 = value(
        await p((s) =>
          s.createItem("tasks", "M1", {
            status: "planned",
            fields: { headline: "t one", tags: ["a", "b"] },
            author: "fable",
            session: "s-mut",
          }),
        ),
      );
      expect(t1).toMatchObject({ id: "T1", milestoneId: "M1", author: "fable", session: "s-mut" });
      await p((s) =>
        s.createItem("tasks", "M1", { id: "T10", status: "planned", fields: { headline: "supplied" } }),
      );
      await p((s) =>
        s.createItem("tasks", "M1", { status: "planned", fields: { headline: "after supplied" } }),
      );
      await p((s) =>
        s.createItem("defects", MILESTONES_AMBIENT_ID, {
          status: "open",
          fields: { headline: "ambient defect", severity: "low" },
        }),
      );

      // Guard errors — same class + message as the fs store.
      expectError(
        await p((s) => s.createItem("tasks", "M1", { id: "T10", status: "planned", fields: { headline: "x" } })),
        DuplicateIdError,
      );
      expectError(
        await p((s) => s.createItem("tasks", "M1", { id: "D5", status: "planned", fields: { headline: "x" } })),
        CrossPrefixIdError,
      );
      expectError(
        await p((s) => s.createItem("milestones", "active", { status: "open", fields: { title: "x" } })),
        BootstrapViolationError,
      );
      expectError(
        await p((s) => s.createItem("nope", "M1", { status: "planned", fields: { headline: "x" } })),
        LedgerNotFoundError,
      );
      expectError(
        await p((s) => s.createItem("tasks", "M999", { status: "planned", fields: { headline: "x" } })),
        MilestoneItemNotFoundError,
      );
      // Terminal milestone is not active (strict Q5 check).
      await p((s) => s.updateMilestone("M5", { status: "done" }));
      expectError(
        await p((s) => s.createItem("tasks", "M5", { status: "planned", fields: { headline: "x" } })),
        MilestoneItemNotFoundError,
      );
      expectError(
        await p((s) => s.createItem("tasks", "M1", { status: "bogus", fields: { headline: "x" } })),
        InvalidStatusError,
      );
      expectError(
        await p((s) => s.createItem("tasks", "M1", { status: "planned", fields: {} })),
        MissingRequiredFieldError,
      );
      expectError(
        await p((s) => s.createItem("tasks", "M1", { status: "planned", fields: { headline: "x", nope: "y" } })),
        SchemaValidationError,
      );
      // D39 handoffs conditional invariant.
      expectError(
        await p((s) => s.createItem("handoffs", "M1", { status: "mixed", fields: { summary: "s" } })),
        SchemaValidationError,
      );
      await p((s) =>
        s.createItem("handoffs", "M1", {
          status: "mixed",
          fields: { summary: "s", blockingQuestions: ["Q1"] },
        }),
      );

      expectStoreParity(stores);
    } finally {
      await stores.dispose();
    }
  });

  test("updateItem / updateMilestone: transitions, F2/D29/D39 preconditions, provenance", async () => {
    const stores = await parityStores();
    try {
      const p = <T>(op: (s: LedgerStore) => Promise<T>): Promise<Outcome<T>> =>
        parity(stores, op);

      await p((s) => s.createMilestone({ title: "m" })); // M1
      await p((s) => s.createItem("tasks", "M1", { status: "planned", fields: { headline: "t" } })); // T1

      // Legal transition + field patch + provenance overwrite.
      const wip = value(
        await p((s) =>
          s.updateItem("tasks", "T1", {
            status: "wip",
            fields: { description: "now wip" },
            author: "fable",
            session: "s-upd",
          }),
        ),
      );
      expect(wip).toMatchObject({ status: "wip", author: "fable", session: "s-upd" });

      // F1 declarative transition guard + status/lookup guards.
      expectError(await p((s) => s.updateItem("tasks", "T1", { status: "planned" })), InvalidTransitionError);
      expectError(await p((s) => s.updateItem("tasks", "T1", { status: "bogus" })), InvalidStatusError);
      expectError(await p((s) => s.updateItem("tasks", "T404", { status: "wip" })), ItemNotFoundError);
      expectError(await p((s) => s.updateItem("nope", "T1", {})), LedgerNotFoundError);
      expectError(await p((s) => s.updateItem("tasks", "T1", { fields: { nope: "x" } })), SchemaValidationError);

      // D29 — a question cannot enter `answered` without a usable answer.
      await p((s) => s.createItem("questions", "M1", { status: "open", fields: { question: "q?" } })); // Q1
      expectError(await p((s) => s.updateItem("questions", "Q1", { status: "answered" })), SchemaValidationError);
      await p((s) =>
        s.updateItem("questions", "Q1", { status: "answered", fields: { answer: "because" } }),
      );

      // F2 — goal-phase preconditions against the questions/decisions ledgers.
      await p((s) =>
        s.createItem("goals", "M1", { status: "clarifying", fields: { title: "g", description: "gd" } }),
      ); // G1
      await p((s) =>
        s.createItem("questions", "M1", {
          status: "open",
          fields: { question: "blocking?", ledgerRefs: ["goals:G1"] },
        }),
      ); // Q2
      expectError(await p((s) => s.updateItem("goals", "G1", { status: "planning" })), GoalPreconditionError);
      await p((s) => s.updateItem("questions", "Q2", { status: "answered", fields: { answer: "a" } }));
      await p((s) => s.updateItem("goals", "G1", { status: "planning" }));
      expectError(await p((s) => s.updateItem("goals", "G1", { status: "planned" })), GoalPreconditionError);
      await p((s) =>
        s.createItem("decisions", "M1", {
          status: "proposed",
          fields: { headline: "k", ledgerRefs: ["goals:G1"] },
        }),
      ); // K1
      await p((s) => s.updateItem("decisions", "K1", { status: "locked" }));
      await p((s) => s.updateItem("goals", "G1", { status: "planned" }));

      // D39 — a field-only patch cannot empty blockingQuestions on `mixed`.
      await p((s) =>
        s.createItem("handoffs", "M1", {
          status: "mixed",
          fields: { summary: "s", blockingQuestions: ["Q2"] },
        }),
      ); // HO1
      expectError(
        await p((s) => s.updateItem("handoffs", "HO1", { fields: { blockingQuestions: [] } })),
        SchemaValidationError,
      );

      // updateMilestone: patch shape, immortal M-AMBIENT, lookup + transitions.
      await p((s) =>
        s.updateMilestone("M1", { title: "renamed", description: "nd", blockedBy: [MILESTONES_AMBIENT_ID] }),
      );
      expectError(
        await p((s) => s.updateMilestone(MILESTONES_AMBIENT_ID, { status: "done" })),
        BootstrapViolationError,
      );
      expectError(await p((s) => s.updateMilestone("M404", { title: "x" })), ItemNotFoundError);
      await p((s) => s.updateMilestone("M1", { status: "done" }));
      expectError(await p((s) => s.updateMilestone("M1", { status: "open" })), InvalidTransitionError);

      expectStoreParity(stores);
    } finally {
      await stores.dispose();
    }
  });

  test("reopenItem: terminal-only, non-terminal target, createdAt preserved", async () => {
    const stores = await parityStores();
    try {
      const p = <T>(op: (s: LedgerStore) => Promise<T>): Promise<Outcome<T>> =>
        parity(stores, op);

      await p((s) => s.createMilestone({ title: "m" })); // M1
      await p((s) => s.createItem("tasks", "M1", { status: "planned", fields: { headline: "t" } })); // T1

      expectError(await p((s) => s.reopenItem("tasks", "T1", "wip")), LedgerError); // non-terminal
      await p((s) => s.updateItem("tasks", "T1", { status: "done" }));
      expectError(await p((s) => s.reopenItem("tasks", "T1", "done")), LedgerError); // terminal target
      expectError(await p((s) => s.reopenItem("tasks", "T1", "bogus")), InvalidStatusError);
      expectError(await p((s) => s.reopenItem("tasks", "T404", "wip")), ItemNotFoundError);
      expectError(await p((s) => s.reopenItem("nope", "T1", "wip")), LedgerNotFoundError);

      const reopened = value(await p((s) => s.reopenItem("tasks", "T1", "wip")));
      expect(reopened.status).toBe("wip");
      expect(reopened.createdAt).toBe(FIXED_NOW);

      expectStoreParity(stores);
    } finally {
      await stores.dispose();
    }
  });

  test("createLedger: view parity, name/prefix/schema guards, then usable for createItem", async () => {
    const stores = await parityStores();
    try {
      const p = <T>(op: (s: LedgerStore) => Promise<T>): Promise<Outcome<T>> =>
        parity(stores, op);

      const created = value(await p((s) => s.createLedger("notes", NOTES_SCHEMA)));
      expect(created.schema).toEqual(NOTES_SCHEMA);
      await p((s) => s.createMilestone({ title: "m" })); // M1
      expect(
        value(await p((s) => s.createItem("notes", "M1", { status: "open", fields: { text: "n" } }))).id,
      ).toBe("N1");

      expectError(await p((s) => s.createLedger("notes", NOTES_SCHEMA)), DuplicateIdError);
      expectError(await p((s) => s.createLedger("milestones", NOTES_SCHEMA)), BootstrapViolationError);
      expectError(await p((s) => s.createLedger("bad/name", NOTES_SCHEMA)), LedgerError);
      expectError(
        await p((s) => s.createLedger("taskclone", { ...NOTES_SCHEMA, idPrefix: "T" })),
        DuplicatePrefixError,
      );
      expectError(
        await p((s) =>
          s.createLedger("badschema", { statusValues: ["a"], terminalStatuses: ["zzz"], fields: {} }),
        ),
        SchemaValidationError,
      );

      expectStoreParity(stores);
    } finally {
      await stores.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// In-process two-connection smoke (the cross-process stress is T531)
// ---------------------------------------------------------------------------

describe("two stores over one db (in-process smoke)", () => {
  test("interleaved createItem/createMilestone allocate distinct sequential ids", async () => {
    const dbPath = await freshDbPath();
    const s1 = new SqliteLedgerStore({ dbPath, now });
    const s2 = new SqliteLedgerStore({ dbPath, now });
    await s1.init();
    await s2.init();
    try {
      expect((await s1.createMilestone({ title: "shared" })).id).toBe("M1");
      expect((await s2.createMilestone({ title: "peer" })).id).toBe("M2");

      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push((await s1.createItem("tasks", "M1", { status: "planned", fields: { headline: `a${i}` } })).id);
        ids.push((await s2.createItem("tasks", "M2", { status: "planned", fields: { headline: `b${i}` } })).id);
      }
      expect(ids).toEqual(["T1", "T2", "T3", "T4", "T5", "T6"]);
      expect(new Set(ids).size).toBe(ids.length);

      // Both connections observe all six committed rows (WAL coherence).
      expect(s1.fetch("tasks")).toEqual(s2.fetch("tasks"));
      expect(
        s1
          .fetch("tasks")
          .milestones.flatMap((g) => g.items)
          .map((it) => it.id)
          .sort(),
      ).toEqual(ids);
    } finally {
      await s1.dispose();
      await s2.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// onMutation — fired post-COMMIT, guarded
// ---------------------------------------------------------------------------

describe("onMutation", () => {
  test("fires (ledgerId, op) per successful mutation; nothing on failure; a throwing hook never unwinds the committed write", async () => {
    const events: Array<[string, LedgerMutationOp]> = [];
    let boom = false;
    const store = new SqliteLedgerStore({
      dbPath: await freshDbPath(),
      now,
      onMutation: (ledgerId, op): void => {
        events.push([ledgerId, op]);
        if (boom) throw new Error("hook boom");
      },
    });
    await store.init();
    try {
      await store.createMilestone({ title: "m" }); // M1
      await store.createItem("tasks", "M1", { status: "planned", fields: { headline: "t" } }); // T1
      await store.updateItem("tasks", "T1", { status: "done" });
      await store.reopenItem("tasks", "T1", "wip");
      await store.updateMilestone("M1", { title: "renamed" });
      await store.createLedger("notes", NOTES_SCHEMA);
      expect(events).toEqual([
        ["milestones", "create"],
        ["tasks", "create"],
        ["tasks", "update"],
        ["tasks", "update"],
        ["milestones", "update"],
        ["notes", "create"],
      ]);

      // A failed mutation fires nothing.
      events.length = 0;
      await expect(
        store.createItem("tasks", "M404", { status: "planned", fields: { headline: "x" } }),
      ).rejects.toThrow(MilestoneItemNotFoundError);
      expect(events).toEqual([]);

      // A throwing hook is guarded: the write is committed and returned.
      boom = true;
      const item = await store.createItem("tasks", "M1", {
        status: "planned",
        fields: { headline: "post-boom" },
      });
      expect(events).toEqual([["tasks", "create"]]);
      expect(store.fetchItem("tasks", item.id).fields["headline"]).toBe("post-boom");
    } finally {
      await store.dispose();
    }
  });
});
