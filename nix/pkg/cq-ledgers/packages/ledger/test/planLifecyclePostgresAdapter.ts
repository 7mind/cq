/**
 * The T851 `PlanLifecycleStore` conformance fixture for `PostgresLedgerStore`.
 *
 * Two structural choices mirror the sqlite fixture deliberately:
 *
 *  - The lifecycle surface handed to the contract ALTERNATES between two stores
 *    that share a tenant but own SEPARATE `Bun.sql` pools, so every consecutive
 *    pair of lifecycle calls crosses a connection boundary. A fence that
 *    consulted its own instance's materialized cache instead of live rows
 *    cannot pass a single multi-step case under this fixture.
 *  - `restart()` yields a genuinely INDEPENDENT peer, by copying the tenant's
 *    rows into a fresh `project_key` — the multi-tenant analogue of the sqlite
 *    fixture's `VACUUM INTO` into a fresh database file. The contract relies on
 *    that independence: after the restarted handle releases a claim, the
 *    original handle must still observe the claim it captured.
 *
 * Coherence between the two same-tenant stores is the job of
 * {@link AlternatingPostgresLifecycle}, which invalidates the peer store after
 * each dispatched call so the contract's assertions are deterministic.
 *
 * Env-gated on CQ_TEST_PG_URL (Q286) by the conformance test that registers
 * this factory.
 */

import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { SQL } from "bun";
import {
  ensureSchema,
  PostgresLedgerStore,
  type Item,
  type PlanClaimInput,
  type PlanClaimResult,
  type PlanFinalizeInput,
  type PlanFinalizeResult,
  type PlanLifecycleStore,
  type PlanPublishDraftInput,
  type PlanPublishDraftResult,
  type PlanReleaseInput,
  type PlanReleaseResult,
} from "../src/index.js";
import type { PlanLifecycleSerializationContender } from "../src/store/planLifecycleSerialization.js";
import {
  LedgerStorePlanLifecycleFixture,
  SEED_PROVENANCE,
} from "./planLifecycleInMemoryAdapter.js";
import { GOALS_LEDGER, MILESTONES_LEDGER } from "../src/index.js";
import type {
  PlanLifecycleContractFactory,
  PlanLifecycleContractFixture,
} from "./planLifecycleReferenceAdapter.js";
import { OneShotSerializationBoundary } from "./planLifecycleSerializationBoundary.js";

const PG_URL_ENV = "CQ_TEST_PG_URL";
const TEST_POOL_MAX = 4;
/** Prefix distinguishing this suite's throwaway tenants from every other one. */
export const T851_PROJECT_KEY_PREFIX = "t851-";

type PostgresLifecycleStore = PostgresLedgerStore & PlanLifecycleStore;

export interface PostgresTestPoolCloseable {
  close(options?: { readonly timeout?: number }): Promise<void>;
}

export function withImmediatePostgresTestPoolDisposal<Pool extends PostgresTestPoolCloseable>(
  pool: Pool,
): Pool {
  return new Proxy(pool, {
    apply: (target, _thisArgument, argumentsList) =>
      Reflect.apply(target as unknown as (...args: unknown[]) => unknown, target, argumentsList),
    get: (target, property) => {
      if (property === "close") return () => target.close({ timeout: 0 });
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function openTestPool(dsn: string): SQL {
  return withImmediatePostgresTestPoolDisposal(new SQL({ url: dsn, max: TEST_POOL_MAX }));
}

function postgresApplicationDsn(dsn: string, applicationName: string): string {
  const url = new URL(dsn);
  url.searchParams.set("application_name", applicationName);
  return url.href;
}

export function postgresTestDsn(): string {
  const dsn = process.env[PG_URL_ENV];
  if (dsn === undefined || dsn.length === 0) {
    throw new Error(`planLifecyclePostgresAdapter: ${PG_URL_ENV} is not set`);
  }
  return dsn;
}

/** Open one store over `projectKey` on its OWN pool. */
export async function openTenantStore(
  dsn: string,
  projectKey: string,
  serializationHarness?: PostgresSerializationHarness,
): Promise<PostgresLifecycleStore> {
  const rawPool = openTestPool(dsn);
  await ensureSchema(rawPool);
  const pool = serializationHarness?.wrapPool(rawPool) ?? rawPool;
  const store = new PostgresLedgerStore({ pool, projectKey, displayName: projectKey });
  await store.init();
  return store as PostgresLifecycleStore;
}

class PostgresSerializationHarness {
  private readonly contender = new AsyncLocalStorage<PlanLifecycleSerializationContender>();

  constructor(readonly boundary: OneShotSerializationBoundary) {}

  run<Result>(
    contender: PlanLifecycleSerializationContender,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return this.contender.run(contender, operation);
  }

  wrapPool(pool: SQL): SQL {
    return this.proxySql(pool, true);
  }

  private proxySql<Sql extends SQL>(sql: Sql, wrapBegin: boolean): Sql {
    return new Proxy(sql, {
      apply: (target, _thisArgument, argumentsList) => {
        const query = Reflect.apply(
          target as unknown as (...args: unknown[]) => unknown,
          target,
          argumentsList,
        );
        if (!this.isGoalRowLock(argumentsList[0])) return query;
        const contender = this.contender.getStore();
        if (contender === undefined) return query;
        return Promise.resolve(query).then(async (result) => {
          await this.boundary.hook(contender);
          return result;
        });
      },
      get: (target, property) => {
        if (wrapBegin && property === "begin") {
          return <Result>(callback: SQL.TransactionContextCallback<Result>) =>
            target.begin((transaction) => callback(this.proxySql(transaction, false)));
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Sql;
  }

  private isGoalRowLock(template: unknown): boolean {
    if (!Array.isArray(template)) return false;
    const sql = template.join("?");
    return /SELECT\s+1\s+FROM\s+items[\s\S]*FOR\s+UPDATE/i.test(sql);
  }
}

/** Copy every row this tenant owns into `to` — the fixture's restart primitive. */
export async function cloneTenant(admin: SQL, from: string, to: string): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`
      INSERT INTO projects (project_key, display_name)
      SELECT ${to}, display_name FROM projects WHERE project_key = ${from}
    `;
    await tx`
      INSERT INTO ledgers (project_key, name, schema_json, milestone_counter, item_counter)
      SELECT ${to}, name, schema_json, milestone_counter, item_counter
      FROM ledgers WHERE project_key = ${from}
    `;
    await tx`
      INSERT INTO groups (project_key, ledger, id, title, description)
      SELECT ${to}, ledger, id, title, description
      FROM groups WHERE project_key = ${from} ORDER BY seq
    `;
    await tx`
      INSERT INTO items (project_key, ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
      SELECT ${to}, ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session
      FROM items WHERE project_key = ${from} ORDER BY seq
    `;
    await tx`
      INSERT INTO archive_pointers (project_key, ledger, id, summary, title, status, archived_at)
      SELECT ${to}, ledger, id, summary, title, status, archived_at
      FROM archive_pointers WHERE project_key = ${from} ORDER BY seq
    `;
    await tx`
      INSERT INTO archived_items (project_key, ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
      SELECT ${to}, ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at, author, session
      FROM archived_items WHERE project_key = ${from} ORDER BY seq
    `;
    await tx`
      INSERT INTO plan_claims (project_key, scope, record_json)
      SELECT ${to}, scope, record_json FROM plan_claims WHERE project_key = ${from}
    `;
    await tx`
      INSERT INTO plan_operations (project_key, scope, record_json)
      SELECT ${to}, scope, record_json FROM plan_operations WHERE project_key = ${from}
    `;
  });
}

/** Remove every row a throwaway tenant owns (children first, FK order). */
export async function dropTenant(admin: SQL, projectKey: string): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`DELETE FROM archived_items WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM archive_pointers WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM items WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM groups WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM ledgers WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM plan_claims WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM plan_operations WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM logs WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM projects WHERE project_key = ${projectKey}`;
  });
}

/**
 * Round-robins the lifecycle surface across independent connections and then
 * plays the T578 watcher's part, invalidating the store(s) that did not run the
 * call so the fixture's read store never serves a cache a peer just superseded.
 */
class AlternatingPostgresLifecycle implements PlanLifecycleStore {
  private nextIndex = 0;

  constructor(
    private readonly stores: readonly PostgresLifecycleStore[],
    private readonly serializationHarness: PostgresSerializationHarness,
  ) {}

  private next(): PostgresLifecycleStore {
    const store = this.stores[this.nextIndex % this.stores.length];
    if (store === undefined) throw new Error("Postgres lifecycle fixture has no store");
    this.nextIndex += 1;
    return store;
  }

  private async dispatch<T>(op: (store: PostgresLifecycleStore) => Promise<T>): Promise<T> {
    const store = this.next();
    try {
      return await op(store);
    } finally {
      for (const peer of this.stores) {
        if (peer !== store) await refreshStore(peer);
      }
    }
  }

  claimPlan(input: PlanClaimInput): Promise<PlanClaimResult> {
    if (input.purpose === "follow-up") {
      return this.serializationHarness.run("follow-up-claim", () =>
        this.dispatch((store) => store.claimPlan(input)),
      );
    }
    return this.dispatch((store) => store.claimPlan(input));
  }

  publishPlanDraft(input: PlanPublishDraftInput): Promise<PlanPublishDraftResult> {
    return this.dispatch((store) => store.publishPlanDraft(input));
  }

  releasePlanClaim(input: PlanReleaseInput): Promise<PlanReleaseResult> {
    return this.dispatch((store) => store.releasePlanClaim(input));
  }

  finalizePlan(input: PlanFinalizeInput): Promise<PlanFinalizeResult> {
    return this.dispatch((store) => store.finalizePlan(input));
  }
}

async function refreshStore(store: PostgresLifecycleStore): Promise<void> {
  for (const ledgerId of store.enumerate()) await store.invalidate(ledgerId);
}

/** One throwaway tenant plus the stores opened over it. */
class TenantLease {
  readonly stores: PostgresLifecycleStore[] = [];

  constructor(
    readonly dsn: string,
    readonly projectKey: string,
    readonly applicationName: string,
  ) {}

  async release(admin: SQL): Promise<void> {
    for (const store of this.stores.splice(0)) await store.dispose();
    await dropTenant(admin, this.projectKey);
  }
}

class PostgresPlanLifecycleFixture extends LedgerStorePlanLifecycleFixture<PostgresLifecycleStore> {
  /** Fixtures spawned by {@link restart}; each owns its own tenant. */
  private readonly spawned: PostgresPlanLifecycleFixture[] = [];
  readonly operatorActionPeers: readonly [PostgresLifecycleStore, PostgresLifecycleStore];

  private constructor(
    private readonly admin: SQL,
    private readonly lease: TenantLease,
    private readonly ownsAdmin: boolean,
    readonly postgresApplicationName: string,
    stores: readonly [PostgresLifecycleStore, PostgresLifecycleStore],
    private readonly serializationHarness: PostgresSerializationHarness,
  ) {
    super(
      stores[0],
      new AlternatingPostgresLifecycle(stores, serializationHarness),
      undefined,
      serializationHarness.boundary,
    );
    this.operatorActionPeers = stores;
  }

  private static async openOver(
    admin: SQL,
    lease: TenantLease,
    ownsAdmin: boolean,
  ): Promise<PostgresPlanLifecycleFixture> {
    const serializationHarness = new PostgresSerializationHarness(
      new OneShotSerializationBoundary(),
    );
    // Sequential init: both stores auto-register the same tenant on connect, so
    // letting them race the bootstrap writes would be testing Postgres, not the
    // fence.
    const first = await openTenantStore(lease.dsn, lease.projectKey, serializationHarness);
    const second = await openTenantStore(lease.dsn, lease.projectKey, serializationHarness);
    lease.stores.push(first, second);
    return new PostgresPlanLifecycleFixture(
      admin,
      lease,
      ownsAdmin,
      lease.applicationName,
      [first, second],
      serializationHarness,
    );
  }

  override startTask(
    taskId: string,
    provenance: { author: string; session?: string },
  ): Promise<void> {
    return this.serializationHarness.run("task-start", () => super.startTask(taskId, provenance));
  }

  override blockTask(
    taskId: string,
    provenance: { author: string; session?: string },
  ): Promise<void> {
    return this.serializationHarness.run("task-block", () => super.blockTask(taskId, provenance));
  }

  static async create(): Promise<PostgresPlanLifecycleFixture> {
    const applicationName = `cq-plan-lifecycle-${randomUUID()}`;
    const dsn = postgresApplicationDsn(postgresTestDsn(), applicationName);
    const admin = openTestPool(dsn);
    await ensureSchema(admin);
    const lease = new TenantLease(
      dsn,
      `${T851_PROJECT_KEY_PREFIX}${randomUUID()}`,
      applicationName,
    );
    return PostgresPlanLifecycleFixture.openOver(admin, lease, true);
  }

  /**
   * Seed a field the public API deliberately refuses to write (managed plan
   * metadata, ownership refs), by going STRAIGHT to the row. Both stores are
   * refreshed afterwards, since neither observed the write.
   */
  protected async seedUpdate(
    ledgerId: string,
    itemId: string,
    mutate: (item: Item) => void,
  ): Promise<void> {
    const item = this.store.fetchItem(ledgerId, itemId);
    mutate(item);
    await this.admin`
      UPDATE items
      SET status = ${item.status}, fields_json = ${JSON.stringify(item.fields)},
          author = ${item.author ?? null}, session = ${item.session ?? null}
      WHERE project_key = ${this.lease.projectKey} AND ledger = ${ledgerId} AND id = ${itemId}
    `;
    for (const store of this.lease.stores) await store.invalidate(ledgerId);
  }

  override async seedOrphanGoal(goalId: string, kind: "absent" | "terminal"): Promise<void> {
    let milestoneId = "M-orphaned-parent";
    if (kind === "terminal") {
      const milestone = await this.store.createMilestone({
        title: "orphaned parent",
        ...SEED_PROVENANCE,
      });
      milestoneId = milestone.id;
      await this.seedUpdate(MILESTONES_LEDGER, milestoneId, (mutableMilestone) => {
        mutableMilestone.status = "done";
      });
    }
    await this.admin`
      INSERT INTO groups (project_key, ledger, id, title, description)
      VALUES (${this.lease.projectKey}, ${GOALS_LEDGER}, ${milestoneId}, '', '')
      ON CONFLICT (project_key, ledger, id) DO NOTHING
    `;
    await this.admin`
      UPDATE items
      SET milestone_id = ${milestoneId}
      WHERE project_key = ${this.lease.projectKey} AND ledger = ${GOALS_LEDGER} AND id = ${goalId}
    `;
    for (const store of this.lease.stores) await store.invalidate(GOALS_LEDGER);
  }

  async corruptOperatorActionExpectedEvidence(actionId: string): Promise<void> {
    await this.seedUpdate("operatorActions", actionId, (action) => {
      (action.fields as Record<string, unknown>)["expectedEvidence"] = ["probe-v1", 42];
    });
  }

  async restart(): Promise<PlanLifecycleContractFixture> {
    const lease = new TenantLease(
      this.lease.dsn,
      `${this.lease.projectKey}-r${String(this.spawned.length + 1)}`,
      this.lease.applicationName,
    );
    await cloneTenant(this.admin, this.lease.projectKey, lease.projectKey);
    const restarted = await PostgresPlanLifecycleFixture.openOver(this.admin, lease, false);
    this.spawned.push(restarted);
    return restarted;
  }

  override async dispose(): Promise<void> {
    for (const fixture of this.spawned.splice(0)) await fixture.dispose();
    await this.lease.release(this.admin);
    if (this.ownsAdmin) await this.admin.close();
  }
}

export const postgresPlanLifecycleFactory: PlanLifecycleContractFactory = {
  name: "PostgresLedgerStore (two connections)",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  progression: false,
  skip: process.env[PG_URL_ENV] === undefined || process.env[PG_URL_ENV] === "",
  build: () => PostgresPlanLifecycleFixture.create(),
};
