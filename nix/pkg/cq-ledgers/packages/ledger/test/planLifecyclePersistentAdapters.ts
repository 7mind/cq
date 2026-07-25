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

type PersistentStore = LedgerStore & PlanLifecycleStore;

async function fixture(
  build: () => Promise<PersistentStore>,
): Promise<PlanLifecycleContractFixture> {
  const store = await build();
  return new InMemoryPlanLifecycleFixture(
    store,
    build,
    (ledgerIds) => persistDirectLedgers(store, ledgerIds),
  );
}

export const fsPlanLifecycleFactory: PlanLifecycleContractFactory = {
  name: "FsLedgerStore",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  progression: false,
  async build() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-lifecycle-fs-"));
    const build = async (): Promise<PersistentStore> => {
      const store = new FsLedgerStore({ root });
      await store.init();
      return store;
    };
    return fixture(build);
  },
};

export const gitPlanLifecycleFactory: PlanLifecycleContractFactory = {
  name: "GitObjectLedgerBackend",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  progression: false,
  async build() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-lifecycle-git-"));
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    const build = async (): Promise<PersistentStore> => {
      const store = new GitObjectLedgerBackend({ repoRoot: root });
      await store.init();
      return store;
    };
    return fixture(build);
  },
};
