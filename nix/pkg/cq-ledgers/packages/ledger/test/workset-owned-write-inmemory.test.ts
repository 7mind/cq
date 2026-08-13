/**
 * T1962 — in-memory dummy leg of the owner-scoped lifecycle write dual-test pair.
 *
 * Focused cases beyond the shared Blackbox contract: child-ledger mismatch,
 * admission kind stability, and generic sealed-ownership still rejected.
 */

import { describe, expect, it } from "bun:test";
import {
  buildActiveStateFromLedgerStore,
  closeWorkset,
  createInMemoryWorksetStore,
  createInMemoryWorksetOwnedGuardedLedger,
  createWorksetGenericMutationGateway,
  createWorksetOwnedWriteGateway,
  InMemoryLedgerStore,
  WorksetOwnedLifecycleError,
  WorksetGenericMutationError,
  worksetMemberRefSet,
  readCanonicalOwnership,
  DEFECTS_LEDGER,
  IDEAS_LEDGER,
  GOALS_LEDGER,
  MILESTONES_AMBIENT_ID,
  TASKS_LEDGER,
  WORKSET_OWNER_REF_FIELD,
  type WorksetStore,
} from "../src/index.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("workset owned-write in-memory focused [T1962]", () => {
  it("child-ledger mismatch is rejected with zero mutation", async () => {
    const ledger = createInMemoryWorksetOwnedGuardedLedger();
    await ledger.init();
    const idea = await ledger.owned.createOwnerless({
      ledgerId: IDEAS_LEDGER,
      status: "open",
      fields: { title: "mismatch-idea" },
    });
    const before = ledger.fetch(TASKS_LEDGER).counters.item;
    try {
      await ledger.owned.createOwned({
        owner: { ledgerId: IDEAS_LEDGER, itemId: idea.id },
        creationKind: "idea-to-goal",
        child: {
          ledgerId: TASKS_LEDGER,
          status: "planned",
          fields: { headline: "wrong child ledger" },
        },
      });
      throw new Error("expected child-ledger-mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(WorksetOwnedLifecycleError);
      expect((error as WorksetOwnedLifecycleError).code).toBe("child-ledger-mismatch");
    }
    expect(ledger.fetch(TASKS_LEDGER).counters.item).toBe(before);
  });

  it("generic update still cannot forge ownership on an owned child", async () => {
    const ledger = createInMemoryWorksetOwnedGuardedLedger();
    await ledger.init();
    const idea = await ledger.owned.createOwnerless({
      ledgerId: IDEAS_LEDGER,
      status: "open",
      fields: { title: "seal-idea" },
    });
    const { child } = await ledger.owned.createOwned({
      owner: { ledgerId: IDEAS_LEDGER, itemId: idea.id },
      creationKind: "idea-to-goal",
      child: {
        ledgerId: GOALS_LEDGER,
        status: "clarifying",
        fields: { title: "sealed-goal", description: "x" },
      },
    });
    const before = readCanonicalOwnership(child);
    expect(before).not.toBeNull();
    try {
      await ledger.mutations.updateItem(GOALS_LEDGER, child.id, {
        fields: { [WORKSET_OWNER_REF_FIELD]: "ideas:I999" },
      });
      throw new Error("expected sealed-ownership denial");
    } catch (error) {
      expect(error).toBeInstanceOf(WorksetGenericMutationError);
      expect((error as WorksetGenericMutationError).code).toBe("sealed-ownership");
    }
    expect(readCanonicalOwnership(ledger.fetchItem(GOALS_LEDGER, child.id))).toEqual(
      before,
    );
  });

  it("owner-not-found yields zero mutation", async () => {
    const ledger = createInMemoryWorksetOwnedGuardedLedger();
    await ledger.init();
    const before = ledger.fetch(GOALS_LEDGER).counters.item;
    try {
      await ledger.owned.createOwned({
        owner: { ledgerId: IDEAS_LEDGER, itemId: "I99999" },
        creationKind: "idea-to-goal",
        child: {
          ledgerId: GOALS_LEDGER,
          status: "clarifying",
          fields: { title: "ghost", description: "x" },
        },
      });
      throw new Error("expected owner-not-found");
    } catch (error) {
      expect(error).toBeInstanceOf(WorksetOwnedLifecycleError);
      expect((error as WorksetOwnedLifecycleError).code).toBe("owner-not-found");
    }
    expect(ledger.fetch(GOALS_LEDGER).counters.item).toBe(before);
  });

  it("rejects a stale admission epoch before starting the ledger transaction", async () => {
    const rawStore = new InMemoryLedgerStore();
    await rawStore.init();
    const admittedStore = createInMemoryWorksetStore();
    const staleStore: WorksetStore = {
      snapshot: async () => {
        const snapshot = await admittedStore.snapshot();
        return { roots: snapshot.roots, epoch: snapshot.epoch + 1 };
      },
      setRoots: (roots) => admittedStore.setRoots(roots),
      admitLedgerMutation: (input) => admittedStore.admitLedgerMutation(input),
      admitExternalEffect: (input) => admittedStore.admitExternalEffect(input),
      runAdministrative: (input) => admittedStore.runAdministrative(input),
      activeAdmissionCount: () => admittedStore.activeAdmissionCount(),
      exclusiveHeld: () => admittedStore.exclusiveHeld(),
    };
    let transactionRuns = 0;
    const owned = createWorksetOwnedWriteGateway({
      rawStore,
      worksetStore: staleStore,
      runOwnedTransaction: async (mutate) => {
        transactionRuns += 1;
        return rawStore.runAtomicOwnedMutation(mutate);
      },
    });

    await expect(
      owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "stale-must-not-write" },
      }),
    ).rejects.toMatchObject({ code: "stale-epoch" });
    expect(transactionRuns).toBe(0);
    expect(rawStore.fetch(IDEAS_LEDGER).counters.item).toBe(0);
    expect(staleStore.activeAdmissionCount()).toBe(0);
  });

  it("revalidates owner membership inside the atomic ledger transaction", async () => {
    const rawStore = new InMemoryLedgerStore();
    await rawStore.init();
    const prerequisite = await rawStore.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
      status: "planned",
      fields: { headline: "prerequisite" },
    });
    const root = await rawStore.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
      status: "planned",
      fields: { headline: "root", dependsOn: [`${TASKS_LEDGER}:${prerequisite.id}`] },
    });
    const worksetStore = createInMemoryWorksetStore({
      isTargetAdmitted: (target, roots) => {
        const graph = closeWorkset(roots, buildActiveStateFromLedgerStore(rawStore));
        return worksetMemberRefSet(graph).has(target);
      },
    });
    await worksetStore.setRoots([`${TASKS_LEDGER}:${root.id}`]);
    const transactionReached = deferred();
    const releaseTransaction = deferred();
    const host = {
      rawStore,
      worksetStore,
      runOwnedTransaction: async <T>(
        mutate: Parameters<InMemoryLedgerStore["runAtomicOwnedMutation"]>[0],
      ): Promise<T> => {
        transactionReached.resolve();
        await releaseTransaction.promise;
        return rawStore.runAtomicOwnedMutation(mutate) as Promise<T>;
      },
    };
    const owned = createWorksetOwnedWriteGateway(host);
    const generic = createWorksetGenericMutationGateway(host);
    const creation = owned.createOwned({
      owner: { ledgerId: TASKS_LEDGER, itemId: prerequisite.id },
      creationKind: "implementation-defect",
      child: {
        ledgerId: DEFECTS_LEDGER,
        status: "open",
        fields: { headline: "must not escape", severity: "low" },
      },
    });
    await transactionReached.promise;
    await generic.updateItem(TASKS_LEDGER, root.id, { fields: { dependsOn: [] } });
    releaseTransaction.resolve();

    await expect(creation).rejects.toMatchObject({ code: "owner-excluded" });
    expect(rawStore.fetch(DEFECTS_LEDGER).counters.item).toBe(0);
  });

  it("rolls back authoritative rows and FTS backing together", async () => {
    const rawStore = new InMemoryLedgerStore();
    await rawStore.init();
    const item = await rawStore.createItem(IDEAS_LEDGER, MILESTONES_AMBIENT_ID, {
      status: "open",
      fields: { title: "preimageterm" },
    });
    await expect(
      rawStore.runAtomicOwnedMutation((tx) => {
        tx.updateItem(IDEAS_LEDGER, item.id, { fields: { title: "rolledbackterm" } });
        throw new Error("rollback-probe");
      }),
    ).rejects.toThrow("rollback-probe");

    expect(rawStore.fetchItem(IDEAS_LEDGER, item.id).fields.title).toBe("preimageterm");
    expect((await rawStore.ftsSearch("preimageterm")).map((hit) => hit.item.id)).toEqual([
      item.id,
    ]);
    expect(await rawStore.ftsSearch("rolledbackterm")).toEqual([]);
  });

  it("rejects bundle-only draft kinds on the single-child gateway", async () => {
    for (const [status, creationKind] of [
      ["planning", "active-current-draft"],
      ["planned", "finalized-manifest"],
    ] as const) {
      const ledger = createInMemoryWorksetOwnedGuardedLedger();
      await ledger.init();
      const goal = await ledger.owned.createOwnerless({
        ledgerId: GOALS_LEDGER,
        status,
        fields: { title: creationKind, description: "bundle required" },
      });
      const before = ledger.fetch(TASKS_LEDGER).counters.item;
      await expect(
        ledger.owned.createOwned({
          owner: { ledgerId: GOALS_LEDGER, itemId: goal.id },
          creationKind,
          child: {
            ledgerId: TASKS_LEDGER,
            status: "planned",
            fields: { headline: "incomplete draft" },
          },
        }),
      ).rejects.toMatchObject({ code: "bundle-incomplete" });
      expect(ledger.fetch(TASKS_LEDGER).counters.item).toBe(before);
    }
  });
});
