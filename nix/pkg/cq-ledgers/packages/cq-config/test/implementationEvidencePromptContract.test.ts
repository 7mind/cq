import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const commandPath = resolve(
  import.meta.dir,
  "../../../../cq-assets/commands/cq/implement/advance.md",
);

function assertContract(source: string): void {
  const compact = source.replace(/\s+/g, " ");
  for (const token of [
    "prepare_implementation_review_panel",
    "prepare_implementation_review_attempt",
    "execute_external_implementation_review_attempt",
    "finalize_implementation_review_attempt",
    "prepare_implementation_review_fallback",
    "prepare_implementation_completion",
    "record_implementation_completion",
    "--completion-ref <completionRef>",
    "--operation-id <merge_operation_id>",
    "CQ_IMPLEMENTATION_COMPLETION_MERGE=<canonical JSON>",
    "supersedes_completion_ref",
    "blocks every other repository merge",
    "manifest-derived bootstrap mode",
    "process only the exact mapped `t-evidence` task",
    "Stop `user-action-required` after recording its terminal completion",
  ])
    expect(compact).toContain(token);
  expect(compact).toContain("not `update_item` or `create_item`");
  expect(compact).not.toContain(
    "cq gate git-effect --operation merge --cwd <repositoryRoot> --task-id <taskId> --commit <resultCommit> ```",
  );
}

describe("implementation evidence orchestration prompt contract [BA]", () => {
  test("requires opaque review receipts, pre-merge preparation, acknowledgement validation, and recovery", async () => {
    assertContract(await readFile(commandPath, "utf8"));
  });

  test.each([
    ["legacy merge", " --completion-ref <completionRef> --operation-id <merge_operation_id>", ""],
    [
      "acknowledgement",
      "CQ_IMPLEMENTATION_COMPLETION_MERGE=<canonical JSON>",
      "legacy merge succeeded",
    ],
    ["protected completion", "record_implementation_completion", "update_item"],
    [
      "restart recovery",
      "blocks every other repository\nmerge",
      "permits another repository merge",
    ],
  ])("rejects the %s mutation", async (_name, from, to) => {
    const source = await readFile(commandPath, "utf8");
    const mutated = source.replaceAll(from, to);
    expect(mutated).not.toBe(source);
    expect(() => assertContract(mutated)).toThrow();
  });
});
