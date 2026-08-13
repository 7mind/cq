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
  const epoch = 7;
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
      let guardianShared = false;
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
        shareWithGuardian() {
          if (closed) throw new Error("closed");
          if (!registered) throw new Error("not registered");
          guardianShared = true;
        },
        async abandonBeforeRegistration() {
          if (closed) throw new Error("already released");
          if (registered) throw new Error("already registered");
          closed = true;
        },
        markSettled() {
          if (closed) throw new Error("closed");
          if (!registered || !guardianShared) throw new Error("guardian not shared");
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
    await session.registerProcessGroup({ pgid: 4242, leaderPid: 4242 });
    expect(session.stage).toBe("process-group-registered");
    await session.shareWithGuardian();
    session.releaseTarget();
    expect(session.stage).toBe("target-released");
    session.beginTermination("normal");
    expect(session.stage).toBe("terminating");
    await session.markSettled();
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
    await session.registerProcessGroup({ pgid: 9, leaderPid: 9 });
    await session.shareWithGuardian();
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

  it("refuses target release before the registered guardian shares admission", async () => {
    const provider = createRecordingProvider();
    const session = new WorksetEffectProtocolSession({
      provider,
      kind: "child-dispatch",
      targetRef: "tasks:T-guardian",
    });
    await session.acquireAdmission();
    await session.registerProcessGroup({ pgid: 10, leaderPid: 10 });
    expect(() => session.releaseTarget()).toThrow(WorksetEffectProtocolError);
    await session.shareWithGuardian();
    session.releaseTarget();
    expect(session.stage).toBe("target-released");
  });

  it("one session admits exactly one observable effect", async () => {
    const provider = createRecordingProvider();
    const session = new WorksetEffectProtocolSession({
      provider,
      kind: "worktree-create",
      targetRef: "tasks:T4",
    });
    await session.acquireAdmission();
    await session.registerProcessGroup({ pgid: 11, leaderPid: 11 });
    await session.shareWithGuardian();
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

  it("provider-backed session closes admission only after settle for parent-death", async () => {
    const provider = createRecordingProvider();
    const session = new WorksetEffectProtocolSession({
      provider,
      kind: "child-dispatch",
      targetRef: "tasks:T-race",
    });
    await session.acquireAdmission();
    await session.registerProcessGroup({ pgid: 77, leaderPid: 77 });
    await session.shareWithGuardian();
    session.releaseTarget();
    session.beginTermination("parent-death");
    await session.markSettled();
    await session.closeAdmission();
    expect(session.stage).toBe("admission-closed");
    expect(session.reason).toBe("parent-death");
    expect(provider.releases).toEqual(["prov-1"]);
  });
});
