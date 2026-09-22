import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

async function source(command: string): Promise<string> {
  return (await readFile(resolve(import.meta.dir, `../../../../cq-assets/commands/cq/${command}.md`), "utf8")).replace(/\s+/gu, " ");
}

describe("canonical always-on cohort command contract [Behavioral-Active Blackbox-Atomic]", () => {
  test("outer advance observes bounded ready work and reports measured progress without broadening authority", async () => {
    const text = await source("advance");
    for (const clause of ["mandatory safe fusion", "phase-homogeneous", "common atom", "explicit singleton", "get_cohort_status",
      "bounded ready observation", "Never auto-close goals", "bootstrap-repair"]) expect(text).toContain(clause);
    expect(text).not.toContain("For every id currently returned by `pInvestigate.items`");
  });
  test("ordinary implementation uses exact sealed evidence and atomic cohort completion", async () => {
    const text = await source("implement/advance");
    for (const clause of ["cohort_advance", "pending candidate attempt", "immutable candidate seal", "evidenceSubject",
      "selected shared-regression", "one canonical full gate", "record_cohort_review", "complete_cohort", "current execution epoch",
      "No fusion setting", "no post-merge validation", "explicit singleton", "whole-candidate", "bootstrap mode"]) expect(text).toContain(clause);
    expect(text).not.toContain("trusted result storage runs the repository-wide full gate exactly once");
    expect(text).not.toContain("Every reviewer reruns the gate only when exact trusted evidence is absent or invalid.");
  });
  test("investigation preserves per-member adjudication within its admitted homogeneous cohort", async () => {
    const text = await source("investigate/advance");
    for (const clause of ["mandatory safe fusion", "common atom", "explicit singleton", "cohort_advance",
      "cohort_investigation_advance", "prepared launch is not an executed role", "evidenceDigest", "completeOutput",
      "investigationCohort: launch.nativeBinding", "cq-cohort-effect:v1:<planDigest>",
      "per-member", "split", "current execution epoch", "no implementation acceptance", "user alone"]) expect(text).toContain(clause);
  });
});
