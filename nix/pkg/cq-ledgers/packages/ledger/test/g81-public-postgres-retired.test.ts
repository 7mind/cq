import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { PublicPostgresBackendRetiredError } from "../src/index.js";

describe("T736 public postgres backend is retired [BA]", () => {
  test("createLedgerStore no longer constructs a postgres store", () => {
    const src = readFileSync(
      path.resolve(import.meta.dir, "../src/store/createLedgerStore.ts"),
      "utf8",
    );
    expect(src).toContain("PublicPostgresBackendRetiredError");
    expect(src).toMatch(/if \(backend === "postgres"\) \{\s*throw new PublicPostgresBackendRetiredError/);
  });

  test("the retirement error names backend=remote", () => {
    const err = new PublicPostgresBackendRetiredError("probe", "/tmp/x");
    expect(err.message).toContain('backend = "remote"');
    expect(err.message).toContain("cq serve");
  });
});
