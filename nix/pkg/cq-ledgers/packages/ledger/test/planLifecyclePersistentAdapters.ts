import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  GitObjectLedgerBackend,
  type LedgerStore,
  type PlanLifecycleStore,
} from "../src/index.js";
import {
  InMemoryPlanLifecycleFixture,
  persistDirectLedgers,
} from "./planLifecycleInMemoryAdapter.js";
import type {
  PlanLifecycleContractFactory,
  PlanLifecycleContractFixture,
} from "./planLifecycleReferenceAdapter.js";
import { OneShotSerializationBoundary } from "./planLifecycleSerializationBoundary.js";

type PersistentStore = LedgerStore & PlanLifecycleStore;

/**
 * Ownership of ONE persistent location shared by a fixture and every fixture
 * `restart()` spawns from it. Each restart opens ANOTHER store over the same
 * `root`, so both the stores and the mkdtemp root outlive the fixture that
 * created them; the context tracks them all and releases them exactly once,
 * whichever sibling fixture the contract disposes.
 */
class PersistentLocation {
  private readonly stores: PersistentStore[] = [];
  private released = false;

  constructor(readonly root: string) {}

  track(store: PersistentStore): void {
    this.stores.push(store);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    for (const store of this.stores) await store.dispose();
    await fs.rm(this.root, { recursive: true, force: true });
  }
}

class PersistentPlanLifecycleFixture extends InMemoryPlanLifecycleFixture {
  private constructor(
    store: PersistentStore,
    private readonly location: PersistentLocation,
    private readonly openStore: (
      serializationBoundary: OneShotSerializationBoundary,
    ) => Promise<PersistentStore>,
    serializationBoundary: OneShotSerializationBoundary,
  ) {
    super(
      store,
      () => openStore(new OneShotSerializationBoundary()),
      (ledgerIds) => persistDirectLedgers(store, ledgerIds),
      serializationBoundary,
    );
  }

  static async createAt(
    root: string,
    openStore: (serializationBoundary: OneShotSerializationBoundary) => Promise<PersistentStore>,
  ): Promise<PersistentPlanLifecycleFixture> {
    const location = new PersistentLocation(root);
    return PersistentPlanLifecycleFixture.open(location, openStore);
  }

  private static async open(
    location: PersistentLocation,
    openStore: (serializationBoundary: OneShotSerializationBoundary) => Promise<PersistentStore>,
  ): Promise<PersistentPlanLifecycleFixture> {
    const serializationBoundary = new OneShotSerializationBoundary();
    const store = await openStore(serializationBoundary);
    location.track(store);
    return new PersistentPlanLifecycleFixture(store, location, openStore, serializationBoundary);
  }

  override async restart(): Promise<PlanLifecycleContractFixture> {
    return PersistentPlanLifecycleFixture.open(this.location, this.openStore);
  }

  override async dispose(): Promise<void> {
    await this.location.release();
  }
}

export const fsPlanLifecycleFactory: PlanLifecycleContractFactory = {
  name: "FsLedgerStore",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  progression: false,
  async build() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-lifecycle-fs-"));
    return PersistentPlanLifecycleFixture.createAt(root, async (serializationBoundary) => {
      const store = new FsLedgerStore({
        root,
        planSerializationBoundaryHook: serializationBoundary.hook,
      });
      await store.init();
      return store;
    });
  },
};

export const gitPlanLifecycleFactory: PlanLifecycleContractFactory = {
  name: "GitObjectLedgerBackend",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  progression: false,
  // D291: git cat-file under full-suite load can exceed the 10s default.
  timeoutMs: 30_000,
  async build() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-lifecycle-git-"));
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    return PersistentPlanLifecycleFixture.createAt(root, async (serializationBoundary) => {
      const store = new GitObjectLedgerBackend({
        repoRoot: root,
        planSerializationBoundaryHook: serializationBoundary.hook,
      });
      await store.init();
      return store;
    });
  },
};
