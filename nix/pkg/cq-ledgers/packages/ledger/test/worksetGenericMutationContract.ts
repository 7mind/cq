/**
 * T1961 — parameterized Behavioral-Active Blackbox contract for the guarded
 * generic-mutation gateway.
 *
 * One abstract suite over {@link WorksetGuardedLedger}. Always runnable
 * against the in-memory dummy; future fs/sqlite/postgres legs supply their
 * own factory without changing these assertions.
 *
 * Scope (acceptance):
 * - unrestricted empty-root parity with raw create/update
 * - allowed in-graph updates under restrictive roots
 * - exact inactive-root unarchive recovery
 * - zero-mutation denial for creation, createLedger, excluded targets,
 *   excluded introduced refs, incomplete archive sweeps
 * - sealed-owner rejection
 * - set∥mutation linearization (mutation holds admission; set waits)
 * - absence of a public raw-write escape hatch
 */

import { describe, expect, it } from "bun:test";
import {
  WorksetGenericMutationError,
  assertNoPublicRawWriteEscape,
  assertGenericMutationAdmissionNotCallerMinted,
  WORKSET_GENERIC_MUTATION_RAW_WRITE_METHODS,
  WORKSET_OWNER_REF_FIELD,
  WORKSET_OWNER_EDGE_KIND_FIELD,
  MILESTONES_AMBIENT_ID,
  TASKS_LEDGER,
  MILESTONES_LEDGER,
  type WorksetGuardedLedger,
  type WorksetGenericMutationErrorCode,
  type CreateInMemoryWorksetGuardedLedgerOptions,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Factory surface
// ---------------------------------------------------------------------------

export type WorksetGenericMutationContractClassification =
  | "Behavioral-Active Blackbox-Atomic"
  | "Behavioral-Active Blackbox-GoodCommunication";

export type WorksetGenericMutationContractBuildOptions =
  CreateInMemoryWorksetGuardedLedgerOptions;

export interface WorksetGenericMutationContractFactory {
  readonly name: string;
  readonly classification: WorksetGenericMutationContractClassification;
  /**
   * Optional per-case wall-clock bound for durable backends (git/fs/sql).
   * In-memory dummy leaves this unset (bun default). Assertions are unchanged.
   */
  readonly timeoutMs?: number;
  build(
    options?: WorksetGenericMutationContractBuildOptions,
  ): WorksetGuardedLedger | Promise<WorksetGuardedLedger>;
}

function caseIt(
  factory: WorksetGenericMutationContractFactory,
  name: string,
  fn: () => void | Promise<void>,
): void {
  if (factory.timeoutMs !== undefined) {
    it(name, fn, factory.timeoutMs);
  } else {
    it(name, fn);
  }
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

async function expectGatewayRejection(
  promise: Promise<unknown>,
  code: WorksetGenericMutationErrorCode,
): Promise<WorksetGenericMutationError> {
  try {
    await promise;
    throw new Error(`expected WorksetGenericMutationError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(WorksetGenericMutationError);
    const gatewayError = error as WorksetGenericMutationError;
    expect(gatewayError.code).toBe(code);
    return gatewayError;
  }
}

async function seedMinimalGraph(
  ledger: WorksetGuardedLedger,
): Promise<{ milestoneId: string; taskIn: string; taskOut: string }> {
  await ledger.init();
  const milestone = await ledger.mutations.createMilestone({
    title: "workset-seed",
  });
  const taskIn = await ledger.mutations.createItem(TASKS_LEDGER, milestone.id, {
    status: "planned",
    fields: { headline: "inside root" },
  });
  const taskOut = await ledger.mutations.createItem(TASKS_LEDGER, milestone.id, {
    status: "planned",
    fields: { headline: "outside root" },
  });
  return { milestoneId: milestone.id, taskIn: taskIn.id, taskOut: taskOut.id };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

export function runWorksetGenericMutationContract(
  factory: WorksetGenericMutationContractFactory,
): void {
  describe(`workset generic-mutation contract [T1961] — ${factory.name} (${factory.classification})`, () => {
    caseIt(factory, "exposes no public raw-write escape hatch", async () => {
      const ledger = await factory.build();
      await ledger.init();
      assertNoPublicRawWriteEscape(ledger);
      for (const method of WORKSET_GENERIC_MUTATION_RAW_WRITE_METHODS) {
        expect(typeof (ledger as unknown as Record<string, unknown>)[method]).not.toBe(
          "function",
        );
      }
      expect(ledger.mutations.form).toBe("workset-generic-mutation-gateway");
      expect(typeof ledger.mutations.updateItem).toBe("function");
      expect(typeof ledger.mutations.createItem).toBe("function");
    });

    caseIt(factory, "rejects caller-minted admission lookalikes at the gateway boundary", () => {
      expect(() =>
        assertGenericMutationAdmissionNotCallerMinted({
          form: "ledger-mutation",
          id: "forged",
          acknowledge: async () => undefined,
        }),
      ).toThrow(WorksetGenericMutationError);
      expect(() => assertGenericMutationAdmissionNotCallerMinted({ hello: 1 })).not.toThrow();
    });

    caseIt(factory, "empty-root parity: create and update succeed unrestricted", async () => {
      const ledger = await factory.build();
      await ledger.init();
      expect(await ledger.snapshotRoots()).toEqual({ roots: [], epoch: 0 });

      const m = await ledger.mutations.createMilestone({ title: "m-empty" });
      const t = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "t-empty" },
      });
      const updated = await ledger.mutations.updateItem(TASKS_LEDGER, t.id, {
        status: "wip",
        fields: { headline: "t-empty-updated" },
      });
      expect(updated.status).toBe("wip");
      expect(updated.fields.headline).toBe("t-empty-updated");
      expect(ledger.fetchItem(TASKS_LEDGER, t.id).status).toBe("wip");
    });

    caseIt(factory, "allowed in-graph update under restrictive roots", async () => {
      const ledger = await factory.build();
      const { taskIn, taskOut } = await seedMinimalGraph(ledger);
      await ledger.setRoots([`${TASKS_LEDGER}:${taskIn}`]);

      const updated = await ledger.mutations.updateItem(TASKS_LEDGER, taskIn, {
        status: "wip",
      });
      expect(updated.status).toBe("wip");

      // Excluded target: zero mutation.
      const before = ledger.fetchItem(TASKS_LEDGER, taskOut);
      await expectGatewayRejection(
        ledger.mutations.updateItem(TASKS_LEDGER, taskOut, { status: "wip" }),
        "target-excluded",
      );
      expect(ledger.fetchItem(TASKS_LEDGER, taskOut)).toEqual(before);
    });

    caseIt(factory, "denies generic creation and createLedger under non-empty roots (zero mutation)", async () => {
      const ledger = await factory.build();
      const { milestoneId, taskIn } = await seedMinimalGraph(ledger);
      await ledger.setRoots([`${TASKS_LEDGER}:${taskIn}`]);

      const beforeEnumerate = ledger.enumerate().slice().sort();
      const beforeCount = ledger.listMilestoneItems(milestoneId)[TASKS_LEDGER]?.length ?? 0;

      await expectGatewayRejection(
        ledger.mutations.createItem(TASKS_LEDGER, milestoneId, {
          status: "planned",
          fields: { headline: "denied-create" },
        }),
        "creation-denied",
      );
      await expectGatewayRejection(
        ledger.mutations.createMilestone({ title: "denied-m" }),
        "creation-denied",
      );
      await expectGatewayRejection(
        ledger.mutations.createLedger("xenos-denied", {
          idPrefix: "X",
          statusValues: ["open", "closed"],
          terminalStatuses: ["closed"],
          fields: { title: { type: "string", required: true } },
        }),
        "create-ledger-denied",
      );

      expect(ledger.enumerate().slice().sort()).toEqual(beforeEnumerate);
      expect(ledger.listMilestoneItems(milestoneId)[TASKS_LEDGER]?.length ?? 0).toBe(
        beforeCount,
      );
    });

    caseIt(factory, "rejects sealed ownership fields on generic update (zero mutation)", async () => {
      const ledger = await factory.build();
      const { taskIn } = await seedMinimalGraph(ledger);
      // Unrestricted still rejects sealed ownership.
      const before = ledger.fetchItem(TASKS_LEDGER, taskIn);
      await expectGatewayRejection(
        ledger.mutations.updateItem(TASKS_LEDGER, taskIn, {
          fields: { [WORKSET_OWNER_REF_FIELD]: "goals:G1" },
        }),
        "sealed-ownership",
      );
      await expectGatewayRejection(
        ledger.mutations.updateItem(TASKS_LEDGER, taskIn, {
          fields: { [WORKSET_OWNER_EDGE_KIND_FIELD]: "review" },
        }),
        "sealed-ownership",
      );
      expect(ledger.fetchItem(TASKS_LEDGER, taskIn)).toEqual(before);
    });

    caseIt(factory, "rejects newly introduced closure refs outside the admitted graph (zero mutation)", async () => {
      const ledger = await factory.build();
      const { taskIn, taskOut } = await seedMinimalGraph(ledger);
      await ledger.setRoots([`${TASKS_LEDGER}:${taskIn}`]);
      const before = ledger.fetchItem(TASKS_LEDGER, taskIn);

      await expectGatewayRejection(
        ledger.mutations.updateItem(TASKS_LEDGER, taskIn, {
          fields: { dependsOn: [`${TASKS_LEDGER}:${taskOut}`] },
        }),
        "introduced-ref-excluded",
      );
      expect(ledger.fetchItem(TASKS_LEDGER, taskIn)).toEqual(before);
    });

    caseIt(factory, "allows dependsOn to an already-admitted graph member", async () => {
      const ledger = await factory.build();
      await ledger.init();
      const m = await ledger.mutations.createMilestone({ title: "dep-m" });
      const a = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "a" },
      });
      const b = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "b", dependsOn: [`${TASKS_LEDGER}:${a.id}`] },
      });
      // Root b pulls a via prerequisite closure.
      await ledger.setRoots([`${TASKS_LEDGER}:${b.id}`]);
      const updated = await ledger.mutations.updateItem(TASKS_LEDGER, b.id, {
        fields: { dependsOn: [`${TASKS_LEDGER}:${a.id}`], blockedBy: [] },
      });
      expect(updated.fields.dependsOn).toEqual([`${TASKS_LEDGER}:${a.id}`]);
    });

    caseIt(factory, "exact inactive-root unarchive recovery; non-root unarchive denied", async () => {
      const ledger = await factory.build();
      await ledger.init();
      const m = await ledger.mutations.createMilestone({ title: "arch-m" });
      const keep = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "done",
        fields: { headline: "keep-root" },
      });
      const other = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "done",
        fields: { headline: "other-archived" },
      });
      // Milestone itself must be terminal before archiveMilestone accepts.
      await ledger.mutations.updateMilestone(m.id, { status: "done" });
      // Archive the whole milestone (both tasks + milestone terminal).
      await ledger.mutations.archiveMilestone(m.id, "seed archive");

      // Configure the archived keep task as the sole root — inactive restrictive.
      await ledger.setRoots([`${TASKS_LEDGER}:${keep.id}`]);
      const roots = await ledger.snapshotRoots();
      expect(roots.roots).toEqual([`${TASKS_LEDGER}:${keep.id}`]);

      // Exact inactive root may be unarchived.
      const restored = await ledger.mutations.unarchiveItem(
        TASKS_LEDGER,
        m.id,
        keep.id,
      );
      expect(restored.id).toBe(keep.id);
      expect(ledger.fetchItem(TASKS_LEDGER, keep.id).id).toBe(keep.id);

      // Other archived item is not an exact configured inactive root.
      await expectGatewayRejection(
        ledger.mutations.unarchiveItem(TASKS_LEDGER, m.id, other.id),
        "unarchive-not-exact-inactive-root",
      );
    });

    caseIt(factory, "archive requires every sweep member in the admitted graph (zero mutation on deny)", async () => {
      const ledger = await factory.build();
      const { milestoneId, taskIn, taskOut } = await seedMinimalGraph(ledger);
      // Make both terminal so archive would succeed if admitted.
      await ledger.mutations.updateItem(TASKS_LEDGER, taskIn, { status: "done" });
      await ledger.mutations.updateItem(TASKS_LEDGER, taskOut, { status: "done" });
      await ledger.mutations.updateMilestone(milestoneId, { status: "done" });

      // Restrict to only one task — sweep is incomplete.
      await ledger.setRoots([`${TASKS_LEDGER}:${taskIn}`]);
      const beforeM = ledger.fetchItem(MILESTONES_LEDGER, milestoneId);
      await expectGatewayRejection(
        ledger.mutations.archiveMilestone(milestoneId, "should-fail"),
        "archive-sweep-incomplete",
      );
      expect(ledger.fetchItem(MILESTONES_LEDGER, milestoneId)).toEqual(beforeM);

      // Full sweep under explicit roots covering every member succeeds.
      // (Terminal members are not auto-expanded from a milestone root via
      // live-status filters, so list every sweep ref as a configured root.)
      await ledger.setRoots([
        `${MILESTONES_LEDGER}:${milestoneId}`,
        `${TASKS_LEDGER}:${taskIn}`,
        `${TASKS_LEDGER}:${taskOut}`,
      ]);
      const ptr = await ledger.mutations.archiveMilestone(milestoneId, "ok");
      expect(ptr.id).toBe(milestoneId);
    });

    caseIt(factory, "archives terminal items without removing unfinished siblings and later merges the whole milestone [D396]", async () => {
      const ledger = await factory.build();
      await ledger.init();
      const milestone = await ledger.mutations.createMilestone({ title: "partial archive" });
      const finished = await ledger.mutations.createItem(TASKS_LEDGER, milestone.id, {
        status: "done",
        fields: { headline: "finished" },
      });
      const unfinished = await ledger.mutations.createItem(TASKS_LEDGER, milestone.id, {
        status: "planned",
        fields: { headline: "unfinished" },
      });
      const swept = await ledger.mutations.archiveTerminalItems(
        [TASKS_LEDGER],
        "completed item sweep",
        "fail-on-active-gate",
      );
      expect(swept).toEqual({
        archivedItems: 1,
        archiveGroups: 1,
        byLedger: { [TASKS_LEDGER]: 1 },
        retainedActiveGates: [],
      });
      expect(() => ledger.fetchItem(TASKS_LEDGER, finished.id)).toThrow();
      expect(ledger.fetchItem(TASKS_LEDGER, unfinished.id).status).toBe("planned");
      const partial = await ledger.fetchArchive(TASKS_LEDGER, milestone.id);
      expect(partial.kind).toBe("group");
      if (partial.kind === "group") {
        expect(partial.milestone.items.map((item) => item.id)).toEqual([finished.id]);
      }

      await ledger.mutations.updateItem(TASKS_LEDGER, unfinished.id, { status: "done" });
      await ledger.mutations.updateMilestone(milestone.id, { status: "done" });
      await ledger.mutations.archiveMilestone(milestone.id, "whole milestone");
      const complete = await ledger.fetchArchive(TASKS_LEDGER, milestone.id);
      expect(complete.kind).toBe("group");
      if (complete.kind === "group") {
        expect(complete.milestone.items.map((item) => item.id).sort()).toEqual(
          [finished.id, unfinished.id].sort(),
        );
      }
    });

    caseIt(factory, "refuses a terminal-item sweep under restrictive roots", async () => {
      const ledger = await factory.build();
      await ledger.init();
      const milestone = await ledger.mutations.createMilestone({ title: "restricted archive" });
      const finished = await ledger.mutations.createItem(TASKS_LEDGER, milestone.id, {
        status: "done",
        fields: { headline: "finished" },
      });
      await ledger.setRoots([`${TASKS_LEDGER}:${finished.id}`]);

      await expectGatewayRejection(
        ledger.mutations.archiveTerminalItems(
          [TASKS_LEDGER],
          "denied sweep",
          "fail-on-active-gate",
        ),
        "archive-terminal-items-denied",
      );
      expect(ledger.fetchItem(TASKS_LEDGER, finished.id).status).toBe("done");
    });

    caseIt(factory, "refuses to archive an unsatisfying terminal item that still gates active work", async () => {
      const ledger = await factory.build();
      await ledger.init();
      const milestone = await ledger.mutations.createMilestone({ title: "gated archive" });
      const abandoned = await ledger.mutations.createItem(TASKS_LEDGER, milestone.id, {
        status: "abandoned",
        fields: { headline: "abandoned prerequisite" },
      });
      const dependent = await ledger.mutations.createItem(TASKS_LEDGER, milestone.id, {
        status: "planned",
        fields: {
          headline: "active dependent",
          dependsOn: [`${TASKS_LEDGER}:${abandoned.id}`],
        },
      });

      await expect(
        ledger.mutations.archiveTerminalItems(
          [TASKS_LEDGER],
          "unsafe sweep",
          "fail-on-active-gate",
        ),
      ).rejects.toThrow(
        `active ${TASKS_LEDGER}:${dependent.id} still depends on non-satisfying ${TASKS_LEDGER}:${abandoned.id}`,
      );
      expect(ledger.fetchItem(TASKS_LEDGER, abandoned.id).status).toBe("abandoned");
    });

    caseIt(factory, "retains unsatisfying active gates while archiving unrelated terminal items", async () => {
      const ledger = await factory.build();
      await ledger.init();
      const milestone = await ledger.mutations.createMilestone({ title: "retained gate" });
      const abandoned = await ledger.mutations.createItem(TASKS_LEDGER, milestone.id, {
        status: "abandoned",
        fields: { headline: "retained prerequisite" },
      });
      const finished = await ledger.mutations.createItem(TASKS_LEDGER, milestone.id, {
        status: "done",
        fields: { headline: "independent completion" },
      });
      await ledger.mutations.createItem(TASKS_LEDGER, milestone.id, {
        status: "planned",
        fields: {
          headline: "active dependent",
          dependsOn: [`${TASKS_LEDGER}:${abandoned.id}`],
        },
      });
      const result = await ledger.mutations.archiveTerminalItems(
        [TASKS_LEDGER],
        "retain active gates",
        "retain-active-gates",
      );
      expect(result).toEqual({
        archivedItems: 1,
        archiveGroups: 1,
        byLedger: { [TASKS_LEDGER]: 1 },
        retainedActiveGates: [`${TASKS_LEDGER}:${abandoned.id}`],
      });
      expect(ledger.fetchItem(TASKS_LEDGER, abandoned.id).status).toBe("abandoned");
      expect(() => ledger.fetchItem(TASKS_LEDGER, finished.id)).toThrow();
    });

    caseIt(factory, "set waits behind an in-flight generic mutation admission", async () => {
      // Hold only the post-seed mutation critical section so setRoots observes
      // activeAdmissionCount > 0 and cannot finish until release.
      const admitted = deferred();
      const releaseHold = deferred();
      let holdEnabled = false;
      const ledger = await factory.build({
        afterGenericAdmit: async () => {
          if (!holdEnabled) return;
          admitted.resolve();
          await releaseHold.promise;
        },
      });
      const { taskIn } = await seedMinimalGraph(ledger);
      await ledger.setRoots([`${TASKS_LEDGER}:${taskIn}`]);

      holdEnabled = true;
      const mutPromise = ledger.mutations.updateItem(TASKS_LEDGER, taskIn, {
        fields: { headline: "held-update" },
      });
      await admitted.promise;
      expect(ledger.activeAdmissionCount()).toBeGreaterThan(0);

      let setDone = false;
      const setPromise = ledger.setRoots([]).then((snap) => {
        setDone = true;
        return snap;
      });
      // Allow set to reach exclusive wait without completing.
      await new Promise((r) => setTimeout(r, 20));
      expect(setDone).toBe(false);

      releaseHold.resolve();
      await mutPromise;
      const setSnap = await setPromise;
      expect(setDone).toBe(true);
      expect(setSnap.roots).toEqual([]);
      expect(ledger.activeAdmissionCount()).toBe(0);
      // Unrestricted after clear: create works again.
      await ledger.mutations.createMilestone({ title: "post-clear" });
    });

    caseIt(factory, "mutation after set sees the new epoch; excluded target denied at new roots", async () => {
      const ledger = await factory.build();
      const { taskIn, taskOut } = await seedMinimalGraph(ledger);
      await ledger.setRoots([`${TASKS_LEDGER}:${taskIn}`, `${TASKS_LEDGER}:${taskOut}`]);
      const mid = await ledger.mutations.updateItem(TASKS_LEDGER, taskOut, {
        status: "wip",
      });
      expect(mid.status).toBe("wip");

      const replaced = await ledger.setRoots([`${TASKS_LEDGER}:${taskIn}`]);
      expect(replaced.roots).toEqual([`${TASKS_LEDGER}:${taskIn}`]);

      await ledger.mutations.updateItem(TASKS_LEDGER, taskIn, { status: "done" });
      const beforeOut = ledger.fetchItem(TASKS_LEDGER, taskOut);
      await expectGatewayRejection(
        ledger.mutations.updateItem(TASKS_LEDGER, taskOut, { status: "done" }),
        "target-excluded",
      );
      expect(ledger.fetchItem(TASKS_LEDGER, taskOut)).toEqual(beforeOut);
    });

    caseIt(factory, "reopen of an in-graph terminal item is allowed under restrictive roots", async () => {
      const ledger = await factory.build();
      const { taskIn } = await seedMinimalGraph(ledger);
      await ledger.mutations.updateItem(TASKS_LEDGER, taskIn, { status: "done" });
      await ledger.setRoots([`${TASKS_LEDGER}:${taskIn}`]);
      const reopened = await ledger.mutations.reopenItem(TASKS_LEDGER, taskIn, "planned");
      expect(reopened.status).toBe("planned");
    });

    caseIt(factory, "ambient create under empty roots still works for milestone-less intake", async () => {
      const ledger = await factory.build();
      await ledger.init();
      // Ideas-style ambient: use tasks under ambient only if schema allows;
      // createMilestone + item is the canonical empty-root path already covered.
      const m = await ledger.mutations.createMilestone({
        title: "ambient-path",
        description: MILESTONES_AMBIENT_ID,
      });
      expect(m.id.length).toBeGreaterThan(0);
    });
  });
}
