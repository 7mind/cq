/**
 * F2 — server-enforced cross-ledger preconditions on `goals` phase changes.
 *
 * Runs the same assertions against BOTH adapters (FsLedgerStore over a tmp
 * dir, InMemoryLedgerStore dummy) via a per-test factory mirroring
 * transitions.test.ts.
 *
 * Two preconditions, enforced at the LedgerStore layer so NO client can
 * bypass them:
 *  (a) a `goals` item cannot LEAVE `clarifying` while ANY `open` `questions`
 *      item links to it (`fields.ledgerRefs` contains `goals:<G>`);
 *  (b) a `goals` item cannot ENTER `planned` unless at least one `locked`
 *      `decisions` item links to it.
 *
 * "Links to the goal" = the linking item's `fields.ledgerRefs` array contains
 * the soft ref `"goals:<goalId>"` (the established `<ledgerName>:<itemId>`
 * cross-ledger ref convention).
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  InMemoryLedgerStore,
  serializeRegistry,
  GOALS_LEDGER,
  QUESTIONS_LEDGER,
  DECISIONS_LEDGER,
  GoalPreconditionError,
  InvalidTransitionError,
  type LedgerStore,
  LEDGER_STORAGE_DIRNAME,
} from "../src/index.js";

interface StoreFactory {
  name: string;
  build(): Promise<LedgerStore>;
  teardown(store: LedgerStore): Promise<void>;
}

const dirs: string[] = [];

const fsFactory: StoreFactory = {
  name: "FsLedgerStore",
  async build() {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-goal-precond-"));
    dirs.push(dir);
    const docsDir = path.join(dir, LEDGER_STORAGE_DIRNAME);
    await mkdir(docsDir, { recursive: true });
    await writeFile(
      path.join(docsDir, "ledgers.yaml"),
      serializeRegistry({ version: 1, ledgers: [] }),
      "utf8",
    );
    const store = new FsLedgerStore({ root: dir });
    await store.init();
    return store;
  },
  async teardown(store) {
    await store.dispose();
  },
};

const inMemFactory: StoreFactory = {
  name: "InMemoryLedgerStore",
  async build() {
    const store = new InMemoryLedgerStore({ seed: [] });
    await store.init();
    return store;
  },
  async teardown(store) {
    await store.dispose();
  },
};

/** Create a goal in `clarifying`; returns its id. */
async function seedGoal(store: LedgerStore, milestoneId: string): Promise<string> {
  const goal = await store.createItem(GOALS_LEDGER, milestoneId, {
    status: "clarifying",
    fields: { title: "g", description: "d" },
  });
  return goal.id;
}

for (const factory of [fsFactory, inMemFactory]) {
  describe(`goal preconditions (${factory.name})`, () => {
    // (a) blocks: open question linking the goal blocks leaving clarifying.
    it("1. (a) blocks leaving clarifying while an open linked question exists", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const goalId = await seedGoal(store, m.id);
        await store.createItem(QUESTIONS_LEDGER, m.id, {
          status: "open",
          fields: { question: "why?", ledgerRefs: [`goals:${goalId}`] },
        });
        await expect(
          store.updateItem(GOALS_LEDGER, goalId, { status: "planning" }),
        ).rejects.toThrow(GoalPreconditionError);
      } finally {
        await factory.teardown(store);
      }
    });

    // (a) allows: the linked question is answered → leaving clarifying succeeds.
    it("2. (a) allows leaving clarifying once the linked question is answered", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const goalId = await seedGoal(store, m.id);
        const q = await store.createItem(QUESTIONS_LEDGER, m.id, {
          status: "open",
          fields: { question: "why?", ledgerRefs: [`goals:${goalId}`] },
        });
        await store.updateItem(QUESTIONS_LEDGER, q.id, {
          status: "answered",
          fields: { answer: "because" },
        });
        const updated = await store.updateItem(GOALS_LEDGER, goalId, {
          status: "planning",
        });
        expect(updated.status).toBe("planning");
      } finally {
        await factory.teardown(store);
      }
    });

    // (a) ignores unrelated: an open question linking a DIFFERENT goal does
    // not block this goal.
    it("3. (a) ignores an open question that links a different goal", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const goalId = await seedGoal(store, m.id);
        const otherGoalId = await seedGoal(store, m.id);
        await store.createItem(QUESTIONS_LEDGER, m.id, {
          status: "open",
          fields: { question: "other?", ledgerRefs: [`goals:${otherGoalId}`] },
        });
        const updated = await store.updateItem(GOALS_LEDGER, goalId, {
          status: "planning",
        });
        expect(updated.status).toBe("planning");
      } finally {
        await factory.teardown(store);
      }
    });

    // (b) blocks: no locked decision linked → entering planned throws.
    it("4. (b) blocks entering planned with no locked linked decision", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const goalId = await seedGoal(store, m.id);
        // clarifying → planning (no open questions, so allowed).
        await store.updateItem(GOALS_LEDGER, goalId, { status: "planning" });
        await expect(
          store.updateItem(GOALS_LEDGER, goalId, { status: "planned" }),
        ).rejects.toThrow(GoalPreconditionError);
      } finally {
        await factory.teardown(store);
      }
    });

    // (b) allows: a locked decision linking the goal → entering planned succeeds.
    it("5. (b) allows entering planned once a locked linked decision exists", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const goalId = await seedGoal(store, m.id);
        await store.updateItem(GOALS_LEDGER, goalId, { status: "planning" });
        const k = await store.createItem(DECISIONS_LEDGER, m.id, {
          status: "proposed",
          fields: { headline: "decide", ledgerRefs: [`goals:${goalId}`] },
        });
        await store.updateItem(DECISIONS_LEDGER, k.id, { status: "locked" });
        const updated = await store.updateItem(GOALS_LEDGER, goalId, {
          status: "planned",
        });
        expect(updated.status).toBe("planned");
      } finally {
        await factory.teardown(store);
      }
    });

    // No effect on non-goals ledgers or non-gated goal transitions.
    it("6a. updating a non-goals item is unaffected", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const goalId = await seedGoal(store, m.id);
        // An open question linking the goal exists — it must NOT block a
        // status change on the QUESTION itself (rule is goals-only).
        const q = await store.createItem(QUESTIONS_LEDGER, m.id, {
          status: "open",
          fields: { question: "why?", ledgerRefs: [`goals:${goalId}`] },
        });
        const updated = await store.updateItem(QUESTIONS_LEDGER, q.id, {
          status: "withdrawn",
        });
        expect(updated.status).toBe("withdrawn");
      } finally {
        await factory.teardown(store);
      }
    });

    it("6b. planning → clarifying (not gated) is unaffected by an open question", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const goalId = await seedGoal(store, m.id);
        // Leave clarifying first (no questions yet).
        await store.updateItem(GOALS_LEDGER, goalId, { status: "planning" });
        // Now file an open linked question; planning → clarifying is NOT a
        // "leave clarifying" move, so it must not be blocked.
        await store.createItem(QUESTIONS_LEDGER, m.id, {
          status: "open",
          fields: { question: "why?", ledgerRefs: [`goals:${goalId}`] },
        });
        const updated = await store.updateItem(GOALS_LEDGER, goalId, {
          status: "clarifying",
        });
        expect(updated.status).toBe("clarifying");
      } finally {
        await factory.teardown(store);
      }
    });

    it("6c. planned → building (not gated by these rules) is unaffected", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const goalId = await seedGoal(store, m.id);
        await store.updateItem(GOALS_LEDGER, goalId, { status: "planning" });
        const k = await store.createItem(DECISIONS_LEDGER, m.id, {
          status: "proposed",
          fields: { headline: "decide", ledgerRefs: [`goals:${goalId}`] },
        });
        await store.updateItem(DECISIONS_LEDGER, k.id, { status: "locked" });
        await store.updateItem(GOALS_LEDGER, goalId, { status: "planned" });
        // planned → building must succeed without any further precondition.
        const updated = await store.updateItem(GOALS_LEDGER, goalId, {
          status: "building",
        });
        expect(updated.status).toBe("building");
      } finally {
        await factory.teardown(store);
      }
    });

    // (i) Schema-illegal jump takes precedence over the F2 precondition: the
    // transition guard runs first, so clarifying → planned (not a declared
    // transition) rejects with InvalidTransitionError, NOT GoalPreconditionError,
    // even though an open linked question would also have blocked leaving
    // clarifying.
    it("7. illegal transition takes precedence over the precondition", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const goalId = await seedGoal(store, m.id);
        await store.createItem(QUESTIONS_LEDGER, m.id, {
          status: "open",
          fields: { question: "why?", ledgerRefs: [`goals:${goalId}`] },
        });
        // clarifying → planned is not a declared transition (clarifying only
        // permits planning/abandoned), so the transition guard must fire first.
        await expect(
          store.updateItem(GOALS_LEDGER, goalId, { status: "planned" }),
        ).rejects.toThrow(InvalidTransitionError);
        // And it must NOT surface as a precondition error.
        await expect(
          store.updateItem(GOALS_LEDGER, goalId, { status: "planned" }),
        ).rejects.not.toThrow(GoalPreconditionError);
        // The goal must remain in clarifying (no mutation on the rejected path).
        const fetched = store.fetchItem(GOALS_LEDGER, goalId);
        expect(fetched.status).toBe("clarifying");
      } finally {
        await factory.teardown(store);
      }
    });

    // (ii) A locked decision linking a DIFFERENT goal does not satisfy rule (b)
    // for this goal: G1 has no locked decision linking it, so entering planned
    // on G1 still rejects with GoalPreconditionError.
    it("8. (b) a locked decision on a different goal does not satisfy the rule", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const goal1Id = await seedGoal(store, m.id);
        const goal2Id = await seedGoal(store, m.id);
        await store.updateItem(GOALS_LEDGER, goal1Id, { status: "planning" });
        // A locked decision exists, but it links G2 — not G1.
        const k = await store.createItem(DECISIONS_LEDGER, m.id, {
          status: "proposed",
          fields: { headline: "decide", ledgerRefs: [`goals:${goal2Id}`] },
        });
        await store.updateItem(DECISIONS_LEDGER, k.id, { status: "locked" });
        await expect(
          store.updateItem(GOALS_LEDGER, goal1Id, { status: "planned" }),
        ).rejects.toThrow(GoalPreconditionError);
      } finally {
        await factory.teardown(store);
      }
    });

    // (iii) A withdrawn question does not block: the only linked question is
    // withdrawn (not open), so leaving clarifying succeeds.
    it("9. (a) a withdrawn linked question does not block leaving clarifying", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const goalId = await seedGoal(store, m.id);
        const q = await store.createItem(QUESTIONS_LEDGER, m.id, {
          status: "open",
          fields: { question: "why?", ledgerRefs: [`goals:${goalId}`] },
        });
        await store.updateItem(QUESTIONS_LEDGER, q.id, { status: "withdrawn" });
        const updated = await store.updateItem(GOALS_LEDGER, goalId, {
          status: "planning",
        });
        expect(updated.status).toBe("planning");
      } finally {
        await factory.teardown(store);
      }
    });

    // (iv) Mixed open + answered still blocks: one answered and one open linked
    // question → the open one still blocks leaving clarifying.
    it("10. (a) a mix of open and answered linked questions still blocks", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const goalId = await seedGoal(store, m.id);
        const answered = await store.createItem(QUESTIONS_LEDGER, m.id, {
          status: "open",
          fields: { question: "answered?", ledgerRefs: [`goals:${goalId}`] },
        });
        await store.updateItem(QUESTIONS_LEDGER, answered.id, {
          status: "answered",
          fields: { answer: "yes" },
        });
        await store.createItem(QUESTIONS_LEDGER, m.id, {
          status: "open",
          fields: { question: "still open?", ledgerRefs: [`goals:${goalId}`] },
        });
        await expect(
          store.updateItem(GOALS_LEDGER, goalId, { status: "planning" }),
        ).rejects.toThrow(GoalPreconditionError);
      } finally {
        await factory.teardown(store);
      }
    });
  });
}

afterAll(async () => {
  for (const d of dirs) {
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});
