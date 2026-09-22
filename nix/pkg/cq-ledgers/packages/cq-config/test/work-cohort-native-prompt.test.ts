import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

async function source(role: string): Promise<string> {
  return (await readFile(resolve(import.meta.dir, `../../../../cq-assets/agents/${role}.md`), "utf8"))
    .replace(/\s+/g, " ");
}

describe("full-cohort role prompt contract [Blackbox-Atomic]", () => {
  test("worker stages every member without a child full-gate fallback", async () => {
    const prompt = await source("implement-worker");
    for (const token of ["Full-cohort arm (worker v13)", "memberObservations", "stage-only",
      "Never invoke `cq gate run`, `bun run check`", "single queue-front full gate", "cohort-arm `pass`",
      "omit `taskId`", "version-2"]) expect(prompt).toContain(token);
    expect(prompt).not.toContain("`pass` requires observed gate success,");
  });

  test("reviewer makes one sealed-cohort review with separate member adjudications", async () => {
    const prompt = await source("implement-reviewer");
    for (const token of ["Full-cohort arm (reviewer v8)", "complete sealed", "memberObservations",
      "every member's acceptance separately", "evidenceSubject", "Never run another full gate for a cohort",
      "For a task arm only, when both evidence fields are absent"]) expect(prompt).toContain(token);
  });

  test("resolver preserves each member intent and exact full-cohort receipts", async () => {
    const prompt = await source("implement-conflict-resolver");
    for (const token of ["Full-cohort arm (resolver v7)", "every ordered member's intent",
      "exact `conflictState` digest", "version-2 full-cohort continuation receipt", "memberObservations",
      "no child full gate", "If the intents are incompatible, return `fail`"]) expect(prompt).toContain(token);
  });
});
