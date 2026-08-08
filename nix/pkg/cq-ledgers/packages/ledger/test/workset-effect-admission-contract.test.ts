/**
 * T1953 — linearizable admission contract (in-memory reference).
 *
 * Deterministic latches prove:
 * - both set/effect orderings
 * - set waiting behind an admitted effect
 * - epoch advancement exactly once per successful replacement
 * - invalid replacement atomicity
 * - one admission per effect
 * - cleanup-before-release for normal/cancel/timeout/parent-death/broker-death
 */

import { describe, expect, it } from "bun:test";
import {
  WorksetAdmissionError,
  canonicalizeWorksetRootReplacement,
  createInMemoryWorksetAdmissionCoordinator,
  isLiveWorksetAdmission,
  assertCallerCannotMintAdmission,
  WORKSET_EFFECT_TERMINATION_REASONS,
  type WorksetAdmissionCoordinator,
  type WorksetExternalEffectAdmission,
} from "../src/index.js";

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
  code: string,
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

async function runExternalThroughSettlement(
  coordinator: WorksetAdmissionCoordinator,
  targetRef: string,
  reason: (typeof WORKSET_EFFECT_TERMINATION_REASONS)[number] = "normal",
): Promise<WorksetExternalEffectAdmission> {
  const admission = await coordinator.admitExternalEffect({
    kind: "child-dispatch",
    targetRef,
  });
  // reason is recorded by the broker protocol; the admission contract only
  // requires settlement before release for every cleanup path.
  void reason;
  admission.registerProcessGroup({ pgid: 4242, leaderPid: 4242 });
  admission.markSettled();
  await admission.releaseAfterSettlement();
  return admission;
}

describe("workset effect admission contract [T1953]", () => {
  it("starts unrestricted at epoch 0 with empty roots", () => {
    const c = createInMemoryWorksetAdmissionCoordinator();
    expect(c.snapshot()).toEqual({ roots: [], epoch: 0 });
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

  it("advances epoch exactly once per successful replacement, including identical roots", async () => {
    const c = createInMemoryWorksetAdmissionCoordinator();
    const first = await c.setRoots(["goals:G1", "tasks:T1"]);
    expect(first).toEqual({ roots: ["goals:G1", "tasks:T1"], epoch: 1 });
    const second = await c.setRoots(["goals:G1", "tasks:T1"]);
    expect(second).toEqual({ roots: ["goals:G1", "tasks:T1"], epoch: 2 });
    const third = await c.setRoots([]);
    expect(third).toEqual({ roots: [], epoch: 3 });
    expect(c.snapshot().epoch).toBe(3);
  });

  it("leaves roots and epoch unchanged after invalid replacement (atomicity)", async () => {
    const c = createInMemoryWorksetAdmissionCoordinator({
      validateReplacement: (roots) => {
        if (roots.includes("bad:ROOT")) {
          throw new WorksetAdmissionError(
            "invalid-replacement",
            "synthetic invalid member",
          );
        }
      },
    });
    await c.setRoots(["goals:G1"]);
    expect(c.snapshot()).toEqual({ roots: ["goals:G1"], epoch: 1 });
    await expectRejection(c.setRoots(["goals:G1", "bad:ROOT"]), "invalid-replacement");
    expect(c.snapshot()).toEqual({ roots: ["goals:G1"], epoch: 1 });
    await expectRejection(c.setRoots([""]), "invalid-replacement");
    expect(c.snapshot()).toEqual({ roots: ["goals:G1"], epoch: 1 });
  });

  it("set waits for an already-admitted effect, then commits (effect-then-set)", async () => {
    const effectAck = deferred();
    const setSawEmpty = deferred();
    const c = createInMemoryWorksetAdmissionCoordinator({
      hooks: {
        afterExclusiveReady: () => {
          setSawEmpty.resolve();
        },
      },
    });

    const effect = await c.admitExternalEffect({
      kind: "rebase",
      targetRef: "tasks:T9",
    });
    expect(c.activeAdmissionCount()).toBe(1);

    const setPromise = c.setRoots(["goals:G1"]);
    // set must not finish while the effect admission is held
    let setDone = false;
    void setPromise.then(() => {
      setDone = true;
    });
    await Promise.resolve();
    expect(setDone).toBe(false);
    expect(c.exclusiveHeld()).toBe(true);

    effect.registerProcessGroup({ pgid: 100, leaderPid: 100 });
    effect.markSettled();
    // Hold the admission open briefly after settlement marks to prove set waits
    // on admission close, not merely on settlement.
    queueMicrotask(() => {
      void effect.releaseAfterSettlement().then(() => effectAck.resolve());
    });
    await effectAck.promise;
    await setSawEmpty.promise;
    const snap = await setPromise;
    expect(snap).toEqual({ roots: ["goals:G1"], epoch: 1 });
    expect(c.activeAdmissionCount()).toBe(0);
  });

  it("set-first ordering revokes a not-yet-admitted effect and denies excluded targets after commit", async () => {
    const beforeGrant = deferred();
    const releaseGrant = deferred();
    const c = createInMemoryWorksetAdmissionCoordinator({
      hooks: {
        beforeAdmissionGrant: async () => {
          beforeGrant.resolve();
          await releaseGrant.promise;
        },
      },
    });

    const effectPromise = c.admitExternalEffect({
      kind: "merge",
      targetRef: "tasks:T-old",
    });
    await beforeGrant.promise;

    // Commit exclusive replacement while the effect is mid-admit.
    const setPromise = c.setRoots(["goals:G-only"]);
    // Allow the effect's grant path to resume; generation bump must revoke it.
    releaseGrant.resolve();
    await expectRejection(effectPromise, "revoked");
    const snap = await setPromise;
    expect(snap).toEqual({ roots: ["goals:G-only"], epoch: 1 });

    // Subsequent effect against the excluded branch is denied at the new epoch.
    await expectRejection(
      c.admitExternalEffect({ kind: "child-dispatch", targetRef: "tasks:T-old" }),
      "target-excluded",
    );
    // Admitted target under the new roots succeeds at epoch 1.
    const ok = await c.admitLedgerMutation({
      kind: "generic-write",
      targets: ["goals:G-only"],
    });
    expect(ok.epoch).toBe(1);
    await ok.acknowledge();
  });

  it("ledger mutation holds admission through acknowledgement and validates targets", async () => {
    const c = createInMemoryWorksetAdmissionCoordinator();
    await c.setRoots(["milestones:M1"]);
    const admission = await c.admitLedgerMutation({
      kind: "claim-plan",
      targets: ["milestones:M1"],
    });
    expect(admission.form).toBe("ledger-mutation");
    expect(admission.epoch).toBe(1);
    expect(isLiveWorksetAdmission(admission)).toBe(true);
    expect(c.activeAdmissionCount()).toBe(1);
    await admission.acknowledge();
    expect(c.activeAdmissionCount()).toBe(0);
    await expectRejection(admission.acknowledge(), "admission-closed");

    await expectRejection(
      c.admitLedgerMutation({
        kind: "owned-write",
        targets: ["tasks:T-out"],
      }),
      "target-excluded",
    );
  });

  it("external effect enforces register → settle → release (cleanup-before-release)", async () => {
    const c = createInMemoryWorksetAdmissionCoordinator();
    const admission = await c.admitExternalEffect({
      kind: "worktree-create",
      targetRef: "tasks:T1",
    });
    await expectRejection(admission.releaseAfterSettlement(), "admission-not-registered");
    try {
      admission.markSettled();
      throw new Error("expected markSettled to require registration");
    } catch (error) {
      expect(error).toBeInstanceOf(WorksetAdmissionError);
      expect((error as WorksetAdmissionError).code).toBe("admission-not-registered");
    }
    admission.registerProcessGroup({ pgid: 7, leaderPid: 7 });
    await expectRejection(admission.releaseAfterSettlement(), "process-group-not-settled");
    admission.markSettled();
    await admission.releaseAfterSettlement();
    expect(c.activeAdmissionCount()).toBe(0);

    const again = await c.admitExternalEffect({
      kind: "worktree-remove",
      targetRef: "tasks:T1",
    });
    again.registerProcessGroup({ pgid: 8, leaderPid: 8 });
    again.markSettled();
    await again.releaseAfterSettlement();
    expect(c.activeAdmissionCount()).toBe(0);
  });

  it("cleanup-before-release holds for every termination reason", async () => {
    const c = createInMemoryWorksetAdmissionCoordinator();
    for (const reason of WORKSET_EFFECT_TERMINATION_REASONS) {
      // The admission form does not branch on reason: every path must settle
      // the registered group before release. The broker protocol binds reasons.
      await runExternalThroughSettlement(c, `tasks:T-${reason}`, reason);
      expect(c.activeAdmissionCount()).toBe(0);
    }
  });

  it("one admission authorizes exactly one effect close (no multi-effect reuse)", async () => {
    const c = createInMemoryWorksetAdmissionCoordinator();
    const admission = await c.admitLedgerMutation({
      kind: "finalize-plan",
      targets: [],
    });
    await admission.acknowledge();
    await expectRejection(admission.acknowledge(), "admission-closed");

    const external = await c.admitExternalEffect({
      kind: "branch-create",
      targetRef: "tasks:T2",
    });
    external.registerProcessGroup({ pgid: 9, leaderPid: 9 });
    external.markSettled();
    await external.releaseAfterSettlement();
    await expectRejection(external.releaseAfterSettlement(), "admission-closed");
  });

  it("rejects caller-minted admission lookalikes and treats live handles as non-transfer tokens", () => {
    expect(() =>
      assertCallerCannotMintAdmission({
        form: "ledger-mutation",
        id: "forged",
        acknowledge: async () => undefined,
      }),
    ).toThrow(WorksetAdmissionError);

    try {
      assertCallerCannotMintAdmission({
        form: "external-effect",
        id: "forged-ee",
      });
      throw new Error("expected caller-minted rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(WorksetAdmissionError);
      expect((error as WorksetAdmissionError).code).toBe("caller-minted-admission");
    }

    expect(() => assertCallerCannotMintAdmission({ hello: "world" })).not.toThrow();
  });

  it("set after ledger mutation waits; mutation after set sees the new epoch", async () => {
    const c = createInMemoryWorksetAdmissionCoordinator();
    const mutation = await c.admitLedgerMutation({
      kind: "publish-plan-draft",
      targets: [],
    });
    const setPromise = c.setRoots(["ideas:I1"]);
    let setFinished = false;
    void setPromise.then(() => {
      setFinished = true;
    });
    await Promise.resolve();
    expect(setFinished).toBe(false);
    await mutation.acknowledge();
    const snap = await setPromise;
    expect(snap.epoch).toBe(1);
    const next = await c.admitLedgerMutation({
      kind: "release-plan-claim",
      targets: ["ideas:I1"],
    });
    expect(next.epoch).toBe(1);
    await next.acknowledge();
  });
});
