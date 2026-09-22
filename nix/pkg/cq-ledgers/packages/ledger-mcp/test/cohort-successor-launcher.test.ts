import { describe, expect, test } from "bun:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DispatchPrepared } from "@cq/config";
import { cohortEffectTargetRefV1 } from "@cq/process-control";
import { createImplementationSuccessorLauncher } from "../src/main.js";
import { cohortGitBrokerFixture } from "../../ledger/test/workCohortGitBrokerFixture.js";

describe("cohort successor private launch [Effectual-GoodCommunication]", () => {
  test("full subject is sent on private stdin without a task anchor or capabilities in argv", async () => {
    const subject = await cohortGitBrokerFixture("memory");
    try {
      const script = join(subject.root, "record-successor.ts");
      const captured = join(subject.root, "successor.json");
      await writeFile(script, `const invocation = JSON.parse(await Bun.stdin.text());
await Bun.write(${JSON.stringify(captured)}, JSON.stringify({ invocation, argv: process.argv.slice(2) }));
console.log(JSON.stringify(invocation.handle));\n`);
      const prepared: DispatchPrepared = {
        attestationId: "cohort-successor", generation: 2,
        promptProvenance: { roleId: "implement-worker", version: 13, surface: "codex",
          promptDigest: "a".repeat(64), catalogHash: "b".repeat(64), inputDigest: "c".repeat(64) },
        inputCapability: { scope: "fetch-input", token: "cq_input_successor" },
        resultCapability: { scope: "store-result", token: "cq_result_successor" },
        parentGateCapability: { scope: "parent-gate", token: "cq_parent_successor" },
        gitChangeCapability: { scope: "git-change", token: "cq_git_successor" },
        responseStoreNow: "2099-01-01T00:00:00.000Z", childCancelAt: "2099-01-01T00:01:00.000Z", launchDeadline: "2099-01-01T00:02:00.000Z",
      };
      const launch = createImplementationSuccessorLauncher({ roleCommand: process.execPath, roleScript: script,
        ledgerCommand: "/recording/cq", codexExecutable: "/recording/codex", model: "recording",
        reasoningEffort: "medium", sandboxMode: "workspace-write" }, subject.root, {});
      await launch({ prepared, managed: subject.authorization, expectedChild: { childId: "implement-worker#cohort", runId: "cohort-run" }, timeoutMs: 5_000 });
      const result = JSON.parse(await readFile(captured, "utf8"));
      expect(result.argv).toEqual([]);
      expect(result.invocation.cohort).toEqual(subject.authority.envelope);
      expect(result.invocation.effectTargetRef).toBe(cohortEffectTargetRefV1(subject.authority.envelope));
      expect(Object.hasOwn(result.invocation, "taskId")).toBe(false);
      expect(JSON.stringify(result.argv)).not.toContain("cq_git_successor");
    } finally { await subject.close(); }
  });
});
