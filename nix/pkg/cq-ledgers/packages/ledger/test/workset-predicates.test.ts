/**
 * T1985 — shared workset-filtered predicate dual-adapter contract.
 *
 * Constructive taxonomy: Behavioral / Active / Blackbox. The in-memory leg is
 * Atomic; the filesystem leg is Good-Communication over durable project files.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  DEFECTS_LEDGER,
  FsLedgerStore,
  GOALS_LEDGER,
  IDEAS_LEDGER,
  InMemoryLedgerStore,
  LEDGER_STORAGE_DIRNAME,
  QUESTIONS_LEDGER,
  RESEARCHES_LEDGER,
  TASKS_LEDGER,
  createTrustedWorksetManagementAuthority,
  createWorksetOwnedGuardedLedger,
  derivePredicates,
  deriveWorksetPredicates,
  requireWorksetStore,
  serializeRegistry,
  type LedgerStore,
  type WorksetOwnedGuardedLedger,
  type WorksetOwnedWriteTx,
} from "../src/index.js";

type AtomicOwnedStore = LedgerStore & {
  runAtomicOwnedMutation<T>(mutate: (tx: WorksetOwnedWriteTx) => T): Promise<T>;
};

interface Fixture {
  readonly store: AtomicOwnedStore;
  readonly guarded: WorksetOwnedGuardedLedger;
}

interface FixtureFactory {
  readonly name: string;
  readonly classification: "Blackbox-Atomic" | "Blackbox-GoodCommunication";
  build(): Promise<Fixture>;
}

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

function bindGuarded(store: AtomicOwnedStore): WorksetOwnedGuardedLedger {
  return createWorksetOwnedGuardedLedger({
    rawStore: store,
    worksetStore: requireWorksetStore(store),
    invocationAuthority: createTrustedWorksetManagementAuthority(),
    runOwnedTransaction: (mutate) => store.runAtomicOwnedMutation(mutate),
  });
}

const inMemoryFactory: FixtureFactory = {
  name: "InMemoryLedgerStore",
  classification: "Blackbox-Atomic",
  async build() {
    const store = new InMemoryLedgerStore();
    await store.init();
    return { store, guarded: bindGuarded(store) };
  },
};

const fsFactory: FixtureFactory = {
  name: "FsLedgerStore",
  classification: "Blackbox-GoodCommunication",
  async build() {
    const root = await mkdtemp(path.join(tmpdir(), "workset-predicates-"));
    roots.push(root);
    const ledgerDir = path.join(root, LEDGER_STORAGE_DIRNAME);
    await mkdir(ledgerDir, { recursive: true });
    await writeFile(
      path.join(ledgerDir, "ledgers.yaml"),
      serializeRegistry({ version: 1, ledgers: [] }),
      "utf8",
    );
    const store = new FsLedgerStore({ root });
    await store.init();
    return { store, guarded: bindGuarded(store) };
  },
};

function expectEveryVerdictFalse(value: Awaited<ReturnType<typeof deriveWorksetPredicates>>): void {
  for (const verdict of Object.values(value)) {
    expect(verdict).toEqual({ value: false, items: [] });
  }
}

function runContract(factory: FixtureFactory): void {
  describe(`workset-filtered predicates — ${factory.name} [Behavioral-Active ${factory.classification}]`, () => {
    it("preserves empty-root verdict bytes exactly", async () => {
      const { store } = await factory.build();
      try {
        const milestone = await store.createMilestone({ title: "empty-root parity" });
        await store.createItem(DEFECTS_LEDGER, milestone.id, {
          status: "open",
          fields: { headline: "actionable", severity: "high" },
        });

        expect(JSON.stringify(await deriveWorksetPredicates(store))).toBe(
          JSON.stringify(derivePredicates(store)),
        );
      } finally {
        await store.dispose();
      }
    });

    it("excludes unrelated actionable items under a restrictive direct root", async () => {
      const { store } = await factory.build();
      try {
        const milestone = await store.createMilestone({ title: "direct root" });
        const included = await store.createItem(DEFECTS_LEDGER, milestone.id, {
          status: "open",
          fields: { headline: "included", severity: "high" },
        });
        await store.createItem(DEFECTS_LEDGER, milestone.id, {
          status: "open",
          fields: { headline: "unrelated", severity: "high" },
        });
        await requireWorksetStore(store).setRoots([`${DEFECTS_LEDGER}:${included.id}`]);

        expect((await deriveWorksetPredicates(store)).pInvestigate).toEqual({
          value: true,
          items: [included.id],
        });
      } finally {
        await store.dispose();
      }
    });

    it("follows idea ownership, current-draft, research, defect, and exact-gate edges", async () => {
      const { store, guarded } = await factory.build();
      try {
        const idea = await guarded.owned.createOwnerless({
          ledgerId: IDEAS_LEDGER,
          status: "open",
          fields: { title: "included idea" },
        });
        const { goal } = await guarded.bundles.bootstrapIdeaToGoal({
          ideaId: idea.id,
          goal: { title: "included goal", description: "planning" },
        });
        const draft = await guarded.bundles.publishOwnedDraft({
          goalId: goal.id,
          creationKind: "active-current-draft",
          milestone: { title: "current draft" },
          tasks: [
            { headline: "draft task", fields: { ledgerRefs: [`${GOALS_LEDGER}:${goal.id}`] } },
          ],
        });
        const research = await guarded.owned.createOwned({
          owner: { ledgerId: GOALS_LEDGER, itemId: goal.id },
          creationKind: "research",
          child: {
            ledgerId: RESEARCHES_LEDGER,
            status: "open",
            fields: {
              question: "included research",
              ledgerRefs: [`${GOALS_LEDGER}:${goal.id}`],
            },
          },
        });
        const goalGate = await guarded.owned.createOwned({
          owner: { ledgerId: GOALS_LEDGER, itemId: goal.id },
          creationKind: "exact-gate-question",
          child: {
            ledgerId: QUESTIONS_LEDGER,
            status: "open",
            fields: {
              question: "goal gate",
              ledgerRefs: [`${GOALS_LEDGER}:${goal.id}`],
            },
          },
        });
        const researchGate = await guarded.owned.createOwned({
          owner: { ledgerId: RESEARCHES_LEDGER, itemId: research.child.id },
          creationKind: "exact-gate-question",
          child: {
            ledgerId: QUESTIONS_LEDGER,
            status: "open",
            fields: {
              question: "research gate",
              ledgerRefs: [`${RESEARCHES_LEDGER}:${research.child.id}`],
            },
          },
        });
        const implementationDefect = await guarded.owned.createOwned({
          owner: { ledgerId: TASKS_LEDGER, itemId: draft.tasks[0]!.id },
          creationKind: "implementation-defect",
          child: {
            ledgerId: DEFECTS_LEDGER,
            status: "open",
            fields: {
              headline: "included implementation defect",
              severity: "high",
              ledgerRefs: [`${TASKS_LEDGER}:${draft.tasks[0]!.id}`],
            },
          },
        });
        await store.createItem(DEFECTS_LEDGER, draft.milestone.id, {
          status: "open",
          fields: { headline: "unrelated defect", severity: "high" },
        });
        await store.createItem(RESEARCHES_LEDGER, draft.milestone.id, {
          status: "open",
          fields: { question: "unrelated research" },
        });
        await requireWorksetStore(store).setRoots([`${IDEAS_LEDGER}:${idea.id}`]);

        const actual = await deriveWorksetPredicates(store);
        expect(actual.pInvestigate).toEqual({
          value: true,
          items: [implementationDefect.child.id],
        });
        expect(actual.pPlan).toEqual({ value: false, items: [] });
        expect(actual.pResearch).toEqual({ value: false, items: [] });
        expect(actual.openQuestionGate).toEqual({
          value: true,
          items: [goalGate.child.id, researchGate.child.id],
        });
      } finally {
        await store.dispose();
      }
    });

    it("keeps a finalized manifest gated until its exact question is answered", async () => {
      const { store, guarded } = await factory.build();
      try {
        const idea = await guarded.owned.createOwnerless({
          ledgerId: IDEAS_LEDGER,
          status: "open",
          fields: { title: "finalized idea" },
        });
        const { goal } = await guarded.bundles.bootstrapIdeaToGoal({
          ideaId: idea.id,
          goal: { title: "finalized goal", description: "ready", status: "planned" },
        });
        const draft = await guarded.bundles.publishOwnedDraft({
          goalId: goal.id,
          creationKind: "finalized-manifest",
          milestone: { title: "finalized milestone" },
          tasks: [
            {
              headline: "finalized task",
              fields: { ledgerRefs: [`${GOALS_LEDGER}:${goal.id}`] },
            },
          ],
        });
        const task = draft.tasks[0]!;
        const gate = await guarded.owned.createOwned({
          owner: { ledgerId: TASKS_LEDGER, itemId: task.id },
          creationKind: "exact-gate-question",
          child: {
            ledgerId: QUESTIONS_LEDGER,
            status: "open",
            fields: {
              question: "task gate",
              ledgerRefs: [`${TASKS_LEDGER}:${task.id}`],
            },
          },
        });
        const unrelatedGoal = await store.createItem(GOALS_LEDGER, draft.milestone.id, {
          status: "building",
          fields: { title: "unrelated goal", description: "outside" },
        });
        await store.createItem(TASKS_LEDGER, draft.milestone.id, {
          status: "planned",
          fields: {
            headline: "unrelated task",
            ledgerRefs: [`${GOALS_LEDGER}:${unrelatedGoal.id}`],
          },
        });
        await requireWorksetStore(store).setRoots([`${GOALS_LEDGER}:${goal.id}`]);

        expect((await deriveWorksetPredicates(store)).pImplement).toEqual({
          value: false,
          items: [],
        });
        expect((await deriveWorksetPredicates(store)).openQuestionGate).toEqual({
          value: true,
          items: [gate.child.id],
        });

        await guarded.mutations.updateItem(QUESTIONS_LEDGER, gate.child.id, {
          status: "answered",
          fields: { answer: "yes" },
        });
        const answered = await deriveWorksetPredicates(store);
        expect(answered.pImplement).toEqual({ value: true, items: [task.id] });
        expect(answered.openQuestionGate).toEqual({ value: false, items: [] });
      } finally {
        await store.dispose();
      }
    });

    it("treats an all-inactive configured set as restrictive without fallback", async () => {
      const { store } = await factory.build();
      try {
        const milestone = await store.createMilestone({ title: "inactive root" });
        const archived = await store.createItem(DEFECTS_LEDGER, milestone.id, {
          status: "open",
          fields: { headline: "archived root", severity: "high" },
        });
        await store.updateItem(DEFECTS_LEDGER, archived.id, { status: "wontfix" });
        await store.updateMilestone(milestone.id, { status: "done" });
        await store.archiveMilestone(milestone.id, "inactive workset fixture");
        await store.createItem(DEFECTS_LEDGER, "M-AMBIENT", {
          status: "open",
          fields: { headline: "must not become fallback work", severity: "high" },
        });
        await requireWorksetStore(store).setRoots([`${DEFECTS_LEDGER}:${archived.id}`]);

        expectEveryVerdictFalse(await deriveWorksetPredicates(store));
      } finally {
        await store.dispose();
      }
    });
  });
}

runContract(inMemoryFactory);
runContract(fsFactory);
