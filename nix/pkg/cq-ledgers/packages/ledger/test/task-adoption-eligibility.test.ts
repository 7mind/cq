import { describe, expect, it } from "bun:test";
import type { Item } from "../src/types.js";
import { observeTaskAdoptionEligibility } from "../src/taskAdoptionEligibility.js";

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
});
