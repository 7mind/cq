/**
 * T1962 — parameterized Behavioral-Active Blackbox contract for owner-scoped
 * lifecycle writes.
 *
 * One abstract suite over {@link WorksetOwnedGuardedLedger}. Always runnable
 * against the in-memory dummy; future fs/sqlite/postgres legs supply their
 * own factory without changing these assertions.
 *
 * Scope (acceptance):
 * - allowed kinds seal canonical ownership and enter the owner's closure
 * - owner-excluded / policy-denied / ownerless-under-roots produce zero mutation
 * - forged ownership fields are rejected
 * - raw generic creation remains inaccessible on the public surface
 * - each operation holds exactly one owned-write admission through commit
 */

import { describe, expect, it } from "bun:test";
import {
  WorksetOwnedLifecycleError,
  WorksetGenericMutationError,
  type WorksetGenericMutationErrorCode,
  assertNoPublicRawWriteEscape,
  assertOwnedWriteAdmissionNotCallerMinted,
  createTrustedWorksetManagementAuthority,
  closeWorkset,
  buildActiveStateFromLedgerStore,
  worksetMemberRefSet,
  readCanonicalOwnership,
  WORKSET_OWNER_REF_FIELD,
  WORKSET_OWNER_EDGE_KIND_FIELD,
  IDEAS_LEDGER,
  GOALS_LEDGER,
  TASKS_LEDGER,
  DEFECTS_LEDGER,
  QUESTIONS_LEDGER,
  REVIEWS_LEDGER,
  RESEARCHES_LEDGER,
  HYPOTHESIS_LEDGER,
  DECISIONS_LEDGER,
  HANDOFFS_LEDGER,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  type WorksetOwnedGuardedLedger,
  type WorksetOwnedLifecycleErrorCode,
  type CreateInMemoryWorksetOwnedGuardedLedgerOptions,
  type WorksetOwnedWriteCreationKind,
  InMemoryLedgerStore,
  MEMORIES_LEDGER,
  MemoryManagementAuthorityRequiredError,
  UnsupportedMemoryKindError,
  WORKSET_OWNED_WRITE_CREATION_KINDS,
  closedGraphIsTargetAdmitted,
  createInMemoryWorksetStore,
  createWorksetOwnedGuardedLedger,
  type Item,
  type OwnedOwnerRef,
  type OwnerlessCreateInput,
  type PhysicalLedgerState,
  type WorksetOwnedWriteHost,
  type WorksetOwnedWriteTx,
  type WorksetRootsEpoch,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Factory surface
// ---------------------------------------------------------------------------

export type WorksetOwnedWriteContractClassification =
  | "Behavioral-Active Blackbox-Atomic"
  | "Behavioral-Active Blackbox-GoodCommunication";

export type WorksetOwnedWriteContractBuildOptions =
  CreateInMemoryWorksetOwnedGuardedLedgerOptions;

export interface WorksetOwnedWriteContractFactory {
  readonly name: string;
  readonly classification: WorksetOwnedWriteContractClassification;
  build(
    options?: WorksetOwnedWriteContractBuildOptions,
  ): WorksetOwnedGuardedLedger | Promise<WorksetOwnedGuardedLedger>;
  /**
   * G192/T6629 — an ordinary surface (built WITHOUT an invocation authority,
   * so the constructor's observe-only default applies) and a trusted
   * management surface over ONE shared persistence. Both route every owned
   * transaction callback through `probe`.
   */
  buildMemoryAuthorityPair(probe: OwnedTransactionProbe): Promise<WorksetOwnedMemoryAuthorityPair>;
}

export interface WorksetOwnedMemoryAuthorityPair {
  readonly ordinary: WorksetOwnedGuardedLedger;
  readonly management: WorksetOwnedGuardedLedger;
}

/** Wraps the callback an adapter runs inside its owned transaction. */
export interface OwnedTransactionProbe {
  observe<T>(mutate: (tx: WorksetOwnedWriteTx) => T): (tx: WorksetOwnedWriteTx) => T;
}

/** In-memory {@link WorksetOwnedWriteContractFactory.buildMemoryAuthorityPair}. */
export async function buildInMemoryOwnedMemoryAuthorityPair(
  probe: OwnedTransactionProbe,
): Promise<WorksetOwnedMemoryAuthorityPair> {
  const rawStore = new InMemoryLedgerStore();
  const host: WorksetOwnedWriteHost = {
    rawStore,
    worksetStore: createInMemoryWorksetStore({
      isTargetAdmitted: closedGraphIsTargetAdmitted(rawStore),
    }),
    runOwnedTransaction: (mutate, context) =>
      rawStore.runAtomicOwnedMutation(probe.observe(mutate), context),
  };
  const pair = {
    ordinary: createWorksetOwnedGuardedLedger(host),
    management: createWorksetOwnedGuardedLedger({
      ...host,
      invocationAuthority: createTrustedWorksetManagementAuthority(),
    }),
  };
  await pair.management.init();
  return pair;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function expectOwnedRejection(
  promise: Promise<unknown>,
  code: WorksetOwnedLifecycleErrorCode,
): Promise<WorksetOwnedLifecycleError> {
  try {
    await promise;
    throw new Error(`expected WorksetOwnedLifecycleError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(WorksetOwnedLifecycleError);
    const ownedError = error as WorksetOwnedLifecycleError;
    expect(ownedError.code).toBe(code);
    return ownedError;
  }
}

async function expectGenericRejection(
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

async function seedIdea(
  ledger: WorksetOwnedGuardedLedger,
): Promise<{ ideaId: string }> {
  await ledger.init();
  const idea = await ledger.owned.createOwnerless({
    ledgerId: IDEAS_LEDGER,
    status: "open",
    fields: { title: "seed-idea" },
  });
  return { ideaId: idea.id };
}

function memberRefsForRoot(
  ledger: WorksetOwnedGuardedLedger,
  root: string,
): ReadonlySet<string> {
  // WorksetOwnedGuardedLedger is a read surface + mutations; rebuild active
  // state via enumerate/fetch like the gateway does.
  const state = buildActiveStateFromLedgerStore(ledger);
  const graph = closeWorkset([root], state);
  return worksetMemberRefSet(graph);
}

interface SingleChildCase {
  readonly creationKind: WorksetOwnedWriteCreationKind;
  readonly ownerLedger: string;
  readonly ownerStatus: string;
  readonly seedOwner: (ledger: WorksetOwnedGuardedLedger) => Promise<string>;
  readonly child: {
    readonly ledgerId: string;
    readonly status: string;
    readonly fields: Record<string, string | string[]>;
  };
}

const SINGLE_CHILD_CASES: readonly SingleChildCase[] = [
  {
    creationKind: "exact-gate-question",
    ownerLedger: GOALS_LEDGER,
    ownerStatus: "clarifying",
    seedOwner: async (ledger) => {
      const idea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "q-owner-idea" },
      });
      const boot = await ledger.bundles.bootstrapIdeaToGoal({
        ideaId: idea.id,
        goal: { title: "q-goal", description: "for questions" },
      });
      return boot.goal.id;
    },
    child: {
      ledgerId: QUESTIONS_LEDGER,
      status: "open",
      fields: { question: "exact gate?" },
    },
  },
  {
    creationKind: "review",
    ownerLedger: GOALS_LEDGER,
    ownerStatus: "clarifying",
    seedOwner: async (ledger) => {
      const idea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "r-owner-idea" },
      });
      const boot = await ledger.bundles.bootstrapIdeaToGoal({
        ideaId: idea.id,
        goal: { title: "r-goal", description: "for review" },
      });
      return boot.goal.id;
    },
    child: {
      ledgerId: REVIEWS_LEDGER,
      status: "go-ahead",
      fields: {},
    },
  },
  {
    creationKind: "review-filed-defect",
    ownerLedger: GOALS_LEDGER,
    ownerStatus: "clarifying",
    seedOwner: async (ledger) => {
      const idea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "d-owner-idea" },
      });
      const boot = await ledger.bundles.bootstrapIdeaToGoal({
        ideaId: idea.id,
        goal: { title: "d-goal", description: "for defect" },
      });
      return boot.goal.id;
    },
    child: {
      ledgerId: DEFECTS_LEDGER,
      status: "open",
      fields: { headline: "filed", severity: "low" },
    },
  },
  {
    creationKind: "research",
    ownerLedger: GOALS_LEDGER,
    ownerStatus: "clarifying",
    seedOwner: async (ledger) => {
      const idea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "rs-owner-idea" },
      });
      const boot = await ledger.bundles.bootstrapIdeaToGoal({
        ideaId: idea.id,
        goal: { title: "rs-goal", description: "for research" },
      });
      return boot.goal.id;
    },
    child: {
      ledgerId: RESEARCHES_LEDGER,
      status: "open",
      fields: { question: "does X hold?" },
    },
  },
  {
    creationKind: "decision",
    ownerLedger: GOALS_LEDGER,
    ownerStatus: "clarifying",
    seedOwner: async (ledger) => {
      const idea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "k-owner-idea" },
      });
      const boot = await ledger.bundles.bootstrapIdeaToGoal({
        ideaId: idea.id,
        goal: { title: "k-goal", description: "for decision" },
      });
      return boot.goal.id;
    },
    child: {
      ledgerId: DECISIONS_LEDGER,
      status: "proposed",
      fields: { headline: "lock the API" },
    },
  },
  {
    creationKind: "handoff",
    ownerLedger: GOALS_LEDGER,
    ownerStatus: "clarifying",
    seedOwner: async (ledger) => {
      const idea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "ho-owner-idea" },
      });
      const boot = await ledger.bundles.bootstrapIdeaToGoal({
        ideaId: idea.id,
        goal: { title: "ho-goal", description: "for handoff" },
      });
      return boot.goal.id;
    },
    child: {
      ledgerId: HANDOFFS_LEDGER,
      status: "drained",
      fields: { summary: "session drained" },
    },
  },
  {
    creationKind: "hypothesis",
    ownerLedger: DEFECTS_LEDGER,
    ownerStatus: "open",
    seedOwner: async (ledger) => {
      const defect = await ledger.owned.createOwnerless({
        ledgerId: DEFECTS_LEDGER,
        status: "open",
        fields: { headline: "hyp-host", severity: "medium" },
      });
      return defect.id;
    },
    child: {
      ledgerId: HYPOTHESIS_LEDGER,
      status: "open",
      fields: { headline: "maybe null deref" },
    },
  },
  {
    creationKind: "implementation-defect",
    ownerLedger: TASKS_LEDGER,
    ownerStatus: "planned",
    seedOwner: async (ledger) => {
      const task = await ledger.owned.createOwnerless({
        ledgerId: TASKS_LEDGER,
        status: "planned",
        fields: { headline: "impl-task" },
      });
      return task.id;
    },
    child: {
      ledgerId: DEFECTS_LEDGER,
      status: "open",
      fields: { headline: "impl bug", severity: "high" },
    },
  },
];

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

export function runWorksetOwnedWriteContract(
  factory: WorksetOwnedWriteContractFactory,
): void {
  describe(`workset owned-write contract [T1962] — ${factory.name} (${factory.classification})`, () => {
    it("exposes owned + generic gateways and no public raw-write escape", async () => {
      const ledger = await factory.build();
      await ledger.init();
      assertNoPublicRawWriteEscape(ledger);
      expect(ledger.owned.form).toBe("workset-owned-write-gateway");
      expect(ledger.bundles.form).toBe("workset-coordination-bundle-gateway");
      expect(ledger.mutations.form).toBe("workset-generic-mutation-gateway");
      expect(typeof ledger.owned.createOwned).toBe("function");
      expect(typeof ledger.owned.createOwnerless).toBe("function");
    });

    it("rejects caller-minted owned-write admission lookalikes", () => {
      expect(() =>
        assertOwnedWriteAdmissionNotCallerMinted({
          form: "ledger-mutation",
          id: "forged",
          acknowledge: async () => undefined,
        }),
      ).toThrow(WorksetOwnedLifecycleError);
      expect(() => assertOwnedWriteAdmissionNotCallerMinted({ hello: 1 })).not.toThrow();
    });

    it("ownerless intake succeeds only under empty roots", async () => {
      const ledger = await factory.build();
      await ledger.init();
      const idea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "ownerless-ok" },
      });
      expect(readCanonicalOwnership(idea)).toBeNull();
      expect(idea.fields[WORKSET_OWNER_REF_FIELD]).toBeUndefined();

      await ledger.setRoots([`${IDEAS_LEDGER}:${idea.id}`]);
      const before = ledger.fetch(TASKS_LEDGER).counters.item;
      await expectOwnedRejection(
        ledger.owned.createOwnerless({
          ledgerId: TASKS_LEDGER,
          status: "planned",
          fields: { headline: "denied-ownerless" },
        }),
        "ownerless-denied",
      );
      expect(ledger.fetch(TASKS_LEDGER).counters.item).toBe(before);
    });

    it("idea-to-goal seals ownership and child enters owner closure", async () => {
      const ledger = await factory.build();
      const { ideaId } = await seedIdea(ledger);
      const created = await ledger.owned.createOwned({
        owner: { ledgerId: IDEAS_LEDGER, itemId: ideaId },
        creationKind: "idea-to-goal",
        child: {
          ledgerId: GOALS_LEDGER,
          status: "clarifying",
          fields: { title: "from-idea", description: "sealed" },
        },
      });
      const ownership = readCanonicalOwnership(created.child);
      expect(ownership).not.toBeNull();
      expect(ownership!.ownerRef).toBe(`${IDEAS_LEDGER}:${ideaId}`);
      expect(ownership!.edgeKind).toBe("idea-to-goal");
      expect(created.child.fields[WORKSET_OWNER_REF_FIELD]).toBe(
        `${IDEAS_LEDGER}:${ideaId}`,
      );
      expect(created.child.fields[WORKSET_OWNER_EDGE_KIND_FIELD]).toBe("idea-to-goal");

      const members = memberRefsForRoot(ledger, `${IDEAS_LEDGER}:${ideaId}`);
      expect(members.has(`${GOALS_LEDGER}:${created.child.id}`)).toBe(true);
    });

    it("generic update, archive, and unarchive preserve sealed ownership", async () => {
      const ledger = await factory.build({
        invocationAuthority: createTrustedWorksetManagementAuthority(),
      });
      await ledger.init();
      const idea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "preservation-owner" },
      });
      const bootstrap = await ledger.bundles.bootstrapIdeaToGoal({
        ideaId: idea.id,
        goal: { title: "preservation-goal", description: "ownership host" },
      });
      const milestone = await ledger.mutations.createMilestone({
        title: "preservation-milestone",
      });
      const review = await ledger.owned.createOwned({
        owner: { ledgerId: GOALS_LEDGER, itemId: bootstrap.goal.id },
        creationKind: "review",
        child: {
          ledgerId: REVIEWS_LEDGER,
          milestoneId: milestone.id,
          status: "go-ahead",
          fields: { summary: "initial" },
        },
      });
      const ownership = readCanonicalOwnership(review.child);

      const updated = await ledger.mutations.updateItem(REVIEWS_LEDGER, review.child.id, {
        fields: { summary: "updated" },
      });
      expect(readCanonicalOwnership(updated)).toEqual(ownership);

      await ledger.mutations.updateMilestone(milestone.id, { status: "done" });
      await ledger.setRoots([
        `${MILESTONES_LEDGER}:${milestone.id}`,
        `${REVIEWS_LEDGER}:${review.child.id}`,
      ]);
      await ledger.mutations.archiveMilestone(milestone.id, "ownership preservation");
      await ledger.setRoots([`${REVIEWS_LEDGER}:${review.child.id}`]);
      const restored = await ledger.mutations.unarchiveItem(
        REVIEWS_LEDGER,
        milestone.id,
        review.child.id,
      );
      expect(readCanonicalOwnership(restored)).toEqual(ownership);
    });

    for (const cse of SINGLE_CHILD_CASES) {
      it(`allowed ${cse.creationKind} under ${cse.ownerLedger} seals ownership + enters closure`, async () => {
        const ledger = await factory.build();
        await ledger.init();
        const ownerId = await cse.seedOwner(ledger);
        const ownerRef = `${cse.ownerLedger}:${ownerId}`;
        // Restrictive roots on the owner — owned create must still succeed.
        await ledger.setRoots([ownerRef]);
        const result = await ledger.owned.createOwned({
          owner: { ledgerId: cse.ownerLedger, itemId: ownerId },
          creationKind: cse.creationKind,
          child: {
            ledgerId: cse.child.ledgerId,
            milestoneId: MILESTONES_AMBIENT_ID,
            status: cse.child.status,
            fields: { ...cse.child.fields },
          },
        });
        const ownership = readCanonicalOwnership(result.child);
        expect(ownership).not.toBeNull();
        expect(ownership!.ownerRef).toBe(ownerRef);
        expect(ownership!.edgeKind).toBe(cse.creationKind);
        const members = memberRefsForRoot(ledger, ownerRef);
        expect(members.has(`${cse.child.ledgerId}:${result.child.id}`)).toBe(true);
      });
    }

    it("excluded owner under restrictive roots produces zero mutation", async () => {
      const ledger = await factory.build();
      await ledger.init();
      const inIdea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "in-root" },
      });
      const outIdea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "out-root" },
      });
      await ledger.setRoots([`${IDEAS_LEDGER}:${inIdea.id}`]);
      const beforeGoals = ledger.fetch(GOALS_LEDGER).counters.item;
      await expectOwnedRejection(
        ledger.owned.createOwned({
          owner: { ledgerId: IDEAS_LEDGER, itemId: outIdea.id },
          creationKind: "idea-to-goal",
          child: {
            ledgerId: GOALS_LEDGER,
            status: "clarifying",
            fields: { title: "nope", description: "excluded" },
          },
        }),
        "owner-excluded",
      );
      expect(ledger.fetch(GOALS_LEDGER).counters.item).toBe(beforeGoals);
    });

    it("policy-denied creation kind produces zero mutation", async () => {
      const ledger = await factory.build();
      await ledger.init();
      const idea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "deny-idea" },
      });
      const before = ledger.fetch(QUESTIONS_LEDGER).counters.item;
      await expectOwnedRejection(
        ledger.owned.createOwned({
          owner: { ledgerId: IDEAS_LEDGER, itemId: idea.id },
          creationKind: "exact-gate-question",
          child: {
            ledgerId: QUESTIONS_LEDGER,
            status: "open",
            fields: { question: "ideas never own questions" },
          },
        }),
        "owner-policy-denied",
      );
      expect(ledger.fetch(QUESTIONS_LEDGER).counters.item).toBe(before);
    });

    it("forged ownership fields are rejected (zero mutation)", async () => {
      const ledger = await factory.build();
      const { ideaId } = await seedIdea(ledger);
      const before = ledger.fetch(GOALS_LEDGER).counters.item;
      await expectOwnedRejection(
        ledger.owned.createOwned({
          owner: { ledgerId: IDEAS_LEDGER, itemId: ideaId },
          creationKind: "idea-to-goal",
          child: {
            ledgerId: GOALS_LEDGER,
            status: "clarifying",
            fields: {
              title: "forged",
              description: "x",
              [WORKSET_OWNER_REF_FIELD]: "ideas:I999",
            },
          },
        }),
        "forged-ownership",
      );
      await expectOwnedRejection(
        ledger.owned.createOwnerless({
          ledgerId: TASKS_LEDGER,
          status: "planned",
          fields: {
            headline: "forged-ownerless",
            [WORKSET_OWNER_EDGE_KIND_FIELD]: "review",
          },
        }),
        "forged-ownership",
      );
      expect(ledger.fetch(GOALS_LEDGER).counters.item).toBe(before);
    });

    it("raw generic creation remains inaccessible under non-empty roots", async () => {
      const ledger = await factory.build();
      const { ideaId } = await seedIdea(ledger);
      await ledger.setRoots([`${IDEAS_LEDGER}:${ideaId}`]);
      try {
        await ledger.mutations.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
          status: "planned",
          fields: { headline: "generic-denied" },
        });
        throw new Error("expected generic creation denial");
      } catch (error) {
        expect(error).toBeInstanceOf(WorksetGenericMutationError);
        expect((error as WorksetGenericMutationError).code).toBe("creation-denied");
      }
    });

    it("ownerless intake holds exactly one owned-write admission", async () => {
      const subject: { ledger: WorksetOwnedGuardedLedger | null } = { ledger: null };
      const observedAdmissions: number[] = [];
      const ledger = await factory.build({
        afterOwnedAdmit: () => {
          expect(subject.ledger).not.toBeNull();
          observedAdmissions.push(subject.ledger!.activeAdmissionCount());
        },
      });
      subject.ledger = ledger;
      await ledger.init();
      await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "one-ownerless-admission" },
      });
      expect(observedAdmissions).toEqual([1]);
      expect(ledger.activeAdmissionCount()).toBe(0);
    });

    it("holds exactly one owned-write admission through commit (set waits)", async () => {
      // Hold only the post-seed owned-write critical section so setRoots observes
      // exactly one active admission and cannot finish until release.
      const admitted = deferred();
      const releaseHold = deferred();
      let holdEnabled = false;
      const ledger = await factory.build({
        afterOwnedAdmit: async () => {
          if (!holdEnabled) return;
          admitted.resolve();
          await releaseHold.promise;
        },
      });
      const { ideaId } = await seedIdea(ledger);

      holdEnabled = true;
      let createDone = false;
      const createP = ledger.owned
        .createOwned({
          owner: { ledgerId: IDEAS_LEDGER, itemId: ideaId },
          creationKind: "idea-to-goal",
          child: {
            ledgerId: GOALS_LEDGER,
            status: "clarifying",
            fields: { title: "held", description: "admission" },
          },
        })
        .then((r) => {
          createDone = true;
          return r;
        });

      await admitted.promise;
      expect(ledger.activeAdmissionCount()).toBe(1);
      expect(createDone).toBe(false);

      let setDone = false;
      const setP = ledger.setRoots([]).then((s) => {
        setDone = true;
        return s;
      });
      // set must wait on the live owned admission
      await new Promise((r) => setTimeout(r, 20));
      expect(setDone).toBe(false);

      releaseHold.resolve();
      await createP;
      await setP;
      expect(createDone).toBe(true);
      expect(setDone).toBe(true);
      expect(ledger.activeAdmissionCount()).toBe(0);
    });

    it("wrong-status owner is policy-denied with zero mutation", async () => {
      const ledger = await factory.build();
      await ledger.init();
      // Discarded idea cannot own idea-to-goal.
      const idea = await ledger.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "will-discard" },
      });
      // Consume via bootstrap then try again on planned idea.
      await ledger.bundles.bootstrapIdeaToGoal({
        ideaId: idea.id,
        goal: { title: "first", description: "consume" },
        consumeIdea: true,
      });
      const planned = ledger.fetchItem(IDEAS_LEDGER, idea.id);
      expect(planned.status).toBe("planned");
      const before = ledger.fetch(GOALS_LEDGER).counters.item;
      await expectOwnedRejection(
        ledger.owned.createOwned({
          owner: { ledgerId: IDEAS_LEDGER, itemId: idea.id },
          creationKind: "idea-to-goal",
          child: {
            ledgerId: GOALS_LEDGER,
            status: "clarifying",
            fields: { title: "second", description: "denied" },
          },
        }),
        "owner-policy-denied",
      );
      expect(ledger.fetch(GOALS_LEDGER).counters.item).toBe(before);
    });

    // D487: execution readiness and archival cleanup are different authorities.
    // Workset traversal deliberately drops an ANSWERED gate question and a DONE
    // task's children, because neither is runnable — but a milestone only
    // becomes archivable once its members are terminal, so that same filter
    // removes exactly the members an archival sweep must cover. The observed
    // production refusal named `questions:Q408`, an answered gate question
    // sealed to `tasks:T6518`, while T6518 itself was admitted.
    async function seedTerminalOwnedGateQuestion(
      ledger: WorksetOwnedGuardedLedger,
      withUnrelatedSibling = false,
    ): Promise<{
      readonly milestoneId: string;
      readonly taskId: string;
      readonly questionId: string;
      readonly siblingId: string | null;
    }> {
      await ledger.init();
      const milestone = await ledger.mutations.createMilestone({ title: "D487 cleanup" });
      const task = await ledger.owned.createOwnerless({
        ledgerId: TASKS_LEDGER,
        milestoneId: milestone.id,
        status: "planned",
        fields: { headline: "owner of the gate question" },
      });
      const question = await ledger.owned.createOwned({
        owner: { ledgerId: TASKS_LEDGER, itemId: task.id },
        creationKind: "exact-gate-question",
        child: {
          ledgerId: QUESTIONS_LEDGER,
          milestoneId: milestone.id,
          status: "open",
          fields: { question: "which runtime does the gate pin?" },
        },
      });
      // Sealed ownership is what makes this a canonical descendant rather than
      // an advisory neighbour.
      const sealed = readCanonicalOwnership(
        ledger.fetchItem(QUESTIONS_LEDGER, question.child.id),
      );
      expect(sealed).toEqual({
        ownerRef: `${TASKS_LEDGER}:${task.id}`,
        edgeKind: "exact-gate-question",
      });
      await ledger.mutations.updateItem(QUESTIONS_LEDGER, question.child.id, {
        status: "answered",
        fields: { answer: "the pinned one" },
        author: "user",
      });
      await ledger.mutations.updateItem(TASKS_LEDGER, task.id, { status: "done" });
      // A sibling with no ownership edge to anything admitted: advisory-only
      // proximity (same milestone) must never buy admission. Seeded before the
      // milestone goes terminal, since creation requires an active milestone.
      const sibling = withUnrelatedSibling
        ? await ledger.owned.createOwnerless({
            ledgerId: TASKS_LEDGER,
            milestoneId: milestone.id,
            status: "planned",
            fields: { headline: "unrelated sibling" },
          })
        : null;
      if (sibling !== null) {
        await ledger.mutations.updateItem(TASKS_LEDGER, sibling.id, { status: "done" });
      }
      await ledger.mutations.updateMilestone(milestone.id, { status: "done" });
      return {
        milestoneId: milestone.id,
        taskId: task.id,
        questionId: question.child.id,
        siblingId: sibling?.id ?? null,
      };
    }

    it("D487 archives a terminal canonically owned gate question without rooting it", async () => {
      const ledger = await factory.build();
      const { milestoneId, taskId, questionId } = await seedTerminalOwnedGateQuestion(ledger);

      // The question is NOT a root and is NOT reachable by runnable traversal:
      // its owner is done and it is answered.
      await ledger.setRoots([
        `${MILESTONES_LEDGER}:${milestoneId}`,
        `${TASKS_LEDGER}:${taskId}`,
      ]);
      const graph = closeWorkset(
        (await ledger.snapshotRoots()).roots,
        buildActiveStateFromLedgerStore(ledger),
      );
      expect(worksetMemberRefSet(graph).has(`${QUESTIONS_LEDGER}:${questionId}`)).toBe(false);

      const pointer = await ledger.mutations.archiveMilestone(milestoneId, "D487 cleanup");
      expect(pointer.id).toBe(milestoneId);
      expect(() => ledger.fetchItem(QUESTIONS_LEDGER, questionId)).toThrow();
      expect(() => ledger.fetchItem(TASKS_LEDGER, taskId)).toThrow();
    });

    it("D487 still refuses an unrelated terminal member of the same milestone", async () => {
      const ledger = await factory.build();
      const { milestoneId, taskId, siblingId } = await seedTerminalOwnedGateQuestion(
        ledger,
        true,
      );
      if (siblingId === null) throw new Error("unrelated sibling was not seeded");
      await ledger.setRoots([
        `${MILESTONES_LEDGER}:${milestoneId}`,
        `${TASKS_LEDGER}:${taskId}`,
      ]);
      const before = ledger.fetchItem(MILESTONES_LEDGER, milestoneId);
      const error = await expectGenericRejection(
        ledger.mutations.archiveMilestone(milestoneId, "should-fail"),
        "archive-sweep-incomplete",
      );
      expect(error.message).toContain(`${TASKS_LEDGER}:${siblingId}`);
      expect(ledger.fetchItem(MILESTONES_LEDGER, milestoneId)).toEqual(before);
    });

    it("D487 refuses a canonically owned terminal child whose owner is not admitted", async () => {
      const ledger = await factory.build();
      await ledger.init();
      // The owner lives in ANOTHER milestone, so it is not swept in with the
      // archived group. Sealed ownership alone must not admit the child: the
      // OWNER has to be an admitted member.
      const ownerMilestone = await ledger.mutations.createMilestone({ title: "D487 owner" });
      const gateMilestone = await ledger.mutations.createMilestone({ title: "D487 gate" });
      const task = await ledger.owned.createOwnerless({
        ledgerId: TASKS_LEDGER,
        milestoneId: ownerMilestone.id,
        status: "planned",
        fields: { headline: "owner in another milestone" },
      });
      const question = await ledger.owned.createOwned({
        owner: { ledgerId: TASKS_LEDGER, itemId: task.id },
        creationKind: "exact-gate-question",
        child: {
          ledgerId: QUESTIONS_LEDGER,
          milestoneId: gateMilestone.id,
          status: "open",
          fields: { question: "cross-milestone gate" },
        },
      });
      await ledger.mutations.updateItem(QUESTIONS_LEDGER, question.child.id, {
        status: "answered",
        fields: { answer: "yes" },
        author: "user",
      });
      await ledger.mutations.updateItem(TASKS_LEDGER, task.id, { status: "done" });
      await ledger.mutations.updateMilestone(gateMilestone.id, { status: "done" });

      await ledger.setRoots([`${MILESTONES_LEDGER}:${gateMilestone.id}`]);
      const before = ledger.fetchItem(MILESTONES_LEDGER, gateMilestone.id);
      const error = await expectGenericRejection(
        ledger.mutations.archiveMilestone(gateMilestone.id, "owner-not-admitted"),
        "archive-sweep-incomplete",
      );
      expect(error.message).toContain(`${QUESTIONS_LEDGER}:${question.child.id}`);
      expect(ledger.fetchItem(MILESTONES_LEDGER, gateMilestone.id)).toEqual(before);

      // Admitting the owner — still without rooting the question — releases it.
      await ledger.setRoots([
        `${MILESTONES_LEDGER}:${gateMilestone.id}`,
        `${TASKS_LEDGER}:${task.id}`,
      ]);
      const pointer = await ledger.mutations.archiveMilestone(gateMilestone.id, "owner-admitted");
      expect(pointer.id).toBe(gateMilestone.id);
    });

    it("D487 refuses a canonically owned child that is not terminal", async () => {
      const ledger = await factory.build();
      await ledger.init();
      const milestone = await ledger.mutations.createMilestone({ title: "D487 live child" });
      const task = await ledger.owned.createOwnerless({
        ledgerId: TASKS_LEDGER,
        milestoneId: milestone.id,
        status: "planned",
        fields: { headline: "owner of a live gate question" },
      });
      const question = await ledger.owned.createOwned({
        owner: { ledgerId: TASKS_LEDGER, itemId: task.id },
        creationKind: "exact-gate-question",
        child: {
          ledgerId: QUESTIONS_LEDGER,
          milestoneId: milestone.id,
          status: "open",
          fields: { question: "still unanswered" },
        },
      });
      // The owner goes terminal while its gate question stays OPEN, so runnable
      // traversal drops the question (a done task owns no live children) and
      // cleanup must not pick it up either: an unanswered gate is live work.
      // The milestone is deliberately left open, because closing it is itself
      // refused while a child is non-terminal — this is the one shape that
      // reaches the archive path with a live member.
      await ledger.mutations.updateItem(TASKS_LEDGER, task.id, { status: "done" });
      await ledger.setRoots([
        `${MILESTONES_LEDGER}:${milestone.id}`,
        `${TASKS_LEDGER}:${task.id}`,
      ]);
      const before = ledger.fetchItem(MILESTONES_LEDGER, milestone.id);
      const error = await expectGenericRejection(
        ledger.mutations.archiveMilestone(milestone.id, "live-child"),
        "archive-sweep-incomplete",
      );
      expect(error.message).toContain(`${QUESTIONS_LEDGER}:${question.child.id}`);
      expect(ledger.fetchItem(MILESTONES_LEDGER, milestone.id)).toEqual(before);
    });

    // G192/T6629 — owned-write memory authoring authority.

    it("ordinary authority creates ownerless omitted and explicit facts inside the owned transaction", async () => {
      const probe = createRecordingProbe();
      const { ordinary, management } = await factory.buildMemoryAuthorityPair(probe);
      await management.setRoots([]);
      const omitted = await ordinary.owned.createOwnerless(memoryInput("omitted fact", undefined));
      const explicit = await ordinary.owned.createOwnerless(memoryInput("explicit fact", "fact"));
      expect(probe.events).toEqual([...COMMITTED_TRACE, ...COMMITTED_TRACE]);
      const stored = physicalMemories(await ordinary.exportPhysicalLedgerState());
      expect(stored.map((item) => [item.id, item.fields.kind])).toEqual([
        [omitted.id, "fact"],
        [explicit.id, "fact"],
      ]);
    });

    for (const kind of ["rule", "environment"] as const) {
      it(`ordinary authority cannot create an ownerless ${kind} with forged provenance or admission; management can`, async () => {
        const probe = createRecordingProbe();
        const { ordinary, management } = await factory.buildMemoryAuthorityPair(probe);
        await management.setRoots([]);
        const forgeries: readonly OwnerlessCreateInput[] = [
          memoryInput(`plain ${kind}`, kind),
          {
            ...memoryInput(`forged ${kind}`, kind),
            author: "management",
            session: "trusted-management-host",
            fields: {
              title: `forged ${kind}`,
              content: "authored under trusted management authority",
              kind,
              tags: ["management"],
            },
          },
          {
            ...memoryInput(`admitted ${kind}`, kind),
            admission: { form: "ledger-mutation", kind: "owned-write", targets: [], roots: [], epoch: 0 },
            invocationAuthority: { scope: "management" },
          } as OwnerlessCreateInput,
        ];
        for (const input of forgeries) {
          probe.events.length = 0;
          const before = await observeOwnedState(management);
          await expect(ordinary.owned.createOwnerless(input)).rejects.toThrow(
            MemoryManagementAuthorityRequiredError,
          );
          expect(probe.events).toEqual(["transaction", "threw:MemoryManagementAuthorityRequiredError"]);
          expect(await observeOwnedState(management)).toEqual(before);
        }

        probe.events.length = 0;
        const created = await management.owned.createOwnerless(memoryInput(`managed ${kind}`, kind));
        expect(probe.events).toEqual([...COMMITTED_TRACE]);
        expect(created.fields.kind).toBe(kind);
      });
    }

    it("unsupported memory kinds reject for every authority before the adapter create", async () => {
      const probe = createRecordingProbe();
      const pair = await factory.buildMemoryAuthorityPair(probe);
      for (const surface of [pair.ordinary, pair.management]) {
        probe.events.length = 0;
        const before = await observeOwnedState(pair.management);
        await expect(
          surface.owned.createOwnerless(memoryInput("unsupported", "note")),
        ).rejects.toThrow(UnsupportedMemoryKindError);
        expect(probe.events).toEqual(["transaction", "threw:UnsupportedMemoryKindError"]);
        expect(await observeOwnedState(pair.management)).toEqual(before);
      }
    });

    it("deterministic interleaving: authority and kind validation run inside the owned creation transaction", async () => {
      const probe = createRecordingProbe();
      const { ordinary, management } = await factory.buildMemoryAuthorityPair(probe);
      await expect(ordinary.owned.createOwnerless(memoryInput("r1", "rule"))).rejects.toThrow(
        MemoryManagementAuthorityRequiredError,
      );
      await management.owned.createOwnerless(memoryInput("r2", "rule"));
      await expect(ordinary.owned.createOwnerless(memoryInput("u1", "note"))).rejects.toThrow(
        UnsupportedMemoryKindError,
      );
      await ordinary.owned.createOwnerless(memoryInput("f1", undefined));
      expect(probe.events).toEqual([
        "transaction",
        "threw:MemoryManagementAuthorityRequiredError",
        ...COMMITTED_TRACE,
        "transaction",
        "threw:UnsupportedMemoryKindError",
        ...COMMITTED_TRACE,
      ]);
      expect(
        physicalMemories(await management.exportPhysicalLedgerState()).map((item) => [
          item.fields.title,
          item.fields.kind,
        ]),
      ).toEqual([
        ["r2", "rule"],
        ["f1", "fact"],
      ]);
    });

    it("every createOwned attempt to target memories rejects before persistence", async () => {
      const probe = createRecordingProbe();
      const pair = await factory.buildMemoryAuthorityPair(probe);
      const owners = new Map<WorksetOwnedWriteCreationKind, OwnedOwnerRef>();
      for (const cse of SINGLE_CHILD_CASES) {
        owners.set(cse.creationKind, {
          ledgerId: cse.ownerLedger,
          itemId: await cse.seedOwner(pair.management),
        });
      }
      const idea = await pair.management.owned.createOwnerless({
        ledgerId: IDEAS_LEDGER,
        status: "open",
        fields: { title: "memory-child idea owner" },
      });
      owners.set("idea-to-goal", { ledgerId: IDEAS_LEDGER, itemId: idea.id });
      const defect = await pair.management.owned.createOwnerless({
        ledgerId: DEFECTS_LEDGER,
        status: "open",
        fields: { headline: "memory-child defect owner", severity: "low" },
      });
      owners.set("fix-goal", { ledgerId: DEFECTS_LEDGER, itemId: defect.id });
      expect([...owners.keys()].sort()).toEqual([...WORKSET_OWNED_WRITE_CREATION_KINDS].sort());

      for (const [creationKind, owner] of owners) {
        for (const surface of [pair.ordinary, pair.management]) {
          for (const kind of [undefined, "fact", "rule", "environment"] as const) {
            probe.events.length = 0;
            const before = await observeOwnedState(pair.management);
            const input = memoryInput(`owned ${creationKind}`, kind);
            await expectOwnedRejection(
              surface.owned.createOwned({
                owner,
                creationKind,
                child: { ledgerId: MEMORIES_LEDGER, status: input.status, fields: input.fields },
              }),
              "child-ledger-mismatch",
            );
            expect(probe.events).toEqual(["transaction", "threw:WorksetOwnedLifecycleError"]);
            expect(await observeOwnedState(pair.management)).toEqual(before);
          }
        }
      }
    });
  });
}

/** A successful owned create: the callback reached the adapter create and returned. */
const COMMITTED_TRACE = ["transaction", "createItemOwnerless", "returned"] as const;

interface RecordingProbe extends OwnedTransactionProbe {
  readonly events: string[];
}

/**
 * Records callback entry, every adapter create reached through `tx`, and how
 * the callback settled — so a trace proves where inside the transaction a
 * rejection happened.
 */
function createRecordingProbe(): RecordingProbe {
  const events: string[] = [];
  return {
    events,
    observe: (mutate) => (tx) => {
      events.push("transaction");
      const observed = new Proxy(tx, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (typeof property === "string" && property.startsWith("create")) events.push(property);
            return Reflect.apply(value as (...values: unknown[]) => unknown, target, args);
          };
        },
      });
      try {
        const result = mutate(observed);
        events.push("returned");
        return result;
      } catch (error) {
        events.push(`threw:${(error as Error).name}`);
        throw error;
      }
    },
  };
}

function memoryInput(title: string, kind: string | undefined): OwnerlessCreateInput {
  return {
    ledgerId: MEMORIES_LEDGER,
    status: "active",
    fields: {
      title,
      content: `${title} body`,
      ...(kind === undefined ? {} : { kind }),
    },
  };
}

function physicalMemories(state: PhysicalLedgerState): readonly Item[] {
  const memories = state.ledgers.find((entry) => entry.ledger.id === MEMORIES_LEDGER);
  if (memories === undefined) throw new Error("physical state has no memories ledger");
  return memories.ledger.milestones.flatMap((group) => group.items);
}

/**
 * Every ledger's physical payloads, counters, provenance, timestamps, and
 * archives, plus workset roots/epoch and held admissions.
 */
async function observeOwnedState(ledger: WorksetOwnedGuardedLedger): Promise<{
  readonly physical: PhysicalLedgerState;
  readonly roots: WorksetRootsEpoch;
  readonly admissions: number;
}> {
  return {
    physical: await ledger.exportPhysicalLedgerState(),
    roots: await ledger.snapshotRoots(),
    admissions: ledger.activeAdmissionCount(),
  };
}
