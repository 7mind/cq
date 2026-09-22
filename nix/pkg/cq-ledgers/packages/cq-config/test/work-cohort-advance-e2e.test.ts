import { expect, test } from "bun:test";
import { resolve } from "node:path";

const WORKSPACE = resolve(import.meta.dir, "../../..");
const PROBE = resolve(WORKSPACE, "packages/ledger-mcp/test/fixtures/cohortAdvanceProbe.ts");

for (const adapter of ["memory", "sqlite"] as const) {
  test(`canonical cohort flow preserves one candidate and whole-member completion ${adapter} [Behavioral-Active Effectual-GoodCommunication]`, async () => {
    const child = Bun.spawn([process.execPath, PROBE, adapter], {
      cwd: WORKSPACE, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({
      state: "complete", identicalReplay: true, members: ["tasks:T1", "tasks:T2"],
      commands: ["bun test T1.test.ts", "bun test T2.test.ts", "bun test shared.test.ts", "bun run check"],
      counters: { observations: 1, admissions: 1, definitions: 1, candidateSeals: 1,
        focusedReceipts: 2, sharedRegressionReceipts: 1, fullGateReceipts: 1, acceptedCandidates: 1 },
      handoff: { phase: "released", archivedRefs: expect.arrayContaining(["tasks:T1", "tasks:T2"]) },
      goalStatus: "building", unrelatedTaskStatus: "wip",
    });
  }, 30_000);
}
