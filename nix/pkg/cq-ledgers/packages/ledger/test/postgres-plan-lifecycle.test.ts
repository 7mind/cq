/**
 * Postgres-SPECIFIC plan-lifecycle guarantees (T851) — the four claims the
 * shared `planLifecycleStoreContract` cannot make, because each is about how
 * THIS backend reaches its answer rather than what the answer is:
 *
 *  1. The fence reads LIVE rows, never the instance's materialized cache. This
 *     backend is the only one whose reads are served from a cache a peer's
 *     committed write can silently invalidate, so it is the only one where the
 *     staleness defect recorded against the fs/git path (D141) has a genuine
 *     analogue.
 *  2. `reopenItem` is fenced too — a separate write path from `updateItem`, and
 *     one a backend can plausibly leave unguarded.
 *  3. The whole mutation is ATOMIC: the test injects a failure at EVERY
 *     statement boundary of a finalize transaction and shows no boundary leaves
 *     a partial row behind, and that the decision and the finalized goal only
 *     ever appear together.
 *  4. No owner fence TOKEN is ever persisted — asserted by reading the rows,
 *     not by reading a projection of them.
 *
 * Env-gated on CQ_TEST_PG_URL (Q286).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { SQL } from "bun";
import {
  DECISIONS_LEDGER,
  GOALS_LEDGER,
  MILESTONES_AMBIENT_ID,
  PLAN_FINALIZED_MANIFEST_FIELD,
  PLAN_GENERATION_FIELD,
  PLAN_REVIEW_DRAFT_FIELD,
  REVIEWS_LEDGER,
  TASKS_LEDGER,
  ensureSchema,
  openPgPool,
  PostgresLedgerStore,
  type PlanClaimAcknowledgement,
  type PlanDraftManifest,
  type PlanFinalizeInput,
  type PlanLifecycleStore,
} from "../src/index.js";
import {
  cloneTenant,
  dropTenant,
  openTenantStore,
  postgresTestDsn,
  T851_PROJECT_KEY_PREFIX,
} from "./planLifecyclePostgresAdapter.js";

const PG_URL = process.env.CQ_TEST_PG_URL;

const GOAL_ID = "G1";
const OWNER_TOKEN = "A".repeat(22);
const PROVENANCE = { author: "t851", session: "t851-session" } as const;
const INJECTED = "t851 injected mid-transaction failure";

const MANIFEST = {
  milestones: [{ key: "delivery", title: "Deliver the fence" }],
  tasks: [
    { key: "first", milestoneKey: "delivery", headline: "First task" },
    {
      key: "second",
      milestoneKey: "delivery",
      headline: "Second task",
      dependsOn: [{ kind: "draft-task", key: "first" }],
    },
  ],
} as const satisfies PlanDraftManifest;

type LifecycleStore = PostgresLedgerStore & PlanLifecycleStore;

/** Everything one test owns, torn down by {@link Harness.dispose}. */
class Harness {
  readonly stores: LifecycleStore[] = [];
  readonly tenants: string[] = [];

  constructor(
    readonly dsn: string,
    readonly admin: SQL,
    readonly projectKey: string,
  ) {
    this.tenants.push(projectKey);
  }

  static async create(): Promise<Harness> {
    const dsn = postgresTestDsn();
    const admin = openPgPool(dsn);
    await ensureSchema(admin);
    return new Harness(dsn, admin, `${T851_PROJECT_KEY_PREFIX}${randomUUID()}`);
  }

  async open(): Promise<LifecycleStore> {
    const store = await openTenantStore(this.dsn, this.projectKey);
    this.stores.push(store);
    return store;
  }

  /** Open a store whose pool can be told to fail the Nth statement of a transaction. */
  async openInjecting(): Promise<{ store: LifecycleStore; injector: Injector }> {
    const { pool, injector } = injectingPool(this.dsn);
    await ensureSchema(pool);
    const store = new PostgresLedgerStore({
      pool,
      projectKey: this.projectKey,
      displayName: this.projectKey,
    });
    await store.init();
    this.stores.push(store as LifecycleStore);
    return { store: store as LifecycleStore, injector };
  }

  track(tenant: string): void {
    this.tenants.push(tenant);
  }

  async dispose(): Promise<void> {
    for (const store of this.stores.splice(0)) {
      try {
        await store.dispose();
      } catch {
        // a store whose injected failure closed its pool is already gone
      }
    }
    for (const tenant of this.tenants.splice(0)) await dropTenant(this.admin, tenant);
    await this.admin.close();
  }
}

interface Injector {
  /** Throw on the `nth` statement issued inside a transaction (1-based). */
  armAt(nth: number): void;
  disarm(): void;
}

/**
 * A pool that fails the Nth statement issued while armed.
 *
 * BOTH the transaction handle and the pool itself are counted. Counting only
 * the transaction handle would leave a real defect invisible: an implementation
 * that wrote part of the mutation on a SEPARATE connection would place that
 * write outside every countable boundary, so the walk would step straight past
 * the torn interleaving it exists to find.
 */
function injectingPool(dsn: string): { pool: SQL; injector: Injector } {
  const real = openPgPool(dsn);
  let failAt: number | null = null;
  let seen = 0;

  const countOrThrow = (): void => {
    if (failAt === null) return;
    seen += 1;
    if (seen === failAt) throw new Error(INJECTED);
  };

  const counting = (handle: SQL): SQL =>
    new Proxy(handle as unknown as (...args: unknown[]) => unknown, {
      apply(target, thisArg, args: unknown[]): unknown {
        countOrThrow();
        return Reflect.apply(target, thisArg, args);
      },
      get(target, prop, receiver): unknown {
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as SQL;

  const pool = new Proxy(real as unknown as (...args: unknown[]) => unknown, {
    apply(target, thisArg, args: unknown[]): unknown {
      countOrThrow();
      return Reflect.apply(target, thisArg, args);
    },
    get(target, prop, receiver): unknown {
      if (prop === "begin") {
        return (fn: (tx: SQL) => Promise<unknown>): unknown =>
          (target as unknown as SQL).begin((tx) => fn(counting(tx as unknown as SQL)));
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as SQL;

  return {
    pool,
    injector: {
      armAt(nth: number): void {
        failAt = nth;
        seen = 0;
      },
      disarm(): void {
        failAt = null;
      },
    },
  };
}

function verifier(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Dispatch `op` a few milliseconds late, so the other racer reaches its lock first. */
async function delayed<T>(op: () => Promise<T>): Promise<T> {
  await Bun.sleep(5);
  return op();
}

async function seedGoal(store: LifecycleStore, goalId: string): Promise<void> {
  await store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: goalId,
    status: "clarifying",
    fields: { title: `goal ${goalId}`, description: "T851 fence coverage" },
    ...PROVENANCE,
  });
}

async function claim(store: LifecycleStore, requestId: string): Promise<PlanClaimAcknowledgement> {
  const result = await store.claimPlan({
    goalId: GOAL_ID,
    purpose: "initial",
    claimRequestId: requestId,
    ownerFenceToken: OWNER_TOKEN,
    expectedGeneration: null,
    ...PROVENANCE,
  });
  if (!result.ok) throw new Error(`claim conflicted: ${result.conflict.code}`);
  return result.acknowledgement;
}

/**
 * Drive a goal all the way to `planned` with a two-task finalized manifest,
 * leaving the fixture at the point where the acceptance's interesting races
 * (raw task-start vs follow-up replacement) become possible.
 */
async function driveToFinalized(
  store: LifecycleStore,
  reviewId: string,
): Promise<{ taskIds: string[] }> {
  const acknowledgement = await claim(store, `claim-${reviewId}`);
  const published = await store.publishPlanDraft({
    goalId: GOAL_ID,
    claimId: acknowledgement.claimId,
    generation: acknowledgement.generation,
    operationId: `publish-${reviewId}`,
    ownerFenceToken: acknowledgement.ownerFenceToken,
    ...PROVENANCE,
    manifest: MANIFEST,
  });
  if (!published.ok) throw new Error(`publish conflicted: ${published.conflict.code}`);
  const draft = {
    goalId: GOAL_ID,
    claimId: acknowledgement.claimId,
    generation: acknowledgement.generation,
    revision: published.acknowledgement.manifest.revision,
  };
  await store.createItem(REVIEWS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: reviewId,
    status: "go-ahead",
    fields: {
      [PLAN_REVIEW_DRAFT_FIELD]: JSON.stringify(draft),
      ledgerRefs: [`${GOALS_LEDGER}:${GOAL_ID}`],
    },
    ...PROVENANCE,
  });
  const finalized = await store.finalizePlan(finalizeInput(acknowledgement, reviewId, draft.revision));
  if (!finalized.ok) throw new Error(`finalize conflicted: ${finalized.conflict.code}`);
  return { taskIds: finalized.acknowledgement.manifest.tasks.map(({ id }) => id) };
}

function finalizeInput(
  acknowledgement: PlanClaimAcknowledgement,
  reviewId: string,
  draftRevision: number,
): PlanFinalizeInput {
  return {
    goalId: GOAL_ID,
    claimId: acknowledgement.claimId,
    generation: acknowledgement.generation,
    operationId: `finalize-${reviewId}`,
    ownerFenceToken: acknowledgement.ownerFenceToken,
    ...PROVENANCE,
    reviewId,
    draftRevision,
    decision: { headline: "Lock the reviewed draft" },
  };
}

let harness: Harness | null = null;

afterEach(async () => {
  const current = harness;
  harness = null;
  if (current !== null) await current.dispose();
});

async function newHarness(): Promise<Harness> {
  harness = await Harness.create();
  return harness;
}

describe.skipIf(!PG_URL)("postgres plan-lifecycle fence (T851)", () => {
  test("a guarded raw write decides from live rows, not from its own store's stale cache", async () => {
    const h = await newHarness();
    const writer = await h.open();
    const stale = await h.open();
    await seedGoal(writer, GOAL_ID);
    // `stale` observed the tenant at init and is never invalidated again, so
    // every row `writer` creates below is invisible to its cache.
    await stale.invalidate(GOALS_LEDGER);
    const { taskIds } = await driveToFinalized(writer, "R1");
    const [first, second] = taskIds;
    if (first === undefined || second === undefined) throw new Error("manifest is short");

    // The stale store cannot see either task in `this.ledgers` — proving the
    // premise of this test rather than assuming it.
    expect(() => stale.fetchItem(TASKS_LEDGER, first)).toThrow();

    // A cache-based fence would fail this with "item not found"; a live-read
    // fence starts the ready task and rejects the dependency-blocked one for
    // the RIGHT reason.
    const started = await stale.updateItem(TASKS_LEDGER, first, {
      status: "wip",
      ...PROVENANCE,
    });
    expect(started.status).toBe("wip");
    await expect(
      stale.updateItem(TASKS_LEDGER, second, { status: "wip", ...PROVENANCE }),
    ).rejects.toThrow(/dependencies/);

    const reader = await h.open();
    expect(reader.fetchItem(TASKS_LEDGER, first).status).toBe("wip");
    expect(reader.fetchItem(TASKS_LEDGER, second).status).toBe("planned");
  }, 30_000);

  test("reopenItem is fenced: a superseded managed task cannot be resurrected raw", async () => {
    const h = await newHarness();
    const store = await h.open();
    await seedGoal(store, GOAL_ID);
    const { taskIds } = await driveToFinalized(store, "R2");
    const [first] = taskIds;
    if (first === undefined) throw new Error("manifest is short");

    // A follow-up generation abandons the planned tasks and drops them out of
    // the finalized manifest.
    const followUp = await store.claimPlan({
      goalId: GOAL_ID,
      purpose: "follow-up",
      claimRequestId: "follow-up-reopen",
      ownerFenceToken: OWNER_TOKEN,
      expectedGeneration: 1,
      ...PROVENANCE,
    });
    expect(followUp.ok).toBe(true);
    expect(store.fetchItem(TASKS_LEDGER, first).status).toBe("abandoned");

    // `reopenItem` is a DIFFERENT write path from `updateItem`. Unfenced, it
    // would happily walk this superseded task back to planned.
    await expect(store.reopenItem(TASKS_LEDGER, first, "planned")).rejects.toThrow(
      /superseded manifest/,
    );
    expect(store.fetchItem(TASKS_LEDGER, first).status).toBe("abandoned");
  }, 30_000);

  test("finalize is all-or-nothing at every statement boundary, and commits decision with goal together", async () => {
    const h = await newHarness();
    const setup = await h.open();
    await seedGoal(setup, GOAL_ID);
    const acknowledgement = await claim(setup, "atomic");
    const published = await setup.publishPlanDraft({
      goalId: GOAL_ID,
      claimId: acknowledgement.claimId,
      generation: acknowledgement.generation,
      operationId: "publish-atomic",
      ownerFenceToken: acknowledgement.ownerFenceToken,
      ...PROVENANCE,
      manifest: MANIFEST,
    });
    if (!published.ok) throw new Error("publish conflicted");
    await setup.createItem(REVIEWS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: "R3",
      status: "go-ahead",
      fields: {
        [PLAN_REVIEW_DRAFT_FIELD]: JSON.stringify({
          goalId: GOAL_ID,
          claimId: acknowledgement.claimId,
          generation: acknowledgement.generation,
          revision: published.acknowledgement.manifest.revision,
        }),
        ledgerRefs: [`${GOALS_LEDGER}:${GOAL_ID}`],
      },
      ...PROVENANCE,
    });

    const { store, injector } = await h.openInjecting();
    const input = finalizeInput(acknowledgement, "R3", published.acknowledgement.manifest.revision);

    const decisionCount = async (): Promise<number> => {
      const rows = await h.admin<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM items
        WHERE project_key = ${h.projectKey} AND ledger = ${DECISIONS_LEDGER}
      `;
      return Number(rows[0]?.n ?? "0");
    };
    const goalFields = async (): Promise<Record<string, unknown>> => {
      const rows = await h.admin<Array<{ fields_json: string }>>`
        SELECT fields_json FROM items
        WHERE project_key = ${h.projectKey} AND ledger = ${GOALS_LEDGER} AND id = ${GOAL_ID}
      `;
      return JSON.parse(rows[0]?.fields_json ?? "{}") as Record<string, unknown>;
    };
    const operationCount = async (): Promise<number> => {
      const rows = await h.admin<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM plan_operations
        WHERE project_key = ${h.projectKey} AND scope LIKE ${"%finalize%"}
      `;
      return Number(rows[0]?.n ?? "0");
    };

    // Walk the injection point forward one statement at a time. Every rollback
    // must leave the tenant EXACTLY as it was; the first attempt that survives
    // to COMMIT ends the walk.
    const MAX_STATEMENTS = 400;
    let committed = 0;
    let rolledBack = 0;
    for (let nth = 1; nth <= MAX_STATEMENTS; nth += 1) {
      injector.armAt(nth);
      let threw = false;
      try {
        const result = await store.finalizePlan(input);
        if (!result.ok) throw new Error(`finalize conflicted: ${result.conflict.code}`);
      } catch (error) {
        threw = true;
        expect((error as Error).message).toBe(INJECTED);
      } finally {
        injector.disarm();
      }
      if (!threw) {
        committed = nth;
        break;
      }
      rolledBack += 1;
      // No torn write at THIS boundary: no decision row, no finalized goal, no
      // replay record that would make a retry look like a duplicate.
      expect(await decisionCount()).toBe(0);
      expect(await goalFields()).not.toHaveProperty(PLAN_FINALIZED_MANIFEST_FIELD);
      expect(await operationCount()).toBe(0);
    }

    // The walk must have exercised real injection points, not fallen straight
    // through — otherwise the assertions above never ran.
    expect(rolledBack).toBeGreaterThan(5);
    expect(committed).toBeGreaterThan(rolledBack);

    // …and the successful attempt landed BOTH effects, in one commit.
    expect(await decisionCount()).toBe(1);
    expect(await goalFields()).toHaveProperty(PLAN_FINALIZED_MANIFEST_FIELD);
    expect(await operationCount()).toBe(1);
  }, 120_000);

  test("no owner fence token is ever persisted — only its verifier", async () => {
    const h = await newHarness();
    const store = await h.open();
    await seedGoal(store, GOAL_ID);
    await driveToFinalized(store, "R4");

    const claimRows = await h.admin<Array<{ record_json: string }>>`
      SELECT record_json FROM plan_claims WHERE project_key = ${h.projectKey}
    `;
    expect(claimRows.length).toBeGreaterThan(0);
    for (const row of claimRows) {
      expect(row.record_json).not.toContain(OWNER_TOKEN);
      expect(row.record_json).toContain(verifier(OWNER_TOKEN));
    }

    const everyText = await h.admin<Array<{ blob: string }>>`
      SELECT string_agg(fields_json, ' ') AS blob FROM items WHERE project_key = ${h.projectKey}
      UNION ALL
      SELECT string_agg(record_json, ' ') AS blob FROM plan_operations WHERE project_key = ${h.projectKey}
    `;
    for (const row of everyText) {
      expect(row.blob ?? "").not.toContain(OWNER_TOKEN);
    }
  }, 30_000);

  test("a raw task start racing a follow-up claim on independent connections yields ONE authority", async () => {
    // Both operations reach the goal-row lock in a handful of round-trips, so
    // whoever is dispatched first wins essentially every time. Staggering the
    // launch is what makes BOTH orders reachable — without it only one branch
    // below would ever execute, and the other would be a dead assertion.
    const outcomes: string[] = [];
    for (const headStart of ["starter", "replacer"] as const) {
      const h = await newHarness();
      try {
        const setup = await h.open();
        await seedGoal(setup, GOAL_ID);
        const { taskIds } = await driveToFinalized(setup, "R5");
        const [first] = taskIds;
        if (first === undefined) throw new Error("manifest is short");

        // Two INDEPENDENT connections, contending for the same goal. Neither
        // has committed when the other is dispatched — the loser blocks on the
        // goal row rather than reading around it.
        const starter = await h.open();
        const replacer = await h.open();
        const startTask = (): Promise<"started" | "rejected"> =>
          starter
            .updateItem(TASKS_LEDGER, first, { status: "wip", ...PROVENANCE })
            .then(
              () => "started" as const,
              () => "rejected" as const,
            );
        const followUp = (): ReturnType<LifecycleStore["claimPlan"]> =>
          replacer.claimPlan({
            goalId: GOAL_ID,
            purpose: "follow-up",
            claimRequestId: `race-${headStart}`,
            ownerFenceToken: OWNER_TOKEN,
            expectedGeneration: 1,
            ...PROVENANCE,
          });

        const [startOutcome, claimOutcome] =
          headStart === "starter"
            ? await Promise.all([startTask(), delayed(followUp)])
            : await Promise.all([delayed(startTask), followUp()]);

        const observer = await h.open();
        const task = observer.fetchItem(TASKS_LEDGER, first);
        const goal = observer.fetchItem(GOALS_LEDGER, GOAL_ID);
        const generation = Number(goal.fields[PLAN_GENERATION_FIELD]);

        if (claimOutcome.ok) {
          // The replacement won: it must have observed a startable task and
          // abandoned it, and the raw start must have lost.
          outcomes.push("replacer-won");
          expect(startOutcome).toBe("rejected");
          expect(task.status).toBe("abandoned");
          expect(generation).toBe(2);
        } else {
          // The raw start won: the claim must have been refused BECAUSE
          // implementation is active, and the generation must not have moved.
          outcomes.push("starter-won");
          expect(startOutcome).toBe("started");
          expect(claimOutcome.conflict.code).toBe("implementation-active");
          expect(task.status).toBe("wip");
          expect(generation).toBe(1);
        }
      } finally {
        const current = harness;
        harness = null;
        if (current !== null) await current.dispose();
      }
    }
    // Neither branch above is dead: the fence produced ONE authority under BOTH
    // serialization orders, not just the one the scheduler happens to favour.
    expect([...outcomes].sort()).toEqual(["replacer-won", "starter-won"]);
  }, 120_000);

  test("plan-fence side state survives a tenant clone, so a restarted peer replays exactly", async () => {
    const h = await newHarness();
    const store = await h.open();
    await seedGoal(store, GOAL_ID);
    const acknowledgement = await claim(store, "clone-replay");

    const cloneKey = `${h.projectKey}-clone`;
    await cloneTenant(h.admin, h.projectKey, cloneKey);
    h.track(cloneKey);
    const peer = await openTenantStore(h.dsn, cloneKey);
    h.stores.push(peer as LifecycleStore);

    const replay = await (peer as LifecycleStore).claimPlan({
      goalId: GOAL_ID,
      purpose: "initial",
      claimRequestId: "clone-replay",
      ownerFenceToken: OWNER_TOKEN,
      expectedGeneration: null,
      ...PROVENANCE,
    });
    expect(replay).toEqual({ ok: true, replayed: true, acknowledgement });
  }, 30_000);
});
