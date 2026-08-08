/**
 * T1953 — workset external-effect broker protocol.
 *
 * Proves the stage machine, one-admission-per-effect rule, and
 * cleanup-before-release ordering for normal completion, cancellation,
 * timeout, parent death, and broker death — against an injected opaque
 * admission provider (no store internals).
 */

import { describe, expect, it } from "bun:test";
import {
  WORKSET_BROKER_EXTERNAL_EFFECT_KINDS,
  WORKSET_BROKER_TERMINATION_REASONS,
  WORKSET_EFFECT_BROKER_STAGES,
  WorksetEffectProtocolError,
  WorksetEffectProtocolSession,
  runWorksetEffectProtocol,
  type WorksetBrokerAdmissionHandle,
  type WorksetEffectAdmissionProvider,
} from "../src/worksetEffectProtocol.ts";

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

function createRecordingProvider(): WorksetEffectAdmissionProvider & {
  readonly releases: string[];
  readonly acquisitions: Array<{ kind: string; targetRef: string; epoch: number }>;
} {
  const releases: string[] = [];
  const acquisitions: Array<{ kind: string; targetRef: string; epoch: number }> = [];
  let nextId = 0;
  let epoch = 7;
  return {
    releases,
    acquisitions,
    async acquire(input): Promise<WorksetBrokerAdmissionHandle> {
      const id = `prov-${++nextId}`;
      const grantedEpoch = epoch;
      acquisitions.push({
        kind: input.kind,
        targetRef: input.targetRef,
        epoch: grantedEpoch,
      });
      let registered = false;
      let settled = false;
      let closed = false;
      return {
        id,
        epoch: grantedEpoch,
        kind: input.kind,
        targetRef: input.targetRef,
        registerProcessGroup(registration) {
          if (closed) throw new Error("closed");
          if (registration.pgid !== registration.leaderPid) {
            throw new Error("leader mismatch");
          }
          registered = true;
        },
        markSettled() {
          if (closed) throw new Error("closed");
          if (!registered) throw new Error("not registered");
          settled = true;
        },
        async releaseAfterSettlement() {
          if (closed) throw new Error("already released");
          if (!registered || !settled) {
            throw new Error("cleanup-before-release violated at provider");
          }
          closed = true;
          releases.push(id);
        },
      };
    },
  };
}

describe("workset effect protocol [T1953]", () => {
  it("seals broker external kinds, stages, and termination reasons", () => {
    expect([...WORKSET_BROKER_EXTERNAL_EFFECT_KINDS]).toEqual([
      "child-dispatch",
      "worktree-create",
      "worktree-remove",
      "branch-create",
      "branch-remove",
      "rebase",
      "merge",
    ]);
    expect([...WORKSET_EFFECT_BROKER_STAGES]).toEqual([
      "unacquired",
      "admission-held",
      "process-group-registered",
      "target-released",
      "terminating",
      "settled",
      "admission-closed",
    ]);
    expect([...WORKSET_BROKER_TERMINATION_REASONS]).toEqual([
      "normal",
      "cancel",
      "timeout",
      "parent-death",
      "broker-death",
    ]);
  });

  it("orders acquire → register → release-target → terminate → settle → close", async () => {
    const provider = createRecordingProvider();
    const session = new WorksetEffectProtocolSession({
      provider,
      kind: "child-dispatch",
      targetRef: "tasks:T1",
    });
    expect(session.stage).toBe("unacquired");
    await session.acquireAdmission();
    expect(session.stage).toBe("admission-held");
    expect(session.admissionId).toBe("prov-1");
    expect(session.admissionEpoch).toBe(7);
    session.registerProcessGroup({ pgid: 4242, leaderPid: 4242 });
    expect(session.stage).toBe("process-group-registered");
    session.releaseTarget();
    expect(session.stage).toBe("target-released");
    session.beginTermination("normal");
    expect(session.stage).toBe("terminating");
    session.markSettled();
    expect(session.stage).toBe("settled");
    await session.closeAdmission();
    expect(session.stage).toBe("admission-closed");
    expect(provider.releases).toEqual(["prov-1"]);
  });

  it("refuses to close admission before settlement (cleanup-before-release)", async () => {
    const provider = createRecordingProvider();
    const session = new WorksetEffectProtocolSession({
      provider,
      kind: "rebase",
      targetRef: "tasks:T2",
    });
    await session.acquireAdmission();
    session.registerProcessGroup({ pgid: 9, leaderPid: 9 });
    session.releaseTarget();
    try {
      await session.closeAdmission();
      throw new Error("expected settlement-required");
    } catch (error) {
      expect(error).toBeInstanceOf(WorksetEffectProtocolError);
      expect((error as WorksetEffectProtocolError).code).toBe("settlement-required");
    }
    expect(provider.releases).toEqual([]);
  });

  it("refuses target release before process-group registration", async () => {
    const provider = createRecordingProvider();
    const session = new WorksetEffectProtocolSession({
      provider,
      kind: "merge",
      targetRef: "tasks:T3",
    });
    await session.acquireAdmission();
    try {
      session.releaseTarget();
      throw new Error("expected illegal-stage-transition");
    } catch (error) {
      expect(error).toBeInstanceOf(WorksetEffectProtocolError);
      expect((error as WorksetEffectProtocolError).code).toBe(
        "illegal-stage-transition",
      );
    }
  });

  it("one session admits exactly one observable effect", async () => {
    const provider = createRecordingProvider();
    const session = new WorksetEffectProtocolSession({
      provider,
      kind: "worktree-create",
      targetRef: "tasks:T4",
    });
    await session.acquireAdmission();
    session.registerProcessGroup({ pgid: 11, leaderPid: 11 });
    session.releaseTarget();
    try {
      session.releaseTarget();
      throw new Error("expected illegal-stage-transition on second effect");
    } catch (error) {
      expect(error).toBeInstanceOf(WorksetEffectProtocolError);
      expect((error as WorksetEffectProtocolError).code).toBe(
        "illegal-stage-transition",
      );
    }
  });

  for (const reason of WORKSET_BROKER_TERMINATION_REASONS) {
    it(`cleanup-before-release for termination reason ${reason}`, async () => {
      const provider = createRecordingProvider();
      const launched = deferred();
      const settled = deferred();
      const result = await runWorksetEffectProtocol({
        provider,
        kind: "branch-remove",
        targetRef: `tasks:T-${reason}`,
        registration: { pgid: 1000, leaderPid: 1000 },
        launch: async () => {
          launched.resolve();
        },
        settle: async (observed) => {
          expect(observed).toBe(reason);
          settled.resolve();
        },
        reason,
      });
      await launched.promise;
      await settled.promise;
      expect(result.reason).toBe(reason);
      expect(result.admissionId).toBe("prov-1");
      expect(provider.releases).toEqual(["prov-1"]);
      expect(provider.acquisitions).toEqual([
        { kind: "branch-remove", targetRef: `tasks:T-${reason}`, epoch: 7 },
      ]);
    });
  }

  it("integrates with a coordinator-backed provider and proves set waits on broker release", async () => {
    // Late import keeps process-control free of a package dependency edge while
    // still exercising the provider surface against the ledger reference.
    const {
      createInMemoryWorksetAdmissionCoordinator,
    } = await import("../../ledger/src/worksetEffectAdmission.ts");

    const releaseEffect = deferred();
    const setReady = deferred();
    const coordinator = createInMemoryWorksetAdmissionCoordinator({
      hooks: {
        afterExclusiveReady: () => {
          setReady.resolve();
        },
      },
    });

    const provider: WorksetEffectAdmissionProvider = {
      async acquire(input) {
        const handle = await coordinator.admitExternalEffect(input);
        return {
          id: handle.id,
          epoch: handle.epoch,
          kind: handle.kind,
          targetRef: handle.targetRef,
          registerProcessGroup: (registration) => {
            handle.registerProcessGroup(registration);
          },
          markSettled: () => {
            handle.markSettled();
          },
          releaseAfterSettlement: () => handle.releaseAfterSettlement(),
        };
      },
    };

    const session = new WorksetEffectProtocolSession({
      provider,
      kind: "child-dispatch",
      targetRef: "tasks:T-race",
    });
    await session.acquireAdmission();
    session.registerProcessGroup({ pgid: 77, leaderPid: 77 });
    session.releaseTarget();

    const setPromise = coordinator.setRoots(["goals:G1"]);
    let setDone = false;
    void setPromise.then(() => {
      setDone = true;
    });
    await Promise.resolve();
    expect(setDone).toBe(false);

    // Terminate for parent-death; settlement then release unblocks set.
    session.beginTermination("parent-death");
    session.markSettled();
    queueMicrotask(() => {
      void session.closeAdmission().then(() => releaseEffect.resolve());
    });
    await releaseEffect.promise;
    await setReady.promise;
    const snap = await setPromise;
    expect(snap).toEqual({ roots: ["goals:G1"], epoch: 1 });
    expect(setDone).toBe(true);
    expect(coordinator.activeAdmissionCount()).toBe(0);
  });
});
