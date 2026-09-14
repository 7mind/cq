import { describe, expect, test } from "bun:test";
import { postgresAdoptionBounds } from "./postgresAdoptionBounds.js";
import { assertPostgresLifecycleBounds } from "./postgresLifecycleBoundsAssertions.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL operator-adoption bounds [Performance-Effectual Blackbox-GoodCommunication]", () => {
  test("adoption and exact replay keep indexed closure work fixed at 2000 and 20000 unrelated rows", async () => {
    const small = await postgresAdoptionBounds(2_000);
    const large = await postgresAdoptionBounds(20_000);
    assertPostgresLifecycleBounds(small, large);
    expect(small.observations).toHaveLength(4);
  }, 60_000);
});
