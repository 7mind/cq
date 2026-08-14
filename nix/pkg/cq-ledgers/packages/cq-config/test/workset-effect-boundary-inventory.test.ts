import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function source(...segments: string[]): string {
  return readFileSync(join(import.meta.dir, "..", "..", ...segments), "utf8");
}

describe("T1984 workset effect boundary inventory", () => {
  test("every production worktree/rebase/merge host enters the registered effect broker [Behavioral-Active Blackbox-Atomic]", () => {
    const worktreeTool = source("ledger", "src", "mcp", "worktreeManageTools.ts");
    const conflictHost = source("ledger-mcp", "src", "dispatchCapability.ts");
    const gateHost = source("cq-cli", "src", "gateGitEffect.ts");
    const broker = source("process-control", "src", "worksetGitEffectGate.ts");

    expect(worktreeTool).toContain("createManagedWorktreeGitEffectRunner");
    expect(conflictHost).toContain("runLedgerWorksetGitEffect");
    expect(gateHost).toContain("runWorksetGitEffectGate");
    expect(broker).toContain("beforeLaunch");
    for (const kind of [
      "worktree-create",
      "worktree-remove",
      "branch-create",
      "branch-remove",
      "rebase",
      "merge",
    ]) {
      expect(broker).toContain(`case "${kind}"`);
    }
  });
});
