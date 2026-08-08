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
 *  (defects)  the guarded-filed review-defect batch (T854): for EACH action
 *             that can carry one — draft PUBLISH (revise), QUESTION pause,
 *             FINALIZE, and abandon release (noop) — the filed defects carry
 *             the goals:<G> + reviews:<R> links (goal- and review-side), are
 *             discovered by the plan-owned goal-linked worklist query EXACTLY
 *             ONCE each, and are EXCLUDED from the global P-investigate
 *             predicate while the goal is clarifying/planning (the exclusion
 *             LIFTS at `planned`); the question-pause case also proves the
 *             phase divergence: questions park the goal in `clarifying`
 *             waiting for ANSWERS (P-plan suppressed until answered);
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
  DEFECTS_LEDGER,
  FsLedgerStore,
  GitObjectLedgerBackend,
  GOALS_LEDGER,
  InMemoryLedgerStore,
  type Item,
  type LedgerStore,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  openPgPool,
  PLAN_REVIEW_DRAFT_FIELD,
  type PlanClaimAcknowledgement,
  type PlanDraftManifest,
  type PlanLifecycleStore,
  type PlanReviewDefectBatch,
  QUESTIONS_LEDGER,
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
/** Task-wait dispositions that SUPPRESS P-plan (T1268 / T1267). */
const SUPPRESSING_TASK_STATUSES = ["planned", "wip", "blocked"] as const;
/** Task-wait dispositions that RE-ENABLE P-plan (T1268 / T1267). */
const RESUMING_TASK_STATUSES = ["done", "abandoned"] as const;

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
  /**
   * T1268: remove a waited task from the ACTIVE view (missing/archived
   * equivalence class for task waits).
   */
  removeTaskFromActiveView(
    store: LifecycleStore,
    taskId: string,
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
  async removeTaskFromActiveView(store, taskId, disposition) {
    const removed = spliceFromLedgersMap(store, TASKS_LEDGER, taskId);
    if (disposition === "archived") {
      const state = store as unknown as {
        archives: Map<
          string,
          { id: string; title: string; description: string; items: Item[] }
        >;
      };
      state.archives.set(`${TASKS_LEDGER}/M-ARCH-T`, {
        id: "M-ARCH-T",
        title: "",
        description: "",
        items: [removed],
      });
      expect(await store.fetchArchive(TASKS_LEDGER, "M-ARCH-T")).toMatchObject({
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
  async removeTaskFromActiveView(store, taskId) {
    spliceFromLedgersMap(store, TASKS_LEDGER, taskId);
    await persistDirectLedgers(store, [TASKS_LEDGER]);
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
  async removeTaskFromActiveView(store, taskId) {
    spliceFromLedgersMap(store, TASKS_LEDGER, taskId);
    await persistDirectLedgers(store, [TASKS_LEDGER]);
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
  async removeTaskFromActiveView(store, taskId) {
    const dbPath = sqliteDbPaths.get(store);
    if (dbPath === undefined) throw new Error("sqlite fixture lost its dbPath");
    const db = openLedgerDb(dbPath);
    try {
      db.query("DELETE FROM items WHERE ledger = ? AND id = ?").run(TASKS_LEDGER, taskId);
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
  async removeTaskFromActiveView(store, taskId) {
    const key = pgTenantKeys.get(store);
    if (key === undefined) throw new Error("postgres fixture lost its tenant key");
    const admin = openPgPool(postgresTestDsn());
    try {
      await admin`
        DELETE FROM items WHERE project_key = ${key} AND ledger = ${TASKS_LEDGER} AND id = ${taskId}
      `;
    } finally {
      await admin.close();
    }
    await store.invalidate(TASKS_LEDGER);
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

/** Publish one draft task and pause the claim on it (T1268 guarded path). */
async function publishAndPauseForTask(
  store: LifecycleStore,
  claim: PlanClaimAcknowledgement,
  publishOp: string,
  pauseOp: string,
): Promise<string> {
  await publishManifest(store, claim, publishOp, {
    milestones: [{ key: "delivery", title: "Delivery" }],
    tasks: [{ key: "waited", milestoneKey: "delivery", headline: "Waited task" }],
  });
  const waited = goalLinkedTasks(store, claim.goalId).find(
    ({ fields }) => fields["headline"] === "Waited task",
  );
  if (waited === undefined) throw new Error("published waited task missing");
  const result = await store.releasePlanClaim({
    kind: "pause",
    goalId: claim.goalId,
    claimId: claim.claimId,
    generation: claim.generation,
    operationId: pauseOp,
    ownerFenceToken: claim.ownerFenceToken,
    ...PROVENANCE,
    effect: { kind: "tasks", tasks: [waited.id] },
  });
  if (!result.ok || result.acknowledgement.kind !== "tasks") {
    throw new Error("tasks pause failed");
  }
  return waited.id;
}

/**
 * Set a waited task's status for predicate observation. Bypasses the managed
 * draft write-side fence so terminal transitions remain exercisable without
 * the implement-flow finalize path — mirrors planLifecycleInMemoryAdapter.
 */
async function setTaskStatus(
  store: LifecycleStore,
  taskId: string,
  status: "planned" | "wip" | "blocked" | "done" | "abandoned",
): Promise<void> {
  const name = (store as { constructor: { name: string } }).constructor.name;

  if (name === "SqliteLedgerStore") {
    const dbPath = sqliteDbPaths.get(store);
    if (dbPath === undefined) throw new Error("sqlite fixture lost its dbPath");
    const db = openLedgerDb(dbPath);
    try {
      db.query("UPDATE items SET status = ? WHERE ledger = ? AND id = ?").run(
        status,
        TASKS_LEDGER,
        taskId,
      );
    } finally {
      db.close();
    }
    return;
  }

  if (name === "PostgresLedgerStore") {
    const key = pgTenantKeys.get(store);
    if (key === undefined) throw new Error("postgres fixture lost its tenant key");
    const admin = openPgPool(postgresTestDsn());
    try {
      await admin`
        UPDATE items SET status = ${status}
        WHERE project_key = ${key} AND ledger = ${TASKS_LEDGER} AND id = ${taskId}
      `;
    } finally {
      await admin.close();
    }
    await store.invalidate(TASKS_LEDGER);
    return;
  }

  // InMemory / Fs / Git: mutate the in-memory ledgers map directly.
  const state = store as unknown as {
    ledgers: Map<string, { milestones: Array<{ items: Item[] }> }>;
  };
  const ledger = state.ledgers.get(TASKS_LEDGER);
  if (ledger === undefined) throw new Error("tasks ledger missing");
  let found = false;
  for (const milestone of ledger.milestones) {
    for (const item of milestone.items) {
      if (item.id === taskId) {
        item.status = status;
        found = true;
      }
    }
  }
  if (!found) throw new Error(`task not found: ${taskId}`);
  if (name === "FsLedgerStore" || name === "GitObjectLedgerBackend") {
    await persistDirectLedgers(store, [TASKS_LEDGER]);
  }
}

async function publishManifest(
  store: LifecycleStore,
  claim: PlanClaimAcknowledgement,
  operationId: string,
  manifest: PlanDraftManifest,
  reviewDefects?: PlanReviewDefectBatch,
): Promise<string[]> {
  const result = await store.publishPlanDraft({
    goalId: claim.goalId,
    claimId: claim.claimId,
    generation: claim.generation,
    operationId,
    ownerFenceToken: claim.ownerFenceToken,
    ...PROVENANCE,
    manifest,
    ...(reviewDefects === undefined ? {} : { reviewDefects }),
  });
  if (!result.ok) throw new Error(`publish failed: ${result.conflict.code}`);
  return result.acknowledgement.reviewDefects.map(({ id }) => id);
}

async function pauseForQuestions(
  store: LifecycleStore,
  claim: PlanClaimAcknowledgement,
  operationId: string,
  key = "scope",
  reviewDefects?: PlanReviewDefectBatch,
): Promise<{ questionId: string; defectIds: string[] }> {
  const result = await store.releasePlanClaim({
    kind: "pause",
    goalId: claim.goalId,
    claimId: claim.claimId,
    generation: claim.generation,
    operationId,
    ownerFenceToken: claim.ownerFenceToken,
    ...PROVENANCE,
    effect: {
      kind: "questions",
      questions: [
        { key, question: "Which scope should the plan cover?", recommendation: "smallest" },
      ],
    },
    ...(reviewDefects === undefined ? {} : { reviewDefects }),
  });
  if (!result.ok || result.acknowledgement.kind !== "questions") {
    throw new Error("question pause failed");
  }
  const [questionId] = result.acknowledgement.questions.map(({ id }) => id);
  if (questionId === undefined) throw new Error("question allocation missing");
  return {
    questionId,
    defectIds: result.acknowledgement.reviewDefects.map(({ id }) => id),
  };
}

async function reviewAndFinalize(
  store: LifecycleStore,
  claim: PlanClaimAcknowledgement,
  reviewId: string,
  draftRevision: number,
  operationId: string,
  reviewDefects?: PlanReviewDefectBatch,
): Promise<string[]> {
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
    ...(reviewDefects === undefined ? {} : { reviewDefects }),
  });
  if (!result.ok) throw new Error(`finalize failed: ${result.conflict.code}`);
  return result.acknowledgement.reviewDefects.map(({ id }) => id);
}

async function abandonClaim(
  store: LifecycleStore,
  claim: PlanClaimAcknowledgement,
  operationId: string,
  reviewDefects?: PlanReviewDefectBatch,
): Promise<string[]> {
  const result = await store.releasePlanClaim({
    kind: "abandon",
    goalId: claim.goalId,
    claimId: claim.claimId,
    generation: claim.generation,
    operationId,
    reason: "predicate probe complete",
    ...PROVENANCE,
    ...(reviewDefects === undefined ? {} : { reviewDefects }),
  });
  if (!result.ok) throw new Error(`abandon release failed: ${result.conflict.code}`);
  return result.acknowledgement.reviewDefects.map(({ id }) => id);
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

/**
 * The plan-owned auto-investigate WORKLIST query (advance.md §Auto-investigate
 * filed defects): every ACTIVE defect whose ledgerRefs link the goal
 * (`goals:<goalId>`) and whose status is still actionable
 * (open/wip/inconclusive) — derived by LEDGER QUERY, never from prose.
 */
function goalLinkedDefectWorklist(store: LifecycleStore, goalId: string): Item[] {
  return store
    .fetch(DEFECTS_LEDGER)
    .milestones.flatMap(({ items }) => items)
    .filter(
      ({ status, fields }) =>
        ["open", "wip", "inconclusive"].includes(status) &&
        Array.isArray(fields["ledgerRefs"]) &&
        fields["ledgerRefs"].includes(`${GOALS_LEDGER}:${goalId}`),
    );
}

/** A two-defect review batch — multi-defect filing is the T854 atomic unit. */
function reviewDefectsBatch(reviewId: string): PlanReviewDefectBatch {
  return {
    reviewId,
    defects: [
      {
        key: "double_file",
        headline: "A retried operation must not double-file its batch",
        severity: "high",
        rootCause: "The response was lost after the batch committed",
        suggestedFix: "Replay the recorded allocation exactly",
      },
      {
        key: "unowned_triage",
        headline: "A goal-linked defect must not be triaged globally",
        severity: "medium",
        tags: ["guard"],
      },
    ],
  };
}

/** The goal+review links every guarded-filed defect must carry. */
function expectFiledDefectLinks(
  defects: readonly Item[],
  goalId: string,
  reviewId: string,
): void {
  for (const defect of defects) {
    expect(defect.status).toBe("open");
    expect(defect.fields["ledgerRefs"]).toEqual([
      `${GOALS_LEDGER}:${goalId}`,
      `${REVIEWS_LEDGER}:${reviewId}`,
    ]);
  }
}

/** Seed a review the guarded batch can link back to (review-side defect list). */
async function seedReview(
  store: LifecycleStore,
  reviewId: string,
  goalId: string,
): Promise<void> {
  await store.createItem(REVIEWS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: reviewId,
    status: "revise",
    fields: {
      summary: "reviewed",
      ledgerRefs: [`${GOALS_LEDGER}:${goalId}`],
    },
    author: "reviewer",
    session: "review-session",
  });
}

/** The review-side link: the named review's defects[] names the batch ids. */
function expectReviewSideLink(
  store: LifecycleStore,
  reviewId: string,
  defectIds: readonly string[],
): void {
  expectIds(
    (store.fetchItem(REVIEWS_LEDGER, reviewId).fields["defects"] ?? []) as string[],
    defectIds,
  );
}

/** Sorted id-list comparison (allocation order is incidental). */
function expectIds(actual: readonly string[], expected: readonly string[]): void {
  expect([...actual].sort()).toEqual([...expected].sort());
}

// --- the suite --------------------------------------------------------------

function runPlanPredicatesSuite(backend: Backend): void {
  const suiteDescribe = backend.skip === true ? describe.skip : describe;
  // Load-sensitive: GitObject under full-suite + many linked worktrees exceeds
  // the default 5s wall-clock (D293). SUT invariants unchanged.
  const caseTimeoutMs =
    backend.name === "GitObjectLedgerBackend" ? 30_000 : undefined;
  const itCase = (
    name: string,
    fn: () => Promise<void>,
    explicitTimeoutMs?: number,
  ): void => {
    // Floor is the backend load bound; never let a smaller explicit override it.
    const timeoutMs =
      explicitTimeoutMs === undefined
        ? caseTimeoutMs
        : caseTimeoutMs === undefined
          ? explicitTimeoutMs
          : Math.max(explicitTimeoutMs, caseTimeoutMs);
    if (timeoutMs === undefined) it(name, fn);
    else it(name, fn, timeoutMs);
  };
  suiteDescribe(`T853 plan-gated predicates (${backend.name})`, () => {
    itCase("(busy) an active claim suppresses P-plan and surfaces in planBusy; abandon re-enables", async () => {
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
      itCase(`(wait) a wait ref at ${status} suppresses P-plan`, async () => {
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
      itCase(`(wait) a wait ref at ${status} re-enables P-plan`, async () => {
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
      itCase(`(wait) a wait ref whose research left the active view (${disposition}) re-enables P-plan and the next claim`, async () => {
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

    // --- T1268 task-wait dispositions (guarded pause → pPlan) ---------------

    for (const status of SUPPRESSING_TASK_STATUSES) {
      itCase(`(task-wait) a real guarded tasks pause at ${status} excludes the goal from pPlan.items`, async () => {
        const store = await backend.build();
        try {
          await seedLegacyGoal(store, GOAL_ID, "clarifying");
          const claim = await claimInitial(store, GOAL_ID, `task-wait-${status}-claim`, null);
          const taskId = await publishAndPauseForTask(
            store,
            claim,
            `task-wait-${status}-publish`,
            `task-wait-${status}-pause`,
          );
          await setTaskStatus(store, taskId, status);
          const predicates = derivePredicates(store);
          expectIds(predicates.pPlan.items, []);
          expectIds(predicates.planBusy.items, []); // pause released the claim
        } finally {
          await backend.dispose(store);
        }
      });
    }

    for (const status of RESUMING_TASK_STATUSES) {
      itCase(`(task-wait) a wait ref at ${status} re-includes the goal in pPlan.items`, async () => {
        const store = await backend.build();
        try {
          await seedLegacyGoal(store, GOAL_ID, "clarifying");
          const claim = await claimInitial(store, GOAL_ID, `task-resume-${status}-claim`, null);
          const taskId = await publishAndPauseForTask(
            store,
            claim,
            `task-resume-${status}-publish`,
            `task-resume-${status}-pause`,
          );
          expectIds(derivePredicates(store).pPlan.items, []); // planned suppresses first
          await setTaskStatus(store, taskId, status);
          expectIds(derivePredicates(store).pPlan.items, [GOAL_ID]);
        } finally {
          await backend.dispose(store);
        }
      });
    }

    for (const disposition of ["missing", "archived"] as const) {
      itCase(`(task-wait) a wait ref whose task left the active view (${disposition}) re-includes the goal`, async () => {
        const store = await backend.build();
        try {
          await seedLegacyGoal(store, GOAL_ID, "clarifying");
          const claim = await claimInitial(
            store,
            GOAL_ID,
            `task-${disposition}-claim`,
            null,
          );
          const taskId = await publishAndPauseForTask(
            store,
            claim,
            `task-${disposition}-publish`,
            `task-${disposition}-pause`,
          );
          expectIds(derivePredicates(store).pPlan.items, []);
          await backend.removeTaskFromActiveView(store, taskId, disposition);
          expectIds(derivePredicates(store).pPlan.items, [GOAL_ID]);
        } finally {
          await backend.dispose(store);
        }
      });
    }

    itCase("(clearing) the next claim clears the wait set; a re-pause replaces it and the verdicts track", async () => {
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

    itCase("(defects:revise) publish-filed defects are P-investigate-excluded under the planning round and discovered exactly once", async () => {
      const store = await backend.build();
      try {
        await seedLegacyGoal(store, GOAL_ID, "clarifying");
        await seedReview(store, "R11", GOAL_ID);
        const claim = await claimInitial(store, GOAL_ID, "defects-revise-claim", null);
        const allocated = await publishManifest(
          store,
          claim,
          "defects-revise-publish",
          {
            milestones: [{ key: "delivery", title: "Delivery" }],
            tasks: [
              { key: "implementation", milestoneKey: "delivery", headline: "Implementation" },
            ],
          },
          reviewDefectsBatch("R11"),
        );
        expect(allocated).toHaveLength(2);

        // The plan-owned worklist discovers EXACTLY the filed batch, once
        // each — and re-derivation is idempotent (a filed defect appears in it
        // EXACTLY ONCE, predicate (a)'s store-side half).
        const worklist = goalLinkedDefectWorklist(store, GOAL_ID);
        expectIds(worklist.map(({ id }) => id), allocated);
        expectIds(goalLinkedDefectWorklist(store, GOAL_ID).map(({ id }) => id), allocated);
        expectFiledDefectLinks(worklist, GOAL_ID, "R11");
        expectReviewSideLink(store, "R11", allocated);

        // While the goal is in a movable planning phase the GLOBAL predicate
        // never surfaces them — the plan-owned worklist is their ONLY
        // investigation channel (never double-triaged).
        expectIds(derivePredicates(store).pInvestigate.items, []);
      } finally {
        await backend.dispose(store);
      }
    });

    itCase("(defects:question) question-pause-filed defects stay P-investigate-excluded in clarifying; the goal waits for answers", async () => {
      const store = await backend.build();
      try {
        await seedLegacyGoal(store, GOAL_ID, "clarifying");
        await seedReview(store, "R12", GOAL_ID);
        const claim = await claimInitial(store, GOAL_ID, "defects-question-claim", null);
        const { questionId, defectIds } = await pauseForQuestions(
          store,
          claim,
          "defects-question-pause",
          "scope",
          reviewDefectsBatch("R12"),
        );
        expect(defectIds).toHaveLength(2);

        // The question pause returned the goal to clarifying (the release
        // contract's goalPhase): the goal WAITS FOR ANSWERS, not for research.
        const goal = store.fetchItem(GOALS_LEDGER, GOAL_ID);
        expect(goal.status).toBe("clarifying");
        expect(goal.fields["waitingResearches"] ?? []).toEqual([]);

        const worklist = goalLinkedDefectWorklist(store, GOAL_ID);
        expectIds(worklist.map(({ id }) => id), defectIds);
        expectIds(goalLinkedDefectWorklist(store, GOAL_ID).map(({ id }) => id), defectIds);
        expectFiledDefectLinks(worklist, GOAL_ID, "R12");
        expectReviewSideLink(store, "R12", defectIds);

        const waiting = derivePredicates(store);
        expectIds(waiting.pInvestigate.items, []);
        expectIds(waiting.pPlan.items, []); // parked on the open question
        expectIds(waiting.planBusy.items, []); // the pause released the claim

        // Answering the question unblocks planning; the defect exclusion holds.
        await store.updateItem(QUESTIONS_LEDGER, questionId, {
          status: "answered",
          fields: { answer: "the smallest scope" },
          ...PROVENANCE,
        });
        const answered = derivePredicates(store);
        expectIds(answered.pPlan.items, [GOAL_ID]);
        expectIds(answered.pInvestigate.items, []);
      } finally {
        await backend.dispose(store);
      }
    });

    itCase("(defects:finalize) finalize-filed defects are discovered exactly once and the exclusion lifts at planned", async () => {
      const store = await backend.build();
      try {
        await seedLegacyGoal(store, GOAL_ID, "clarifying");
        const claim = await claimInitial(store, GOAL_ID, "defects-finalize-claim", null);
        await publishManifest(store, claim, "defects-finalize-publish", {
          milestones: [{ key: "delivery", title: "Delivery" }],
          tasks: [
            { key: "implementation", milestoneKey: "delivery", headline: "Implementation" },
          ],
        });
        const allocated = await reviewAndFinalize(
          store,
          claim,
          "R13",
          1,
          "defects-finalize",
          reviewDefectsBatch("R13"),
        );
        expect(allocated).toHaveLength(2);
        expect(store.fetchItem(GOALS_LEDGER, GOAL_ID).status).toBe("planned");

        // Discovery still finds EXACTLY the filed batch, once each...
        const worklist = goalLinkedDefectWorklist(store, GOAL_ID);
        expectIds(worklist.map(({ id }) => id), allocated);
        expectIds(goalLinkedDefectWorklist(store, GOAL_ID).map(({ id }) => id), allocated);
        expectFiledDefectLinks(worklist, GOAL_ID, "R13");
        expectReviewSideLink(store, "R13", allocated);

        // ...but the goal has LEFT the movable planning phases, so the global
        // predicate's ownership exclusion no longer applies to them.
        expectIds(derivePredicates(store).pInvestigate.items, allocated);
      } finally {
        await backend.dispose(store);
      }
    });

    itCase("(defects:noop) abandon-filed defects stay P-investigate-excluded in planning and are discovered exactly once", async () => {
      const store = await backend.build();
      try {
        await seedLegacyGoal(store, GOAL_ID, "clarifying");
        await seedReview(store, "R14", GOAL_ID);
        const claim = await claimInitial(store, GOAL_ID, "defects-noop-claim", null);
        const allocated = await abandonClaim(
          store,
          claim,
          "defects-noop-abandon",
          reviewDefectsBatch("R14"),
        );
        expect(allocated).toHaveLength(2);

        // The abandon released the claim WITHOUT a phase change: the goal is
        // still in planning, so the filed defects remain plan-owned.
        expect(store.fetchItem(GOALS_LEDGER, GOAL_ID).status).toBe("planning");
        const worklist = goalLinkedDefectWorklist(store, GOAL_ID);
        expectIds(worklist.map(({ id }) => id), allocated);
        expectIds(goalLinkedDefectWorklist(store, GOAL_ID).map(({ id }) => id), allocated);
        expectFiledDefectLinks(worklist, GOAL_ID, "R14");
        expectReviewSideLink(store, "R14", allocated);

        const predicates = derivePredicates(store);
        expectIds(predicates.pInvestigate.items, []);
        expectIds(predicates.planBusy.items, []); // the abandon released the claim
      } finally {
        await backend.dispose(store);
      }
    });

    itCase("(manifest) draft and superseded tasks are excluded; the finalized current manifest executes; transitions and legacy ready sets remain", async () => {
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

    itCase("(off-manifest) a goal-linked task outside the finalized manifest — planned OR wip — is excluded (Q337 leak)", async () => {
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

    itCase("(legacy-manifest) a declared legacy goals.milestones fences readiness to the selected DAG (D166)", async () => {
      const store = await backend.build();
      try {
        // Two racing LEGACY planning sessions both publish a goal-linked DAG;
        // the last goals.milestones write selects the executable set (T845).
        await seedLegacyGoal(store, GOAL_ID, "planned");
        const selected = await store.createMilestone({ title: "selected plan", ...PROVENANCE });
        const superseded = await store.createMilestone({ title: "superseded plan", ...PROVENANCE });
        const selectedTask = await store.createItem(TASKS_LEDGER, selected.id, {
          status: "planned",
          fields: { headline: "selected task", ledgerRefs: [`${GOALS_LEDGER}:${GOAL_ID}`] },
          ...PROVENANCE,
        });
        const supersededTask = await store.createItem(TASKS_LEDGER, superseded.id, {
          status: "planned",
          fields: { headline: "superseded task", ledgerRefs: [`${GOALS_LEDGER}:${GOAL_ID}`] },
          ...PROVENANCE,
        });

        // No declared manifest yet: the pre-G99 goal-ref rule authorizes BOTH.
        expectIds(derivePredicates(store).pImplement.items, [selectedTask.id, supersededTask.id]);

        // The selection write fences readiness to the selected DAG; the
        // canonical `milestones:<id>` prefix form is tolerated.
        await store.updateItem(GOALS_LEDGER, GOAL_ID, {
          fields: { milestones: [`${MILESTONES_LEDGER}:${selected.id}`] },
          ...PROVENANCE,
        });
        expectIds(derivePredicates(store).pImplement.items, [selectedTask.id]);

        // The fence holds in `building` (the implement-flow's dispatch phase).
        await store.updateItem(GOALS_LEDGER, GOAL_ID, { status: "building", ...PROVENANCE });
        expectIds(derivePredicates(store).pImplement.items, [selectedTask.id]);

        // A declared-but-EMPTY manifest authorizes nothing (fail-safe).
        await store.updateItem(GOALS_LEDGER, GOAL_ID, {
          fields: { milestones: [] },
          ...PROVENANCE,
        });
        expectIds(derivePredicates(store).pImplement.items, []);

        // The superseded DAG was never deleted — selection is a readiness
        // fence, not a mutation of the loser's tasks.
        expect(store.fetchItem(TASKS_LEDGER, supersededTask.id).status).toBe("planned");
      } finally {
        await backend.dispose(store);
      }
    });
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

describe("T1268 structural guard — the task-wait table stays single-owned (T1267)", () => {
  it("no package source outside store/predicates.ts interprets the task-wait statuses", async () => {
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
        if (/const activeStatuses = new Set\(\["planned", "wip", "blocked"\]\)/.test(text)) {
          waitTable.push(rel);
        }
        if (text.includes("activePlanTaskWaits")) {
          waitOwnerRefs.push(rel);
        }
      }
    }
    expect(waitTable).toEqual(["packages/ledger/src/store/predicates.ts"]);
    expect(waitOwnerRefs.sort()).toEqual([
      "packages/ledger/src/store/inMemoryPlanLifecycle.ts",
      "packages/ledger/src/store/predicates.ts",
    ]);
  });
});
