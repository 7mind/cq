import { expect, test } from "bun:test";
import { completionRuntimeFixture } from "./workCohortCompletionRuntimeFixture.js";

for (const adapter of ["memory", "sqlite"] as const) {
  test(`${adapter} outer sealed resume retains accepted evidence without running another gate or review [Behavioral-Active Effectual-GoodCommunication]`, async () => {
    const f = await completionRuntimeFixture(adapter, false);
    try {
      const before = await f.cohorts.snapshot();
      const resumed = await f.advance.resume({ plan: f.admissionPlan, definitionDigest: f.envelope.definition.definitionDigest,
        intentDigest: f.envelope.intent.intentDigest, operationId: "sealed-resume" });
      expect(resumed.worktree.status).toBe("prepared");
      expect(resumed.cohort.executionEpoch).not.toBe(f.envelope.executionEpoch);
      expect(resumed.cohort.semanticSubject).toBe(f.envelope.semanticSubject);
      expect((await f.cohorts.snapshot()).portable.commandEvidence).toEqual(before.portable.commandEvidence);
      expect((await f.cohorts.snapshot()).portable.candidateSeals).toEqual(before.portable.candidateSeals);
      expect((await f.cohorts.snapshot()).portable.completionReceipts).toEqual(before.portable.completionReceipts);
      expect(f.commands).toHaveLength(4);
    } finally { await f.close(); }
  }, 30_000);
}
