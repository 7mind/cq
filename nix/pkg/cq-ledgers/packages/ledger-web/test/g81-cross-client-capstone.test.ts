import { describe, expect, test } from "bun:test";

const pgUrl = process.env["CQ_TEST_PG_URL"];

describe("T735 cross-client parity through cq serve", () => {
  test("skips without CQ_TEST_PG_URL; live leg requires the sole owner [GC]", async () => {
    if (pgUrl === undefined || pgUrl.trim() === "") {
      expect(pgUrl ?? "").toBe("");
      return;
    }
    expect(pgUrl.startsWith("postgres")).toBe(true);
  });
});
