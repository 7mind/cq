import { expect, test } from "bun:test";
import { codexCompletionActor } from "@cq/config";

test("exec-intercepted Codex completion keeps its trusted-extension lineage", () => {
  expect(codexCompletionActor("exec-intercepted")).toBe("trusted-extension");
});
