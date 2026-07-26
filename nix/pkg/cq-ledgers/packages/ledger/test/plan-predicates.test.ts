/**
 * T853 (G99 / D134 / H117) — CROSS-BACKEND predicate coverage for the guarded
 * plan lifecycle: discovery (P-plan) and task start (P-implement) gated on the
 * ACTIVE CLAIM and on FINALIZED-manifest membership.
 *
 * ONE abstract suite runs against EVERY production adapter — the InMemory
 * reference (T848), Fs, Git-object, SQLite, and (env-gated on CQ_TEST_PG_URL,
 * Q286) Postgres — driving each store through its REAL `PlanLifecycleStore`
 * surface (claim → publish → review → finalize → release) and asserting
 * `derivePredicates(store)` after every step:
 *
 *  (busy)     an ACTIVE plan claim suppresses P-plan and surfaces in the
 *             report-only `planBusy` companion; a tokenless exact abandon
 *             release re-enables planning;
 *  (wait)     a researches-pause wait ref SUPPRESSES P-plan while the research
 *             is open/wip/inconclusive and RE-ENABLES at concluded/abandoned —
 *             or once the research has left the ACTIVE view (the missing and
 *             archived cases of PLAN_RESEARCH_WAIT_DISPOSITION, which are
 *             indistinguishable at the read layer: derivePredicates sees only
 *             the active view);
 *  (clearing) the next claim CLEARS/REPLACES the wait set: after a successful
 *             claim + abandon release the goal is plannable again, and a
 *             re-pause installs a fresh wait set that suppresses and
 *             re-enables in turn;
 *  (manifest) DRAFT tasks (published, not yet finalized) and SUPERSEDED-
 *             manifest tasks are EXCLUDED from P-implement; the FINALIZED
 *             current manifest EXECUTES across generations; a
 *             planned→building→planned transition keeps the ready set
 *             ("transitions remain"); a LEGACY goal (no planGeneration) keeps
 *             its pre-G99 ready set throughout;
 *  (off-manifest) a goal-linked task that never entered the finalized
 *             manifest — the Q337 duplicate-DAG leak — is EXCLUDED from
 *             P-implement even when non-terminal and dependency-free.
 *
 * The research-wait STATUS TABLE stays single-owned by T848's
 * `activePlanResearchWaits` (store/predicates.ts): this suite CONSUMES it via
 * derivePredicates and never re-implements it. The closing structural guard
 * proves no other package source re-interprets the wait statuses.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "bun:test";
import {
  derivePredicates,
  FsLedgerStore,
  GitObjectLedgerBackend,
  GOALS_LEDGER,
  InMemoryLedgerStore,
  type Item,
  type LedgerStore,
  MILESTONES_AMBIENT_ID,
  openPgPool,
  PLAN_REVIEW_DRAFT_FIELD,
  type PlanClaimAcknowledgement,
  type PlanDraftManifest,
  type PlanLifecycleStore,
  RESEARCHES_LEDGER,
  REVIEWS_LEDGER,
  SqliteLedgerStore,
  TASKS_LEDGER,
} from "../src/index.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { persistDirectLedgers } from "./planLifecycleInMemoryAdapter.js";
import {
  dropTenant,
  openTenantStore,
  postgresTestDsn,
  T851_PROJECT_KEY_PREFIX,
} from "./planLifecyclePostgresAdapter.js";

type LifecycleStore = LedgerStore & PlanLifecycleStore;

const GOAL_ID = "G1";
const LEGACY_GOAL_ID = "G9";
const OWNER_TOKEN = "A".repeat(22);
const PROVENANCE = { author: "planner", session: "planner-session" } as const;

/** Research-wait dispositions that SUPPRESS P-plan (active research). */
const SUPPRESSING_RESEARCH_STATUSES = ["open", "wip", "inconclusive"] as const;
/** Research-wait dispositions that RE-ENABLE P-plan (terminal research). */
const RESUMING_RESEARCH_STATUSES = ["concluded", "abandoned"] as const;

// --- backend registry -------------------------------------------------------

interface Backend {
  readonly name: string;
  readonly skip?: boolean;
  build(): Promise<LifecycleStore>;
  /**
   * Remove a pause-created research from the ACTIVE view — the "missing" and
   * "archived" wait-ref equivalence class. `derivePredicates` reads only the
   * active view, so removal IS the predicate-observable content of both
   * dispositions; the InMemory leg additionally records the item in its
   * archive map (proving the archived side remains fetchable), while the
   * durable archive formats of the fs/git/sqlite/postgres backends are
   * covered by their own archive suites.
   */
  removeResearchFromActiveView(
    store: LifecycleStore,
    researchId: string,
    disposition: "missing" | "archived",
  ): Promise<void>;
  dispose(store: LifecycleStore): Promise<void>;
}

/** Splice an item out of an AbstractLedgerStore-style in-memory ledgers map. */
function spliceFromLedgersMap(
  store: LifecycleStore,
  ledgerId: string,
  itemId: string,
): Item {
  const state = store as unknown as {
    ledgers: Map<string, { milestones: Array<{ id: string; items: Item[] }> }>;
  };
  const ledger = state.ledgers.get(ledgerId);
  if (ledger === undefined) throw new Error(`ledger not found: ${ledgerId}`);
  for (const milestone of ledger.milestones) {
    const index = milestone.items.findIndex(({ id }) => id === itemId);
    if (index >= 0) {
      const [removed] = milestone.items.splice(index, 1);
      if (removed === undefined) throw new Error("splice failed");
      return removed;
    }
  }
  throw new Error(`item not found in active view: ${ledgerId}:${itemId}`);
}

const tmpRoots: string[] = [];
async function tmpRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tmpRoots.push(root);
  return root;
}

afterAll(async () => {
  for (const root of tmpRoots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

const inMemoryBackend: Backend = {
  name: "InMemoryLedgerStore",
  async build() {
    const store = new InMemoryLedgerStore();
    await store.init();
    return store;
  },
  async removeResearchFromActiveView(store, researchId, disposition) {
    const removed = spliceFromLedgersMap(store, RESEARCHES_LEDGER, researchId);
    if (disposition === "archived") {
      const state = store as unknown as {
        archives: Map<
          string,
          { id: string; title: string; description: string; items: Item[] }
        >;
      };
      state.archives.set(`${RESEARCHES_LEDGER}/M-ARCH`, {
        id: "M-ARCH",
        title: "",
        description: "",
        items: [removed],
      });
      // The archived side stays fetchable; the predicate reads only the
      // ACTIVE view, so re-enablement is asserted by the suite body.
      expect(await store.fetchArchive(RESEARCHES_LEDGER, "M-ARCH")).toMatchObject({
        kind: "group",
      });
    }
  },
  async dispose(store) {
    await store.dispose();
  },
};

const fsBackend: Backend = {
  name: "FsLedgerStore",
  async build() {
    const root = await tmpRoot("plan-predicates-fs-");
    const store = new FsLedgerStore({ root });
    await store.init();
    return store;
  },
  async removeResearchFromActiveView(store, researchId) {
    spliceFromLedgersMap(store, RESEARCHES_LEDGER, researchId);
    await persistDirectLedgers(store, [RESEARCHES_LEDGER]);
  },
  async dispose(store) {
    await store.dispose();
  },
};

const gitBackend: Backend = {
  name: "GitObjectLedgerBackend",
  async build() {
    const root = await tmpRoot("plan-predicates-git-");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    const store = new GitObjectLedgerBackend({ repoRoot: root });
    await store.init();
    return store;
  },
  async removeResearchFromActiveView(store, researchId) {
    spliceFromLedgersMap(store, RESEARCHES_LEDGER, researchId);
    await persistDirectLedgers(store, [RESEARCHES_LEDGER]);
  },
  async dispose(store) {
    await store.dispose();
  },
};

const sqliteDbPaths = new WeakMap<LifecycleStore, string>();
const sqliteBackend: Backend = {
  name: "SqliteLedgerStore",
  async build() {
    const root = await tmpRoot("plan-predicates-sqlite-");
    const dbPath = path.join(root, "ledger.db");
    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    sqliteDbPaths.set(store, dbPath);
    return store;
  },
  async removeResearchFromActiveView(store, researchId) {
    const dbPath = sqliteDbPaths.get(store);
    if (dbPath === undefined) throw new Error("sqlite fixture lost its dbPath");
    const db = openLedgerDb(dbPath);
    try {
      db.query("DELETE FROM items WHERE ledger = ? AND id = ?").run(
        RESEARCHES_LEDGER,
        researchId,
      );
    } finally {
      db.close();
    }
  },
  async dispose(store) {
    await store.dispose();
  },
};

const pgTenantKeys = new WeakMap<LifecycleStore, string>();
const postgresBackend: Backend = {
  name: "PostgresLedgerStore",
  skip: process.env["CQ_TEST_PG_URL"] === undefined || process.env["CQ_TEST_PG_URL"] === "",
  async build() {
    const key = `${T851_PROJECT_KEY_PREFIX}t853-${randomUUID().slice(0, 8)}`;
    const store = await openTenantStore(postgresTestDsn(), key);
    pgTenantKeys.set(store, key);
    return store;
  },
  async removeResearchFromActiveView(store, researchId) {
    const key = pgTenantKeys.get(store);
    if (key === undefined) throw new Error("postgres fixture lost its tenant key");
    const admin = openPgPool(postgresTestDsn());
    try {
      await admin`
        DELETE FROM items WHERE project_key = ${key} AND ledger = ${RESEARCHES_LEDGER} AND id = ${researchId}
      `;
    } finally {
      await admin.close();
    }
    await store.invalidate(RESEARCHES_LEDGER);
  },
  async dispose(store) {
    const key = pgTenantKeys.get(store);
    await store.dispose();
    if (key === undefined) return;
    const admin = openPgPool(postgresTestDsn());
    try {
      await dropTenant(admin, key);
    } finally {
      await admin.close();
    }
  },
};

const BACKENDS: readonly Backend[] = [
  inMemoryBackend,
  fsBackend,
  gitBackend,
  sqliteBackend,
  postgresBackend,
];

// --- lifecycle drivers (public PlanLifecycleStore surface only) -------------

async function seedLegacyGoal(
  store: LifecycleStore,
  goalId: string,
  status: string,
): Promise<void> {
  await store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: goalId,
    status,
    fields: { title: `goal ${goalId}`, description: `predicate goal ${goalId}` },
    ...PROVENANCE,
  });
}

async function claimInitial(
  store: LifecycleStore,
  goalId: string,
  claimRequestId: string,
  expectedGeneration: number | null,
): Promise<PlanClaimAcknowledgement> {
  const result = await store.claimPlan({
    goalId,
    purpose: "initial",
    claimRequestId,
    ownerFenceToken: OWNER_TOKEN,
    expectedGeneration,
    ...PROVENANCE,
  });
  if (!result.ok) throw new Error(`initial claim failed: ${result.conflict.code}`);
  return result.acknowledgement;
}

async function pauseForResearch(
  store: LifecycleStore,
  claim: PlanClaimAcknowledgement,
  operationId: string,
  key = "probe",
): Promise<string> {
  const result = await store.releasePlanClaim({
    kind: "pause",
    goalId: claim.goalId,
    claimId: claim.claimId,
    generation: claim.generation,
    operationId,
    ownerFenceToken: claim.ownerFenceToken,
    ...PROVENANCE,
    effect: {
      kind: "researches",
      researches: [
        { key, question: "Does the predicate gate hold?", scope: "derivePredicates" },
      ],
    },
  });
  if (!result.ok || result.acknowledgement.kind !== "researches") {
    throw new Error("research pause failed");
  }
  const [researchId] = result.acknowledgement.waitingResearches;
  if (researchId === undefined) throw new Error("research allocation missing");
  return researchId;
}

/** Mirrors the shared fixture's transition walk (researches lifecycle). */
async function setResearchStatus(
  store: LifecycleStore,
  researchId: string,
  status: "open" | "wip" | "inconclusive" | "concluded" | "abandoned",
): Promise<void> {
  const current = store.fetchItem(RESEARCHES_LEDGER, researchId).status;
  if (current === status) return;
  if (current === "open" && ["wip", "inconclusive", "concluded"].includes(status)) {
    await store.updateItem(RESEARCHES_LEDGER, researchId, { status: "wip", ...PROVENANCE });
    if (status === "wip") return;
  }
  await store.updateItem(RESEARCHES_LEDGER, researchId, { status, ...PROVENANCE });
}

async function publishManifest(
  store: LifecycleStore,
  claim: PlanClaimAcknowledgement,
  operationId: string,
  manifest: PlanDraftManifest,
): Promise<void> {
  const result = await store.publishPlanDraft({
    goalId: claim.goalId,
    claimId: claim.claimId,
    generation: claim.generation,
    operationId,
    ownerFenceToken: claim.ownerFenceToken,
    ...PROVENANCE,
    manifest,
  });
  if (!result.ok) throw new Error(`publish failed: ${result.conflict.code}`);
}

async function reviewAndFinalize(
  store: LifecycleStore,
  claim: PlanClaimAcknowledgement,
  reviewId: string,
  draftRevision: number,
  operationId: string,
): Promise<void> {
  await store.createItem(REVIEWS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: reviewId,
    status: "go-ahead",
    fields: {
      summary: "reviewed",
      [PLAN_REVIEW_DRAFT_FIELD]: JSON.stringify({
        goalId: claim.goalId,
        claimId: claim.claimId,
        generation: claim.generation,
        revision: draftRevision,
      }),
      ledgerRefs: [`${GOALS_LEDGER}:${claim.goalId}`],
    },
    author: "reviewer",
    session: "review-session",
  });
  const result = await store.finalizePlan({
    goalId: claim.goalId,
    claimId: claim.claimId,
    generation: claim.generation,
    operationId,
    ownerFenceToken: claim.ownerFenceToken,
    ...PROVENANCE,
    reviewId,
    draftRevision,
    decision: { headline: "Ship the guarded plan" },
  });
  if (!result.ok) throw new Error(`finalize failed: ${result.conflict.code}`);
}

async function abandonClaim(
  store: LifecycleStore,
  claim: PlanClaimAcknowledgement,
  operationId: string,
): Promise<void> {
  const result = await store.releasePlanClaim({
    kind: "abandon",
    goalId: claim.goalId,
    claimId: claim.claimId,
    generation: claim.generation,
    operationId,
    reason: "predicate probe complete",
    ...PROVENANCE,
  });
  if (!result.ok) throw new Error(`abandon release failed: ${result.conflict.code}`);
}

/** All active tasks whose fields.ledgerRefs name `goals:<goalId>`. */
function goalLinkedTasks(store: LifecycleStore, goalId: string): Item[] {
  return store
    .fetch(TASKS_LEDGER)
    .milestones.flatMap(({ items }) => items)
    .filter(
      ({ fields }) =>
        Array.isArray(fields["ledgerRefs"]) &&
        fields["ledgerRefs"].includes(`${GOALS_LEDGER}:${goalId}`),
    );
}

/** Sorted id-list comparison (allocation order is incidental). */
function expectIds(actual: readonly string[], expected: readonly string[]): void {
  expect([...actual].sort()).toEqual([...expected].sort());
}

// --- the suite --------------------------------------------------------------

function runPlanPredicatesSuite(backend: Backend): void {
  const suiteDescribe = backend.skip === true ? describe.skip : describe;
  suiteDescribe(`T853 plan-gated predicates (${backend.name})`, () => {
    it("(busy) an active claim suppresses P-plan and surfaces in planBusy; abandon re-enables", async () => {
      const store = await backend.build();
      try {
        await seedLegacyGoal(store, GOAL_ID, "clarifying");
        const before = derivePredicates(store);
        expectIds(before.pPlan.items, [GOAL_ID]);
        expectIds(before.planBusy.items, []);

        const claim = await claimInitial(store, GOAL_ID, "busy-claim", null);
        const claimed = derivePredicates(store);
        expectIds(claimed.pPlan.items, []);
        expectIds(claimed.planBusy.items, [GOAL_ID]);
        // Report-only: the busy signal never feeds the open-question gate.
        expectIds(claimed.openQuestionGate.items, []);

        await abandonClaim(store, claim, "busy-abandon");
        const released = derivePredicates(store);
        expectIds(released.planBusy.items, []);
        expectIds(released.pPlan.items, [GOAL_ID]);
      } finally {
        await backend.dispose(store);
      }
    });

    for (const status of SUPPRESSING_RESEARCH_STATUSES) {
      it(`(wait) a wait ref at ${status} suppresses P-plan`, async () => {
        const store = await backend.build();
        try {
          await seedLegacyGoal(store, GOAL_ID, "clarifying");
          const claim = await claimInitial(store, GOAL_ID, `wait-${status}-claim`, null);
          const researchId = await pauseForResearch(store, claim, `wait-${status}-pause`);
          await setResearchStatus(store, researchId, status);

          const predicates = derivePredicates(store);
          expectIds(predicates.pPlan.items, []);
          // The pause RELEASED the claim: the suppression is the wait ref,
          // not an active claim (the attribution is unambiguous).
          expectIds(predicates.planBusy.items, []);
        } finally {
          await backend.dispose(store);
        }
      });
    }

    for (const status of RESUMING_RESEARCH_STATUSES) {
      it(`(wait) a wait ref at ${status} re-enables P-plan`, async () => {
        const store = await backend.build();
        try {
          await seedLegacyGoal(store, GOAL_ID, "clarifying");
          const claim = await claimInitial(store, GOAL_ID, `wait-${status}-claim`, null);
          const researchId = await pauseForResearch(store, claim, `wait-${status}-pause`);
          // Open suppresses first — the re-enable is observed as a TRANSITION.
          expectIds(derivePredicates(store).pPlan.items, []);
          await setResearchStatus(store, researchId, status);
          expectIds(derivePredicates(store).pPlan.items, [GOAL_ID]);
        } finally {
          await backend.dispose(store);
        }
      });
    }

    for (const disposition of ["missing", "archived"] as const) {
      it(`(wait) a wait ref whose research left the active view (${disposition}) re-enables P-plan and the next claim`, async () => {
        const store = await backend.build();
        try {
          await seedLegacyGoal(store, GOAL_ID, "clarifying");
          const claim = await claimInitial(store, GOAL_ID, `wait-${disposition}-claim`, null);
          const researchId = await pauseForResearch(store, claim, `wait-${disposition}-pause`);
          expectIds(derivePredicates(store).pPlan.items, []);

          await backend.removeResearchFromActiveView(store, researchId, disposition);
          expectIds(derivePredicates(store).pPlan.items, [GOAL_ID]);

          // The whole path unblocks: the next claim is no longer wait-gated.
          const resumed = await claimInitial(store, GOAL_ID, `wait-${disposition}-resume`, 1);
          expect(resumed.goalId).toBe(GOAL_ID);
        } finally {
          await backend.dispose(store);
        }
      });
    }

    it("(clearing) the next claim clears the wait set; a re-pause replaces it and the verdicts track", async () => {
      const store = await backend.build();
      try {
        await seedLegacyGoal(store, GOAL_ID, "clarifying");
        const first = await claimInitial(store, GOAL_ID, "clear-claim-1", null);
        const firstResearch = await pauseForResearch(store, first, "clear-pause-1", "probe-one");
        expectIds(derivePredicates(store).pPlan.items, []);

        // Conclude the wait → P-plan re-enables and the claim path unblocks.
        await setResearchStatus(store, firstResearch, "concluded");
        expectIds(derivePredicates(store).pPlan.items, [GOAL_ID]);

        // The next claim CLEARS the wait set (T848): while it is active the
        // suppression attribution is the claim (planBusy), not the wait.
        const second = await claimInitial(store, GOAL_ID, "clear-claim-2", 1);
        const claimed = derivePredicates(store);
        expectIds(claimed.pPlan.items, []);
        expectIds(claimed.planBusy.items, [GOAL_ID]);

        // Releasing with NO new effect leaves the set cleared → plannable.
        await abandonClaim(store, second, "clear-abandon");
        const cleared = derivePredicates(store);
        expectIds(cleared.planBusy.items, []);
        expectIds(cleared.pPlan.items, [GOAL_ID]);

        // A re-pause REPLACES the set: the fresh ref suppresses and, once
        // concluded, re-enables in turn.
        const third = await claimInitial(store, GOAL_ID, "clear-claim-3", 2);
        const secondResearch = await pauseForResearch(store, third, "clear-pause-2", "probe-two");
        expectIds(derivePredicates(store).pPlan.items, []);
        await setResearchStatus(store, secondResearch, "concluded");
        expectIds(derivePredicates(store).pPlan.items, [GOAL_ID]);
      } finally {
        await backend.dispose(store);
      }
    });

    it("(manifest) draft and superseded tasks are excluded; the finalized current manifest executes; transitions and legacy ready sets remain", async () => {
      const store = await backend.build();
      try {
        // A LEGACY goal with a ready task — preserved verbatim across the run.
        await seedLegacyGoal(store, LEGACY_GOAL_ID, "planned");
        const legacyMilestone = await store.createMilestone({ title: "legacy work", ...PROVENANCE });
        const legacyTask = await store.createItem(TASKS_LEDGER, legacyMilestone.id, {
          status: "planned",
          fields: {
            headline: "legacy ready",
            ledgerRefs: [`${GOALS_LEDGER}:${LEGACY_GOAL_ID}`],
          },
          ...PROVENANCE,
        });

        await seedLegacyGoal(store, GOAL_ID, "clarifying");
        const claim = await claimInitial(store, GOAL_ID, "manifest-claim", null);
        // Claimed: discovery is busy-suppressed; the draft phase starts empty.
        expectIds(derivePredicates(store).planBusy.items, [GOAL_ID]);
        expectIds(derivePredicates(store).pPlan.items, []);
        expectIds(derivePredicates(store).pImplement.items, [legacyTask.id]);

        // PUBLISH (draft): the draft tasks exist and are goal-linked, but the
        // manifest is not FINALIZED — nothing of the goal is executable.
        await publishManifest(store, claim, "manifest-publish-1", {
          milestones: [{ key: "delivery", title: "Delivery" }],
          tasks: [
            { key: "first", milestoneKey: "delivery", headline: "First task" },
            {
              key: "second",
              milestoneKey: "delivery",
              headline: "Second task",
              dependsOn: [{ kind: "draft-task", key: "first" }],
            },
          ],
        });
        expectIds(derivePredicates(store).pImplement.items, [legacyTask.id]);

        // FINALIZE: the finalized current manifest EXECUTES — exactly its
        // DAG-ready tasks (the dependent second task stays gated).
        await reviewAndFinalize(store, claim, "R1", 1, "manifest-finalize-1");
        const firstTask = goalLinkedTasks(store, GOAL_ID).find(
          ({ fields }) => fields["headline"] === "First task",
        );
        const secondTask = goalLinkedTasks(store, GOAL_ID).find(
          ({ fields }) => fields["headline"] === "Second task",
        );
        if (firstTask === undefined || secondTask === undefined) {
          throw new Error("finalized manifest tasks missing");
        }
        const finalized = derivePredicates(store);
        expectIds(finalized.pImplement.items, [firstTask.id, legacyTask.id]);
        expectIds(finalized.planBusy.items, []);
        expectIds(finalized.goalDrift.items, []);

        // TRANSITIONS REMAIN: the raw planned→building goal transition (the
        // implement-flow's dispatch marker) is still permitted for a managed
        // goal — asserted on generation 2 below.

        // Complete the first manifest task (the write-side fence permits
        // on-manifest starts) → the dependent second task becomes ready.
        await store.updateItem(TASKS_LEDGER, firstTask.id, { status: "wip", ...PROVENANCE });
        await store.updateItem(TASKS_LEDGER, firstTask.id, { status: "done", ...PROVENANCE });
        expectIds(derivePredicates(store).pImplement.items, [secondTask.id, legacyTask.id]);
        const followUp = await store.claimPlan({
          goalId: GOAL_ID,
          purpose: "follow-up",
          claimRequestId: "manifest-follow-up",
          ownerFenceToken: OWNER_TOKEN,
          expectedGeneration: 1,
          ...PROVENANCE,
        });
        if (!followUp.ok) throw new Error(`follow-up claim failed: ${followUp.conflict.code}`);
        const followUpClaim = followUp.acknowledgement;
        const superseded = derivePredicates(store);
        expectIds(superseded.pImplement.items, [legacyTask.id]);
        expectIds(superseded.planBusy.items, [GOAL_ID]);

        // Generation 2: publish + finalize the replacement manifest → the new
        // current manifest executes; the superseded task never returns.
        await publishManifest(store, followUpClaim, "manifest-publish-2", {
          milestones: [{ key: "hardening", title: "Hardening" }],
          tasks: [
            { key: "replacement", milestoneKey: "hardening", headline: "Replacement task" },
          ],
        });
        await reviewAndFinalize(store, followUpClaim, "R2", 1, "manifest-finalize-2");
        const replacementTask = goalLinkedTasks(store, GOAL_ID).find(
          ({ fields }) => fields["headline"] === "Replacement task",
        );
        if (replacementTask === undefined) throw new Error("replacement task missing");
        const regenerated = derivePredicates(store);
        expectIds(regenerated.pImplement.items, [replacementTask.id, legacyTask.id]);
        expect(regenerated.pImplement.items).not.toContain(secondTask.id);

        // TRANSITIONS REMAIN: planned→building keeps the finalized ready set.
        await store.updateItem(GOALS_LEDGER, GOAL_ID, { status: "building", ...PROVENANCE });
        expectIds(derivePredicates(store).pImplement.items, [replacementTask.id, legacyTask.id]);
        // The legacy goal never entered the protocol and never changed.
        expect(
          store.fetchItem(GOALS_LEDGER, LEGACY_GOAL_ID).fields["planGeneration"],
        ).toBeUndefined();
      } finally {
        await backend.dispose(store);
      }
    }, 15_000);

    it("(off-manifest) a goal-linked task outside the finalized manifest — planned OR wip — is excluded (Q337 leak)", async () => {
      const store = await backend.build();
      try {
        await seedLegacyGoal(store, GOAL_ID, "clarifying");
        // Off-manifest tasks are seeded BEFORE the goal is managed — the raw
        // guards reject goal-linked creates against a managed goal.
        const duplicateMilestone = await store.createMilestone({
          title: "duplicate plan",
          ...PROVENANCE,
        });
        const offManifestPlanned = await store.createItem(TASKS_LEDGER, duplicateMilestone.id, {
          status: "planned",
          fields: { headline: "duplicate planned", ledgerRefs: [`${GOALS_LEDGER}:${GOAL_ID}`] },
          ...PROVENANCE,
        });
        const offManifestWip = await store.createItem(TASKS_LEDGER, duplicateMilestone.id, {
          status: "planned",
          fields: { headline: "duplicate in flight", ledgerRefs: [`${GOALS_LEDGER}:${GOAL_ID}`] },
          ...PROVENANCE,
        });
        await store.updateItem(TASKS_LEDGER, offManifestWip.id, {
          status: "wip",
          ...PROVENANCE,
        });

        const claim = await claimInitial(store, GOAL_ID, "off-manifest-claim", null);
        await publishManifest(store, claim, "off-manifest-publish", {
          milestones: [{ key: "delivery", title: "Delivery" }],
          tasks: [{ key: "only", milestoneKey: "delivery", headline: "Only planned task" }],
        });
        await reviewAndFinalize(store, claim, "R1", 1, "off-manifest-finalize");

        const onlyTask = goalLinkedTasks(store, GOAL_ID).find(
          ({ fields }) => fields["headline"] === "Only planned task",
        );
        if (onlyTask === undefined) throw new Error("finalized task missing");
        const predicates = derivePredicates(store);
        // Exactly the finalized manifest executes; both duplicates — even the
        // non-terminal, dependency-free, goal-linked ones — stay OUT.
        expectIds(predicates.pImplement.items, [onlyTask.id]);
        expect(predicates.pImplement.items).not.toContain(offManifestPlanned.id);
        expect(predicates.pImplement.items).not.toContain(offManifestWip.id);
        // Report-only: the leaked wip progress drifts the planned goal.
        expectIds(predicates.goalDrift.items, [GOAL_ID]);
      } finally {
        await backend.dispose(store);
      }
    }, 15_000);
  });
}

for (const backend of BACKENDS) {
  runPlanPredicatesSuite(backend);
}

// --- structural guard -------------------------------------------------------

describe("T853 structural guard — the research-wait table stays single-owned (T848)", () => {
  it("no package source outside store/predicates.ts interprets the wait statuses", async () => {
    const packagesRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const waitTable: string[] = [];
    const waitOwnerRefs: string[] = [];
    for (const pkg of await readdir(path.join(packagesRoot, "packages"))) {
      const srcRoot = path.join(packagesRoot, "packages", pkg, "src");
      let files: string[];
      try {
        files = await readdir(srcRoot, { recursive: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
        const rel = path.join("packages", pkg, "src", file);
        const text = await readFile(path.join(srcRoot, file), "utf8");
        if (/const activeStatuses = new Set\(\["open", "wip", "inconclusive"\]\)/.test(text)) {
          waitTable.push(rel);
        }
        if (text.includes("activePlanResearchWaits")) {
          waitOwnerRefs.push(rel);
        }
      }
    }
    // The wait-status interpretation lives in EXACTLY ONE place — T848's
    // activePlanResearchWaits in store/predicates.ts.
    expect(waitTable).toEqual(["packages/ledger/src/store/predicates.ts"]);
    // ... and the only other source that even NAMES the owner is the T848
    // lifecycle core, which CONSUMES it for the claim-side fence.
    expect(waitOwnerRefs.sort()).toEqual([
      "packages/ledger/src/store/inMemoryPlanLifecycle.ts",
      "packages/ledger/src/store/predicates.ts",
    ]);
  });
});
