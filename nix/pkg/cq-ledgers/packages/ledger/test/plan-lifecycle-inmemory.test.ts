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
});
