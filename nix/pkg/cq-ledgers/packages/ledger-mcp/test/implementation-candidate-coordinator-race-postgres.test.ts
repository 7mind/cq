import { describe, test } from "bun:test";
import { runCoordinatorProcessContract } from "./implementationCandidateCoordinatorProcessContract.js";

const postgresDsn = process.env["CQ_TEST_PG_URL"];
const requirePostgres = process.env["CQ_TEST_REQUIRE_PG"] === "1";

if (requirePostgres && (postgresDsn === undefined || postgresDsn.length === 0)) {
  throw new Error("CQ_TEST_REQUIRE_PG=1 requires CQ_TEST_PG_URL for the coordinator process race");
}

describe.skipIf(postgresDsn === undefined)(
  "implementation candidate coordinator process race on required-live PostgreSQL",
  () => {
    test(
      "three peer processes over independent PostgreSQL pools launch one guarded rebase and leave the trailing enrollment untouched [Behavioral-Active Effectual-GoodCommunication]",
      () => {
        if (postgresDsn === undefined) throw new Error("PostgreSQL DSN disappeared after setup");
        return runCoordinatorProcessContract({ backend: "postgres", postgresDsn });
      },
      120_000,
    );
  },
);
