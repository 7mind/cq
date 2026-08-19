import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { LEDGER_BACKENDS } from "@cq/config";

describe("T736 public postgres backend is retired [BA]", () => {
  test("LEDGER_BACKENDS does not include postgres", () => {
    expect(LEDGER_BACKENDS).not.toContain("postgres");
    expect(LEDGER_BACKENDS).toContain("remote");
  });

  test("createLedgerStore has no postgres construction branch", () => {
    const src = readFileSync(
      path.resolve(import.meta.dir, "../src/store/createLedgerStore.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/backend === "postgres"/);
    expect(src).not.toContain("new PostgresLedgerStore");
  });
});
