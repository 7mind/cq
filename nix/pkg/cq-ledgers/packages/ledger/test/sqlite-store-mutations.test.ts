/**
 * SqliteLedgerStore T527 acceptance — direct mutation outcomes across the
 * canonical ledgers, including guard errors, item and milestone updates, and
 * reopen behavior. It also covers the in-process two-connection createItem
 * smoke, the post-commit onMutation contract, and parent-liveness
 * serialization. Transaction mechanics remain covered in sqlite-write-txn.
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
import type { LedgerMutationOp } from "../src/store/LedgerStore.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";

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

async function sqliteStore(): Promise<SqliteLedgerStore> {
  const store = new SqliteLedgerStore({ dbPath: await freshDbPath(), now });
  await store.init();
  return store;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; err: unknown };

async function settle<T>(op: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await op() };
  } catch (err: unknown) {
    return { ok: false, err };
  }
}

function value<T>(o: Outcome<T>): T {
  if (!o.ok) throw new Error(`expected success, got: ${String(o.err)}`);
  return o.value;
}

function expectError(o: Outcome<unknown>, cls: new (...args: never[]) => Error): void {
  if (o.ok) throw new Error(`expected ${cls.name}, got success`);
  expect(o.err).toBeInstanceOf(cls);
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

describe("SqliteLedgerStore mutation outcomes", () => {
  test("createMilestone / createItem: ids, counters, group auto-create, guard errors", async () => {
    const store = await sqliteStore();
    try {
      const p = <T>(op: (s: SqliteLedgerStore) => Promise<T>): Promise<Outcome<T>> =>
        settle(() => op(store));

      // Auto milestone id.
      const m1 = value(
        await p((s) =>
          s.createMilestone({
            title: "m one",
            description: "d1",
            dependsOn: [MILESTONES_AMBIENT_ID],
          }),
        ),
      );
      expect(m1.id).toBe("M1");
      // Caller-supplied id jumps the counter; the next generated id follows it.
      expect(value(await p((s) => s.createMilestone({ id: "M5", title: "m five" }))).id).toBe("M5");
      expect(value(await p((s) => s.createMilestone({ title: "m after five" })))).toMatchObject({
        id: "M7",
        fields: { title: "m after five" },
      });
      expectError(await p((s) => s.createMilestone({ id: "M5", title: "dup" })), DuplicateIdError);
      expectError(
        await p((s) => s.createMilestone({ id: "X9", title: "cross" })),
        CrossPrefixIdError,
      );

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
      const t10 = value(
        await p((s) =>
          s.createItem("tasks", "M1", {
            id: "T10",
            status: "planned",
            fields: { headline: "supplied" },
          }),
        ),
      );
      expect(t10).toMatchObject({ id: "T10", milestoneId: "M1" });
      const t11 = value(
        await p((s) =>
          s.createItem("tasks", "M1", {
            status: "planned",
            fields: { headline: "after supplied" },
          }),
        ),
      );
      expect(t11).toMatchObject({ id: "T12", milestoneId: "M1" });
      const ambientDefect = value(
        await p((s) =>
          s.createItem("defects", MILESTONES_AMBIENT_ID, {
            status: "open",
            fields: { headline: "ambient defect", severity: "low" },
          }),
        ),
      );
      expect(ambientDefect).toMatchObject({ id: "D1", milestoneId: MILESTONES_AMBIENT_ID });
      expect(
        store
          .fetch("tasks")
          .milestones.map((group) => [group.id, group.items.map((item) => item.id)]),
      ).toEqual([["M1", ["T1", "T10", "T12"]]]);

      // Guard errors are observable SQLite outcomes.
      expectError(
        await p((s) =>
          s.createItem("tasks", "M1", { id: "T10", status: "planned", fields: { headline: "x" } }),
        ),
        DuplicateIdError,
      );
      expectError(
        await p((s) =>
          s.createItem("tasks", "M1", { id: "D5", status: "planned", fields: { headline: "x" } }),
        ),
        CrossPrefixIdError,
      );
      expectError(
        await p((s) =>
          s.createItem("milestones", "active", { status: "open", fields: { title: "x" } }),
        ),
        BootstrapViolationError,
      );
      expectError(
        await p((s) =>
          s.createItem("nope", "M1", { status: "planned", fields: { headline: "x" } }),
        ),
        LedgerNotFoundError,
      );
      expectError(
        await p((s) =>
          s.createItem("tasks", "M999", { status: "planned", fields: { headline: "x" } }),
        ),
        MilestoneItemNotFoundError,
      );
      // Terminal milestone is not active (strict Q5 check).
      expect(value(await p((s) => s.updateMilestone("M5", { status: "done" })))).toMatchObject({
        id: "M5",
        status: "done",
      });
      expectError(
        await p((s) =>
          s.createItem("tasks", "M5", { status: "planned", fields: { headline: "x" } }),
        ),
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
        await p((s) =>
          s.createItem("tasks", "M1", { status: "planned", fields: { headline: "x", nope: "y" } }),
        ),
        SchemaValidationError,
      );
      // D39 handoffs conditional invariant.
      expectError(
        await p((s) =>
          s.createItem("handoffs", "M1", { status: "mixed", fields: { summary: "s" } }),
        ),
        SchemaValidationError,
      );
      expect(
        value(
          await p((s) =>
            s.createItem("handoffs", "M1", {
              status: "mixed",
              fields: { summary: "s", blockingQuestions: ["Q1"] },
            }),
          ),
        ),
      ).toMatchObject({ id: "HO1", status: "mixed" });
    } finally {
      await store.dispose();
    }
  });

  test("updateItem / updateMilestone: transitions, F2/D29/D39 preconditions, provenance", async () => {
    const store = await sqliteStore();
    try {
      const p = <T>(op: (s: SqliteLedgerStore) => Promise<T>): Promise<Outcome<T>> =>
        settle(() => op(store));

      expect(value(await p((s) => s.createMilestone({ title: "m" })))).toMatchObject({ id: "M1" });
      expect(
        value(
          await p((s) =>
            s.createItem("tasks", "M1", { status: "planned", fields: { headline: "t" } }),
          ),
        ),
      ).toMatchObject({ id: "T1" });

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
      expectError(
        await p((s) => s.updateItem("tasks", "T1", { status: "planned" })),
        InvalidTransitionError,
      );
      expectError(
        await p((s) => s.updateItem("tasks", "T1", { status: "bogus" })),
        InvalidStatusError,
      );
      expectError(
        await p((s) => s.updateItem("tasks", "T404", { status: "wip" })),
        ItemNotFoundError,
      );
      expectError(await p((s) => s.updateItem("nope", "T1", {})), LedgerNotFoundError);
      expectError(
        await p((s) => s.updateItem("tasks", "T1", { fields: { nope: "x" } })),
        SchemaValidationError,
      );

      // D29 — a question cannot enter `answered` without a usable answer.
      expect(
        value(
          await p((s) =>
            s.createItem("questions", "M1", { status: "open", fields: { question: "q?" } }),
          ),
        ),
      ).toMatchObject({ id: "Q1" });
      expectError(
        await p((s) => s.updateItem("questions", "Q1", { status: "answered" })),
        SchemaValidationError,
      );
      expect(
        value(
          await p((s) =>
            s.updateItem("questions", "Q1", { status: "answered", fields: { answer: "because" } }),
          ),
        ),
      ).toMatchObject({ id: "Q1", status: "answered" });

      // F2 — goal-phase preconditions against the questions/decisions ledgers.
      expect(
        value(
          await p((s) =>
            s.createItem("goals", "M1", {
              status: "clarifying",
              fields: { title: "g", description: "gd" },
            }),
          ),
        ),
      ).toMatchObject({ id: "G1", status: "clarifying" });
      expect(
        value(
          await p((s) =>
            s.createItem("questions", "M1", {
              status: "open",
              fields: { question: "blocking?", ledgerRefs: ["goals:G1"] },
            }),
          ),
        ),
      ).toMatchObject({ id: "Q2", status: "open" });
      expectError(
        await p((s) => s.updateItem("goals", "G1", { status: "planning" })),
        GoalPreconditionError,
      );
      expect(
        value(
          await p((s) =>
            s.updateItem("questions", "Q2", { status: "answered", fields: { answer: "a" } }),
          ),
        ),
      ).toMatchObject({ status: "answered" });
      expect(
        value(await p((s) => s.updateItem("goals", "G1", { status: "planning" }))),
      ).toMatchObject({ status: "planning" });
      expectError(
        await p((s) => s.updateItem("goals", "G1", { status: "planned" })),
        GoalPreconditionError,
      );
      expect(
        value(
          await p((s) =>
            s.createItem("decisions", "M1", {
              status: "proposed",
              fields: { headline: "k", ledgerRefs: ["goals:G1"] },
            }),
          ),
        ),
      ).toMatchObject({ id: "K1", status: "proposed" });
      expect(
        value(await p((s) => s.updateItem("decisions", "K1", { status: "locked" }))),
      ).toMatchObject({ status: "locked" });
      expect(
        value(await p((s) => s.updateItem("goals", "G1", { status: "planned" }))),
      ).toMatchObject({ status: "planned" });

      // D39 — a field-only patch cannot empty blockingQuestions on `mixed`.
      expect(
        value(
          await p((s) =>
            s.createItem("handoffs", "M1", {
              status: "mixed",
              fields: { summary: "s", blockingQuestions: ["Q2"] },
            }),
          ),
        ),
      ).toMatchObject({ id: "HO1", status: "mixed" });
      expectError(
        await p((s) => s.updateItem("handoffs", "HO1", { fields: { blockingQuestions: [] } })),
        SchemaValidationError,
      );

      // updateMilestone: patch shape, immortal M-AMBIENT, lookup + transitions.
      expect(
        value(
          await p((s) =>
            s.updateMilestone("M1", {
              title: "renamed",
              description: "nd",
              blockedBy: [MILESTONES_AMBIENT_ID],
            }),
          ),
        ),
      ).toMatchObject({ id: "M1", fields: { title: "renamed" } });
      expectError(
        await p((s) => s.updateMilestone(MILESTONES_AMBIENT_ID, { status: "done" })),
        BootstrapViolationError,
      );
      expectError(await p((s) => s.updateMilestone("M404", { title: "x" })), ItemNotFoundError);
      // D267/T1856: M1 cannot close here — goal G1 at "planned" is a
      // non-terminal child, so the close is refused with the new invariant.
      // Use a childless milestone for the close/reopen transition checks.
      const mClose = value(await p((s) => s.createMilestone({ title: "close-target" })));
      expect(value(await p((s) => s.updateMilestone(mClose.id, { status: "done" })))).toMatchObject(
        { status: "done" },
      );
      expectError(
        await p((s) => s.updateMilestone(mClose.id, { status: "open" })),
        InvalidTransitionError,
      );
    } finally {
      await store.dispose();
    }
  });

  test("reopenItem: terminal-only, non-terminal target, createdAt preserved", async () => {
    const store = await sqliteStore();
    try {
      const p = <T>(op: (s: SqliteLedgerStore) => Promise<T>): Promise<Outcome<T>> =>
        settle(() => op(store));

      expect(value(await p((s) => s.createMilestone({ title: "m" })))).toMatchObject({ id: "M1" });
      expect(
        value(
          await p((s) =>
            s.createItem("tasks", "M1", { status: "planned", fields: { headline: "t" } }),
          ),
        ),
      ).toMatchObject({ id: "T1" });

      expectError(await p((s) => s.reopenItem("tasks", "T1", "wip")), LedgerError); // non-terminal
      expect(value(await p((s) => s.updateItem("tasks", "T1", { status: "done" })))).toMatchObject({
        status: "done",
      });
      expectError(await p((s) => s.reopenItem("tasks", "T1", "done")), LedgerError); // terminal target
      expectError(await p((s) => s.reopenItem("tasks", "T1", "bogus")), InvalidStatusError);
      expectError(await p((s) => s.reopenItem("tasks", "T404", "wip")), ItemNotFoundError);
      expectError(await p((s) => s.reopenItem("nope", "T1", "wip")), LedgerNotFoundError);

      const reopened = value(await p((s) => s.reopenItem("tasks", "T1", "wip")));
      expect(reopened.status).toBe("wip");
      expect(reopened.createdAt).toBe(FIXED_NOW);
    } finally {
      await store.dispose();
    }
  });

  test("createLedger: expected view, name/prefix/schema guards, then usable for createItem", async () => {
    const store = await sqliteStore();
    try {
      const p = <T>(op: (s: SqliteLedgerStore) => Promise<T>): Promise<Outcome<T>> =>
        settle(() => op(store));

      const created = value(await p((s) => s.createLedger("notes", NOTES_SCHEMA)));
      expect(created.schema).toEqual(NOTES_SCHEMA);
      expect(value(await p((s) => s.createMilestone({ title: "m" })))).toMatchObject({ id: "M1" });
      expect(
        value(
          await p((s) => s.createItem("notes", "M1", { status: "open", fields: { text: "n" } })),
        ).id,
      ).toBe("N1");

      expectError(await p((s) => s.createLedger("notes", NOTES_SCHEMA)), DuplicateIdError);
      expectError(
        await p((s) => s.createLedger("milestones", NOTES_SCHEMA)),
        BootstrapViolationError,
      );
      expectError(await p((s) => s.createLedger("bad/name", NOTES_SCHEMA)), LedgerError);
      expectError(
        await p((s) => s.createLedger("taskclone", { ...NOTES_SCHEMA, idPrefix: "T" })),
        DuplicatePrefixError,
      );
      expectError(
        await p((s) =>
          s.createLedger("badschema", {
            statusValues: ["a"],
            terminalStatuses: ["zzz"],
            fields: {},
          }),
        ),
        SchemaValidationError,
      );
    } finally {
      await store.dispose();
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
        ids.push(
          (await s1.createItem("tasks", "M1", { status: "planned", fields: { headline: `a${i}` } }))
            .id,
        );
        ids.push(
          (await s2.createItem("tasks", "M2", { status: "planned", fields: { headline: `b${i}` } }))
            .id,
        );
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

// ---------------------------------------------------------------------------
// D267/T1857 — two-store parent-liveness serialization over one database
// ---------------------------------------------------------------------------

describe("two SqliteLedgerStore instances — parent-liveness serialization (D267/T1857)", () => {
  async function twoStores(): Promise<{
    s1: SqliteLedgerStore;
    s2: SqliteLedgerStore;
    dbPath: string;
  }> {
    const dbPath = await freshDbPath();
    const s1 = new SqliteLedgerStore({ dbPath, now });
    const s2 = new SqliteLedgerStore({ dbPath, now });
    await s1.init();
    await s2.init();
    return { s1, s2, dbPath };
  }

  test("close-versus-create serializes to exactly one winner via either API, in both winner orderings", async () => {
    for (const api of ["canonical", "direct"] as const) {
      const close = (s: SqliteLedgerStore, id: string): Promise<{ status: string }> =>
        api === "canonical"
          ? s.updateMilestone(id, { status: "done" })
          : s.updateItem("milestones", id, { status: "done" });

      // close first: create under the terminal parent refuses.
      {
        const { s1, s2 } = await twoStores();
        try {
          const m = await s1.createMilestone({ title: `cc-${api}-close-first` });
          await close(s1, m.id);
          await expect(
            s2.createItem("tasks", m.id, { status: "planned", fields: { headline: "x" } }),
          ).rejects.toThrow(/terminal/);
          expect(s1.fetch("tasks")).toEqual(s2.fetch("tasks"));
        } finally {
          await s1.dispose();
          await s2.dispose();
        }
      }
      // create first: the close refuses the fresh non-terminal child; after
      // the child is terminal it closes through the same API.
      {
        const { s1, s2 } = await twoStores();
        try {
          const m = await s1.createMilestone({ title: `cc-${api}-create-first` });
          const t = await s2.createItem("tasks", m.id, {
            status: "planned",
            fields: { headline: "x" },
          });
          await expect(close(s1, m.id)).rejects.toThrow(/Cannot close milestone/);
          await s2.updateItem("tasks", t.id, { status: "done" });
          expect((await close(s1, m.id)).status).toBe("done");
        } finally {
          await s1.dispose();
          await s2.dispose();
        }
      }
    }

    // Truly concurrent over two connections: exactly one winner.
    for (let i = 0; i < 10; i++) {
      const { s1, s2 } = await twoStores();
      try {
        const m = await s1.createMilestone({ title: `cc-par-${i}` });
        const [closeResult, createResult] = await Promise.allSettled([
          s1.updateMilestone(m.id, { status: "done" }),
          s2.createItem("tasks", m.id, { status: "planned", fields: { headline: "x" } }),
        ]);
        expect((closeResult.status === "fulfilled") !== (createResult.status === "fulfilled")).toBe(
          true,
        );
      } finally {
        await s1.dispose();
        await s2.dispose();
      }
    }
  });

  test("close-versus-reopen refuses resurrection under a closed parent in both winner orderings, counters untouched", async () => {
    for (const winner of ["close", "reopen"] as const) {
      const { s1, s2 } = await twoStores();
      try {
        const m = await s1.createMilestone({ title: `cr-${winner}` });
        const t = await s1.createItem("tasks", m.id, {
          status: "planned",
          fields: { headline: "x" },
        });
        await s1.updateItem("tasks", t.id, { status: "done" });
        const before = s2.fetch("tasks");
        if (winner === "close") {
          await s1.updateMilestone(m.id, { status: "done" });
          await expect(s2.reopenItem("tasks", t.id, "wip")).rejects.toThrow(/terminal/);
          expect(s2.fetchItem("tasks", t.id).status).toBe("done");
        } else {
          await s2.reopenItem("tasks", t.id, "wip");
          await expect(s1.updateMilestone(m.id, { status: "done" })).rejects.toThrow(
            /Cannot close milestone/,
          );
        }
        expect(s2.fetch("tasks").counters).toEqual(before.counters);
      } finally {
        await s1.dispose();
        await s2.dispose();
      }
    }
  });

  test("legacy nonterminal unarchive refuses under a closed parent; terminal archived item re-attaches with status retained", async () => {
    const { s1, s2, dbPath } = await twoStores();
    try {
      const m = await s1.createMilestone({ title: "cu" });
      const t = await s1.createItem("tasks", m.id, {
        status: "planned",
        fields: { headline: "x" },
      });
      await s1.updateItem("tasks", t.id, { status: "done" });
      await s1.updateMilestone(m.id, { status: "done" });
      await s1.archiveMilestone(m.id, "archived");
      // Legacy-inconsistent: the archived row is flipped back to non-terminal.
      const db = openLedgerDb(dbPath);
      try {
        db.query("UPDATE archived_items SET status = ? WHERE ledger = ? AND id = ?").run(
          "wip",
          "tasks",
          t.id,
        );
      } finally {
        db.close();
      }
      await expect(s2.unarchiveItem("tasks", m.id, t.id)).rejects.toThrow(/archived/);
      // Restored to terminal: reattachment proceeds and retains the status.
      const db2 = openLedgerDb(dbPath);
      try {
        db2
          .query("UPDATE archived_items SET status = ? WHERE ledger = ? AND id = ?")
          .run("done", "tasks", t.id);
      } finally {
        db2.close();
      }
      const reattached = await s2.unarchiveItem("tasks", m.id, t.id);
      expect(reattached.status).toBe("done");
    } finally {
      await s1.dispose();
      await s2.dispose();
    }
  });
});
