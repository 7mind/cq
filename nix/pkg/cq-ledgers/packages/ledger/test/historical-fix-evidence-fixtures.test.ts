import { describe, expect, test } from "bun:test";
import {
  D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE,
  HISTORICAL_IMPLEMENTATION_FIXTURES,
  deriveHistoricalImplementationAuditTaskRefs,
  nodeGitRunner,
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

async function productionHistoricalManifest(key: "D303" | "D343") {
  const fixture = HISTORICAL_IMPLEMENTATION_FIXTURES[key];
  const requiredResultCommits: Readonly<Record<string, string>> =
    fixture.requiredResultCommits;
  const abstentionReviewRefs: readonly string[] = fixture.abstentionReviewRefs;
  const taskIds = fixture.expectedTaskRefs.map((taskRef) => taskRef.slice("tasks:".length));
  const bases = Object.fromEntries(
    taskIds.map((taskId, index) => [taskId, String(index + 1).repeat(40)]),
  );
  const finalized = JSON.stringify({
    revision: 1,
    milestones: [{ key: "m-fix", id: `M${key.slice(1)}` }],
    tasks: taskIds.map((id) => ({ key: `t-${id.toLowerCase()}`, id })),
  });
  const tasks = taskIds.map((id) => {
    const taskRef = `tasks:${id}`;
    const resultCommit = requiredResultCommits[taskRef];
    if (resultCommit === undefined) throw new Error(`fixture has no result commit for ${taskRef}`);
    return authorityItem(id, "done", {
      headline: id,
      acceptance: `accept ${id}`,
      resultCommit,
      worksetOwnerRef: `goals:G${key.slice(1)}`,
      worksetOwnerEdgeKind: "finalized-manifest",
    });
  });
  const reviews = Object.values(fixture.reviewRefs).map((reviewRef) => {
    const id = reviewRef.slice("reviews:".length);
    const abstained = abstentionReviewRefs.includes(reviewRef);
    return authorityItem(id, abstained ? "abstained" : "go-ahead", {
      summary: abstained ? "operational-abstention" : "approved historical review",
    });
  });
  const operatorActions = Object.entries(fixture.excludedExternalEffects).map(
    ([taskRef, actionRef]) =>
      authorityItem(actionRef.slice("operatorActions:".length), "completed", { taskRef }),
  );
  const ledgers: Record<string, readonly ReturnType<typeof authorityItem>[]> = {
    tasks,
    goals: [
      authorityItem(`G${key.slice(1)}`, "building", {
        title: `${key} fix`,
        planFinalizedManifest: finalized,
        worksetOwnerRef: `defects:${key}`,
        worksetOwnerEdgeKind: "fix-goal",
      }),
    ],
    defects: [authorityItem(key, "resolved", { headline: key, severity: "high" })],
    reviews,
    operatorActions,
  };
  return await readPackagedImplementationAuditManifest({
    store: {
      fetch: (ledgerId: string) => ({
        id: ledgerId,
        schema: {},
        counters: { milestone: 1, item: 1 },
        milestones: [{ id: "active", milestone: {}, items: ledgers[ledgerId] ?? [] }],
        archivePointers: [],
      }),
      fetchArchive: async () => {
        throw new Error("production fixture has no advertised archive");
      },
    } as never,
    manifestId: fixture.manifestId,
    repository: {
      repositoryHead: async () => "f".repeat(40),
      readCommitFile: async (_commit, path) => {
        const taskId = /^WIP-(T[0-9]+)\.md$/u.exec(path)?.[1];
        if (taskId === undefined || bases[taskId] === undefined)
          throw new Error("unexpected WIP path");
        return `\`\`\`json\n${JSON.stringify({ taskId, role: "implement-worker", baseCommit: bases[taskId] })}\n\`\`\`\n`;
      },
      diff: async (baseCommit, resultCommit) => `diff ${baseCommit} ${resultCommit}`,
      isAncestor: async () => true,
    },
  });
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

  test("assembles D303 through the production registry with observed R1419 abstention", async () => {
    const manifest = await productionHistoricalManifest("D303");
    expect(manifest.records.map(({ taskRef }) => taskRef)).toEqual([
      ...HISTORICAL_IMPLEMENTATION_FIXTURES.D303.expectedTaskRefs,
    ]);
    const review = manifest.records.find(({ taskRef }) => taskRef === "tasks:T2109")
      ?.historicalReview as Record<string, unknown>;
    expect(review).toMatchObject({
      reviewRef: "reviews:R1419",
      item: { status: "abstained", fields: { summary: "operational-abstention" } },
    });
  });

  test("assembles D343 through the production registry while preserving OA2229", async () => {
    const manifest = await productionHistoricalManifest("D343");
    expect(manifest.records.map(({ taskRef }) => taskRef)).toEqual(["tasks:T2228"]);
    expect(manifest.records[0]?.historicalReview).toMatchObject({ reviewRef: "reviews:R1413" });
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

  test("production D347 registry excludes completed tasks not retained at the boundary", async () => {
    const git = nodeGitRunner(process.cwd());
    const postBoundary = (await git(["rev-parse", "HEAD"])).stdout.trim();
    const head = (await git(["rev-parse", "HEAD^"])).stdout.trim();
    expect((await git(["merge-base", "--is-ancestor", postBoundary, head])).code).toBe(1);
    const finalized = JSON.stringify({
      revision: 1,
      milestones: [{ key: "m-evidence", id: "M347" }],
      tasks: [
        { key: "t-evidence", id: "T3000" },
        { key: "t-historical-evidence", id: "T3001" },
        { key: "t-activate-evidence", id: "T3002" },
        { key: "t-successor", id: "T3003" },
        { key: "t-post-boundary", id: "T3004" },
      ],
    });
    const task = (id: string, resultCommit: string) =>
      authorityItem(id, "done", {
        headline: id,
        acceptance: `accept ${id}`,
        resultCommit,
        worksetOwnerRef: "goals:G176",
        worksetOwnerEdgeKind: "finalized-manifest",
      }, "M347");
    const ledgers: Record<string, readonly ReturnType<typeof authorityItem>[]> = {
      tasks: [
        task("T3000", head),
        task("T3001", head),
        authorityItem("T3002", "planned", {
          headline: "T3002",
          worksetOwnerRef: "goals:G176",
          worksetOwnerEdgeKind: "finalized-manifest",
        }, "M347"),
        task("T3003", head),
        task("T3004", postBoundary),
      ],
      goals: [authorityItem("G176", "building", { title: "D347", planFinalizedManifest: finalized })],
      defects: [],
      reviews: [],
      operatorActions: [],
    };

    const manifest = await readPackagedImplementationAuditManifest({
      store: {
        fetch: (ledgerId: string) => ({
          id: ledgerId,
          schema: {},
          counters: { milestone: 1, item: 1 },
          milestones: [{ id: "active", milestone: {}, items: ledgers[ledgerId] ?? [] }],
          archivePointers: [],
        }),
        fetchArchive: async () => {
          throw new Error("unexpected archive read");
        },
      } as never,
      manifestId: D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE.manifestId,
      repository: {
        repositoryHead: async () => head,
        readCommitFile: async (_commit, path) => {
          const taskId = /^WIP-(T[0-9]+)\.md$/u.exec(path)?.[1];
          if (taskId === undefined) throw new Error("unexpected WIP path");
          return `\`\`\`json\n${JSON.stringify({ taskId, role: "implement-worker", baseCommit: head })}\n\`\`\`\n`;
        },
        diff: async (baseCommit, resultCommit) => `diff ${baseCommit} ${resultCommit}`,
        isAncestor: async (ancestor, descendant) =>
          (await git(["merge-base", "--is-ancestor", ancestor, descendant])).code === 0,
      },
    });

    expect(manifest.records.map(({ taskRef }) => taskRef)).toEqual([
      "tasks:T3000",
      "tasks:T3001",
      "tasks:T3003",
    ]);
  });
});
