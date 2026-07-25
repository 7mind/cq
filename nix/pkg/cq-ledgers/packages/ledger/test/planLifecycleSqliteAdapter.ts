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
import { LedgerStorePlanLifecycleFixture } from "./planLifecycleInMemoryAdapter.js";
import type {
  PlanLifecycleContractFactory,
  PlanLifecycleContractFixture,
} from "./planLifecycleReferenceAdapter.js";

type SqliteLifecycleStore = SqliteLedgerStore & PlanLifecycleStore;

class AlternatingSqliteLifecycle implements PlanLifecycleStore {
  private nextIndex = 0;

  constructor(private readonly stores: readonly SqliteLifecycleStore[]) {}

  private next(): SqliteLifecycleStore {
    const store = this.stores[this.nextIndex % this.stores.length];
    if (store === undefined) throw new Error("SQLite lifecycle fixture has no store");
    this.nextIndex += 1;
    return store;
  }

  claimPlan(input: PlanClaimInput): Promise<PlanClaimResult> {
    return this.next().claimPlan(input);
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

class SqlitePlanLifecycleFixture extends LedgerStorePlanLifecycleFixture<SqliteLifecycleStore> {
  private constructor(
    readonly root: string,
    readonly dbPath: string,
    readonly stores: readonly [SqliteLifecycleStore, SqliteLifecycleStore],
  ) {
    super(stores[0], new AlternatingSqliteLifecycle(stores));
  }

  static async createFromPath(
    root: string,
    dbPath: string,
  ): Promise<SqlitePlanLifecycleFixture> {
    const first = new SqliteLedgerStore({ dbPath });
    const second = new SqliteLedgerStore({ dbPath });
    await first.init();
    await second.init();
    return new SqlitePlanLifecycleFixture(
      root,
      dbPath,
      [first as SqliteLifecycleStore, second as SqliteLifecycleStore],
    );
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

  async restart(): Promise<PlanLifecycleContractFixture> {
    const root = await mkdtemp(path.join(tmpdir(), "ledger-plan-sqlite-restart-"));
    const dbPath = path.join(root, "ledger.db");
    const source = openLedgerDb(this.dbPath);
    try {
      source.query("VACUUM INTO ?").run(dbPath);
    } finally {
      source.close();
    }
    return SqlitePlanLifecycleFixture.createFromPath(root, dbPath);
  }

  override async dispose(): Promise<void> {
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
