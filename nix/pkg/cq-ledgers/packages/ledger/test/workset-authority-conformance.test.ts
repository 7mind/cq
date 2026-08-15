import { describe, expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DECISIONS_LEDGER,
  DEFECTS_LEDGER,
  GOALS_LEDGER,
  HANDOFFS_LEDGER,
  HYPOTHESIS_LEDGER,
  IDEAS_LEDGER,
  MILESTONES_AMBIENT_ID,
  QUESTIONS_LEDGER,
  RESEARCHES_LEDGER,
  REVIEWS_LEDGER,
  TASKS_LEDGER,
  WORKSET_OWNED_WRITE_CREATION_KINDS,
  WorksetGenericMutationError,
  WorksetInvocationAuthorityError,
  WorksetOwnedLifecycleError,
  createInMemoryWorksetGuardedPlanLifecycleStore,
  createObserveOnlyWorksetInvocationAuthority,
  createTrustedWorksetManagementAuthority,
  defaultChildLedgerForCreationKind,
  isTrustedWorksetManagementAuthority,
} from "../src/index.js";

const OWNED_WRITE_ADAPTERS = ["fs", "git", "sqlite", "postgres"] as const;

const ADMINISTRATIVE_CONFORMANCE_PATHS = [
  join(import.meta.dir, "workset-admin-admission.test.ts"),
  join(import.meta.dir, "workset-root-migration.test.ts"),
  join(import.meta.dir, "workset-owner-backup-restore.test.ts"),
  join(import.meta.dir, "workset-postgres-disconnect.test.ts"),
  join(import.meta.dir, "..", "..", "cq-cli", "test", "reset-erase-postgres.test.ts"),
] as const;

describe("T1988 owner and deny authority matrix [Behavioral-Active Blackbox-Atomic]", () => {
  test("closes every owner-scoped creation row over its canonical child ledger", () => {
    expect(
      Object.fromEntries(
        WORKSET_OWNED_WRITE_CREATION_KINDS.map((kind) => [
          kind,
          defaultChildLedgerForCreationKind(kind),
        ]),
      ),
    ).toEqual({
      "idea-to-goal": GOALS_LEDGER,
      "exact-gate-question": QUESTIONS_LEDGER,
      review: REVIEWS_LEDGER,
      "review-filed-defect": DEFECTS_LEDGER,
      "implementation-defect": DEFECTS_LEDGER,
      research: RESEARCHES_LEDGER,
      hypothesis: HYPOTHESIS_LEDGER,
      decision: DECISIONS_LEDGER,
      "fix-goal": GOALS_LEDGER,
      handoff: HANDOFFS_LEDGER,
    });
  });

  test("registers the unchanged owned-write contract on every durable adapter", async () => {
    for (const adapter of OWNED_WRITE_ADAPTERS) {
      const source = await readFile(
        join(import.meta.dir, `workset-owned-write-${adapter}.test.ts`),
        "utf8",
      );
      expect(source).toContain("runWorksetOwnedWriteContract(");
    }
  });

  test("keeps administrative, migration, backup, and PostgreSQL recovery legs gate-reachable", async () => {
    for (const path of ADMINISTRATIVE_CONFORMANCE_PATHS) {
      await access(path);
    }
    expect(ADMINISTRATIVE_CONFORMANCE_PATHS).toHaveLength(5);
  });

  test("denies ownerless, raw-generic, observe-only, and forged management effects before mutation", async () => {
    const store = createInMemoryWorksetGuardedPlanLifecycleStore({
      invocationAuthority: createTrustedWorksetManagementAuthority(),
    });
    await store.init();
    try {
      const idea = await store.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "authority owner" },
      });
      const { goal } = await store.bundles.bootstrapIdeaToGoal({
        ideaId: idea.id,
        goal: { title: "authority goal", description: "authority" },
        consumeIdea: false,
      });
      await store.setRoots([`${GOALS_LEDGER}:${goal.id}`]);
      const beforeTasks = store.fetch(TASKS_LEDGER).counters.item;
      const beforeHandoffs = store.fetch(HANDOFFS_LEDGER).counters.item;

      await expect(
        store.owned.createOwnerless({
          ledgerId: TASKS_LEDGER,
          milestoneId: MILESTONES_AMBIENT_ID,
          status: "planned",
          fields: { headline: "ownerless denied" },
        }),
      ).rejects.toBeInstanceOf(WorksetOwnedLifecycleError);
      await expect(
        store.mutations.createItem(HANDOFFS_LEDGER, MILESTONES_AMBIENT_ID, {
          status: "open",
          fields: { headline: "generic denied", flow: "implement" },
        }),
      ).rejects.toBeInstanceOf(WorksetGenericMutationError);
      expect(store.fetch(TASKS_LEDGER).counters.item).toBe(beforeTasks);
      expect(store.fetch(HANDOFFS_LEDGER).counters.item).toBe(beforeHandoffs);

      let accesses = 0;
      const observe = createObserveOnlyWorksetInvocationAuthority();
      await expect(
        observe.set(() => {
          accesses += 1;
        }),
      ).rejects.toBeInstanceOf(WorksetInvocationAuthorityError);
      const trusted = createTrustedWorksetManagementAuthority();
      expect(isTrustedWorksetManagementAuthority({ ...trusted })).toBe(false);
      expect(accesses).toBe(0);
      expect(store.activeAdmissionCount()).toBe(0);
    } finally {
      await store.dispose();
    }
  });
});
