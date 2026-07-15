/**
 * Dual-adapter fixture suite for the shared `derivePredicates` (T366 / G44,
 * fixes D50).
 *
 * ONE abstract fixture suite runs against BOTH adapters — the production
 * `FsLedgerStore` (against a freshly-created tmp `.cq/` dir per test) AND the
 * `InMemoryLedgerStore` dummy — per the repo's dual-tests pattern. Each fixture
 * seeds its store IDENTICALLY through the public `createMilestone` /
 * `createItem` / `updateItem` surface (so the two adapters are exercised
 * observationally identically), then asserts `derivePredicates(store)` — BOTH
 * the boolean `value` AND the exact `items[]` ids.
 *
 * This supersedes the minimal stub-store `predicates-smoke.test.ts` (T361): its
 * cases are folded in here against real adapters, so that file is removed.
 *
 * Fixtures (a)–(f) mirror T366's acceptance:
 *  (a) actionable open defect, unlinked → pInvestigate TRUE, items=[defect];
 *  (b) defect linked to a clarifying/planning goal → pInvestigate FALSE;
 *  (c) defect blocked solely on an open linked question → pInvestigate FALSE,
 *      question in openQuestionGate;
 *  (d) clarifying goal with open question → pPlan FALSE; same goal without →
 *      pPlan TRUE; planning goal → pPlan TRUE;
 *  (e) planned goal with a DAG-ready task → pImplement TRUE; with an unfinished
 *      dependsOn task → FALSE; with an open linked question → FALSE + question
 *      in gate; task whose milestone-dependency has a non-terminal task → FALSE;
 *  (f) all-terminal ledger → all three predicates FALSE.
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it, expect, afterAll } from "bun:test";
import {
  FsLedgerStore,
  InMemoryLedgerStore,
  serializeRegistry,
  derivePredicates,
  CANONICAL_LEDGERS,
  type LedgerStore,
  type PredicateVerdict,
  LEDGER_STORAGE_DIRNAME,
} from "../src/index.js";

/**
 * G77/M240 P-seed probe. The `pSeed` + `belowFloor` verdicts are asserted via
 * this structural cast so the suite RUNS rather than fails to COMPILE while the
 * fields are still absent from `DerivedPredicates` (they read `undefined` at
 * runtime pre-fix, so the seed fixtures fail with a clear undefined-vs-object
 * mismatch, then turn green once T542 adds the fields).
 */
type SeedProbe = { pSeed?: PredicateVerdict; belowFloor?: PredicateVerdict };
/** Order-insensitive verdict comparison (item creation order is incidental). */
function expectVerdict(actual: PredicateVerdict | undefined, value: boolean, items: string[]): void {
  expect(actual).toBeDefined();
  expect(actual!.value).toBe(value);
  expect([...actual!.items].sort()).toEqual([...items].sort());
}

// The canonical ledgers (defects/tasks/questions/goals/milestones) are
// bootstrapped on init(); the fixtures seed straight into them, so neither
// adapter needs a custom seed.
const NO_SEED: [] = [];

/** Build a fresh store of the named kind with the canonical ledgers bootstrapped. */
interface PredicatesStoreFactory {
  name: string;
  build(): Promise<LedgerStore>;
  teardown(store: LedgerStore): Promise<void>;
}

const fsDirs: string[] = [];

const fsFactory: PredicatesStoreFactory = {
  name: "FsLedgerStore",
  async build(): Promise<LedgerStore> {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-predicates-"));
    fsDirs.push(dir);
    const docsDir = path.join(dir, LEDGER_STORAGE_DIRNAME);
    await mkdir(docsDir, { recursive: true });
    await writeFile(
      path.join(docsDir, "ledgers.yaml"),
      serializeRegistry({ version: 1, ledgers: NO_SEED }),
      "utf8",
    );
    const store = new FsLedgerStore({ root: dir });
    await store.init();
    return store;
  },
  async teardown(store: LedgerStore): Promise<void> {
    await store.dispose();
  },
};

const inMemoryFactory: PredicatesStoreFactory = {
  name: "InMemoryLedgerStore",
  async build(): Promise<LedgerStore> {
    const store = new InMemoryLedgerStore({ seed: NO_SEED });
    await store.init();
    return store;
  },
  async teardown(store: LedgerStore): Promise<void> {
    await store.dispose();
  },
};

afterAll(async () => {
  for (const d of fsDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

// Canonical ledger names — assert against the real bootstrapped schemas so a
// fixture that drifts from the schema (bad status / missing required field)
// fails loudly at seed time rather than silently mis-asserting.
const DEFECTS = "defects";
const GOALS = "goals";
const TASKS = "tasks";
const QUESTIONS = "questions";

// Sanity guard: the fixtures below assume the canonical names are bootstrapped.
const canonicalNames = new Set(CANONICAL_LEDGERS.map((c) => c.name));
for (const name of [DEFECTS, GOALS, TASKS, QUESTIONS]) {
  if (!canonicalNames.has(name)) throw new Error(`expected canonical ledger ${name}`);
}

function runPredicatesSuite(factory: PredicatesStoreFactory): void {
  describe(`derivePredicates (dual-adapter fixtures, ${factory.name})`, () => {
    // (a) An actionable open defect NOT linked to any goal.
    it("(a) actionable open defect, unlinked → pInvestigate TRUE, items=[defect]", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const d = await store.createItem(DEFECTS, m.id, {
          status: "open",
          fields: { headline: "leak", severity: "major" },
        });

        const p = derivePredicates(store);
        expect(p.pInvestigate).toEqual({ value: true, items: [d.id] });
        expect(p.openQuestionGate).toEqual({ value: false, items: [] });
      } finally {
        await factory.teardown(store);
      }
    });

    // (b) A defect linked (ledgerRefs goals:G) to a goal in clarifying OR
    //     planning → pInvestigate FALSE (owned by a planning-phase goal).
    it("(b) defect linked to a clarifying/planning goal → pInvestigate FALSE", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const gClar = await store.createItem(GOALS, m.id, {
          status: "clarifying",
          fields: { title: "g-clar", description: "d" },
        });
        const gPlan = await store.createItem(GOALS, m.id, {
          status: "planning",
          fields: { title: "g-plan", description: "d" },
        });
        await store.createItem(DEFECTS, m.id, {
          status: "open",
          fields: { headline: "owned-by-clarifying", severity: "minor", ledgerRefs: [`${GOALS}:${gClar.id}`] },
        });
        await store.createItem(DEFECTS, m.id, {
          status: "open",
          fields: { headline: "owned-by-planning", severity: "minor", ledgerRefs: [`${GOALS}:${gPlan.id}`] },
        });

        const p = derivePredicates(store);
        // Both defects are owned by a movable planning-phase goal → excluded.
        expect(p.pInvestigate).toEqual({ value: false, items: [] });
      } finally {
        await factory.teardown(store);
      }
    });

    // (c) A defect whose only forward path is an open question linked to it.
    it("(c) defect blocked solely on an open linked question → pInvestigate FALSE + question in gate", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const d = await store.createItem(DEFECTS, m.id, {
          status: "open",
          fields: { headline: "needs-answer", severity: "major" },
        });
        const q = await store.createItem(QUESTIONS, m.id, {
          status: "open",
          fields: { question: "which?", ledgerRefs: [`${DEFECTS}:${d.id}`] },
        });

        const p = derivePredicates(store);
        expect(p.pInvestigate).toEqual({ value: false, items: [] });
        expect(p.openQuestionGate).toEqual({ value: true, items: [q.id] });
      } finally {
        await factory.teardown(store);
      }
    });

    // (d) Goal in clarifying with an open linked question → pPlan FALSE; the
    //     same goal with the question answered → pPlan TRUE; a planning goal →
    //     pPlan TRUE.
    it("(d) clarifying goal gated by an open question → pPlan FALSE; answered → TRUE; planning → TRUE", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const g = await store.createItem(GOALS, m.id, {
          status: "clarifying",
          fields: { title: "g-clar", description: "d" },
        });
        const q = await store.createItem(QUESTIONS, m.id, {
          status: "open",
          fields: { question: "scope?", ledgerRefs: [`${GOALS}:${g.id}`] },
        });

        // Open question gates the clarifying goal.
        const gated = derivePredicates(store);
        expect(gated.pPlan).toEqual({ value: false, items: [] });
        expect(gated.openQuestionGate).toEqual({ value: true, items: [q.id] });

        // Answer the question → the clarifying goal becomes plannable.
        await store.updateItem(QUESTIONS, q.id, { status: "answered", fields: { answer: "yes" } });
        const answered = derivePredicates(store);
        expect(answered.pPlan).toEqual({ value: true, items: [g.id] });
        expect(answered.openQuestionGate).toEqual({ value: false, items: [] });

        // A goal in `planning` is plannable regardless of linked questions.
        await store.updateItem(GOALS, g.id, { status: "planning" });
        const planning = derivePredicates(store);
        expect(planning.pPlan).toEqual({ value: true, items: [g.id] });
      } finally {
        await factory.teardown(store);
      }
    });

    // (e) Planned goal with a DAG-ready task → pImplement TRUE, items=[task];
    //     same task with an unfinished dependsOn task → FALSE; same task with an
    //     open linked question → FALSE + question in gate; a task whose
    //     milestone's dependsOn milestone has a non-terminal task → FALSE.
    it("(e1) planned goal with a DAG-ready task → pImplement TRUE, items=[task]", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const g = await store.createItem(GOALS, m.id, {
          status: "planned",
          fields: { title: "g", description: "d" },
        });
        const t = await store.createItem(TASKS, m.id, {
          status: "planned",
          fields: { headline: "ready", ledgerRefs: [`${GOALS}:${g.id}`] },
        });

        const p = derivePredicates(store);
        expect(p.pImplement).toEqual({ value: true, items: [t.id] });
        expect(p.openQuestionGate).toEqual({ value: false, items: [] });
      } finally {
        await factory.teardown(store);
      }
    });

    it("(e2) DAG-ready task held back by an unfinished dependsOn task → pImplement FALSE", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const g = await store.createItem(GOALS, m.id, {
          status: "planned",
          fields: { title: "g", description: "d" },
        });
        const dep = await store.createItem(TASKS, m.id, {
          status: "wip", // non-terminal dependency
          fields: { headline: "dep" },
        });
        await store.createItem(TASKS, m.id, {
          status: "planned",
          fields: { headline: "blocked-by-dep", ledgerRefs: [`${GOALS}:${g.id}`], dependsOn: [dep.id] },
        });

        const p = derivePredicates(store);
        // `dep` belongs to no buildable goal, so it is not itself ready; the
        // dependent task is held back by the unfinished `dep`.
        expect(p.pImplement).toEqual({ value: false, items: [] });
      } finally {
        await factory.teardown(store);
      }
    });

    it("(e3) DAG-ready task with an open linked question → pImplement FALSE + question in gate", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const g = await store.createItem(GOALS, m.id, {
          status: "planned",
          fields: { title: "g", description: "d" },
        });
        const t = await store.createItem(TASKS, m.id, {
          status: "planned",
          fields: { headline: "gated", ledgerRefs: [`${GOALS}:${g.id}`] },
        });
        const q = await store.createItem(QUESTIONS, m.id, {
          status: "open",
          fields: { question: "how?", ledgerRefs: [`${TASKS}:${t.id}`] },
        });

        const p = derivePredicates(store);
        expect(p.pImplement).toEqual({ value: false, items: [] });
        expect(p.openQuestionGate).toEqual({ value: true, items: [q.id] });
      } finally {
        await factory.teardown(store);
      }
    });

    it("(e4) task whose milestone's dependsOn milestone has a non-terminal task → pImplement FALSE", async () => {
      const store = await factory.build();
      try {
        // Milestone M1 holds a non-terminal task; M2 dependsOn M1.
        const m1 = await store.createMilestone({ title: "dep-milestone" });
        const m2 = await store.createMilestone({ title: "downstream", dependsOn: [m1.id] });
        const g = await store.createItem(GOALS, m2.id, {
          status: "planned",
          fields: { title: "g", description: "d" },
        });
        // Non-terminal task under the dependency milestone M1.
        await store.createItem(TASKS, m1.id, {
          status: "planned",
          fields: { headline: "unfinished-in-dep-milestone" },
        });
        // The candidate task under M2 is otherwise DAG-ready.
        await store.createItem(TASKS, m2.id, {
          status: "planned",
          fields: { headline: "candidate", ledgerRefs: [`${GOALS}:${g.id}`] },
        });

        const p = derivePredicates(store);
        expect(p.pImplement).toEqual({ value: false, items: [] });
      } finally {
        await factory.teardown(store);
      }
    });

    // (f) An all-terminal ledger (defects resolved, goals done, tasks done) →
    //     all three predicates FALSE.
    it("(f) all-terminal ledger → all three predicates FALSE", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        await store.createItem(DEFECTS, m.id, {
          status: "resolved",
          fields: { headline: "fixed", severity: "minor" },
        });
        const g = await store.createItem(GOALS, m.id, {
          status: "done",
          fields: { title: "shipped", description: "d" },
        });
        await store.createItem(TASKS, m.id, {
          status: "done",
          fields: { headline: "completed", ledgerRefs: [`${GOALS}:${g.id}`] },
        });

        const p = derivePredicates(store);
        expect(p.pInvestigate).toEqual({ value: false, items: [] });
        expect(p.pPlan).toEqual({ value: false, items: [] });
        expect(p.pImplement).toEqual({ value: false, items: [] });
        expect(p.openQuestionGate).toEqual({ value: false, items: [] });
        // G77/M240: the DRAINED snapshot also carries an all-false seed verdict
        // + an empty belowFloor companion.
        const ext = p as unknown as SeedProbe;
        expectVerdict(ext.pSeed, false, []);
        expectVerdict(ext.belowFloor, false, []);
      } finally {
        await factory.teardown(store);
      }
    });

    // -----------------------------------------------------------------------
    // (G77/M240) P-seed predicate + belowFloor companion — fixtures 1..8.
    // A P-seed is a root-caused defect at/above the severity floor owned by NO
    // live goal and not gated by an open question: the fix-owning gap D94 that
    // matched no prior predicate. belowFloor mirrors it for sub-floor severities
    // and is INFORMATIONAL (never gates a stop).
    // -----------------------------------------------------------------------

    // (1) REPRODUCTION — a root-caused HIGH defect linked to NO goal: the three
    //     stage predicates are all FALSE (root-caused is not investigate-actionable
    //     and there is no goal/task), yet pSeed names the defect.
    it("(seed-1) root-caused HIGH defect, unlinked → pInvestigate/pPlan/pImplement FALSE, pSeed=[defect]", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const d = await store.createItem(DEFECTS, m.id, {
          status: "root-caused",
          fields: { headline: "root-caused, unowned", severity: "high" },
        });

        const p = derivePredicates(store);
        expect(p.pInvestigate).toEqual({ value: false, items: [] });
        expect(p.pPlan).toEqual({ value: false, items: [] });
        expect(p.pImplement).toEqual({ value: false, items: [] });
        const ext = p as unknown as SeedProbe;
        expectVerdict(ext.pSeed, true, [d.id]);
        expectVerdict(ext.belowFloor, false, []);
      } finally {
        await factory.teardown(store);
      }
    });

    // (2) severity floor — medium & low root-caused unowned defects are BELOW the
    //     floor (pSeed FALSE, belowFloor names them); a critical one is at/above
    //     the floor → pSeed names it.
    it("(seed-2) severity floor: medium & low → belowFloor; critical → pSeed", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const med = await store.createItem(DEFECTS, m.id, {
          status: "root-caused",
          fields: { headline: "medium", severity: "medium" },
        });
        const low = await store.createItem(DEFECTS, m.id, {
          status: "root-caused",
          fields: { headline: "low", severity: "low" },
        });
        const crit = await store.createItem(DEFECTS, m.id, {
          status: "root-caused",
          fields: { headline: "critical", severity: "critical" },
        });

        const ext = derivePredicates(store) as unknown as SeedProbe;
        expectVerdict(ext.pSeed, true, [crit.id]);
        expectVerdict(ext.belowFloor, true, [med.id, low.id]);
      } finally {
        await factory.teardown(store);
      }
    });

    // (2b) case-insensitive + whitespace-trimmed severity match: 'High' and
    //      ' high ' both satisfy the floor.
    it("(seed-2b) severity match is case-insensitive and trimmed: 'High' / ' high ' → pSeed", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const d1 = await store.createItem(DEFECTS, m.id, {
          status: "root-caused",
          fields: { headline: "cap-High", severity: "High" },
        });
        const d2 = await store.createItem(DEFECTS, m.id, {
          status: "root-caused",
          fields: { headline: "ws-high", severity: " high " },
        });

        const ext = derivePredicates(store) as unknown as SeedProbe;
        expectVerdict(ext.pSeed, true, [d1.id, d2.id]);
        expectVerdict(ext.belowFloor, false, []);
      } finally {
        await factory.teardown(store);
      }
    });

    // (2c) unrecognized / empty severities are BELOW the floor: pSeed FALSE, all
    //      three appear in belowFloor.
    it("(seed-2c) unknown severity 'urgent'/'blocker'/'' → pSeed FALSE + belowFloor", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const urgent = await store.createItem(DEFECTS, m.id, {
          status: "root-caused",
          fields: { headline: "urgent", severity: "urgent" },
        });
        const blocker = await store.createItem(DEFECTS, m.id, {
          status: "root-caused",
          fields: { headline: "blocker", severity: "blocker" },
        });
        const empty = await store.createItem(DEFECTS, m.id, {
          status: "root-caused",
          fields: { headline: "empty-sev", severity: "" },
        });

        const ext = derivePredicates(store) as unknown as SeedProbe;
        expectVerdict(ext.pSeed, false, []);
        expectVerdict(ext.belowFloor, true, [urgent.id, blocker.id, empty.id]);
      } finally {
        await factory.teardown(store);
      }
    });

    // (3) ownership via the DEFECT-side ledgerRefs goals:<G>, for a live goal in
    //     EACH of the four live phases → pSeed FALSE (a live goal owns the fix).
    it("(seed-3) defect-side ledgerRefs to a live goal (clarifying/planning/planned/building) → pSeed FALSE", async () => {
      for (const phase of ["clarifying", "planning", "planned", "building"] as const) {
        const store = await factory.build();
        try {
          const m = await store.createMilestone({ title: "m" });
          const g = await store.createItem(GOALS, m.id, {
            status: phase,
            fields: { title: `g-${phase}`, description: "d" },
          });
          await store.createItem(DEFECTS, m.id, {
            status: "root-caused",
            fields: { headline: `owned-${phase}`, severity: "high", ledgerRefs: [`${GOALS}:${g.id}`] },
          });

          const ext = derivePredicates(store) as unknown as SeedProbe;
          expectVerdict(ext.pSeed, false, []);
          expectVerdict(ext.belowFloor, false, []);
        } finally {
          await factory.teardown(store);
        }
      }
    });

    // (4) ownership via the GOAL-side ref ONLY — a live (clarifying) goal whose
    //     fields.sourceRefs names defects:<D>, while the defect carries NO
    //     goals: ref of its own. This mirrors real investigate-seeded goals,
    //     which carry only the goal→defect link (the `goals` schema has no
    //     ledgerRefs field; sourceRefs is the goal-side cross-ledger link). Both
    //     defects are thus owned by a live goal → pSeed FALSE.
    it("(seed-4) goal-side ref only (goal.sourceRefs → defects:<D>) → pSeed FALSE", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const d1 = await store.createItem(DEFECTS, m.id, {
          status: "root-caused",
          fields: { headline: "goal-owned-1", severity: "high" },
        });
        const d2 = await store.createItem(DEFECTS, m.id, {
          status: "root-caused",
          fields: { headline: "goal-owned-2", severity: "critical" },
        });
        await store.createItem(GOALS, m.id, {
          status: "clarifying",
          fields: {
            title: "g-via-sourceRefs",
            description: "d",
            sourceRefs: [`${DEFECTS}:${d1.id}`, `${DEFECTS}:${d2.id}`],
          },
        });

        const ext = derivePredicates(store) as unknown as SeedProbe;
        expectVerdict(ext.pSeed, false, []);
        expectVerdict(ext.belowFloor, false, []);
      } finally {
        await factory.teardown(store);
      }
    });

    // (5) re-seed edge — a root-caused defect owned ONLY by a done goal (and,
    //     separately, an abandoned goal) is NOT owned by a LIVE goal, so it
    //     re-qualifies as a P-seed.
    it("(seed-5) defect owned only by a done/abandoned goal, still root-caused → pSeed TRUE again", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const gDone = await store.createItem(GOALS, m.id, {
          status: "done",
          fields: { title: "g-done", description: "d" },
        });
        const gAband = await store.createItem(GOALS, m.id, {
          status: "abandoned",
          fields: { title: "g-abandoned", description: "d" },
        });
        const d1 = await store.createItem(DEFECTS, m.id, {
          status: "root-caused",
          fields: { headline: "owned-by-done", severity: "high", ledgerRefs: [`${GOALS}:${gDone.id}`] },
        });
        const d2 = await store.createItem(DEFECTS, m.id, {
          status: "root-caused",
          fields: { headline: "owned-by-abandoned", severity: "critical", ledgerRefs: [`${GOALS}:${gAband.id}`] },
        });

        const ext = derivePredicates(store) as unknown as SeedProbe;
        expectVerdict(ext.pSeed, true, [d1.id, d2.id]);
        expectVerdict(ext.belowFloor, false, []);
      } finally {
        await factory.teardown(store);
      }
    });

    // (6) open-question gate — a root-caused HIGH defect gated by an open linked
    //     question is NOT a P-seed; the question surfaces in openQuestionGate.
    it("(seed-6) root-caused HIGH defect gated by an open question → pSeed FALSE + question in gate", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const d = await store.createItem(DEFECTS, m.id, {
          status: "root-caused",
          fields: { headline: "gated-seed", severity: "high" },
        });
        const q = await store.createItem(QUESTIONS, m.id, {
          status: "open",
          fields: { question: "confirm fix?", ledgerRefs: [`${DEFECTS}:${d.id}`] },
        });

        const p = derivePredicates(store);
        expect(p.openQuestionGate.value).toBe(true);
        expect(p.openQuestionGate.items).toContain(q.id);
        const ext = p as unknown as SeedProbe;
        expectVerdict(ext.pSeed, false, []);
        expectVerdict(ext.belowFloor, false, []);
      } finally {
        await factory.teardown(store);
      }
    });

    // (7) non-root-caused defects (open / resolved / wontfix) are never P-seeds
    //     regardless of severity, and are not belowFloor either.
    it("(seed-7) non-root-caused (open/resolved/wontfix) → pSeed FALSE regardless of severity", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        await store.createItem(DEFECTS, m.id, {
          status: "open",
          fields: { headline: "open-high", severity: "high" },
        });
        await store.createItem(DEFECTS, m.id, {
          status: "resolved",
          fields: { headline: "resolved-critical", severity: "critical" },
        });
        await store.createItem(DEFECTS, m.id, {
          status: "wontfix",
          fields: { headline: "wontfix-high", severity: "high" },
        });

        const ext = derivePredicates(store) as unknown as SeedProbe;
        expectVerdict(ext.pSeed, false, []);
        expectVerdict(ext.belowFloor, false, []);
      } finally {
        await factory.teardown(store);
      }
    });

    // (8) belowFloor companion — a root-caused MEDIUM and a root-caused LOW
    //     unowned, non-gated defect land in belowFloor, NOT pSeed.
    it("(seed-8) root-caused MEDIUM/LOW unowned non-gated → belowFloor names them, pSeed does NOT", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "m" });
        const med = await store.createItem(DEFECTS, m.id, {
          status: "root-caused",
          fields: { headline: "med-below", severity: "medium" },
        });
        const low = await store.createItem(DEFECTS, m.id, {
          status: "root-caused",
          fields: { headline: "low-below", severity: "low" },
        });

        const ext = derivePredicates(store) as unknown as SeedProbe;
        expectVerdict(ext.pSeed, false, []);
        expectVerdict(ext.belowFloor, true, [med.id, low.id]);
        expect(ext.pSeed!.items).not.toContain(med.id);
        expect(ext.pSeed!.items).not.toContain(low.id);
      } finally {
        await factory.teardown(store);
      }
    });
  });
}

runPredicatesSuite(fsFactory);
runPredicatesSuite(inMemoryFactory);
