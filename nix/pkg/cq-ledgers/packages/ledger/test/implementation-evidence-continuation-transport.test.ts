import { describe, expect, test } from "bun:test";
import {
  InMemoryLedgerStore,
  createLedgerMcpTools,
  createManagementLedgerMcpTools,
  createObserveOnlyWorksetInvocationAuthority,
  type ImplementationEvidenceService,
} from "../src/index.js";

const FROM_HEAD = "a".repeat(40);
const REPOSITORY_HEAD = "b".repeat(40);
const PRIOR_REQUIREMENT_REF =
  `cq-implementation-evidence-activation-requirement:v1:${"1".repeat(64)}`;
const COMPLETION_REF = `cq-implementation-completion:v1:${"2".repeat(64)}`;

function continuationService(observed: Array<Record<string, unknown>>): ImplementationEvidenceService {
  return {
    continueEvidenceActivation: async (input: Record<string, unknown>) => {
      observed.push(input);
      return {
        status: "continued",
        continuationRef: `cq-implementation-evidence-activation-continuation:v1:${"3".repeat(64)}`,
        previousRequirementRef: PRIOR_REQUIREMENT_REF,
        requirementRef:
          `cq-implementation-evidence-activation-requirement:v1:${"4".repeat(64)}`,
        activationRef: `cq-implementation-evidence-activation:v1:${"5".repeat(64)}`,
        taskRef: "tasks:T3003",
        completionRef: COMPLETION_REF,
        fromHead: FROM_HEAD,
        repositoryHead: REPOSITORY_HEAD,
      };
    },
  } as unknown as ImplementationEvidenceService;
}

function resultJson(result: unknown): unknown {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  const text = content.find((entry) => entry.type === "text")?.text;
  if (text === undefined) throw new Error("continuation tool result has no JSON text");
  return JSON.parse(text);
}

describe("implementation evidence continuation transport [BG]", () => {
  test("is management-only and translates the exact direct request", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const observed: Array<Record<string, unknown>> = [];
    const service = continuationService(observed);
    const ordinary = createLedgerMcpTools(
      store,
      undefined,
      undefined,
      undefined,
      "",
      undefined,
      undefined,
      "full",
      undefined,
      createObserveOnlyWorksetInvocationAuthority(),
      service,
    ).map(({ name }) => name);
    expect(ordinary).not.toContain("continue_implementation_evidence_activation");

    const management = createManagementLedgerMcpTools(
      store,
      undefined,
      undefined,
      undefined,
      "",
      undefined,
      undefined,
      "implement/advance",
      undefined,
      service,
    );
    const tool = management.find(
      ({ name }) => name === "continue_implementation_evidence_activation",
    );
    if (tool === undefined) throw new Error("management continuation tool is absent");
    const result = resultJson(await tool.handler({
      goal_ref: "goals:G176",
      manifest_id: "d347-implementation-evidence-activation-v2",
      prior_requirement_ref: PRIOR_REQUIREMENT_REF,
      completed_task_ref: "tasks:T3003",
      completion_ref: COMPLETION_REF,
      expected_from_head: FROM_HEAD,
      expected_repository_head: REPOSITORY_HEAD,
      operation_id: "continue-t3003",
      author: "parent",
      session: "run",
    }, null));
    expect(result).toMatchObject({
      status: "continued",
      previousRequirementRef: PRIOR_REQUIREMENT_REF,
      taskRef: "tasks:T3003",
      fromHead: FROM_HEAD,
      repositoryHead: REPOSITORY_HEAD,
    });
    expect(observed).toEqual([{
      goalRef: "goals:G176",
      manifestId: "d347-implementation-evidence-activation-v2",
      priorRequirementRef: PRIOR_REQUIREMENT_REF,
      completedTaskRef: "tasks:T3003",
      completionRef: COMPLETION_REF,
      expectedFromHead: FROM_HEAD,
      expectedRepositoryHead: REPOSITORY_HEAD,
      operationId: "continue-t3003",
      author: "parent",
      session: "run",
    }]);
  });
});
