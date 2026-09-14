import { describe } from "bun:test";
import { operatorActionPostgresFixture } from "./operatorActionPostgresFixture.js";
import { runOperatorActionLifecycleContract } from "./operatorActionLifecycleContract.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL operator lifecycle", () => {
  runOperatorActionLifecycleContract("real PostgreSQL / GoodCommunication", operatorActionPostgresFixture);
});
