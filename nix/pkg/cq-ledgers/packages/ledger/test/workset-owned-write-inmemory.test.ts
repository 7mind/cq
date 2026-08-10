/**
 * T1962 — in-memory dummy leg of the owner-scoped lifecycle write dual-test pair.
 *
 * Focused cases beyond the shared Blackbox contract: child-ledger mismatch,
 * admission kind stability, and generic sealed-ownership still rejected.
 */

import { describe, expect, it } from "bun:test";
import {
  createInMemoryWorksetOwnedGuardedLedger,
  WorksetOwnedLifecycleError,
  WorksetGenericMutationError,
  readCanonicalOwnership,
  IDEAS_LEDGER,
  GOALS_LEDGER,
  TASKS_LEDGER,
  WORKSET_OWNER_REF_FIELD,
} from "../src/index.js";

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
});
