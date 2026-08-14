/** T1981: public MCP handlers preserve both workset/lifecycle linearizations. */

import { describe, expect, it } from "bun:test";
import {
  GOALS_LEDGER,
  InMemoryLedgerStore,
  MILESTONES_AMBIENT_ID,
  createInMemoryWorksetStore,
  createInMemoryWorksetGuardedPlanLifecycleStore,
  createLedgerMcpTools,
  createTrustedWorksetManagementAuthority,
  type WorksetAdmissionCoordinator,
} from "../src/index.js";
import type { InMemoryWorksetPlanLifecycleTx } from "../src/store/InMemoryLedgerStore.js";
import {
  EXCLUDED_CLAIM,
  textPayload,
} from "./worksetPlanLifecycleMcpSupport.js";
import { registerWorksetPlanLifecycleContract } from "./worksetPlanLifecycleContract.js";

async function seedStore(workset: WorksetAdmissionCoordinator): Promise<InMemoryLedgerStore> {
  const store = new InMemoryLedgerStore();
  await store.init();
  for (const goalId of ["G1", "G2"] as const) {
    await store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: goalId,
      status: "clarifying",
      fields: { title: goalId, description: `${goalId} description` },
      author: "t1981",
      session: "t1981-race",
    });
  }
  Object.defineProperty(store, "worksetStore", {
    configurable: true,
    value: () => workset,
  });
  await workset.setRoots(["goals:G1"]);
  return store;
}

function claimTool(
  store: InMemoryLedgerStore,
): ReturnType<typeof createLedgerMcpTools>[number] {
  const tool = createLedgerMcpTools(store).find(({ name }) => name === "claim_plan");
  if (tool === undefined) throw new Error("claim_plan tool not found");
  return tool;
}

describe("workset-guarded plan lifecycle — public MCP races [Behavioral-Active Blackbox-Atomic]", () => {
  it("set-first revokes a public claim waiting before admission grant", async () => {
    let reachedGrant!: () => void;
    let releaseGrant!: () => void;
    const atGrant = new Promise<void>((resolve) => {
      reachedGrant = resolve;
    });
    const continueGrant = new Promise<void>((resolve) => {
      releaseGrant = resolve;
    });
    const workset = createInMemoryWorksetStore({
      hooks: {
        beforeAdmissionGrant: async () => {
          reachedGrant();
          await continueGrant;
        },
      },
    });
    const store = await seedStore(workset);
    try {
      const invocation = claimTool(store).handler(EXCLUDED_CLAIM as never, null);
      await atGrant;
      const replacement = workset.setRoots(["goals:G2"]);
      releaseGrant();

      const [result, roots] = await Promise.all([invocation, replacement]);
      expect(JSON.parse(textPayload(result))).toMatchObject({
        ok: false,
        conflict: {
          code: "workset-conflict",
          operation: "claim-plan",
          reason: "revoked",
        },
      });
      expect(roots.roots).toEqual(["goals:G2"]);
      expect(store.fetchItem(GOALS_LEDGER, "G1").status).toBe("clarifying");
      expect(workset.activeAdmissionCount()).toBe(0);
    } finally {
      await store.dispose();
    }
  });

  it("lifecycle-first holds replacement through transaction and acknowledgement", async () => {
    let reachedTransaction!: () => void;
    let releaseTransaction!: () => void;
    const atTransaction = new Promise<void>((resolve) => {
      reachedTransaction = resolve;
    });
    const continueTransaction = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    const workset = createInMemoryWorksetStore();
    const store = await seedStore(workset);
    const runTransaction = store.runAtomicWorksetPlanLifecycleMutation.bind(store);
    Object.defineProperty(store, "runAtomicWorksetPlanLifecycleMutation", {
      configurable: true,
      value: async <T>(
        goalId: string,
        mutate: (tx: InMemoryWorksetPlanLifecycleTx) => T,
      ): Promise<T> => {
        reachedTransaction();
        await continueTransaction;
        return await runTransaction(goalId, mutate);
      },
    });

    try {
      const invocation = claimTool(store).handler(EXCLUDED_CLAIM as never, null);
      await atTransaction;
      let replacementSettled = false;
      const replacement = workset.setRoots(["goals:G2"]).then((result) => {
        replacementSettled = true;
        return result;
      });
      await Promise.resolve();
      expect(replacementSettled).toBe(false);
      expect(workset.activeAdmissionCount()).toBe(1);

      releaseTransaction();
      const result = await invocation;
      expect(JSON.parse(textPayload(result))).toMatchObject({ ok: true });
      expect((await replacement).roots).toEqual(["goals:G2"]);
      expect(store.fetchItem(GOALS_LEDGER, "G1").status).toBe("planning");
      expect(workset.activeAdmissionCount()).toBe(0);
    } finally {
      await store.dispose();
    }
  });
});

registerWorksetPlanLifecycleContract({
  name: "T1981 in-memory adapter boundary",
  build: async (options = {}) =>
    createInMemoryWorksetGuardedPlanLifecycleStore({
      invocationAuthority: createTrustedWorksetManagementAuthority(),
      ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.afterPlanAdmit === undefined
        ? {}
        : { afterPlanAdmit: options.afterPlanAdmit }),
    }),
});
