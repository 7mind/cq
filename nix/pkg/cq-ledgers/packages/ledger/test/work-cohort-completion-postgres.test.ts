import { describe } from "bun:test";
import { cohortCompletionTransactionContract } from "./cohortCompletionTransactionContract.js";
import { workCohortCompletionContract } from "./workCohortCompletionContract.js";
import { ownedLifecyclePostgresFixture } from "./ownedLifecyclePostgresFixture.js";

describe.skipIf(process.env.CQ_TEST_PG_URL === undefined)("PostgreSQL cohort completion", () => {
  cohortCompletionTransactionContract("PostgreSQL [Blackbox-GoodCommunication]", ownedLifecyclePostgresFixture);
  workCohortCompletionContract("PostgreSQL [Blackbox-GoodCommunication]", ownedLifecyclePostgresFixture);
});
