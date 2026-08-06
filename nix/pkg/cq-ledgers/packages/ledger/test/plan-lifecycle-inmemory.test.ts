import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "bun:test";
import {
  GOALS_LEDGER,
  GOALS_SCHEMA,
  InMemoryLedgerStore,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  PLAN_GENERATION_FIELD,
  RESEARCHES_LEDGER,
  TASKS_LEDGER,
  derivePredicates,
  schemaCompatible,
  type Item,
  type Ledger,
  type PlanClaimAcknowledgement,
  type PlanDraftManifest,
  type PlanLifecycleStore,
  type PlanPrivateClaimRecord,
} from "../src/index.js";
import type { InMemoryPlanOperationRecord } from "../src/store/inMemoryPlanLifecycle.js";
import { inMemoryPlanLifecycleFactory } from "./planLifecycleInMemoryAdapter.js";
import type {
  PlanLifecycleContractFixture,
  ReferencePublicTask,
} from "./planLifecycleReferenceAdapter.js";

const OWNER_A = "aaaaaaaaaaaaaaaaaaaaaa";
const OWNER_B = "bbbbbbbbbbbbbbbbbbbbbb";
const PROVENANCE = { author: "t848", session: "t848-session" } as const;

interface FixtureWithStore extends PlanLifecycleContractFixture {
  readonly store: InMemoryLedgerStore;
}

interface StoreInternals {
  ledgers: Map<string, Ledger>;
  archives: Map<string, { id: string; title: string; description: string; items: Item[] }>;
  planClaims: Map<string, PlanPrivateClaimRecord>;
  planOperations: Map<string, InMemoryPlanOperationRecord>;
}

function internals(store: InMemoryLedgerStore): StoreInternals {
  return store as unknown as StoreInternals;
}

async function buildFixture(
  phase: "clarifying" | "planned" = "clarifying",
  generation: number | null = null,
): Promise<FixtureWithStore> {
  const fixture = (await inMemoryPlanLifecycleFactory.build()) as FixtureWithStore;
  await fixture.seedGoal({ goalId: "G1", phase, generation });
  return fixture;
}

function requireClaim(
  result: Awaited<ReturnType<PlanLifecycleStore["claimPlan"]>>,
): PlanClaimAcknowledgement {
  if (!result.ok) throw new Error(`claim failed: ${result.conflict.code}`);
  return result.acknowledgement;
}

async function claimInitial(
  fixture: PlanLifecycleContractFixture,
  requestId: string,
  token: string,
  expectedGeneration: number | null,
): Promise<PlanClaimAcknowledgement> {
  return requireClaim(
    await fixture.lifecycle.claimPlan({
      goalId: "G1",
      purpose: "initial",
      claimRequestId: requestId,
      ownerFenceToken: token,
      expectedGeneration,
      ...PROVENANCE,
    }),
  );
}

async function pauseForResearches(
  fixture: PlanLifecycleContractFixture,
  claim: PlanClaimAcknowledgement,
  operationId: string,
  keys: string[] = ["probe"],
): Promise<string[]> {
  const result = await fixture.lifecycle.releasePlanClaim({
    kind: "pause",
    goalId: "G1",
    claimId: claim.claimId,
    generation: claim.generation,
    operationId,
    ownerFenceToken: claim.ownerFenceToken,
    ...PROVENANCE,
    effect: {
      kind: "researches",
      researches: keys.map((key) => ({ key, question: `${key}?` })),
    },
  });
  if (!result.ok || result.acknowledgement.kind !== "researches") {
    throw new Error("research pause failed");
  }
  return result.acknowledgement.waitingResearches;
}

async function publishOneTask(
  fixture: PlanLifecycleContractFixture,
  claim: PlanClaimAcknowledgement,
  operationId: string,
): Promise<string> {
  const published = await fixture.lifecycle.publishPlanDraft({
    goalId: "G1",
    claimId: claim.claimId,
    generation: claim.generation,
    operationId,
    ownerFenceToken: claim.ownerFenceToken,
    ...PROVENANCE,
    manifest: {
      milestones: [{ key: "delivery", title: "Delivery" }],
      tasks: [
        {
          key: "implementation",
          milestoneKey: "delivery",
          headline: "Implementation",
        },
      ],
    },
  });
  if (!published.ok) throw new Error("draft publication failed");
  const taskId = published.acknowledgement.manifest.tasks[0]?.id;
  if (taskId === undefined) throw new Error("task allocation missing");
  return taskId;
}

async function pauseForTasks(
  fixture: PlanLifecycleContractFixture,
  claim: PlanClaimAcknowledgement,
  operationId: string,
  tasks: string[],
): Promise<Extract<
  Awaited<ReturnType<PlanLifecycleStore["releasePlanClaim"]>>,
  { ok: true }
>["acknowledgement"]> {
  const result = await fixture.lifecycle.releasePlanClaim({
    kind: "pause",
    goalId: "G1",
    claimId: claim.claimId,
    generation: claim.generation,
    operationId,
    ownerFenceToken: claim.ownerFenceToken,
    ...PROVENANCE,
    effect: { kind: "tasks", tasks },
  });
  if (!result.ok) throw new Error(`task pause failed: ${result.conflict.code}`);
  return result.acknowledgement;
}

describe("T848 InMemory plan lifecycle semantics", () => {
  for (const [status, suppressed] of [
    ["open", true],
    ["wip", true],
    ["inconclusive", true],
    ["concluded", false],
    ["abandoned", false],
  ] as const) {
    it(`owns ${status} research-wait disposition in derivePredicates`, async () => {
      const fixture = await buildFixture();
      try {
        const claim = await claimInitial(fixture, `wait-${status}`, OWNER_A, null);
        const [researchId] = await pauseForResearches(
          fixture,
          claim,
          `pause-${status}`,
        );
        if (researchId === undefined) throw new Error("research allocation missing");
        await fixture.setResearchStatus(researchId, status);
        const predicates = derivePredicates(fixture.store);
        expect(predicates.pPlan.items.includes("G1")).toBe(!suppressed);
        const resumed = await fixture.lifecycle.claimPlan({
          goalId: "G1",
          purpose: "initial",
          claimRequestId: `resume-${status}`,
          ownerFenceToken: OWNER_B,
          expectedGeneration: 1,
          ...PROVENANCE,
        });
        if (suppressed) {
          expect(resumed).toEqual({
            ok: false,
            conflict: {
              code: "research-wait-active",
              goalId: "G1",
              researchIds: [researchId],
            },
          });
        } else {
          expect(resumed.ok).toBe(true);
          expect((await fixture.observe("G1")).waitingResearches).toEqual([]);
        }
      } finally {
        await fixture.dispose();
      }
    });
  }

  for (const disposition of ["missing", "archived"] as const) {
    it(`re-enables planning for a ${disposition} waited research`, async () => {
      const fixture = await buildFixture();
      try {
        const claim = await claimInitial(
          fixture,
          `${disposition}-claim`,
          OWNER_A,
          null,
        );
        const [researchId] = await pauseForResearches(
          fixture,
          claim,
          `${disposition}-pause`,
        );
        if (researchId === undefined) throw new Error("research allocation missing");
        const state = internals(fixture.store);
        const researches = state.ledgers.get(RESEARCHES_LEDGER);
        if (researches === undefined) throw new Error("researches ledger missing");
        let removed: Item | undefined;
        for (const milestone of researches.milestones) {
          const index = milestone.items.findIndex(({ id }) => id === researchId);
          if (index >= 0) [removed] = milestone.items.splice(index, 1);
        }
        if (removed === undefined) throw new Error("research removal failed");
        if (disposition === "archived") {
          state.archives.set(`${RESEARCHES_LEDGER}/M999`, {
            id: "M999",
            title: "",
            description: "",
            items: [removed],
          });
          expect(
            await fixture.store.fetchArchive(RESEARCHES_LEDGER, "M999"),
          ).toMatchObject({ kind: "group" });
        }
        expect(derivePredicates(fixture.store).pPlan.items).toContain("G1");
        expect(
          (
            await fixture.lifecycle.claimPlan({
              goalId: "G1",
              purpose: "initial",
              claimRequestId: `${disposition}-resume`,
              ownerFenceToken: OWNER_B,
              expectedGeneration: 1,
              ...PROVENANCE,
            })
          ).ok,
        ).toBe(true);
      } finally {
        await fixture.dispose();
      }
    });
  }

  it("clears waits on claim and replaces them on the next research pause", async () => {
    const fixture = await buildFixture();
    try {
      const first = await claimInitial(fixture, "replace-1", OWNER_A, null);
      const [firstResearch] = await pauseForResearches(fixture, first, "replace-pause-1");
      if (firstResearch === undefined) throw new Error("first research missing");
      await fixture.setResearchStatus(firstResearch, "concluded");
      const second = await claimInitial(fixture, "replace-2", OWNER_B, 1);
      expect((await fixture.observe("G1")).waitingResearches).toEqual([]);
      const replacements = await pauseForResearches(
        fixture,
        second,
        "replace-pause-2",
        ["first", "second"],
      );
      expect(replacements).toHaveLength(2);
      expect(replacements).not.toContain(firstResearch);
      expect((await fixture.observe("G1")).waitingResearches).toEqual(replacements);
    } finally {
      await fixture.dispose();
    }
  });

  for (const targetStatus of ["done", "abandoned"] as const) {
    it(`rejects an unfinalized managed draft task transition to ${targetStatus}`, async () => {
      const fixture = await buildFixture();
      try {
        const claim = await claimInitial(
          fixture,
          `terminal-bypass-${targetStatus}`,
          OWNER_A,
          null,
        );
        const published = await fixture.lifecycle.publishPlanDraft({
          goalId: "G1",
          claimId: claim.claimId,
          generation: claim.generation,
          operationId: `terminal-bypass-publish-${targetStatus}`,
          ownerFenceToken: claim.ownerFenceToken,
          ...PROVENANCE,
          manifest: {
            milestones: [{ key: "delivery", title: "Delivery" }],
            tasks: [
              {
                key: "implementation",
                milestoneKey: "delivery",
                headline: "Implementation",
              },
            ],
          },
        });
        if (!published.ok) throw new Error("draft publication failed");
        const taskId = published.acknowledgement.manifest.tasks[0]?.id;
        if (taskId === undefined) throw new Error("task allocation missing");

        await expect(
          fixture.store.updateItem(TASKS_LEDGER, taskId, {
            status: targetStatus,
          }),
        ).rejects.toThrow(/draft|superseded/);
        expect(fixture.store.fetchItem(TASKS_LEDGER, taskId).status).toBe("planned");
      } finally {
        await fixture.dispose();
      }
    });
  }

  it("rejects reopening a superseded managed draft task", async () => {
    const fixture = await buildFixture();
    try {
      const claim = await claimInitial(fixture, "reopen-superseded", OWNER_A, null);
      const manifest: PlanDraftManifest = {
        milestones: [{ key: "delivery", title: "Delivery" }],
        tasks: [
          {
            key: "implementation",
            milestoneKey: "delivery",
            headline: "Implementation",
          },
        ],
      };
      const first = await fixture.lifecycle.publishPlanDraft({
        goalId: "G1",
        claimId: claim.claimId,
        generation: claim.generation,
        operationId: "reopen-superseded-first",
        ownerFenceToken: claim.ownerFenceToken,
        ...PROVENANCE,
        manifest,
      });
      if (!first.ok) throw new Error("first draft publication failed");
      const oldTaskId = first.acknowledgement.manifest.tasks[0]?.id;
      if (oldTaskId === undefined) throw new Error("first task allocation missing");
      const replacement = await fixture.lifecycle.publishPlanDraft({
        goalId: "G1",
        claimId: claim.claimId,
        generation: claim.generation,
        operationId: "reopen-superseded-replacement",
        ownerFenceToken: claim.ownerFenceToken,
        ...PROVENANCE,
        manifest,
      });
      if (!replacement.ok) throw new Error("replacement draft publication failed");
      expect(fixture.store.fetchItem(TASKS_LEDGER, oldTaskId).status).toBe("abandoned");

      await expect(
        fixture.store.reopenItem(TASKS_LEDGER, oldTaskId, "wip"),
      ).rejects.toThrow(/draft|superseded/);
      expect(fixture.store.fetchItem(TASKS_LEDGER, oldTaskId).status).toBe("abandoned");
    } finally {
      await fixture.dispose();
    }
  });

  for (const replacement of [[], ["goals:G999"]] as const) {
    it(`rejects replacing managed task ownership refs with ${JSON.stringify(replacement)}`, async () => {
      const fixture = await buildFixture("planned", 1);
      try {
        await fixture.seedWork("G1", {
          taskStatuses: ["planned"],
          openQuestionCount: 0,
          legacy: false,
        });
        const task = (await fixture.observe("G1")).tasks[0];
        if (task === undefined) throw new Error("managed task missing");

        await expect(
          fixture.store.updateItem(TASKS_LEDGER, task.id, {
            fields: { ledgerRefs: [...replacement] },
          }),
        ).rejects.toThrow(/only through PlanLifecycleStore/);
        expect(fixture.store.fetchItem(TASKS_LEDGER, task.id).fields["ledgerRefs"])
          .toEqual(["goals:G1"]);
      } finally {
        await fixture.dispose();
      }
    });
  }

  for (const terminalStatus of ["done", "abandoned"] as const) {
    it(`rejects reopening a managed ${terminalStatus} goal to planning`, async () => {
      const fixture = await buildFixture("planned", 1);
      try {
        if (terminalStatus === "done") {
          await fixture.store.updateItem(GOALS_LEDGER, "G1", {
            status: "building",
          });
        }
        await fixture.store.updateItem(GOALS_LEDGER, "G1", {
          status: terminalStatus,
        });

        await expect(
          fixture.store.reopenItem(GOALS_LEDGER, "G1", "planning"),
        ).rejects.toThrow(/only through PlanLifecycleStore/);
        expect(fixture.store.fetchItem(GOALS_LEDGER, "G1").status).toBe(
          terminalStatus,
        );
      } finally {
        await fixture.dispose();
      }
    });
  }

  it("keeps a building goal with wip work out of initial planning claims", async () => {
    const fixture = await buildFixture("planned", 1);
    try {
      await fixture.seedWork("G1", {
        taskStatuses: ["wip"],
        openQuestionCount: 0,
        legacy: false,
      });
      await fixture.store.updateItem(GOALS_LEDGER, "G1", {
        status: "building",
      });
      let rawTransitionRejected = false;
      try {
        await fixture.store.updateItem(GOALS_LEDGER, "G1", {
          status: "planning",
        });
      } catch {
        rawTransitionRejected = true;
      }
      const claim = await fixture.lifecycle.claimPlan({
        goalId: "G1",
        purpose: "initial",
        claimRequestId: "building-bypass",
        ownerFenceToken: OWNER_A,
        expectedGeneration: 1,
        ...PROVENANCE,
      });

      expect({
        rawTransitionRejected,
        phase: (await fixture.observe("G1")).phase,
        taskStatus: (await fixture.observe("G1")).tasks[0]?.status,
        claim: claim.ok ? "claimed" : claim.conflict.code,
      }).toEqual({
        rawTransitionRejected: true,
        phase: "building",
        taskStatus: "wip",
        claim: "goal-phase-conflict",
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects raw abandonment while the active owner can finalize", async () => {
    const fixture = await buildFixture();
    try {
      const claim = await claimInitial(fixture, "abandon-finalize", OWNER_A, null);
      const published = await fixture.lifecycle.publishPlanDraft({
        goalId: "G1",
        claimId: claim.claimId,
        generation: claim.generation,
        operationId: "abandon-finalize-publish",
        ownerFenceToken: claim.ownerFenceToken,
        ...PROVENANCE,
        manifest: {
          milestones: [{ key: "delivery", title: "Delivery" }],
          tasks: [
            {
              key: "implementation",
              milestoneKey: "delivery",
              headline: "Implementation",
            },
          ],
        },
      });
      if (!published.ok) throw new Error("draft publication failed");
      const draft = {
        goalId: "G1",
        claimId: claim.claimId,
        generation: claim.generation,
        revision: published.acknowledgement.manifest.revision,
      };
      await fixture.seedReview({
        reviewId: "R1",
        goalId: "G1",
        status: "go-ahead",
        draft,
        provenance: PROVENANCE,
      });

      let rawAbandonmentRejected = false;
      try {
        await fixture.store.updateItem(GOALS_LEDGER, "G1", {
          status: "abandoned",
        });
      } catch {
        rawAbandonmentRejected = true;
      }
      const phaseBeforeFinalize = (await fixture.observe("G1")).phase;
      const finalized = await fixture.lifecycle.finalizePlan({
        goalId: "G1",
        claimId: claim.claimId,
        generation: claim.generation,
        operationId: "abandon-finalize",
        ownerFenceToken: claim.ownerFenceToken,
        ...PROVENANCE,
        reviewId: "R1",
        draftRevision: draft.revision,
        decision: { headline: "Approve delivery" },
      });

      expect({
        rawAbandonmentRejected,
        phaseBeforeFinalize,
        finalized: finalized.ok,
        finalPhase: (await fixture.observe("G1")).phase,
      }).toEqual({
        rawAbandonmentRejected: true,
        phaseBeforeFinalize: "planning",
        finalized: true,
        finalPhase: "planned",
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects raw abandonment while the active claim can release", async () => {
    const fixture = await buildFixture();
    try {
      const claim = await claimInitial(fixture, "abandon-release", OWNER_A, null);
      let rawAbandonmentRejected = false;
      try {
        await fixture.store.updateItem(GOALS_LEDGER, "G1", {
          status: "abandoned",
        });
      } catch {
        rawAbandonmentRejected = true;
      }
      const phaseBeforeRelease = (await fixture.observe("G1")).phase;
      const released = await fixture.lifecycle.releasePlanClaim({
        kind: "abandon",
        goalId: "G1",
        claimId: claim.claimId,
        generation: claim.generation,
        operationId: "abandon-release",
        reason: "Stop this planning attempt",
        ...PROVENANCE,
      });

      expect({
        rawAbandonmentRejected,
        phaseBeforeRelease,
        released: released.ok,
        finalPhase: (await fixture.observe("G1")).phase,
      }).toEqual({
        rawAbandonmentRejected: true,
        phaseBeforeRelease: "planning",
        released: true,
        finalPhase: "planning",
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects starting a managed task while an active research dependency gates it", async () => {
    const fixture = await buildFixture("planned", 1);
    try {
      await fixture.seedWork("G1", {
        taskStatuses: ["planned"],
        openQuestionCount: 0,
        legacy: false,
      });
      const task = (await fixture.observe("G1")).tasks[0];
      if (task === undefined) throw new Error("managed task missing");
      const research = await fixture.store.createItem(
        RESEARCHES_LEDGER,
        MILESTONES_AMBIENT_ID,
        {
          status: "open",
          fields: { question: "Is the dependency complete?" },
        },
      );
      await fixture.store.updateItem(TASKS_LEDGER, task.id, {
        fields: { dependsOn: [`${RESEARCHES_LEDGER}:${research.id}`] },
      });

      await expect(
        fixture.store.updateItem(TASKS_LEDGER, task.id, { status: "wip" }),
      ).rejects.toThrow(/dependencies/);
      expect(fixture.store.fetchItem(TASKS_LEDGER, task.id).status).toBe("planned");
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects reopening a managed task while its milestone dependencies gate it", async () => {
    const fixture = await buildFixture("planned", 1);
    try {
      await fixture.seedWork("G1", {
        taskStatuses: ["abandoned"],
        openQuestionCount: 0,
        legacy: false,
      });
      const task = (await fixture.observe("G1")).tasks[0];
      if (task === undefined) throw new Error("managed task missing");
      const dependencyMilestone = await fixture.store.createMilestone({
        title: "Dependency milestone",
      });
      await fixture.store.createItem(TASKS_LEDGER, dependencyMilestone.id, {
        status: "planned",
        fields: { headline: "Unfinished prerequisite" },
      });
      await fixture.store.updateMilestone(task.milestoneId, {
        dependsOn: [`${MILESTONES_LEDGER}:${dependencyMilestone.id}`],
      });

      await expect(
        fixture.store.reopenItem(TASKS_LEDGER, task.id, "wip"),
      ).rejects.toThrow(/dependencies/);
      expect(fixture.store.fetchItem(TASKS_LEDGER, task.id).status).toBe(
        "abandoned",
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects reopening a finalized managed task to wip with unfinished dependencies", async () => {
    const fixture = await buildFixture("planned", 1);
    try {
      await fixture.seedWork("G1", {
        taskStatuses: ["planned", "abandoned"],
        openQuestionCount: 0,
        legacy: false,
      });
      const state = await fixture.observe("G1");
      const dependent = state.tasks.find(({ dependsOn }) => dependsOn.length > 0);
      if (dependent === undefined) throw new Error("dependent task missing");
      expect(dependent.status).toBe("abandoned");

      await expect(
        fixture.store.reopenItem(TASKS_LEDGER, dependent.id, "wip"),
      ).rejects.toThrow(/dependencies/);
      expect(fixture.store.fetchItem(TASKS_LEDGER, dependent.id).status).toBe(
        "abandoned",
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("persists canonical ledger prefixes for materialized internal draft references", async () => {
    const fixture = await buildFixture();
    try {
      const claim = await claimInitial(fixture, "canonical-internal-refs", OWNER_A, null);
      const published = await fixture.lifecycle.publishPlanDraft({
        goalId: "G1",
        claimId: claim.claimId,
        generation: claim.generation,
        operationId: "canonical-internal-refs-publish",
        ownerFenceToken: claim.ownerFenceToken,
        ...PROVENANCE,
        manifest: {
          milestones: [
            { key: "design", title: "Design" },
            {
              key: "delivery",
              title: "Delivery",
              dependsOn: [{ kind: "draft-milestone", key: "design" }],
            },
          ],
          tasks: [
            {
              key: "contract",
              milestoneKey: "design",
              headline: "Contract",
              dependsOn: [{ kind: "draft-milestone", key: "delivery" }],
            },
            {
              key: "implementation",
              milestoneKey: "delivery",
              headline: "Implementation",
              dependsOn: [{ kind: "draft-task", key: "contract" }],
              blockedBy: [{ kind: "draft-task", key: "contract" }],
            },
          ],
        },
      });
      if (!published.ok) throw new Error("draft publication failed");
      const allocations = Object.fromEntries([
        ...published.acknowledgement.manifest.milestones.map(({ key, id }) => [
          key,
          id,
        ]),
        ...published.acknowledgement.manifest.tasks.map(({ key, id }) => [key, id]),
      ]);
      const designId = allocations["design"];
      const deliveryId = allocations["delivery"];
      const contractId = allocations["contract"];
      const implementationId = allocations["implementation"];
      if (
        designId === undefined ||
        deliveryId === undefined ||
        contractId === undefined ||
        implementationId === undefined
      ) {
        throw new Error("draft allocations missing");
      }

      expect(
        fixture.store.fetchItem(MILESTONES_LEDGER, deliveryId).fields["dependsOn"],
      ).toEqual([`${MILESTONES_LEDGER}:${designId}`]);
      expect(fixture.store.fetchItem(TASKS_LEDGER, contractId).fields["dependsOn"])
        .toEqual([`${MILESTONES_LEDGER}:${deliveryId}`]);
      expect(
        fixture.store.fetchItem(TASKS_LEDGER, implementationId).fields["dependsOn"],
      ).toEqual([`${TASKS_LEDGER}:${contractId}`]);
      expect(
        fixture.store.fetchItem(TASKS_LEDGER, implementationId).fields["blockedBy"],
      ).toEqual([`${TASKS_LEDGER}:${contractId}`]);
    } finally {
      await fixture.dispose();
    }
  });

  it("persists only the claim request and SHA-256 verifier outside the live acknowledgement", async () => {
    const fixture = await buildFixture();
    try {
      const claim = await claimInitial(fixture, "redaction", OWNER_A, null);
      expect(claim.ownerFenceToken).toBe(OWNER_A);
      const publicState = JSON.stringify({
        goal: fixture.store.fetchItem(GOALS_LEDGER, "G1"),
        snapshot: fixture.store.snapshot(),
      });
      expect(publicState).not.toContain(OWNER_A);
      expect(publicState).not.toContain("ownerFenceTokenVerifier");
      const privateState = JSON.stringify([...internals(fixture.store).planClaims.values()]);
      expect(privateState).not.toContain(OWNER_A);
      expect(privateState).toContain(
        createHash("sha256").update(OWNER_A, "utf8").digest("hex"),
      );
      expect(privateState).toContain("redaction");
      const restarted = await fixture.restart();
      expect(
        await restarted.lifecycle.claimPlan({
          goalId: "G1",
          purpose: "initial",
          claimRequestId: "redaction",
          ownerFenceToken: OWNER_A,
          expectedGeneration: null,
          ...PROVENANCE,
        }),
      ).toMatchObject({ ok: true, replayed: true });
    } finally {
      await fixture.dispose();
    }
  });

  for (const [status, expected] of [
    ["planned", { outcome: "replace", status: "abandoned" }],
    ["wip", { outcome: "reject", status: "wip" }],
    ["blocked", { outcome: "reject", status: "blocked" }],
    ["done", { outcome: "drained", status: "done" }],
    ["abandoned", { outcome: "drained", status: "abandoned" }],
  ] as const) {
    it(`handles the total follow-up task state ${status}`, async () => {
      const fixture = await buildFixture("planned", 1);
      try {
        await fixture.seedWork("G1", {
          taskStatuses: [status as ReferencePublicTask["status"]],
          openQuestionCount: 0,
          legacy: false,
        });
        const result = await fixture.lifecycle.claimPlan({
          goalId: "G1",
          purpose: "follow-up",
          claimRequestId: `task-${status}`,
          ownerFenceToken: OWNER_A,
          expectedGeneration: 1,
          ...PROVENANCE,
        });
        if (expected.outcome === "reject") {
          expect(result).toMatchObject({
            ok: false,
            conflict: { code: "implementation-active" },
          });
        } else {
          expect(result.ok).toBe(true);
        }
        expect((await fixture.observe("G1")).tasks[0]?.status).toBe(expected.status);
      } finally {
        await fixture.dispose();
      }
    });
  }

  it("keeps old schemas/restored state additive and guards raw managed writes", async () => {
    const managedFields = [
      "planGeneration",
      "planActiveClaim",
      "planCurrentDraft",
      "planFinalizedDraft",
      "planFinalizedManifest",
      "waitingResearches",
      "waitingTasks",
    ];
    const oldSchema = {
      ...GOALS_SCHEMA,
      fields: Object.fromEntries(
        Object.entries(GOALS_SCHEMA.fields).filter(
          ([name]) => !managedFields.includes(name),
        ),
      ),
    };
    expect(schemaCompatible(oldSchema, GOALS_SCHEMA)).toBe(true);

    const store = new InMemoryLedgerStore();
    await store.init();
    try {
      await expect(
        store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
          id: "G1",
          status: "clarifying",
          fields: {
            title: "forbidden",
            description: "raw managed create",
            [PLAN_GENERATION_FIELD]: "1",
          },
        }),
      ).rejects.toThrow(/only through PlanLifecycleStore/);
      await store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
        id: "G2",
        status: "clarifying",
        fields: { title: "legacy", description: "unmanaged goal" },
      });
      expect((await store.updateItem(GOALS_LEDGER, "G2", { status: "abandoned" })).status)
        .toBe("abandoned");
    } finally {
      await store.dispose();
    }
  });

  it("rejects raw planner writes against managed plan state (T854)", async () => {
    const fixture = await buildFixture();
    try {
      const claim = await claimInitial(fixture, "raw-planner-writes", OWNER_A, null);
      const before = await fixture.observe("G1");

      // A planner writing a task onto the managed goal DIRECTLY (bypassing
      // publishPlanDraft) is refused.
      await expect(
        fixture.store.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
          status: "planned",
          fields: {
            headline: "planner bypass task",
            ledgerRefs: ["goals:G1"],
          },
        }),
      ).rejects.toThrow(/only through PlanLifecycleStore/);

      // So is every raw rewrite of the goal's MANAGED plan fields.
      for (const fields of [
        { waitingResearches: ["RS1"] },
        { waitingTasks: ["T1"] },
        { planCurrentDraft: "null" },
        { planFinalizedManifest: "{}" },
        { planActiveClaim: "{}" },
        { milestones: ["M999"] },
      ]) {
        await expect(
          fixture.store.updateItem(GOALS_LEDGER, "G1", { fields }),
        ).rejects.toThrow(/only through PlanLifecycleStore/);
      }

      // The managed state is undisturbed and the claimed round still works.
      expect(await fixture.observe("G1")).toEqual(before);
      expect(
        (
          await fixture.lifecycle.releasePlanClaim({
            kind: "abandon",
            goalId: "G1",
            claimId: claim.claimId,
            generation: claim.generation,
            operationId: "raw-planner-writes-abandon",
            reason: "guard probe complete",
            ...PROVENANCE,
          })
        ).ok,
      ).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  it("keeps research-wait status interpretation structurally single-owned", async () => {
    const [predicateSource, lifecycleSource] = await Promise.all([
      readFile(new URL("../src/store/predicates.ts", import.meta.url), "utf8"),
      readFile(
        new URL("../src/store/inMemoryPlanLifecycle.ts", import.meta.url),
        "utf8",
      ),
    ]);
    expect(
      predicateSource.match(
        /const activeStatuses = new Set\(\["open", "wip", "inconclusive"\]\)/g,
      ),
    )
      .toHaveLength(1);
    expect(lifecycleSource).toContain("activePlanResearchWaits");
    expect(lifecycleSource).not.toMatch(/status === "inconclusive"/);
    expect(lifecycleSource).not.toMatch(/status === "concluded"/);
  });

  it("normalizes bare and canonical task refs to the same tasks pause acknowledgement", async () => {
    const fixture = await buildFixture();
    try {
      const bareClaim = await claimInitial(fixture, "task-ref-bare", OWNER_A, null);
      const bareTaskId = await publishOneTask(fixture, bareClaim, "task-ref-bare-publish");
      const bareAck = await pauseForTasks(fixture, bareClaim, "task-ref-bare-pause", [
        bareTaskId,
      ]);
      expect(bareAck).toMatchObject({
        kind: "tasks",
        tasks: [bareTaskId],
        waitingTasks: [bareTaskId],
        researches: [],
        waitingResearches: [],
        goalPhase: "planning",
      });
      expect((await fixture.observe("G1")).waitingTasks).toEqual([bareTaskId]);
      expect((await fixture.observe("G1")).waitingResearches).toEqual([]);

      await fixture.setTaskStatus(bareTaskId, "done");
      const canonicalClaim = await claimInitial(fixture, "task-ref-canonical", OWNER_B, 1);
      expect(canonicalClaim.waitingTasks).toEqual([]);
      expect((await fixture.observe("G1")).waitingTasks).toEqual([]);
      const canonicalTaskId = await publishOneTask(
        fixture,
        canonicalClaim,
        "task-ref-canonical-publish",
      );
      const canonicalAck = await pauseForTasks(
        fixture,
        canonicalClaim,
        "task-ref-canonical-pause",
        [`tasks:${canonicalTaskId}`],
      );
      expect(canonicalAck).toMatchObject({
        kind: "tasks",
        tasks: [canonicalTaskId],
        waitingTasks: [canonicalTaskId],
      });
      expect((await fixture.observe("G1")).waitingTasks).toEqual([canonicalTaskId]);
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects duplicate, malformed, wrong-ledger, absent, and all-terminal task pauses without releasing the claim", async () => {
    const fixture = await buildFixture();
    try {
      const claim = await claimInitial(fixture, "task-reject", OWNER_A, null);
      const taskId = await publishOneTask(fixture, claim, "task-reject-publish");

      const stillClaimed = async (): Promise<void> => {
        const observed = await fixture.observe("G1");
        expect(observed.activeClaim?.claimId).toBe(claim.claimId);
        expect(observed.waitingTasks).toEqual([]);
      };

      await expect(
        fixture.lifecycle.releasePlanClaim({
          kind: "pause",
          goalId: "G1",
          claimId: claim.claimId,
          generation: claim.generation,
          operationId: "dup-task-pause",
          ownerFenceToken: claim.ownerFenceToken,
          ...PROVENANCE,
          effect: { kind: "tasks", tasks: [taskId, `tasks:${taskId}`] },
        }),
      ).rejects.toThrow();
      await stillClaimed();

      await expect(
        fixture.lifecycle.releasePlanClaim({
          kind: "pause",
          goalId: "G1",
          claimId: claim.claimId,
          generation: claim.generation,
          operationId: "malformed-task-pause",
          ownerFenceToken: claim.ownerFenceToken,
          ...PROVENANCE,
          effect: { kind: "tasks", tasks: ["not-a-task"] },
        }),
      ).rejects.toThrow();
      await stillClaimed();

      await expect(
        fixture.lifecycle.releasePlanClaim({
          kind: "pause",
          goalId: "G1",
          claimId: claim.claimId,
          generation: claim.generation,
          operationId: "wrong-ledger-task-pause",
          ownerFenceToken: claim.ownerFenceToken,
          ...PROVENANCE,
          effect: { kind: "tasks", tasks: ["researches:RS1"] as unknown as string[] },
        }),
      ).rejects.toThrow();
      await stillClaimed();

      await expect(
        fixture.lifecycle.releasePlanClaim({
          kind: "pause",
          goalId: "G1",
          claimId: claim.claimId,
          generation: claim.generation,
          operationId: "absent-task-pause",
          ownerFenceToken: claim.ownerFenceToken,
          ...PROVENANCE,
          effect: { kind: "tasks", tasks: ["T99999"] },
        }),
      ).rejects.toThrow(/absent/);
      await stillClaimed();

      await fixture.setTaskStatus(taskId, "done");
      await expect(
        fixture.lifecycle.releasePlanClaim({
          kind: "pause",
          goalId: "G1",
          claimId: claim.claimId,
          generation: claim.generation,
          operationId: "all-terminal-task-pause",
          ownerFenceToken: claim.ownerFenceToken,
          ...PROVENANCE,
          effect: { kind: "tasks", tasks: [taskId] },
        }),
      ).rejects.toThrow(/terminal/);
      await stillClaimed();
    } finally {
      await fixture.dispose();
    }
  });

  it("does not route a tasks pause to abandonment or the research branch", async () => {
    const fixture = await buildFixture();
    try {
      const claim = await claimInitial(fixture, "task-discriminate", OWNER_A, null);
      const taskId = await publishOneTask(fixture, claim, "task-discriminate-publish");
      const ack = await pauseForTasks(fixture, claim, "task-discriminate-pause", [taskId]);
      expect(ack.kind).toBe("tasks");
      expect(ack.kind).not.toBe("abandon");
      expect(ack.kind).not.toBe("researches");
      if (ack.kind !== "tasks") throw new Error("expected tasks acknowledgement");
      expect(ack.researches).toEqual([]);
      expect(ack.waitingResearches).toEqual([]);
      expect(ack.tasks).toEqual([taskId]);
      expect(ack.waitingTasks).toEqual([taskId]);
      const observed = await fixture.observe("G1");
      expect(observed.waitingResearches).toEqual([]);
      expect(observed.waitingTasks).toEqual([taskId]);
      expect(observed.researches).toEqual([]);
      expect(observed.phase).toBe("planning");
      expect(observed.activeClaim).toBeNull();
    } finally {
      await fixture.dispose();
    }
  });

  for (const [status, suppressed] of [
    ["planned", true],
    ["wip", true],
    ["blocked", true],
    ["done", false],
    ["abandoned", false],
  ] as const) {
    it(`owns ${status} task-wait disposition in derivePredicates and claim`, async () => {
      const fixture = await buildFixture();
      try {
        const claim = await claimInitial(fixture, `task-wait-${status}`, OWNER_A, null);
        const taskId = await publishOneTask(
          fixture,
          claim,
          `task-wait-${status}-publish`,
        );
        await pauseForTasks(fixture, claim, `task-wait-${status}-pause`, [taskId]);
        await fixture.setTaskStatus(taskId, status);
        const predicates = derivePredicates(fixture.store);
        expect(predicates.pPlan.items.includes("G1")).toBe(!suppressed);
        const resumed = await fixture.lifecycle.claimPlan({
          goalId: "G1",
          purpose: "initial",
          claimRequestId: `task-resume-${status}`,
          ownerFenceToken: OWNER_B,
          expectedGeneration: 1,
          ...PROVENANCE,
        });
        if (suppressed) {
          expect(resumed).toEqual({
            ok: false,
            conflict: {
              code: "task-wait-active",
              goalId: "G1",
              taskIds: [taskId],
            },
          });
        } else {
          expect(resumed.ok).toBe(true);
          if (!resumed.ok) throw new Error("expected successful claim");
          expect(resumed.acknowledgement.waitingTasks).toEqual([]);
          expect((await fixture.observe("G1")).waitingTasks).toEqual([]);
        }
      } finally {
        await fixture.dispose();
      }
    });
  }

  for (const disposition of ["missing", "archived"] as const) {
    it(`re-enables planning for a ${disposition} waited task`, async () => {
      const fixture = await buildFixture();
      try {
        const claim = await claimInitial(
          fixture,
          `task-${disposition}-claim`,
          OWNER_A,
          null,
        );
        const taskId = await publishOneTask(
          fixture,
          claim,
          `task-${disposition}-publish`,
        );
        await pauseForTasks(fixture, claim, `task-${disposition}-pause`, [taskId]);
        const state = internals(fixture.store);
        const tasks = state.ledgers.get(TASKS_LEDGER);
        if (tasks === undefined) throw new Error("tasks ledger missing");
        let removed: Item | undefined;
        for (const milestone of tasks.milestones) {
          const index = milestone.items.findIndex(({ id }) => id === taskId);
          if (index >= 0) [removed] = milestone.items.splice(index, 1);
        }
        if (removed === undefined) throw new Error("task removal failed");
        if (disposition === "archived") {
          state.archives.set(`${TASKS_LEDGER}/M999`, {
            id: "M999",
            title: "",
            description: "",
            items: [removed],
          });
          expect(
            await fixture.store.fetchArchive(TASKS_LEDGER, "M999"),
          ).toMatchObject({ kind: "group" });
        }
        expect(derivePredicates(fixture.store).pPlan.items).toContain("G1");
        expect(
          (
            await fixture.lifecycle.claimPlan({
              goalId: "G1",
              purpose: "initial",
              claimRequestId: `task-${disposition}-resume`,
              ownerFenceToken: OWNER_B,
              expectedGeneration: 1,
              ...PROVENANCE,
            })
          ).ok,
        ).toBe(true);
      } finally {
        await fixture.dispose();
      }
    });
  }

  it("clears waitingTasks on questions/researches/abandon releases and pins empty on claim", async () => {
    const fixture = await buildFixture();
    try {
      const first = await claimInitial(fixture, "clear-tasks-1", OWNER_A, null);
      const taskId = await publishOneTask(fixture, first, "clear-tasks-publish");
      await pauseForTasks(fixture, first, "clear-tasks-pause", [taskId]);
      expect((await fixture.observe("G1")).waitingTasks).toEqual([taskId]);

      await fixture.setTaskStatus(taskId, "done");
      const second = await claimInitial(fixture, "clear-tasks-2", OWNER_B, 1);
      expect(second.waitingTasks).toEqual([]);
      expect((await fixture.observe("G1")).waitingTasks).toEqual([]);

      const thirdTask = await publishOneTask(fixture, second, "clear-tasks-publish-2");
      await pauseForTasks(fixture, second, "clear-tasks-pause-2", [thirdTask]);
      await fixture.setTaskStatus(thirdTask, "done");
      const third = await claimInitial(fixture, "clear-tasks-3", OWNER_A, 2);
      const researchPause = await fixture.lifecycle.releasePlanClaim({
        kind: "pause",
        goalId: "G1",
        claimId: third.claimId,
        generation: third.generation,
        operationId: "clear-via-research",
        ownerFenceToken: third.ownerFenceToken,
        ...PROVENANCE,
        effect: {
          kind: "researches",
          researches: [{ key: "probe", question: "still research?" }],
        },
      });
      if (!researchPause.ok || researchPause.acknowledgement.kind !== "researches") {
        throw new Error("research pause failed");
      }
      expect(researchPause.acknowledgement.tasks).toEqual([]);
      expect(researchPause.acknowledgement.waitingTasks).toEqual([]);
      expect((await fixture.observe("G1")).waitingTasks).toEqual([]);

      const researchId = researchPause.acknowledgement.waitingResearches[0]!;
      await fixture.setResearchStatus(researchId, "concluded");
      const fourth = await claimInitial(fixture, "clear-tasks-4", OWNER_B, 3);
      const fourthTask = await publishOneTask(fixture, fourth, "clear-tasks-publish-3");
      await pauseForTasks(fixture, fourth, "clear-tasks-pause-3", [fourthTask]);
      await fixture.setTaskStatus(fourthTask, "done");
      const fifth = await claimInitial(fixture, "clear-tasks-5", OWNER_A, 4);
      const abandoned = await fixture.lifecycle.releasePlanClaim({
        kind: "abandon",
        goalId: "G1",
        claimId: fifth.claimId,
        generation: fifth.generation,
        operationId: "clear-via-abandon",
        reason: "clear waits",
        ...PROVENANCE,
      });
      if (!abandoned.ok || abandoned.acknowledgement.kind !== "abandon") {
        throw new Error("abandon failed");
      }
      expect(abandoned.acknowledgement.tasks).toEqual([]);
      expect(abandoned.acknowledgement.waitingTasks).toEqual([]);
      expect((await fixture.observe("G1")).waitingTasks).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  it("keeps task-wait status interpretation structurally single-owned", async () => {
    const [predicateSource, lifecycleSource] = await Promise.all([
      readFile(new URL("../src/store/predicates.ts", import.meta.url), "utf8"),
      readFile(
        new URL("../src/store/inMemoryPlanLifecycle.ts", import.meta.url),
        "utf8",
      ),
    ]);
    expect(
      predicateSource.match(
        /const activeStatuses = new Set\(\["planned", "wip", "blocked"\]\)/g,
      ),
    ).toHaveLength(1);
    expect(lifecycleSource).toContain("activePlanTaskWaits");
    // Claim must not re-implement the wait table inline; only the helper owns it.
    expect(lifecycleSource).not.toMatch(
      /waitingTasks.*status === "planned"|status === "planned".*waitingTasks/,
    );
    expect(lifecycleSource).not.toMatch(
      /PLAN_WAITING_TASKS_FIELD[\s\S]{0,200}status === "wip"/,
    );
  });
});
