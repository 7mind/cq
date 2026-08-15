import { describe, expect, test } from "bun:test";
import {
  GOALS_LEDGER,
  MILESTONES_AMBIENT_ID,
  createInMemoryWorksetGuardedPlanLifecycleStore,
  createTrustedWorksetManagementAuthority,
  type WorksetGuardedPlanLifecycleStore,
} from "../src/index.js";

async function seedGoals(store: WorksetGuardedPlanLifecycleStore): Promise<void> {
  await store.init();
  for (const id of ["G1988", "G1989"] as const) {
    await store.owned.createOwnerless({
      ledgerId: GOALS_LEDGER,
      milestoneId: MILESTONES_AMBIENT_ID,
      id,
      status: "clarifying",
      fields: { title: id, description: id },
    });
  }
  await store.setRoots(["goals:G1988"]);
}

const CLAIM = {
  goalId: "G1988",
  purpose: "initial",
  claimRequestId: "t1988-race-claim",
  ownerFenceToken: "t1988-race-owner-00001",
  expectedGeneration: null,
  author: "T1988",
} as const;

describe("T1988 replacement/lifecycle t3 ordering [Behavioral-Active Blackbox-Atomic]", () => {
  test("set-first revokes a lifecycle admission waiting before grant with zero mutation", async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let armed = false;
    const store = createInMemoryWorksetGuardedPlanLifecycleStore({
      invocationAuthority: createTrustedWorksetManagementAuthority(),
      hooks: {
        beforeAdmissionGrant: async () => {
          if (!armed) return;
          entered.resolve();
          await resume.promise;
        },
      },
    });
    await seedGoals(store);
    try {
      const before = store.fetchItem(GOALS_LEDGER, "G1988");
      armed = true;
      const claim = store.claimPlan(CLAIM);
      await entered.promise;
      const replacement = store.setRoots(["goals:G1989"]);
      resume.resolve();
      const [result, roots] = await Promise.all([claim, replacement]);
      expect(result).toMatchObject({
        ok: false,
        conflict: { code: "workset-conflict", operation: "claim-plan", reason: "revoked" },
      });
      expect(roots.roots).toEqual(["goals:G1989"]);
      expect(store.fetchItem(GOALS_LEDGER, "G1988")).toEqual(before);
      expect(store.activeAdmissionCount()).toBe(0);
    } finally {
      await store.dispose();
    }
  });

  test("lifecycle-first retains admission through acknowledgement before replacement", async () => {
    const admitted = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let armed = false;
    const store = createInMemoryWorksetGuardedPlanLifecycleStore({
      invocationAuthority: createTrustedWorksetManagementAuthority(),
      afterPlanAdmit: async () => {
        if (!armed) return;
        admitted.resolve();
        await resume.promise;
      },
    });
    await seedGoals(store);
    try {
      armed = true;
      const claim = store.claimPlan({ ...CLAIM, claimRequestId: "t1988-held-claim" });
      await admitted.promise;
      let replacementSettled = false;
      const replacement = store.setRoots(["goals:G1989"]).then((value) => {
        replacementSettled = true;
        return value;
      });
      await Promise.resolve();
      expect(replacementSettled).toBe(false);
      expect(store.activeAdmissionCount()).toBe(1);
      resume.resolve();
      expect((await claim).ok).toBe(true);
      expect((await replacement).roots).toEqual(["goals:G1989"]);
      expect(store.activeAdmissionCount()).toBe(0);
    } finally {
      await store.dispose();
    }
  });
});
