import { describe, expect, test } from "bun:test";
import { bindClaudeNativeWorktree, bindPiNativeWorktree, createCodexRoleBoundaryPlan,
  executeCodexRoleBoundary, type ClaudeNativeWorktreeManagePort } from "@cq/config";
import { nativeManagedWorktreeEffectTarget } from "../../cq-config/src/nativeManagedWorktreeSubject.js";
import { prepareManagedCohortWorktree } from "../src/managedWorktree.js";
import { createCohortWorksetEffectAdmissionProvider } from "../src/workCohortEffects.js";
import { cohortBrokerGit, cohortGitBrokerFixture } from "./workCohortGitBrokerFixture.js";

describe("native full-cohort manager and process admission [Blackbox-GoodCommunication]", () => {
  for (const backend of ["memory", "sqlite"] as const) {
    test(`${backend}: real manager binding and child launch retain every member; removed roots and expired epoch refuse`, async () => {
      const fixture = await cohortGitBrokerFixture(backend);
      try {
        const { prepared, authority, root, baseCommit } = fixture;
        const port: ClaudeNativeWorktreeManagePort = {
          async prepare(request) {
            if (request.handle?.version !== 3 || request.cohort === undefined || Object.hasOwn(request, "taskId")) {
              throw new Error("native prepare lost the complete cohort");
            }
            return prepareManagedCohortWorktree({ repositoryRoot: root, baseCommit, handle: request.handle,
              priorResultCommit: null, integrationHead: baseCommit,
              dependencyReader: { readTaskSnapshots: async () => ["T1", "T2"].map((taskId) => ({
                taskId, status: "planned", dependsOn: [], resultCommit: null, archived: false,
                contributionKind: "git-producing" as const, operatorAction: null,
              })) } }, fixture.deps, { ...authority, envelope: request.cohort });
          },
          async release() { throw new Error("completion owns cohort release"); },
        };
        for (const bind of [bindClaudeNativeWorktree, bindPiNativeWorktree]) {
          const bound = await bind({ port, handle: prepared.handle, cohort: authority.envelope,
            observeHead: (cwd) => cohortBrokerGit(cwd, ["rev-parse", "HEAD"]) });
          expect(bound.status).toBe("bound");
          if (bound.status !== "bound") throw new Error(bound.detail);
          expect(bound.binding.cohort).toEqual(authority.envelope);
          expect(bound.binding.handle).toEqual(prepared.handle);
        }
        const dispatch = { attestationId: "att_native_cohort_boundary", generation: 1 };
        const stream = [
          { type: "item.completed", item: { type: "mcp_tool_call", server: "ledger", tool: "store_result",
            result: { content: [{ type: "text", text: JSON.stringify({ state: "result-stored", result: {
              state: "result-stored", ...dispatch, storedAt: "2026-09-22T00:00:00.000Z", outputDigest: "trusted-adapter-test",
            } }) }] } } },
          { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(dispatch) } },
        ].map((entry) => JSON.stringify(entry)).join("\n");
        const plan = createCodexRoleBoundaryPlan({ roleId: "implement-reviewer", roleInstructions: "Inspect every member",
          handle: dispatch, inputCapability: { scope: "fetch-input", token: "cq_input_cohort_test" },
          resultCapability: { scope: "store-result", token: "cq_result_cohort_test" },
          cwd: prepared.handle.absolutePath, ledgerCwd: root, model: "recording", reasoningEffort: "medium",
          sandboxMode: "danger-full-access", timeoutMs: 5_000, promptRoot: root, ledgerCommand: process.execPath,
          codexExecutable: process.execPath });
        const recordingPlan = { ...plan, argv: [process.execPath, "-e", `process.stdin.resume(); console.log(${JSON.stringify(stream)});`] };
        const effect = { cohort: authority.envelope,
          targetRef: nativeManagedWorktreeEffectTarget({ handle: prepared.handle, cohort: authority.envelope }),
          provider: createCohortWorksetEffectAdmissionProvider(authority, fixture.ledger.worksetStore()) };
        expect(await executeCodexRoleBoundary(recordingPlan, effect)).toEqual(dispatch);
        await fixture.ledger.worksetStore().setRoots(["tasks:T1"]);
        await expect(executeCodexRoleBoundary(recordingPlan, effect)).rejects.toThrow();
        await fixture.ledger.worksetStore().setRoots(["tasks:T1", "tasks:T2"]);
        await fixture.store.beginNewExecutionEpoch();
        await expect(executeCodexRoleBoundary(recordingPlan, effect)).rejects.toThrow("execution epoch");
      } finally { await fixture.close(); }
    });
  }
});
