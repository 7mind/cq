import { describe } from "bun:test";
import { runDirectOwnedLifecycleContract } from "./directOwnedLifecycleContract.js";
import { ownedLifecyclePostgresFixture } from "./ownedLifecyclePostgresFixture.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL direct lifecycle", () => {
  runDirectOwnedLifecycleContract("real PostgreSQL / GoodCommunication", ownedLifecyclePostgresFixture);
});
