import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  SqliteLedgerStore,
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
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import {
  LedgerStorePlanLifecycleFixture,
  SEED_PROVENANCE,
} from "./planLifecycleInMemoryAdapter.js";
import { GOALS_LEDGER, MILESTONES_LEDGER } from "../src/index.js";
import type {
  PlanLifecycleContractFactory,
  PlanLifecycleContractFixture,
} from "./planLifecycleReferenceAdapter.js";
import type {
  SqliteRaceOperation,
  SqliteRaceOperationResult,
  SqliteRaceWorkerResponse,
} from "./planLifecycleSqliteRaceProtocol.js";
import {
  OneShotSerializationBoundary,
  type SerializationLaunchRole,
} from "./planLifecycleSerializationBoundary.js";

type SqliteLifecycleStore = SqliteLedgerStore & PlanLifecycleStore;

class AlternatingSqliteLifecycle implements PlanLifecycleStore {
  private nextIndex = 0;

  constructor(
    private readonly stores: readonly SqliteLifecycleStore[],
    private readonly raceWorker: SqliteRaceWorker,
  ) {}

  private next(): SqliteLifecycleStore {
    const store = this.stores[this.nextIndex % this.stores.length];
    if (store === undefined) throw new Error("SQLite lifecycle fixture has no store");
    this.nextIndex += 1;
    return store;
  }

  claimPlan(input: PlanClaimInput): Promise<PlanClaimResult> {
    const store = this.next();
    const role = this.raceWorker.currentLaunchRole();
    if (input.purpose === "follow-up" && role !== null) {
      return this.raceWorker.run<PlanClaimResult>({ kind: "follow-up-claim", input }, role);
    }
    return store.claimPlan(input);
  }

  publishPlanDraft(input: PlanPublishDraftInput): Promise<PlanPublishDraftResult> {
    return this.next().publishPlanDraft(input);
  }

  releasePlanClaim(input: PlanReleaseInput): Promise<PlanReleaseResult> {
    return this.next().releasePlanClaim(input);
  }

  finalizePlan(input: PlanFinalizeInput): Promise<PlanFinalizeResult> {
    return this.next().finalizePlan(input);
  }
}

const HOLD_STATE_INDEX = 0;
const RELEASED = 2;

class SqliteRaceWorker {
  constructor(
    private readonly dbPath: string,
    private readonly serializationBoundary: OneShotSerializationBoundary,
  ) {}

  currentLaunchRole(): SerializationLaunchRole | null {
    return this.serializationBoundary.currentLaunchRole();
  }

  run<Result extends SqliteRaceOperationResult>(
    operation: SqliteRaceOperation,
    role: SerializationLaunchRole,
  ): Promise<Result> {
    const expected = role === "holder" ? this.serializationBoundary.expectedContender() : null;
    if (role === "holder" && expected === null) {
      throw new Error("SQLite serialization holder started without an armed contender");
    }
    const holdBuffer = role === "holder" ? new SharedArrayBuffer(4) : null;
    const worker = new Worker(new URL("./planLifecycleSqliteRaceWorker.ts", import.meta.url).href);
    return new Promise<Result>((resolve, reject) => {
      let settled = false;
      const releaseWorker = (): void => {
        if (holdBuffer === null) return;
        const state = new Int32Array(holdBuffer);
        Atomics.store(state, HOLD_STATE_INDEX, RELEASED);
        Atomics.notify(state, HOLD_STATE_INDEX);
      };
      const finish = (result: Result): void => {
        if (settled) return;
        settled = true;
        worker.terminate();
        resolve(result);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        releaseWorker();
        worker.terminate();
        reject(error);
      };
      worker.onmessage = (event: MessageEvent<SqliteRaceWorkerResponse>): void => {
        const response = event.data;
        if (response.type === "held") {
          void this.serializationBoundary.arrive(response.contender).then(releaseWorker, fail);
          return;
        }
        if (response.type === "error") {
          fail(new Error(response.message));
          return;
        }
        finish(response.result as Result);
      };
      worker.onerror = (event): void => {
        fail(new Error(event.message));
      };
      worker.postMessage({
        dbPath: this.dbPath,
        operation,
        expected,
        holdBuffer,
      });
    });
  }
}

class SqlitePlanLifecycleFixture extends LedgerStorePlanLifecycleFixture<SqliteLifecycleStore> {
  /**
   * Fixtures spawned by {@link restart}. Each owns its OWN mkdtemp root (a
   * VACUUM copy of this fixture's database), and the contract disposes only
   * the fixture it built — so this fixture releases its descendants too.
   */
  private readonly spawned: SqlitePlanLifecycleFixture[] = [];

  private constructor(
    readonly root: string,
    readonly dbPath: string,
    readonly stores: readonly [SqliteLifecycleStore, SqliteLifecycleStore],
    serializationBoundary: OneShotSerializationBoundary,
    private readonly raceWorker: SqliteRaceWorker,
  ) {
    super(
      stores[0],
      new AlternatingSqliteLifecycle(stores, raceWorker),
      undefined,
      serializationBoundary,
    );
  }

  static async createFromPath(root: string, dbPath: string): Promise<SqlitePlanLifecycleFixture> {
    const serializationBoundary = new OneShotSerializationBoundary();
    const first = new SqliteLedgerStore({ dbPath });
    const second = new SqliteLedgerStore({ dbPath });
    await first.init();
    await second.init();
    return new SqlitePlanLifecycleFixture(
      root,
      dbPath,
      [first as SqliteLifecycleStore, second as SqliteLifecycleStore],
      serializationBoundary,
      new SqliteRaceWorker(dbPath, serializationBoundary),
    );
  }

  override async startTask(
    taskId: string,
    provenance: { author: string; session?: string },
  ): Promise<void> {
    const role = this.raceWorker.currentLaunchRole();
    if (role === null) return super.startTask(taskId, provenance);
    await this.raceWorker.run<void>({ kind: "task-start", taskId, provenance }, role);
  }

  override async blockTask(
    taskId: string,
    provenance: { author: string; session?: string },
  ): Promise<void> {
    const role = this.raceWorker.currentLaunchRole();
    if (role === null) return super.blockTask(taskId, provenance);
    await this.raceWorker.run<void>({ kind: "task-block", taskId, provenance }, role);
  }

  static async create(): Promise<SqlitePlanLifecycleFixture> {
    const root = await mkdtemp(path.join(tmpdir(), "ledger-plan-sqlite-"));
    return SqlitePlanLifecycleFixture.createFromPath(root, path.join(root, "ledger.db"));
  }

  protected async seedUpdate(
    ledgerId: string,
    itemId: string,
    mutate: (item: Item) => void,
  ): Promise<void> {
    const item = this.store.fetchItem(ledgerId, itemId);
    mutate(item);
    const db = openLedgerDb(this.dbPath);
    try {
      db.query(
        "UPDATE items SET status = ?, fields_json = ?, author = ?, session = ? WHERE ledger = ? AND id = ?",
      ).run(
        item.status,
        JSON.stringify(item.fields),
        item.author ?? null,
        item.session ?? null,
        ledgerId,
        itemId,
      );
    } finally {
      db.close();
    }
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
    const db = openLedgerDb(this.dbPath);
    try {
      // A groups row keeps the store's referential load valid while the
      // milestone ITEM itself stays absent — the dangling parent D267/T1855
      // must observe.
      db.query("INSERT OR IGNORE INTO groups (ledger, id, title, description) VALUES (?, ?, '', '')").run(
        GOALS_LEDGER,
        milestoneId,
      );
      db.query("UPDATE items SET milestone_id = ? WHERE ledger = ? AND id = ?").run(
        milestoneId,
        GOALS_LEDGER,
        goalId,
      );
    } finally {
      db.close();
    }
  }

  async restart(): Promise<PlanLifecycleContractFixture> {
    const root = await mkdtemp(path.join(tmpdir(), "ledger-plan-sqlite-restart-"));
    const dbPath = path.join(root, "ledger.db");
    const source = openLedgerDb(this.dbPath);
    try {
      source.query("VACUUM INTO ?").run(dbPath);
    } finally {
      source.close();
    }
    const restarted = await SqlitePlanLifecycleFixture.createFromPath(root, dbPath);
    this.spawned.push(restarted);
    return restarted;
  }

  override async dispose(): Promise<void> {
    for (const fixture of this.spawned.splice(0)) await fixture.dispose();
    for (const store of this.stores) await store.dispose();
    await rm(this.root, { recursive: true, force: true });
  }
}

export const sqlitePlanLifecycleFactory: PlanLifecycleContractFactory = {
  name: "SqliteLedgerStore (two connections)",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  progression: false,
  build: () => SqlitePlanLifecycleFixture.create(),
};
