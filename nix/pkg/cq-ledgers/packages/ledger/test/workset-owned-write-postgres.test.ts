import { describe, it } from "bun:test";
import { runWorksetOwnedWriteContract } from "./worksetOwnedWriteContract.js";
import { postgresOwnedWriteFactory } from "./worksetOwnedWriteDurableFactories.js";

const dsn = process.env.CQ_TEST_PG_URL;

if (dsn === undefined || dsn.length === 0) {
  if (process.env.CQ_TEST_REQUIRE_PG === "1") {
    throw new Error(
      "CQ_TEST_REQUIRE_PG=1 requires CQ_TEST_PG_URL to contain a PostgreSQL DSN",
    );
  }
  describe.skip("workset owned-write contract — PostgresLedgerStore", () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
} else {
  runWorksetOwnedWriteContract(postgresOwnedWriteFactory(dsn));
}
