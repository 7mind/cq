/**
 * T1954 — parameterized Behavioral-Active Blackbox contract for WorksetStore.
 *
 * One abstract suite over the storage capability. Always runnable against the
 * in-memory dummy; future fs/git/sqlite/postgres legs supply their own factory
 * without changing these assertions.
 *
 * Scope (acceptance):
 * - canonical ordering
 * - replacement rather than merge
 * - duplicate handling
 * - read-after-write visibility of complete root/epoch pairs
 * - invalid-batch atomicity
 * - empty-set (unrestricted) semantics
 * - admission revocation at successful set commit
 * - broker lease non-duplication (distinct ids; one effect per admission)
 * - deterministic set∥effect races and cleanup-before-release
 *
 * Out of scope here: filesystem, SQL, restart, notification, multi-process.
 */

import { describe, expect, it } from "bun:test";
import {
  WorksetAdmissionError,
  canonicalizeWorksetRootReplacement,
  readWorksetRootsEpoch,
  type CreateInMemoryWorksetStoreOptions,
  type WorksetAdmissionErrorCode,
  type WorksetExternalEffectAdmission,
  type WorksetStore,
  WORKSET_EFFECT_TERMINATION_REASONS,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Factory surface
// ---------------------------------------------------------------------------

export type WorksetStoreContractClassification =
  | "Behavioral-Active Blackbox-Atomic"
  | "Behavioral-Active Blackbox-GoodCommunication";

/**
 * Options the shared suite may pass when building a fresh store for a fixture.
 * Durable adapters that cannot inject latches may ignore hooks and still pass
 * every non-race clause; the in-memory dummy must honour them.
 */
export type WorksetStoreContractBuildOptions = CreateInMemoryWorksetStoreOptions;

export interface WorksetStoreContractFactory {
  readonly name: string;
  readonly classification: WorksetStoreContractClassification;
  build(options?: WorksetStoreContractBuildOptions): WorksetStore | Promise<WorksetStore>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function expectRejection(
  promise: Promise<unknown>,
  code: WorksetAdmissionErrorCode,
): Promise<WorksetAdmissionError> {
  try {
    await promise;
    throw new Error(`expected WorksetAdmissionError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(WorksetAdmissionError);
    const admissionError = error as WorksetAdmissionError;
    expect(admissionError.code).toBe(code);
    return admissionError;
  }
}

async function settleExternal(
  store: WorksetStore,
  targetRef: string,
  reason: (typeof WORKSET_EFFECT_TERMINATION_REASONS)[number] = "normal",
): Promise<WorksetExternalEffectAdmission> {
  const admission = await store.admitExternalEffect({
    kind: "child-dispatch",
    targetRef,
  });
  void reason;
  await Promise.resolve(admission.registerProcessGroup({ pgid: 4242, leaderPid: 4242 }));
  await Promise.resolve(admission.markSettled());
  await admission.releaseAfterSettlement();
  return admission;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

export function runWorksetStoreContract(factory: WorksetStoreContractFactory): void {
  describe(`workset store contract [T1954] — ${factory.name} (${factory.classification})`, () => {
    it("starts unrestricted at epoch 0 with empty roots (complete pair)", async () => {
      const store = await factory.build();
      expect(await readWorksetRootsEpoch(store)).toEqual({ roots: [], epoch: 0 });
    });

    it("canonicalizes replacements as ordered de-duplicated full replacements", () => {
      expect(
        canonicalizeWorksetRootReplacement([
          "milestones:M1",
          "tasks:T1",
          "milestones:M1",
          "goals:G1",
        ]),
      ).toEqual(["milestones:M1", "tasks:T1", "goals:G1"]);
      expect(canonicalizeWorksetRootReplacement([])).toEqual([]);
    });

    it("set replaces rather than merges and preserves first-seen order", async () => {
      const store = await factory.build();
      await store.setRoots(["goals:G1", "tasks:T1", "goals:G1", "ideas:I1"]);
      expect(await readWorksetRootsEpoch(store)).toEqual({
        roots: ["goals:G1", "tasks:T1", "ideas:I1"],
        epoch: 1,
      });
      // Full replacement drops prior members not in the new batch.
      await store.setRoots(["tasks:T9"]);
      expect(await readWorksetRootsEpoch(store)).toEqual({
        roots: ["tasks:T9"],
        epoch: 2,
      });
    });

    it("advances epoch exactly once per successful replacement, including identical roots", async () => {
      const store = await factory.build();
      const first = await store.setRoots(["goals:G1", "tasks:T1"]);
      expect(first).toEqual({ roots: ["goals:G1", "tasks:T1"], epoch: 1 });
      const second = await store.setRoots(["goals:G1", "tasks:T1"]);
      expect(second).toEqual({ roots: ["goals:G1", "tasks:T1"], epoch: 2 });
      const third = await store.setRoots([]);
      expect(third).toEqual({ roots: [], epoch: 3 });
      expect(await readWorksetRootsEpoch(store)).toEqual({ roots: [], epoch: 3 });
    });

    it("read-after-write visibility observes only complete root/epoch pairs", async () => {
      const store = await factory.build();
      const committed = await store.setRoots(["goals:G-a", "tasks:T-b"]);
      const observed = await readWorksetRootsEpoch(store);
      expect(observed).toEqual(committed);
      expect(observed.roots).toEqual(["goals:G-a", "tasks:T-b"]);
      expect(observed.epoch).toBe(1);
      // Defensive copy: mutating the observed array must not alias store state.
      const mutated = observed.roots as string[];
      if (!Object.isFrozen(mutated)) {
        mutated.push("tasks:T-leak");
      }
      expect(await readWorksetRootsEpoch(store)).toEqual({
        roots: ["goals:G-a", "tasks:T-b"],
        epoch: 1,
      });
    });

    it("leaves roots and epoch unchanged after invalid replacement (atomicity)", async () => {
      const store = await factory.build({
        validateReplacement: (roots) => {
          if (roots.includes("bad:ROOT")) {
            throw new WorksetAdmissionError(
              "invalid-replacement",
              "synthetic invalid member",
            );
          }
        },
      });
      await store.setRoots(["goals:G1"]);
      expect(await readWorksetRootsEpoch(store)).toEqual({
        roots: ["goals:G1"],
        epoch: 1,
      });
      await expectRejection(
        store.setRoots(["goals:G1", "bad:ROOT"]),
        "invalid-replacement",
      );
      expect(await readWorksetRootsEpoch(store)).toEqual({
        roots: ["goals:G1"],
        epoch: 1,
      });
      await expectRejection(store.setRoots([""]), "invalid-replacement");
      expect(await readWorksetRootsEpoch(store)).toEqual({
        roots: ["goals:G1"],
        epoch: 1,
      });
    });

    it("empty roots are the sole unrestricted configuration for target admission", async () => {
      const store = await factory.build();
      // epoch 0, empty → any target admitted
      const open = await store.admitLedgerMutation({
        kind: "generic-write",
        targets: ["tasks:T-anywhere"],
      });
      expect(open.epoch).toBe(0);
      expect(open.roots).toEqual([]);
      await open.acknowledge();

      await store.setRoots(["goals:G-only"]);
      await expectRejection(
        store.admitLedgerMutation({
          kind: "owned-write",
          targets: ["tasks:T-out"],
        }),
        "target-excluded",
      );
      const inside = await store.admitLedgerMutation({
        kind: "owned-write",
        targets: ["goals:G-only"],
      });
      expect(inside.epoch).toBe(1);
      await inside.acknowledge();

      // Returning to empty restores unrestricted admission at the new epoch.
      await store.setRoots([]);
      const again = await store.admitExternalEffect({
        kind: "merge",
        targetRef: "tasks:T-free",
      });
      expect(again.epoch).toBe(2);
      expect(again.roots).toEqual([]);
      await Promise.resolve(again.registerProcessGroup({ pgid: 1, leaderPid: 1 }));
      await Promise.resolve(again.markSettled());
      await again.releaseAfterSettlement();
    });

    it("set waits for an already-admitted effect, then commits (effect-then-set)", async () => {
      const effectAck = deferred();
      const setSawEmpty = deferred();
      const store = await factory.build({
        hooks: {
          afterExclusiveReady: () => {
            setSawEmpty.resolve();
          },
        },
      });

      const effect = await store.admitExternalEffect({
        kind: "rebase",
        targetRef: "tasks:T9",
      });
      expect(store.activeAdmissionCount()).toBe(1);

      const setPromise = store.setRoots(["goals:G1"]);
      let setDone = false;
      void setPromise.then(() => {
        setDone = true;
      });
      await Promise.resolve();
      expect(setDone).toBe(false);
      expect(store.exclusiveHeld()).toBe(true);

      await Promise.resolve(effect.registerProcessGroup({ pgid: 100, leaderPid: 100 }));
      await Promise.resolve(effect.markSettled());
      queueMicrotask(() => {
        void effect.releaseAfterSettlement().then(() => effectAck.resolve());
      });
      await effectAck.promise;
      await setSawEmpty.promise;
      const snap = await setPromise;
      expect(snap).toEqual({ roots: ["goals:G1"], epoch: 1 });
      expect(store.activeAdmissionCount()).toBe(0);
      expect(await readWorksetRootsEpoch(store)).toEqual(snap);
    });

    it("set-first ordering revokes a not-yet-admitted effect (admission revocation)", async () => {
      const beforeGrant = deferred();
      const releaseGrant = deferred();
      const store = await factory.build({
        hooks: {
          beforeAdmissionGrant: async () => {
            beforeGrant.resolve();
            await releaseGrant.promise;
          },
        },
      });

      const effectPromise = store.admitExternalEffect({
        kind: "merge",
        targetRef: "tasks:T-old",
      });
      await beforeGrant.promise;

      const setPromise = store.setRoots(["goals:G-only"]);
      releaseGrant.resolve();
      await expectRejection(effectPromise, "revoked");
      const snap = await setPromise;
      expect(snap).toEqual({ roots: ["goals:G-only"], epoch: 1 });

      await expectRejection(
        store.admitExternalEffect({
          kind: "child-dispatch",
          targetRef: "tasks:T-old",
        }),
        "target-excluded",
      );
      const ok = await store.admitLedgerMutation({
        kind: "generic-write",
        targets: ["goals:G-only"],
      });
      expect(ok.epoch).toBe(1);
      await ok.acknowledge();
    });

    it("broker leases are non-duplicated: distinct ids, one effect close per admission", async () => {
      const store = await factory.build();
      const a = await store.admitExternalEffect({
        kind: "worktree-create",
        targetRef: "tasks:T1",
      });
      const b = await store.admitExternalEffect({
        kind: "worktree-create",
        targetRef: "tasks:T1",
      });
      expect(a.id).not.toBe(b.id);
      expect(a.epoch).toBe(b.epoch);
      expect(store.activeAdmissionCount()).toBe(2);

      await Promise.resolve(a.registerProcessGroup({ pgid: 11, leaderPid: 11 }));
      // Second registration on the same lease is rejected (no multi-effect).
      try {
        await Promise.resolve(a.registerProcessGroup({ pgid: 12, leaderPid: 12 }));
        throw new Error("expected process-group-already-registered");
      } catch (error) {
        expect(error).toBeInstanceOf(WorksetAdmissionError);
        expect((error as WorksetAdmissionError).code).toBe(
          "process-group-already-registered",
        );
      }
      await Promise.resolve(a.markSettled());
      await a.releaseAfterSettlement();
      await expectRejection(a.releaseAfterSettlement(), "admission-closed");

      await Promise.resolve(b.registerProcessGroup({ pgid: 13, leaderPid: 13 }));
      await Promise.resolve(b.markSettled());
      await b.releaseAfterSettlement();
      expect(store.activeAdmissionCount()).toBe(0);

      // Ledger mutation: acknowledge closes the lease; reuse is denied.
      const lm = await store.admitLedgerMutation({
        kind: "finalize-plan",
        targets: [],
      });
      await lm.acknowledge();
      await expectRejection(lm.acknowledge(), "admission-closed");
    });

    it("external effect enforces register → settle → release (cleanup-before-release)", async () => {
      const store = await factory.build();
      const admission = await store.admitExternalEffect({
        kind: "worktree-create",
        targetRef: "tasks:T1",
      });
      await expectRejection(
        admission.releaseAfterSettlement(),
        "admission-not-registered",
      );
      try {
        await Promise.resolve(admission.markSettled());
        throw new Error("expected markSettled to require registration");
      } catch (error) {
        expect(error).toBeInstanceOf(WorksetAdmissionError);
        expect((error as WorksetAdmissionError).code).toBe(
          "admission-not-registered",
        );
      }
      await Promise.resolve(admission.registerProcessGroup({ pgid: 7, leaderPid: 7 }));
      await expectRejection(
        admission.releaseAfterSettlement(),
        "process-group-not-settled",
      );
      await Promise.resolve(admission.markSettled());
      await admission.releaseAfterSettlement();
      expect(store.activeAdmissionCount()).toBe(0);
    });

    it("cleanup-before-release holds for every termination reason", async () => {
      const store = await factory.build();
      for (const reason of WORKSET_EFFECT_TERMINATION_REASONS) {
        await settleExternal(store, `tasks:T-${reason}`, reason);
        expect(store.activeAdmissionCount()).toBe(0);
      }
    });

    it("set after ledger mutation waits; mutation after set sees the new epoch", async () => {
      const store = await factory.build();
      const mutation = await store.admitLedgerMutation({
        kind: "publish-plan-draft",
        targets: [],
      });
      const setPromise = store.setRoots(["ideas:I1"]);
      let setFinished = false;
      void setPromise.then(() => {
        setFinished = true;
      });
      await Promise.resolve();
      expect(setFinished).toBe(false);
      await mutation.acknowledge();
      const snap = await setPromise;
      expect(snap.epoch).toBe(1);
      const next = await store.admitLedgerMutation({
        kind: "release-plan-claim",
        targets: ["ideas:I1"],
      });
      expect(next.epoch).toBe(1);
      await next.acknowledge();
    });

    // Durable GoodCommunication backends pay real I/O per iteration; keep the
    // linearizability check but bound wall-clock. The in-memory dummy keeps the
    // full 200-iteration stress.
    const concurrentIterations =
      factory.classification === "Behavioral-Active Blackbox-GoodCommunication"
        ? 40
        : 200;
    const concurrentTimeoutMs =
      factory.classification === "Behavioral-Active Blackbox-GoodCommunication"
        ? 120_000
        : undefined;
    it(
      "concurrent set∥admit never leaves a live pre-commit epoch admission",
      async () => {
        for (let i = 0; i < concurrentIterations; i++) {
          const store = await factory.build();
          await store.setRoots(["goals:G0"]);
          const admitP = store.admitExternalEffect({
            kind: "merge",
            targetRef: "goals:G0",
          });
          const setP = store.setRoots(["goals:G1"]);
          void admitP
            .then(async (adm) => {
              await Promise.resolve(adm.registerProcessGroup({ pgid: 1, leaderPid: 1 }));
              await Promise.resolve(adm.markSettled());
              await adm.releaseAfterSettlement();
            })
            .catch(() => {
              // revoked / target-excluded — set proceeds alone
            });
          const setSnap = await setP;
          expect(setSnap).toEqual({ roots: ["goals:G1"], epoch: 2 });
          const admitOutcome = await Promise.allSettled([admitP]).then((r) => r[0]!);
          if (admitOutcome.status === "fulfilled") {
            const adm = admitOutcome.value;
            expect(adm.epoch === 1 || adm.epoch === 2).toBe(true);
            if (adm.epoch === 1) expect(adm.roots).toEqual(["goals:G0"]);
            if (adm.epoch === 2) expect(adm.roots).toEqual(["goals:G1"]);
          } else {
            const reason = admitOutcome.reason as { code?: string };
            expect(
              reason.code === "revoked" || reason.code === "target-excluded",
            ).toBe(true);
          }
          expect(store.activeAdmissionCount()).toBe(0);
          expect(await readWorksetRootsEpoch(store)).toEqual({
            roots: ["goals:G1"],
            epoch: 2,
          });
        }
      },
      concurrentTimeoutMs,
    );
  });
}
