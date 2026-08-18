import { describe, expect, it } from "bun:test";
import type { Item } from "../src/types.js";
import {
  observeTaskAdoptionEligibility,
  TaskAdoptionFenceRegistry,
} from "../src/taskAdoptionEligibility.js";

const RESULT_A = "a".repeat(40);
const RESULT_B = "b".repeat(40);

function task(
  id: string,
  status: string,
  fields: Item["fields"],
): Item {
  return {
    id,
    milestoneId: "M1",
    status,
    fields,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

function eligibleT1207Shape(): readonly Item[] {
  return [
    task("T1206", "done", { headline: "dependency", resultCommit: RESULT_A }),
    task("T1207", "wip", { headline: "root", dependsOn: ["tasks:T1206"] }),
  ];
}

function operatorActionDependencyShape(): readonly Item[] {
  return [
    task("T2191", "done", { headline: "Git ancestor", resultCommit: RESULT_A }),
    task("T2192", "done", {
      headline: "External effect",
      description: "CQ-OPERATOR-ACTION v1 deploy-t2192. Deploy it.",
      dependsOn: ["tasks:T2191"],
    }),
    task("T2217", "wip", { headline: "root", dependsOn: ["tasks:T2192"] }),
  ];
}

function replaceTask(
  items: readonly Item[],
  taskId: string,
  replace: (item: Item) => Item,
): readonly Item[] {
  return items.map((item) => (item.id === taskId ? replace(item) : item));
}

describe("task adoption eligibility identity scope", () => {
  it("keeps a T1207-shaped root eligible when an unrelated archived identity is duplicated", () => {
    const result = observeTaskAdoptionEligibility(
      "T1207",
      [...eligibleT1207Shape(), task("T12", "done", { resultCommit: RESULT_B })],
      [task("T12", "done", { resultCommit: RESULT_B })],
    );

    expect(result.status).toBe("eligible");
  });

  it("fails closed when the requested root identity is ambiguous", () => {
    expect(() =>
      observeTaskAdoptionEligibility(
        "T1207",
        eligibleT1207Shape(),
        [task("T1207", "wip", { dependsOn: ["tasks:T1206"] })],
      ),
    ).toThrow("reachable task identity ambiguity: T1207");
  });

  it("fails closed when a reachable dependency identity is ambiguous", () => {
    expect(() =>
      observeTaskAdoptionEligibility(
        "T1207",
        eligibleT1207Shape(),
        [task("T1206", "done", { resultCommit: RESULT_A })],
      ),
    ).toThrow("reachable task identity ambiguity: T1206");
  });

  it("fails closed before resolving a divergent reachable dependency identity", () => {
    expect(() =>
      observeTaskAdoptionEligibility(
        "T1207",
        [
          task("T1206", "blocked", { headline: "active divergent dependency" }),
          task("T1207", "wip", { headline: "root", dependsOn: ["tasks:T1206"] }),
        ],
        [task("T1206", "done", { headline: "archived duplicate", resultCommit: RESULT_A })],
      ),
    ).toThrow("reachable task identity ambiguity: T1206");
  });

  it("fails closed when a bare reachable dependency identity is ambiguous", () => {
    expect(() =>
      observeTaskAdoptionEligibility(
        "T1207",
        [
          task("T1206", "blocked", { headline: "active divergent dependency" }),
          task("T1207", "wip", { headline: "root", dependsOn: ["T1206"] }),
        ],
        [task("T1206", "done", { headline: "archived duplicate", resultCommit: RESULT_A })],
      ),
    ).toThrow("reachable task identity ambiguity: T1206");
  });
});

describe("task adoption external-effect closure fence", () => {
  // regression: D346 omitted a completed strict operator action from the fenced closure.
  it("captures the complete closure with contribution kind and parsed action identity", () => {
    expect(observeTaskAdoptionEligibility("T2217", operatorActionDependencyShape(), [])).toEqual({
      status: "eligible",
      snapshot: {
        taskId: "T2217",
        tasks: [
          {
            taskId: "T2191",
            status: "done",
            dependsOn: [],
            resultCommit: RESULT_A,
            archived: false,
            contributionKind: "git-producing",
            operatorAction: null,
          },
          {
            taskId: "T2192",
            status: "done",
            dependsOn: ["tasks:T2191"],
            resultCommit: null,
            archived: false,
            contributionKind: "external-effect",
            operatorAction: { version: "v1", actionKey: "deploy-t2192" },
          },
          {
            taskId: "T2217",
            status: "wip",
            dependsOn: ["tasks:T2192"],
            resultCommit: null,
            archived: false,
            contributionKind: "git-producing",
            operatorAction: null,
          },
        ],
      },
    });
  });

  it("makes every external-effect closure identity change stale after capture", () => {
    const baseline = operatorActionDependencyShape();
    const registry = new TaskAdoptionFenceRegistry();
    const captured = registry.capture(
      "T2217",
      observeTaskAdoptionEligibility("T2217", baseline, []),
    );
    expect(captured.status).toBe("eligible");
    if (captured.status !== "eligible") throw new Error("expected eligible baseline");

    const mutateFields = (fields: Item["fields"]): readonly Item[] =>
      replaceTask(baseline, "T2192", (item) => ({
        ...item,
        fields: { ...item.fields, ...fields },
      }));
    const cases = [
      {
        name: "status",
        active: replaceTask(baseline, "T2192", (item) => ({ ...item, status: "blocked" })),
        archived: [],
      },
      {
        name: "archive placement",
        active: baseline.filter((item) => item.id !== "T2192"),
        archived: baseline.filter((item) => item.id === "T2192"),
      },
      { name: "dependencies", active: mutateFields({ dependsOn: [] }), archived: [] },
      { name: "resultCommit", active: mutateFields({ resultCommit: RESULT_B }), archived: [] },
      {
        name: "contribution discriminator",
        active: mutateFields({ description: "ordinary completed task" }),
        archived: [],
      },
      {
        name: "parsed envelope",
        active: mutateFields({
          description: "CQ-OPERATOR-ACTION v2 deploy-t2192. Unsupported envelope.",
        }),
        archived: [],
      },
      {
        name: "action key",
        active: mutateFields({
          description: "CQ-OPERATOR-ACTION v1 deploy-t2192-revised. Deploy it.",
        }),
        archived: [],
      },
    ] as const;
    let publicationCount = 0;

    expect(
      cases.map(({ name, active, archived }) => ({
        name,
        result: registry.compareAndPublish(
          captured.fence,
          observeTaskAdoptionEligibility("T2217", active, archived),
          () => {
            publicationCount += 1;
          },
        ),
      })),
    ).toEqual(cases.map(({ name }) => ({ name, result: { status: "stale" } })));
    expect(publicationCount).toBe(0);
    expect(
      registry.compareAndPublish(
        captured.fence,
        observeTaskAdoptionEligibility("T2217", baseline, []),
        () => {
          publicationCount += 1;
        },
      ),
    ).toEqual({ status: "published" });
    expect(publicationCount).toBe(1);
  });
});
