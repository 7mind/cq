import { describe, expect, it } from "bun:test";
import {
  FsLedgerStore,
  GitObjectLedgerBackend,
  PostgresLedgerStore,
  SqliteLedgerStore,
} from "../src/index.js";
import {
  inMemoryPlanLifecycleFactory,
} from "./planLifecycleInMemoryAdapter.js";
import { sqlitePlanLifecycleFactory } from "./planLifecycleSqliteAdapter.js";
import {
  referencePlanLifecycleFactory,
  type PlanLifecycleContractFactory,
} from "./planLifecycleReferenceAdapter.js";
import { runPlanLifecycleStoreContract } from "./planLifecycleStoreContract.js";
import {
  fsPlanLifecycleFactory,
  gitPlanLifecycleFactory,
} from "./planLifecyclePersistentAdapters.js";
import { postgresPlanLifecycleFactory } from "./planLifecyclePostgresAdapter.js";

// Required-live mode (T1855): when CQ_TEST_REQUIRE_PG=1 selects it, an absent
// DSN is fatal at module evaluation rather than a silently skipped PostgreSQL
// leg — the cq-ledger-parent-liveness-postgres flake check depends on it.
if (
  process.env["CQ_TEST_REQUIRE_PG"] === "1" &&
  (process.env["CQ_TEST_PG_URL"] === undefined || process.env["CQ_TEST_PG_URL"] === "")
) {
  throw new Error("CQ_TEST_REQUIRE_PG=1 requires CQ_TEST_PG_URL to contain a PostgreSQL DSN");
}

const PLAN_LIFECYCLE_METHODS = [
  "claimPlan",
  "publishPlanDraft",
  "releasePlanClaim",
  "finalizePlan",
] as const;

interface StoreConstructor {
  readonly prototype: object;
}

interface ProductionRegistration {
  readonly name: string;
  readonly store: StoreConstructor;
}

const PRODUCTION_REGISTRATIONS: readonly ProductionRegistration[] = [
  { name: "FsLedgerStore", store: FsLedgerStore },
  { name: "GitObjectLedgerBackend", store: GitObjectLedgerBackend },
  { name: "SqliteLedgerStore", store: SqliteLedgerStore },
  { name: "PostgresLedgerStore", store: PostgresLedgerStore },
];

function hasCompletePlanLifecycleCapability(store: StoreConstructor): boolean {
  const surface = store.prototype as Record<string, unknown>;
  return PLAN_LIFECYCLE_METHODS.every((method) => typeof surface[method] === "function");
}

function progressionFactory(
  registration: ProductionRegistration,
): PlanLifecycleContractFactory {
  if (hasCompletePlanLifecycleCapability(registration.store)) {
    throw new Error(
      `${registration.name} now exposes PlanLifecycleStore; replace its T847 progression ` +
        "registration with a real GoodCommunication fixture",
    );
  }
  return {
    name: registration.name,
    classification: "Behavioral-Progression Blackbox-GoodCommunication",
    progression: true,
    async build() {
      throw new Error(`${registration.name} has no PlanLifecycleStore capability yet`);
    },
  };
}

runPlanLifecycleStoreContract(referencePlanLifecycleFactory);
runPlanLifecycleStoreContract(inMemoryPlanLifecycleFactory);
runPlanLifecycleStoreContract(sqlitePlanLifecycleFactory);
runPlanLifecycleStoreContract(fsPlanLifecycleFactory);
runPlanLifecycleStoreContract(gitPlanLifecycleFactory);
runPlanLifecycleStoreContract(postgresPlanLifecycleFactory);
// Whatever is left WITHOUT the capability keeps explicit progression coverage.
// Deriving the set from the capability probe (rather than a hand-maintained
// name list) is what makes T851's move of the Postgres leg out of progression
// and into the real run above a single edit that cannot go half-done.
for (const registration of PRODUCTION_REGISTRATIONS.filter(
  (registration) => !hasCompletePlanLifecycleCapability(registration.store),
)) {
  runPlanLifecycleStoreContract(progressionFactory(registration));
}

describe("T847 production capability registry", () => {
  it("enumerates every production LedgerStore backend and the complete lifecycle surface", () => {
    expect(PRODUCTION_REGISTRATIONS.map(({ name }) => name)).toEqual([
      "FsLedgerStore",
      "GitObjectLedgerBackend",
      "SqliteLedgerStore",
      "PostgresLedgerStore",
    ]);
    expect(PLAN_LIFECYCLE_METHODS).toEqual([
      "claimPlan",
      "publishPlanDraft",
      "releasePlanClaim",
      "finalizePlan",
    ]);
  });

  it("keeps each unavailable production leg as explicit progression coverage", () => {
    expect(
      PRODUCTION_REGISTRATIONS.map((registration) => ({
        name: registration.name,
        available: hasCompletePlanLifecycleCapability(registration.store),
      })),
    ).toEqual([
      { name: "FsLedgerStore", available: true },
      { name: "GitObjectLedgerBackend", available: true },
      { name: "SqliteLedgerStore", available: true },
      { name: "PostgresLedgerStore", available: true },
    ]);
  });
});
