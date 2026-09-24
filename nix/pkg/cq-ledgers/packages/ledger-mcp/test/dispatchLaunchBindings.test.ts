/** G224: per-harness launch planning in the production bindings. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createStrictInMemoryWorksetEffectAdmissionProvider } from "@cq/process-control";
import { createDispatchLaunchBindings, DispatchLaunchUnavailableError } from "../src/dispatchLaunchBindings.js";

function bindings() {
  return createDispatchLaunchBindings({
    ledgerCwd: "/project",
    promptSurfacesRoot: "/prompt-surfaces",
    ledgerCommand: "cq",
    claudeExecutable: "claude",
    codexRoleCommand: "cq-codex-role",
    piExecutable: "pi",
    effectAdmission: createStrictInMemoryWorksetEffectAdmissionProvider(),
    cohortEffectAdmission: async () => createStrictInMemoryWorksetEffectAdmissionProvider(),
    readEnvelope: async () => undefined,
    now: () => "2026-09-24T12:00:00.000Z",
  });
}

describe("createDispatchLaunchBindings", () => {
  test("registers one process adapter per target harness", () => {
    expect(bindings().adapters.map((adapter) => adapter.id)).toEqual(["claude:process", "codex:process", "pi:process"]);
  });

  test("every harness mints a <roleId>#<nonce> child id whose qualification identity matches it", () => {
    for (const harness of ["claude", "codex", "pi"] as const) {
      const planned = bindings().planner.plan(harness, "plan-advance", "seed-1");
      expect(planned.expectedChild.childId, harness).toBe(
        `plan-advance#${planned.qualificationIdentity.correlationId}`,
      );
      expect(planned.expectedChild.runId, harness).toBe(planned.qualificationIdentity.runId);
    }
  });

  test("an idempotent replay plans the same child; a different dispatch plans a different one", () => {
    for (const harness of ["claude", "codex", "pi"] as const) {
      const first = bindings().planner.plan(harness, "plan-advance", "key-1");
      const replay = bindings().planner.plan(harness, "plan-advance", "key-1");
      const other = bindings().planner.plan(harness, "plan-advance", "key-2");
      expect(replay.expectedChild, harness).toEqual(first.expectedChild);
      expect(other.expectedChild.childId, harness).not.toBe(first.expectedChild.childId);
    }
    expect(bindings().planner.plan("claude", "implement-worker", "key-1").expectedChild.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("Pi-configured implementation roles are refused before anything is prepared; planners and explorers run", () => {
    for (const roleId of ["implement-worker", "implement-reviewer", "implement-conflict-resolver", "implementation-auditor"]) {
      expect(() => bindings().planner.plan("pi", roleId, "seed-1"), roleId).toThrow(DispatchLaunchUnavailableError);
    }
    for (const roleId of ["plan-advance", "plan-reviewer", "investigate-explorer", "research-experimenter"]) {
      expect(() => bindings().planner.plan("pi", roleId, "seed-1"), roleId).not.toThrow();
    }
  });
});

describe("per-dispatch admission", () => {
  const surfaces = mkdtempSync(path.join(tmpdir(), "cq-g224-bindings-"));
  afterAll(() => rmSync(surfaces, { recursive: true, force: true }));
  mkdirSync(path.join(surfaces, "claude", "roles"), { recursive: true });
  writeFileSync(
    path.join(surfaces, "claude", "roles", "implement-worker.md"),
    "---\nname: implement-worker\ndescription: x\ndisallowedTools: Agent\n---\n\nbody\n",
  );
  const PAST = "2020-01-01T00:00:00.000Z";

  async function launchWithInput(input: Record<string, unknown>) {
    const cohortCalls: Array<{ cohort: unknown; roleId: string }> = [];
    const bound = createDispatchLaunchBindings({
      ledgerCwd: "/project",
      promptSurfacesRoot: surfaces,
      ledgerCommand: "cq",
      claudeExecutable: "claude",
      codexRoleCommand: "cq-codex-role",
      piExecutable: "pi",
      effectAdmission: createStrictInMemoryWorksetEffectAdmissionProvider(),
      cohortEffectAdmission: async (cohort, roleId) => {
        cohortCalls.push({ cohort, roleId });
        return createStrictInMemoryWorksetEffectAdmissionProvider();
      },
      readEnvelope: async () => ({ input }) as never,
      now: () => "2026-09-24T12:00:00.000Z",
    });
    const handle = { attestationId: `att_${"a".repeat(32)}`, generation: 1 };
    bound.planner.plan("claude", "implement-worker", "seed-1").bind(handle);
    const claude = bound.adapters.find((adapter) => adapter.id === "claude:process")!;
    const result = await claude.launch({
      route: { activeHarness: "claude", targetHarness: "claude", forceShellout: true, transport: "process", adapterId: "claude:process" },
      prepared: {
        ...handle,
        promptProvenance: { roleId: "implement-worker" },
        launchDeadline: PAST,
        childCancelAt: PAST,
        responseStoreNow: PAST,
      },
      resolvedModel: { harness: "claude", model: "sonnet", provider: null, effort: null },
      effectTargetRef: "tasks:T1",
      child: {},
    } as never);
    return { result, cohortCalls };
  }

  test("a cohort dispatch takes admission from its cohort authority", async () => {
    const cohort = { intent: { intentDigest: "c".repeat(64) } };
    const { result, cohortCalls } = await launchWithInput({ cohort, worktreePath: "/wt" });
    expect(cohortCalls).toEqual([{ cohort, roleId: "implement-worker" }]);
    expect(result.outcome).toBe("aborted");
  });

  test("a single-target dispatch uses the project workset admission", async () => {
    const { cohortCalls } = await launchWithInput({ taskId: "T1", worktreePath: "/wt" });
    expect(cohortCalls).toEqual([]);
  });
});

