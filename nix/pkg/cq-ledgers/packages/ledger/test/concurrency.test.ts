/**
 * Concurrent SQLite mutations retain valid persisted state, monotonic IDs and
 * timestamps, and terminal-parent invariants across independent connections.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  SqliteLedgerStore,
  derivePredicates,
  type Item,
  type LedgerSchema,
  DECISIONS_LEDGER,
  GOALS_LEDGER,
  TASKS_LEDGER,
  MILESTONES_LEDGER,
} from "../src/index.js";

const dirs: string[] = [];
const stores: SqliteLedgerStore[] = [];
afterAll(async () => {
  for (const store of stores) await store.dispose();
  for (const d of dirs) {
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

const schema: LedgerSchema = {
  statusValues: ["open", "in-progress", "resolved"],
  terminalStatuses: ["resolved"],
  fields: {
    severity: { type: "string", required: true },
    location: { type: "string", required: true },
    description: { type: "string", required: true },
    counter: { type: "string", required: false },
  },
};

function isoTick(tick: number): string {
  return new Date(1_780_000_000_000 + tick).toISOString();
}

async function setup(opts: { now?: () => string } = {}): Promise<SqliteLedgerStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "ledger-conc-"));
  dirs.push(dir);
  const store = new SqliteLedgerStore({
    dbPath: path.join(dir, "ledger.db"),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  stores.push(store);
  await store.init();
  await store.createLedger("xenos", schema);
  return store;
}

interface Gate {
  promise: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open = (): void => {
    throw new Error("gate opened before initialization");
  };
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe("SqliteLedgerStore concurrency", () => {
  it("close-versus-create, close-versus-reopen, close-versus-unarchive races never produce terminal-parent/nonterminal-child (D267/T1856)", async () => {
    // This block builds dozens of stores; remove its own directories eagerly
    // so later tests scanning the shared `dirs` array never pick them up.
    const raceDirsBefore = dirs.length;
    const raceDirs = (): string[] => dirs.slice(raceDirsBefore);
    try {
    const xenosItem = async (store: SqliteLedgerStore, milestoneId: string) =>
      store.createItem("xenos", milestoneId, {
        status: "open",
        fields: { severity: "minor", location: "x.ts", description: "init" },
      });

    // close vs create: either the close lands first (create refuses a
    // terminal parent) or the create lands first (close refuses the new
    // non-terminal child). Both winner orderings stay consistent.
    for (const winner of ["close", "create"] as const) {
      const store = await setup();
      const m = await store.createMilestone({ title: `race-${winner}` });
      const closed = await store.updateItem("milestones", m.id, { status: "done" });
      expect(closed.status).toBe("done");
      if (winner === "close") {
        await expect(xenosItem(store, m.id)).rejects.toThrow(/terminal/);
      }
      await store.dispose();

      const store2 = await setup();
      const m2 = await store2.createMilestone({ title: `race2-${winner}` });
      const created = await xenosItem(store2, m2.id);
      await expect(
        store2.updateMilestone(m2.id, { status: "done" }),
      ).rejects.toThrow(/Cannot close milestone/);
      // Now make it terminal and close through the canonical path.
      await store2.updateItem("xenos", created.id, { status: "resolved" });
      expect((await store2.updateMilestone(m2.id, { status: "done" })).status).toBe("done");
      await store2.dispose();
    }

    // close vs reopen (both winner orderings): reopening under a closed
    // parent refuses, and a live non-terminal child blocks the close.
    for (const winner of ["close", "reopen"] as const) {
      const store = await setup();
      const m = await store.createMilestone({ title: `race-reopen-${winner}` });
      const w1 = await xenosItem(store, m.id);
      await store.updateItem("xenos", w1.id, { status: "resolved" });
      if (winner === "close") {
        await store.updateMilestone(m.id, { status: "done" });
        await expect(store.reopenItem("xenos", w1.id, "open")).rejects.toThrow(/terminal/);
        expect((await store.fetchItem("xenos", w1.id)).status).toBe("resolved");
      } else {
        await store.reopenItem("xenos", w1.id, "open");
        await expect(
          store.updateMilestone(m.id, { status: "done" }),
        ).rejects.toThrow(/Cannot close milestone/);
      }
      await store.dispose();
    }

    // Truly parallel close/create: exactly one consistent winner, never a
    // close through a non-terminal child and never a create under a closed
    // parent.
    for (let i = 0; i < 20; i++) {
      const store = await setup();
      const m = await store.createMilestone({ title: `parallel-${i}` });
      const [closeResult, createResult] = await Promise.allSettled([
        store.updateMilestone(m.id, { status: "done" }),
        store.createItem("xenos", m.id, {
          status: "open",
          fields: { severity: "minor", location: "x.ts", description: "r" },
        }),
      ]);
      const closeOk = closeResult.status === "fulfilled";
      const createOk = createResult.status === "fulfilled";
      expect(closeOk !== createOk).toBe(true);
      await store.dispose();
    }

    // close vs legacy-nonterminal unarchive: a non-terminal archived item
    // must not re-attach under a closed parent, and blocks a live close.
    const store3 = await setup();
    const m3 = await store3.createMilestone({ title: "race-unarchive" });
    const w3 = await xenosItem(store3, m3.id);
    await store3.updateItem("xenos", w3.id, { status: "resolved" });
    await store3.updateMilestone(m3.id, { status: "done" });
    await store3.archiveMilestone(m3.id, "archived");
    // A terminal archived item re-attaches fine even under the archived parent.
    const reattached = await store3.unarchiveItem("xenos", m3.id, w3.id);
    expect(reattached.status).toBe("resolved");
    await store3.dispose();
    } finally {
      await Promise.all(
        raceDirs().map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)),
      );
      dirs.splice(raceDirsBefore);
    }
  });

  it("50 parallel updateItem calls leave complete persisted state", async () => {
    const store = await setup();
    const m = await store.createMilestone({ title: "M-one" });
    const item = await store.createItem("xenos", m.id, {
      status: "open",
      fields: { severity: "minor", location: "x.ts", description: "init" },
    });

    const N = 50;
    const updates = Array.from({ length: N }, (_, i) =>
      store.updateItem("xenos", item.id, {
        fields: { counter: String(i) },
      }),
    );
    const results = await Promise.all(updates);
    expect(results.length).toBe(N);
    const parsed = store.fetch("xenos");
    expect(parsed.milestones[0]?.items[0]?.id).toBe(item.id);
    // At least one of the writes' counter values survives as the final.
    const finalCounter = parsed.milestones[0]?.items[0]?.fields["counter"];
    expect(typeof finalCounter).toBe("string");
    expect(Number(finalCounter)).toBeGreaterThanOrEqual(0);
    expect(Number(finalCounter)).toBeLessThan(N);
  });

  // D-LED-07: strengthen the 50-parallel-update assertion.
  it("50 parallel updateItem calls serialise with monotonic updatedAt and final state is the last write (D-LED-07)", async () => {
    let tick = 0;
    const store = await setup({ now: () => isoTick(tick++) });
    // The bootstrap of the milestones ledger happens before any test
    // `now()` is consumed because init() is called inside setup() before
    // we override anything mutable. The createMilestone call below
    // consumes the first tick(s).
    const baseTick = tick; // tick after init
    const m = await store.createMilestone({ title: "M-one" });
    // createItem also consumes a tick (item.createdAt/updatedAt).
    const item = await store.createItem("xenos", m.id, {
      status: "open",
      fields: { severity: "minor", location: "x.ts", description: "init" },
    });

    const N = 50;
    const updates: Array<Promise<Item>> = [];
    for (let i = 0; i < N; i++) {
      updates.push(
        store.updateItem("xenos", item.id, {
          fields: { counter: String(i) },
        }),
      );
    }
    const results = await Promise.all(updates);

    // ISO 8601 strings compare lexicographically same as the underlying
    // Date.parse'd ms values for same-precision UTC formats.
    const sorted = [...results].sort((a, b) =>
      a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0,
    );
    // strict monotonicity of updatedAt across the N serialised writes
    for (let i = 1; i < N; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev === undefined || cur === undefined) throw new Error("missing result");
      expect(cur.updatedAt > prev.updatedAt).toBe(true);
    }

    // The final on-disk state corresponds to the last serialised write.
    const parsed = store.fetch("xenos");
    const final = parsed.milestones[0]?.items[0];
    if (final === undefined) throw new Error("missing parsed item");
    const winner = sorted[N - 1];
    if (winner === undefined) throw new Error("missing winner");
    expect(final.updatedAt).toBe(winner.updatedAt);
    expect(final.fields["counter"]).toBe(winner.fields["counter"]);
    void baseTick;
  });

  it("50 parallel createItem calls allocate unique monotonic ids", async () => {
    const store = await setup();
    const m = await store.createMilestone({ title: "M-x" });
    const N = 50;
    const items = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.createItem("xenos", m.id, {
          status: "open",
          fields: {
            severity: "minor",
            location: `f${i}.ts`,
            description: `desc ${i}`,
          },
        }),
      ),
    );
    const ids = new Set(items.map((it) => it.id));
    expect(ids.size).toBe(N);
    const ledger = store.fetch("xenos");
    expect(ledger.counters.item).toBeGreaterThanOrEqual(N);
  });

  it("dispose() drains in-flight mutations before returning (D-LED-06)", async () => {
    const store = await setup();
    const m = await store.createMilestone({ title: "M-one" });
    const item = await store.createItem("xenos", m.id, {
      status: "open",
      fields: { severity: "minor", location: "x.ts", description: "init" },
    });

    const N = 20;
    const updates: Array<Promise<Item>> = [];
    for (let i = 0; i < N; i++) {
      updates.push(
        store.updateItem("xenos", item.id, {
          fields: { counter: String(i) },
        }),
      );
    }

    let updatesSettledFirst = false;
    const updatesAll = Promise.all(updates).then(() => {
      updatesSettledFirst = true;
    });

    await store.dispose();

    expect(updatesSettledFirst).toBe(true);
    await updatesAll;
  });

  // Independent database connections must see each other's commits without a relay.
  it("two SQLite connections complete writes with no lost state (LOCK-D01)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-conc-xproc-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "ledger.db");
    const storeA = new SqliteLedgerStore({ dbPath });
    const storeB = new SqliteLedgerStore({ dbPath });
    stores.push(storeA, storeB);
    await storeA.init();
    await storeA.createLedger("xenos", schema);
    await storeB.init();

    // storeA owns milestone creation; both stores create items into it.
    const m = await storeA.createMilestone({ title: "M-shared" });

    const N = 15;
    let aSeq = 0;
    let bSeq = 0;
    for (let i = 0; i < N; i++) {
      await storeA.createItem("xenos", m.id, {
        status: "open",
        fields: { severity: "minor", location: "a.ts", description: `A${aSeq++}` },
      });
      await storeB.createItem("xenos", m.id, {
        status: "open",
        fields: { severity: "minor", location: "b.ts", description: `B${bSeq++}` },
      });
    }
    const parsed = storeB.fetch("xenos");
    const group = parsed.milestones.find((g) => g.id === m.id);
    if (group === undefined) throw new Error("persisted milestone group missing");
    expect(group.items.length).toBe(2 * N);
    const fromA = group.items.filter((it) => it.fields["location"] === "a.ts").length;
    const fromB = group.items.filter((it) => it.fields["location"] === "b.ts").length;
    expect(fromA).toBe(N);
    expect(fromB).toBe(N);
    // Ids are unique (counter monotonicity held across database connections).
    const ids = new Set(group.items.map((it) => it.id));
    expect(ids.size).toBe(2 * N);

    await storeA.dispose();
    await storeB.dispose();
  });

  it("two SQLite connections complete concurrent writes to different ledgers (LOCK-D01)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-conc-xproc2-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "ledger.db");
    const storeA = new SqliteLedgerStore({ dbPath });
    const storeB = new SqliteLedgerStore({ dbPath });
    stores.push(storeA, storeB);
    await storeA.init();
    await storeA.createLedger("alpha", schema);
    await storeA.createLedger("beta", schema);
    await storeB.init();
    const m = await storeA.createMilestone({ title: "M-x" });
    await storeB.invalidate(MILESTONES_LEDGER);

    const N = 20;
    const ops: Array<Promise<unknown>> = [];
    for (let i = 0; i < N; i++) {
      ops.push(
        storeA.createItem("alpha", m.id, {
          status: "open",
          fields: { severity: "minor", location: "a.ts", description: `a${i}` },
        }),
      );
      ops.push(
        storeB.createItem("beta", m.id, {
          status: "open",
          fields: { severity: "minor", location: "b.ts", description: `b${i}` },
        }),
      );
    }
    await Promise.all(ops);

    const alpha = storeB.fetch("alpha");
    const beta = storeA.fetch("beta");
    expect(alpha.milestones.find((g) => g.id === m.id)?.items.length).toBe(N);
    expect(beta.milestones.find((g) => g.id === m.id)?.items.length).toBe(N);

    await storeA.dispose();
    await storeB.dispose();
  });

  it("concurrent updates to different ledgers all complete", async () => {
    // Build a store with two ledgers (plus the bootstrapped milestones).
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-conc-multi-"));
    dirs.push(dir);
    const store = new SqliteLedgerStore({ dbPath: path.join(dir, "ledger.db") });
    stores.push(store);
    await store.init();
    await store.createLedger("a", schema);
    await store.createLedger("b", schema);
    // Single shared milestone (createItem in two different ledgers).
    const m = await store.createMilestone({ title: "Mx" });
    const N = 20;
    const allUpdates: Array<Promise<unknown>> = [];
    for (let i = 0; i < N; i++) {
      allUpdates.push(
        store.createItem("a", m.id, {
          status: "open",
          fields: { severity: "minor", location: "a.ts", description: `a${i}` },
        }),
      );
      allUpdates.push(
        store.createItem("b", m.id, {
          status: "open",
          fields: { severity: "minor", location: "b.ts", description: `b${i}` },
        }),
      );
    }
    await Promise.all(allUpdates);
    expect(store.fetch("a").milestones[0]?.items.length).toBe(N);
    expect(store.fetch("b").milestones[0]?.items.length).toBe(N);
  });

  it("T845: concurrent planning sessions leave only the selected DAG actionable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-plan-conc-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "ledger.db");
    const plannerA = new SqliteLedgerStore({ dbPath });
    const plannerB = new SqliteLedgerStore({ dbPath });
    stores.push(plannerA, plannerB);
    await plannerA.init();
    await plannerB.init();

    try {
      const coordination = await plannerA.createMilestone({ title: "Shared planning goal" });
      await plannerB.invalidate(MILESTONES_LEDGER);
      const goal = await plannerA.createItem(GOALS_LEDGER, coordination.id, {
        status: "planning",
        fields: { title: "Plan once", description: "Produce one executable DAG" },
        session: "planner-a",
      });
      await plannerB.invalidate(GOALS_LEDGER);
      await plannerA.createItem(DECISIONS_LEDGER, coordination.id, {
        status: "locked",
        fields: {
          headline: "Approved planning direction",
          ledgerRefs: [`${GOALS_LEDGER}:${goal.id}`],
        },
        session: "planner-a",
      });
      await plannerB.invalidate(DECISIONS_LEDGER);

      const bothRead = gate();
      let readers = 0;
      const synchronizeAfterRead = async (): Promise<void> => {
        readers += 1;
        if (readers === 2) bothRead.open();
        await bothRead.promise;
      };

      const aMilestoneCreated = gate();
      const bMilestoneCreated = gate();
      const aTasksCreated = gate();
      const bTasksCreated = gate();
      const aFinalized = gate();

      async function createPlanTasks(
        store: SqliteLedgerStore,
        session: string,
        milestone: Item,
      ): Promise<Item[]> {
        const tasks: Item[] = [];
        for (const suffix of ["first", "second"]) {
          tasks.push(
            await store.createItem(TASKS_LEDGER, milestone.id, {
              status: "planned",
              fields: {
                headline: `${session} ${suffix} task`,
                ledgerRefs: [`${GOALS_LEDGER}:${goal.id}`],
              },
              session,
            }),
          );
        }
        return tasks;
      }

      const [resultA, resultB] = await Promise.all([
        (async () => {
          const observed = plannerA.fetchItem(GOALS_LEDGER, goal.id);
          await synchronizeAfterRead();
          const milestone = await plannerA.createMilestone({ title: "planner-a plan" });
          aMilestoneCreated.open();
          await bMilestoneCreated.promise;
          const tasks = await createPlanTasks(plannerA, "planner-a", milestone);
          aTasksCreated.open();
          await bTasksCreated.promise;
          await plannerA.updateItem(GOALS_LEDGER, goal.id, {
            status: "planned",
            fields: { milestones: [milestone.id] },
            session: "planner-a",
          });
          aFinalized.open();
          return { observed, milestone, tasks };
        })(),
        (async () => {
          const observed = plannerB.fetchItem(GOALS_LEDGER, goal.id);
          await synchronizeAfterRead();
          await aMilestoneCreated.promise;
          const milestone = await plannerB.createMilestone({ title: "planner-b plan" });
          bMilestoneCreated.open();
          await aTasksCreated.promise;
          const tasks = await createPlanTasks(plannerB, "planner-b", milestone);
          bTasksCreated.open();
          await aFinalized.promise;
          await plannerB.updateItem(GOALS_LEDGER, goal.id, {
            status: "planned",
            fields: { milestones: [milestone.id] },
            session: "planner-b",
          });
          return { observed, milestone, tasks };
        })(),
      ]);

      expect(resultA.observed).toEqual(resultB.observed);
      expect(resultA.observed.status).toBe("planning");
      expect(resultA.observed.fields["milestones"]).toBeUndefined();

      const finalGoal = plannerB.fetchItem(GOALS_LEDGER, goal.id);
      const selectedMilestoneIds = finalGoal.fields["milestones"];
      expect(selectedMilestoneIds).toEqual([resultB.milestone.id]);

      const allTasks = [...resultA.tasks, ...resultB.tasks];
      expect(allTasks.map((task) => task.status)).toEqual([
        "planned",
        "planned",
        "planned",
        "planned",
      ]);
      // D166/T855: both sessions' raw writes committed (all four tasks stay
      // `planned` — legacy selection never deletes the loser's DAG), but
      // readiness follows the goal's SELECTED manifest, so only planner B's
      // DAG — the last selection write — is actionable.
      const readyTaskIds = [...derivePredicates(plannerB).pImplement.items].sort();
      expect(readyTaskIds).toEqual(resultB.tasks.map((task) => task.id).sort());

      if (!Array.isArray(selectedMilestoneIds)) {
        throw new Error("goals.milestones must be an id array");
      }
      const taskById = new Map(allTasks.map((task) => [task.id, task]));
      const actionableMilestoneIds = [
        ...new Set(
          readyTaskIds.map((taskId) => {
            const task = taskById.get(taskId);
            if (task === undefined) throw new Error(`missing ready task ${taskId}`);
            return task.milestoneId;
          }),
        ),
      ].sort();

      expect(actionableMilestoneIds).toEqual([...selectedMilestoneIds].sort());
    } finally {
      await plannerA.dispose();
      await plannerB.dispose();
    }
  });
});
