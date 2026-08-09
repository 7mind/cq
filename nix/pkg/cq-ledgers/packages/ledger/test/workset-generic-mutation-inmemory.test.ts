/**
 * T1961 — in-memory dummy leg of the guarded generic-mutation dual-test pair.
 *
 * Runs the shared Behavioral-Active Blackbox contract against
 * {@link createInMemoryWorksetGuardedLedger}. Future durable legs bind the
 * same `runWorksetGenericMutationContract` factory without changing assertions.
 */

import { describe, expect, it } from "bun:test";
import {
  createInMemoryWorksetGuardedLedger,
  assertNoPublicRawWriteEscape,
  WorksetGenericMutationError,
  TASKS_LEDGER,
  WORKSET_OWNER_REF_FIELD,
} from "../src/index.js";
import { runWorksetGenericMutationContract } from "./worksetGenericMutationContract.js";

runWorksetGenericMutationContract({
  name: "in-memory-dummy",
  classification: "Behavioral-Active Blackbox-Atomic",
  build: (options) => createInMemoryWorksetGuardedLedger(options),
});

describe("workset generic-mutation in-memory focused [T1961]", () => {
  it("public surface freezes the gateway form and hides raw writes", async () => {
    const ledger = createInMemoryWorksetGuardedLedger();
    await ledger.init();
    assertNoPublicRawWriteEscape(ledger);
    expect(Object.isFrozen(ledger.mutations)).toBe(true);
    expect(ledger.mutations.form).toBe("workset-generic-mutation-gateway");
  });

  it("create under empty roots then restrictive deny leaves counters unchanged", async () => {
    const ledger = createInMemoryWorksetGuardedLedger();
    await ledger.init();
    const m = await ledger.mutations.createMilestone({ title: "counter-m" });
    const t = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
      status: "planned",
      fields: { headline: "counter-t" },
    });
    await ledger.setRoots([`${TASKS_LEDGER}:${t.id}`]);
    const before = ledger.fetch(TASKS_LEDGER).counters.item;
    try {
      await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "nope", [WORKSET_OWNER_REF_FIELD]: "goals:G1" },
      });
      throw new Error("expected denial");
    } catch (error) {
      // creation-denied fires before sealed-ownership on restrictive create
      expect(error).toBeInstanceOf(WorksetGenericMutationError);
      expect((error as WorksetGenericMutationError).code).toBe("creation-denied");
    }
    expect(ledger.fetch(TASKS_LEDGER).counters.item).toBe(before);
  });
});
