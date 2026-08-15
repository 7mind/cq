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

  test("T1986 binds every child effect to one canonical prepared target and strips management credentials", () => {
    const router = source("cq-config", "src", "dispatchTransportRouter.ts");
    const codex = source("cq-config", "src", "codexRoleBoundary.ts");
    const claude = source("cq-config", "src", "claudeDispatchBridge.ts");
    const management = source("cq-config", "src", "worksetManagementCommand.ts");

    for (const field of ["taskId", "goalId", "defectId", "researchId"]) {
      expect(router).toContain(`field: "${field}"`);
    }
    expect(router).toContain("present.length !== 1");
    expect(router).toContain("targetRef: context.effectTargetRef");
    expect(codex).toContain("new WorksetEffectBroker");
    expect(claude).toContain("new WorksetEffectBroker");
    expect(codex).toContain("withoutWorksetCredentials");
    expect(claude).toContain("withoutWorksetCredentials");
    for (const credential of [
      "CQ_SERVE_TOKEN",
      "CQ_SERVE_MANAGEMENT_TOKEN",
      "CQ_LEDGER_REMOTE_TOKEN",
    ]) {
      expect(management).toContain(credential);
    }
  });
});
