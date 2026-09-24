import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DISPATCH_INVOCATION_ENV_NAMES, withoutDispatchInvocationIdentity } from "@cq/config";

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

  test("D506: per-invocation dispatch identity is stripped without touching other settings", () => {
    // Inheriting the parent's correlation re-targets a NESTED invocation at it,
    // which selects the registered-observation path and suppresses the
    // diagnostic the child was launched to emit. Everything else — runtime,
    // test and boundary configuration — must survive untouched.
    expect([...DISPATCH_INVOCATION_ENV_NAMES]).toEqual([
      "CQ_CODEX_ROLE_CORRELATION_ID",
      "CQ_CODEX_ROLE_EXPECTED_RUN_ID",
      "CQ_CODEX_PRETURN_OBSERVATION_PATH",
    ]);

    const parent = {
      CQ_CODEX_ROLE_CORRELATION_ID: "parent-correlation",
      CQ_CODEX_ROLE_EXPECTED_RUN_ID: "parent-run",
      CQ_CODEX_PRETURN_OBSERVATION_PATH: "/parent/observation.json",
      CQ_TEST_PG_URL: "postgresql://fixture/d506",
      CQ_TEST_REQUIRE_PG: "1",
      NODE_OPTIONS: "--no-warnings",
      CQ_CODEX_LEDGER_COMMAND: "/fixture/cq",
      CQ_CODEX_EXECUTABLE: "/fixture/codex",
      PATH: "/fixture/bin",
    } as const;

    expect(withoutDispatchInvocationIdentity(parent)).toEqual({
      CQ_TEST_PG_URL: "postgresql://fixture/d506",
      CQ_TEST_REQUIRE_PG: "1",
      NODE_OPTIONS: "--no-warnings",
      CQ_CODEX_LEDGER_COMMAND: "/fixture/cq",
      CQ_CODEX_EXECUTABLE: "/fixture/codex",
      PATH: "/fixture/bin",
    });

    // Non-mutating, and a caller may bind its own identity afterwards.
    expect(parent.CQ_CODEX_ROLE_CORRELATION_ID).toBe("parent-correlation");
    expect({
      ...withoutDispatchInvocationIdentity(parent),
      CQ_CODEX_ROLE_CORRELATION_ID: "child-correlation",
    }.CQ_CODEX_ROLE_CORRELATION_ID).toBe("child-correlation");

    // Single-sourced: the gate consumes this list rather than its own copy.
    expect(source("ledger", "src", "supervisedWorkerGate.ts")).toContain(
      "DISPATCH_INVOCATION_ENV_NAMES",
    );
  });
});
