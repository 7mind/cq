/**
 * T1953 — exclusive administrative admission.
 *
 * Administrative denial and race fixtures prove restore, reset, erase,
 * migrate, and reinitialization each:
 * - refuse without trusted management authority
 * - wait for an in-flight brokered effect before destroying
 * - cannot self-authorize excluded work (no interleaving under exclusive hold)
 */

import { describe, expect, it } from "bun:test";
import {
  WorksetAdmissionError,
  WORKSET_ADMINISTRATIVE_EFFECT_KINDS,
  createInMemoryWorksetAdmissionCoordinator,
  createTrustedWorksetManagementAuthority,
  isTrustedWorksetManagementAuthority,
  type WorksetAdministrativeEffectKind,
  type WorksetAdmissionErrorCode,
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

async function expectCode(
  promise: Promise<unknown>,
  code: WorksetAdmissionErrorCode,
): Promise<void> {
  try {
    await promise;
    throw new Error(`expected WorksetAdmissionError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(WorksetAdmissionError);
    expect((error as WorksetAdmissionError).code).toBe(code);
  }
}

describe("workset administrative admission [T1953]", () => {
  it("mints trusted management authority and rejects structural lookalikes", () => {
    const authority = createTrustedWorksetManagementAuthority();
    expect(isTrustedWorksetManagementAuthority(authority)).toBe(true);
    expect(isTrustedWorksetManagementAuthority({ brand: true })).toBe(false);
    expect(isTrustedWorksetManagementAuthority(null)).toBe(false);
    expect(isTrustedWorksetManagementAuthority("management")).toBe(false);
  });

  for (const kind of WORKSET_ADMINISTRATIVE_EFFECT_KINDS) {
    it(`${kind} refuses without trusted management authority`, async () => {
      const c = createInMemoryWorksetAdmissionCoordinator();
      let destroyed = false;
      await expectCode(
        c.runAdministrative({
          kind,
          authority: { forged: true },
          destructivePhase: () => {
            destroyed = true;
          },
        }),
        "management-authority-required",
      );
      expect(destroyed).toBe(false);
      expect(c.exclusiveHeld()).toBe(false);
    });
  }

  for (const kind of WORKSET_ADMINISTRATIVE_EFFECT_KINDS) {
    it(`${kind} waits for an in-flight brokered effect before the destructive phase`, async () => {
      const beforeDestructive = deferred();
      const c = createInMemoryWorksetAdmissionCoordinator({
        hooks: {
          beforeAdministrativeDestructive: () => {
            beforeDestructive.resolve();
          },
        },
      });
      const authority = createTrustedWorksetManagementAuthority();

      const effect = await c.admitExternalEffect({
        kind: "child-dispatch",
        targetRef: "tasks:T-live",
      });
      effect.registerProcessGroup({ pgid: 55, leaderPid: 55 });

      let destructiveRan = false;
      const adminPromise = c.runAdministrative({
        kind,
        authority,
        destructivePhase: () => {
          destructiveRan = true;
          // No in-flight admissions may remain when destruction runs.
          expect(c.activeAdmissionCount()).toBe(0);
        },
      });

      let adminDone = false;
      void adminPromise.then(() => {
        adminDone = true;
      });
      await Promise.resolve();
      expect(adminDone).toBe(false);
      expect(destructiveRan).toBe(false);
      expect(c.exclusiveHeld()).toBe(true);

      // Settlement alone is insufficient: admission must close.
      effect.markSettled();
      await Promise.resolve();
      expect(destructiveRan).toBe(false);

      await effect.releaseAfterSettlement();
      await beforeDestructive.promise;
      await adminPromise;
      expect(destructiveRan).toBe(true);
      expect(c.exclusiveHeld()).toBe(false);
    });
  }

  it("administrative exclusive hold prevents a concurrent effect from admitting mid-destruction", async () => {
    const releaseDestructive = deferred();
    const enteredDestructive = deferred();
    const c = createInMemoryWorksetAdmissionCoordinator();
    const authority = createTrustedWorksetManagementAuthority();

    const adminPromise = c.runAdministrative({
      kind: "reset",
      authority,
      destructivePhase: async () => {
        enteredDestructive.resolve();
        await releaseDestructive.promise;
      },
    });
    await enteredDestructive.promise;
    expect(c.exclusiveHeld()).toBe(true);

    const effectPromise = c.admitExternalEffect({
      kind: "merge",
      targetRef: "tasks:T-excluded",
    });
    let effectGranted = false;
    void effectPromise.then(
      () => {
        effectGranted = true;
      },
      () => undefined,
    );
    await Promise.resolve();
    expect(effectGranted).toBe(false);

    releaseDestructive.resolve();
    await adminPromise;
    // Exclusive administrative completion revokes every not-yet-admitted effect.
    await expectCode(effectPromise, "revoked");
    expect(effectGranted).toBe(false);

    // A fresh post-admin admission is required; no self-authorization of the
    // revoked attempt.
    const fresh = await c.admitExternalEffect({
      kind: "merge",
      targetRef: "tasks:T-excluded",
    });
    fresh.registerProcessGroup({ pgid: 1, leaderPid: 1 });
    fresh.markSettled();
    await fresh.releaseAfterSettlement();
  });

  it("cannot self-authorize excluded work: admin without authority never reaches the store phase", async () => {
    const c = createInMemoryWorksetAdmissionCoordinator();
    await c.setRoots(["goals:G-keep"]);
    const observations: string[] = [];

    for (const kind of WORKSET_ADMINISTRATIVE_EFFECT_KINDS as readonly WorksetAdministrativeEffectKind[]) {
      await expectCode(
        c.runAdministrative({
          kind,
          authority: { not: "trusted" },
          destructivePhase: () => {
            observations.push(kind);
          },
        }),
        "management-authority-required",
      );
    }
    expect(observations).toEqual([]);
    // Roots untouched by denied administrative attempts.
    expect(c.snapshot()).toEqual({ roots: ["goals:G-keep"], epoch: 1 });
  });

  it("trusted administrative path holds exclusive admission through completion", async () => {
    const c = createInMemoryWorksetAdmissionCoordinator();
    const authority = createTrustedWorksetManagementAuthority();
    const order: string[] = [];

    await c.runAdministrative({
      kind: "backend-migration",
      authority,
      destructivePhase: () => {
        order.push("destroy");
        expect(c.exclusiveHeld()).toBe(true);
        expect(c.activeAdmissionCount()).toBe(0);
      },
    });
    order.push("after");
    expect(c.exclusiveHeld()).toBe(false);
    expect(order).toEqual(["destroy", "after"]);
  });
});
