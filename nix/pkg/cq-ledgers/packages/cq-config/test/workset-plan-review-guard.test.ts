import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { exposedLedgerToolsForRole } from "../src/index.js";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ASSETS_ROOT = join(REPOSITORY_ROOT, "nix", "pkg", "cq-assets");

describe("T1986 plan-review workset boundary", () => {
  test("portable review stays write-free and fallback review creation names its admitted owner", () => {
    const portable = readFileSync(join(ASSETS_ROOT, "commands", "cq", "plan-review.md"), "utf8");
    const dispatched = readFileSync(join(ASSETS_ROOT, "agents", "plan-reviewer.md"), "utf8");

    expect(exposedLedgerToolsForRole("plan-review")).toEqual([]);
    expect(portable).toContain("Write nothing");
    expect(dispatched).toContain('owner_ref: "goals:<G>"');
    expect(dispatched).toContain('creation_kind: "review"');
    expect(dispatched).not.toContain("management-token");
  });
});
