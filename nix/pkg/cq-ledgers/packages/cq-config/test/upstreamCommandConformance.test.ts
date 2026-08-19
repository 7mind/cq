import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const COMMAND = path.resolve(
  import.meta.dir,
  "../../../../cq-assets/commands/cq/upstream.md",
);

describe("T810 /cq:upstream command conformance", () => {
  test("documents both signatures, kill-switches, and fail-closed rules [BA]", () => {
    const source = readFileSync(COMMAND, "utf8");
    expect(source).toContain("CQ::upstream U<n>");
    expect(source).toContain("Batch-recheck only");
    expect(source).toContain("Never file");
    expect(source).toContain("filing");
    expect(source).toContain("recheck");
    expect(source).toContain("ordinary");
    expect(source).toContain("github");
    expect(source).toContain("filingOperationId");
    expect(source).toContain("reconciliation-required");
    expect(source).toContain("cq log put");
    expect(source).toContain("There is no `:advance`, no `pUpstream`");
    expect(source).not.toMatch(/GH_TOKEN|Bearer /);
  });
});
