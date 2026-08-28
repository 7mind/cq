import { describe, expect, test } from "bun:test";
import {
  D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE,
  HISTORICAL_IMPLEMENTATION_FIXTURES,
  deriveHistoricalImplementationAuditTaskRefs,
  readPackagedImplementationAuditManifest,
  type HistoricalImplementationSourceObservation,
} from "../src/index.js";

function observationsFor(key: keyof typeof HISTORICAL_IMPLEMENTATION_FIXTURES) {
  const fixture = HISTORICAL_IMPLEMENTATION_FIXTURES[key];
  const reviewedAuthority: Readonly<
    Record<keyof typeof HISTORICAL_IMPLEMENTATION_FIXTURES, readonly [string, string][]>
  > = {
    D303: [
      ["tasks:T2096", "a828a90fd0813d28f5f142a2ed80d2709533d0da"],
      ["tasks:T2109", "09731511f5388b9aa0f3a69105bec07da490c3d1"],
      ["tasks:T2110", "b53097724281441c55524c9a54a21a750124ebde"],
    ],
    D340: [
      ["tasks:T2144", "1".repeat(40)],
      ["tasks:T2145", "2".repeat(40)],
      ["tasks:T2146", "3".repeat(40)],
      ["tasks:T2147", "4".repeat(40)],
      ["tasks:T2151", "5dee782ebd6a0b2c743286c0f19752801944bac5"],
    ],
    D343: [["tasks:T2228", "271d9e6e6230012784e7667b6b02ee76b33cc94e"]],
  };
  return [
    ...reviewedAuthority[key].map(([taskRef, resultCommit]) => ({
      taskRef,
      status: "done",
      resultCommit,
      ownLedgerRef: taskRef,
      ownerRefs: [fixture.rule.defectRef],
      ownerEdgeRef: fixture.rule.defectRef,
      finalizedManifestDigest: fixture.rule.finalizedManifestDigest,
    })),
    {
      taskRef: "tasks:T9990",
      status: "done",
      resultCommit: "9".repeat(40),
      ownLedgerRef: "tasks:T9990",
      ownerRefs: [fixture.rule.defectRef, "defects:D999"],
      ownerEdgeRef: fixture.rule.defectRef,
      finalizedManifestDigest: fixture.rule.finalizedManifestDigest,
    },
    {
      taskRef: "tasks:T9991",
      status: "done",
      resultCommit: null,
      ownLedgerRef: "tasks:T9991",
      ownerRefs: [fixture.rule.defectRef],
      ownerEdgeRef: fixture.rule.defectRef,
      finalizedManifestDigest: fixture.rule.finalizedManifestDigest,
    },
  ] satisfies HistoricalImplementationSourceObservation[];
}

function authorityItem(
  id: string,
  status: string,
  fields: Record<string, string | string[]>,
  milestoneId = "M340",
) {
  return {
    id,
    milestoneId,
    status,
    fields,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

describe("trusted historical implementation fixture rules [BA]", () => {
  test("derives the complete D303, D340, and D343 Git cohorts from source observations", () => {
    for (const key of ["D303", "D340", "D343"] as const) {
      const fixture = HISTORICAL_IMPLEMENTATION_FIXTURES[key];
      expect(deriveHistoricalImplementationAuditTaskRefs(observationsFor(key), fixture.rule)).toEqual(
        fixture.expectedTaskRefs,
      );
    }
  });

  test("discovers the D340 guarded-rebase contribution and its exact result commit", () => {
    const fixture = HISTORICAL_IMPLEMENTATION_FIXTURES.D340;
    expect(deriveHistoricalImplementationAuditTaskRefs(observationsFor("D340"), fixture.rule)).toContain(
      "tasks:T2151",
    );
    expect(fixture.requiredResultCommits["tasks:T2151"]).toBe(
      "5dee782ebd6a0b2c743286c0f19752801944bac5",
    );
  });

  test("retains R1419 abstention provenance and leaves T2229 exclusively external", () => {
    expect(HISTORICAL_IMPLEMENTATION_FIXTURES.D303.reviewRefs["tasks:T2109"]).toBe(
      "reviews:R1419",
    );
    expect(HISTORICAL_IMPLEMENTATION_FIXTURES.D303.abstentionReviewRefs).toEqual([
      "reviews:R1419",
    ]);
    expect(HISTORICAL_IMPLEMENTATION_FIXTURES.D343.excludedExternalEffects).toEqual({
      "tasks:T2229": "operatorActions:OA2229",
    });
  });

  test("builds D340 from active plus advertised archive authority and discovers T2151", async () => {
    const taskIds = ["T2144", "T2145", "T2146", "T2147", "T2151"] as const;
    const results: Record<string, string> = {
      T2144: "1".repeat(40),
      T2145: "2".repeat(40),
      T2146: "3".repeat(40),
      T2147: "4".repeat(40),
      T2151: "5dee782ebd6a0b2c743286c0f19752801944bac5",
    };
    const baseValues = ["6", "7", "8", "9", "a"] as const;
    const bases = Object.fromEntries(taskIds.map((id, index) => [id, baseValues[index]!.repeat(40)]));
    const finalized = JSON.stringify({
      revision: 1,
      milestones: [{ key: "m-fix", id: "M340" }],
      tasks: taskIds.map((id) => ({ key: `t-${id.toLowerCase()}`, id })),
    });
    const tasks = taskIds.map((id) =>
      authorityItem(id, "done", {
        headline: id,
        acceptance: `accept ${id}`,
        resultCommit: results[id]!,
        worksetOwnerRef: "goals:G340",
        worksetOwnerEdgeKind: "finalized-manifest",
      }),
    );
    const ledgers: Record<string, readonly ReturnType<typeof authorityItem>[]> = {
      tasks: tasks.slice(0, 4),
      goals: [
        authorityItem("G340", "building", {
          title: "D340 fix",
          planFinalizedManifest: finalized,
          worksetOwnerRef: "defects:D340",
          worksetOwnerEdgeKind: "fix-goal",
        }),
      ],
      defects: [authorityItem("D340", "resolved", { headline: "D340", severity: "high" })],
      reviews: [],
      operatorActions: [],
    };
    const reader = {
      fetch: (ledgerId: string) => ({
        id: ledgerId,
        schema: {},
        counters: { milestone: 1, item: 1 },
        milestones: [{ id: "active", milestone: {}, items: ledgers[ledgerId] ?? [] }],
        archivePointers: ledgerId === "tasks"
          ? [{ id: "M340", path: "./archive/tasks/M340.md", summary: "", title: "", status: "done" }]
          : [],
      }),
      fetchArchive: async (ledgerId: string) => {
        if (ledgerId !== "tasks") throw new Error("unexpected archive read");
        return { kind: "group" as const, milestone: { id: "M340", title: "", description: "", items: [tasks[4]!] } };
      },
    };
    const manifest = await readPackagedImplementationAuditManifest({
      store: reader as never,
      manifestId: "d340-historical-implementation-evidence-v1",
      repository: {
        repositoryHead: async () => "f".repeat(40),
        readCommitFile: async (_commit, path) => {
          const taskId = /^WIP-(T[0-9]+)\.md$/u.exec(path)?.[1];
          if (taskId === undefined) throw new Error("unexpected WIP path");
          return `\`\`\`json\n${JSON.stringify({ taskId, role: "implement-worker", baseCommit: bases[taskId] })}\n\`\`\`\n`;
        },
        diff: async (baseCommit, resultCommit) => `diff ${baseCommit} ${resultCommit}`,
        isAncestor: async () => true,
      },
    });

    expect(manifest.records.map(({ taskRef }) => taskRef)).toEqual(
      [...HISTORICAL_IMPLEMENTATION_FIXTURES.D340.expectedTaskRefs],
    );
    expect(manifest.records.find(({ taskRef }) => taskRef === "tasks:T2151")?.resultCommit).toBe(
      "5dee782ebd6a0b2c743286c0f19752801944bac5",
    );
    expect(manifest.sourceDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("binds activation to finalized draft keys rather than predecessor task literals", () => {
    expect(D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE).toEqual({
      manifestId: "d347-implementation-evidence-activation-v1",
      goalRef: "goals:G176",
      evidenceTaskKey: "t-evidence",
      auditTaskKey: "t-historical-evidence",
      activationTaskKey: "t-activate-evidence",
    });
    expect(JSON.stringify(D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE)).not.toMatch(/T[0-9]+/u);
  });
});
