import { describe, expect, test } from "bun:test";
import { materializeOperatorAction, recordProtectedImplementationCompletion, supersedeOperatorAction, type LedgerStore } from "../src/index.js";
import { LIFECYCLE_NOW, LIFECYCLE_PROVENANCE } from "./sqlitePlanLifecycleFixture.js";
import { IMPLEMENTATION_BASE, IMPLEMENTATION_RESULT, createImplementationEvidenceFixture, prepareImplementationCompletion } from "./implementationEvidenceTestSupport.js";

export const DIRECT_OPERATOR_INPUT = { taskId: "T1", expectedOutputIdentity: "direct-identity", expectedEvidence: ["probe"], ...LIFECYCLE_PROVENANCE };
export const DIRECT_SUPERSEDE_INPUT = { actionId: "OA1", expectedRevision: 1, reason: "superseded", supersededAt: LIFECYCLE_NOW, ...LIFECYCLE_PROVENANCE };
export const DIRECT_TASK_AUTHORITY = { taskRef: "tasks:T2345", ownerGoalRef: "goals:G1", status: "wip", finalizedManifest: "manifest-v1\n" } as const;

export async function directCompletionRecord() {
  const evidence = await createImplementationEvidenceFixture();
  const prepared = await prepareImplementationCompletion(evidence, "direct-keyed-completion");
  await evidence.service.markMergeStarted(prepared.completionRef, IMPLEMENTATION_BASE);
  evidence.setHead(IMPLEMENTATION_RESULT);
  await evidence.service.markMerged(prepared.completionRef, IMPLEMENTATION_RESULT);
  const completion = (await evidence.store.snapshot()).completions[prepared.completionRef];
  if (completion === undefined) throw new Error("prepared completion is absent");
  return completion;
}

export async function seedDirectOwnedTasks(store: LedgerStore): Promise<void> {
  const milestone = await store.createMilestone({ title: "direct owned operations" });
  await store.createItem("tasks", milestone.id, { id: "T1", status: "planned", fields: {
    headline: "operator task", description: "CQ-OPERATOR-ACTION v1 direct-keyed. User acts.", ledgerRefs: ["goals:G1"],
  } });
  await store.createItem("tasks", milestone.id, { id: "T2345", status: "wip", fields: {
    headline: "implementation task", ledgerRefs: ["defects:D1", "defects:D2", "defects:D3", "defects:D4"],
  } });
  for (const [id, status] of [["D1", "root-caused"], ["D2", "open"], ["D4", "root-caused"], ["D90000", "root-caused"]] as const) {
    await store.createItem("defects", "M-AMBIENT", { id, status, fields: { headline: id, severity: "high" } });
  }
}

export interface DirectOwnedContractFixture { readonly store: LedgerStore; dispose(): Promise<void> }

export function runDirectOwnedLifecycleContract(name: string, build: () => Promise<DirectOwnedContractFixture>): void {
  describe(`direct keyed owned lifecycle — ${name} [Behavioral-Active Blackbox]`, () => {
    test("materialization retains exact replay, refuses payload substitution, and supersedes its action/task atomically", async () => {
      const fixture = await build();
      try {
        await seedDirectOwnedTasks(fixture.store);
        const created = await materializeOperatorAction(fixture.store, DIRECT_OPERATOR_INPUT);
        expect(created.state).toBe("created");
        expect(await materializeOperatorAction(fixture.store, DIRECT_OPERATOR_INPUT)).toEqual({ ...created, state: "existing" });
        await expect(materializeOperatorAction(fixture.store, { ...DIRECT_OPERATOR_INPUT, expectedOutputIdentity: "different" })).rejects.toThrow();
        const superseded = await supersedeOperatorAction(fixture.store, DIRECT_SUPERSEDE_INPUT);
        expect(superseded).toMatchObject({ action: { status: "superseded" }, task: { status: "abandoned" } });
        expect(await supersedeOperatorAction(fixture.store, DIRECT_SUPERSEDE_INPUT)).toEqual(superseded);
      } finally { await fixture.dispose(); }
    });
    test("unmaterialized supersession changes only the task and preserves exact retry", async () => {
      const fixture = await build();
      try {
        await seedDirectOwnedTasks(fixture.store);
        const superseded = await supersedeOperatorAction(fixture.store, DIRECT_SUPERSEDE_INPUT);
        expect(superseded).toMatchObject({ task: { status: "abandoned" } });
        expect(superseded.action).toBeUndefined();
        expect(await supersedeOperatorAction(fixture.store, DIRECT_SUPERSEDE_INPUT)).toEqual(superseded);
        expect(() => fixture.store.fetchItem("operatorActions", "OA1")).toThrow();
        await expect(supersedeOperatorAction(fixture.store, { ...DIRECT_SUPERSEDE_INPUT, reason: "different" })).rejects.toThrow("different evidence");
      } finally { await fixture.dispose(); }
    });
    test("D492 collision: unrelated task-number review is preserved while completion allocates and binds another review", async () => {
      const fixture = await build();
      try {
        await seedDirectOwnedTasks(fixture.store);
        const task = fixture.store.fetchItem("tasks", "T2345");
        await fixture.store.createItem("reviews", task.milestoneId, {
          id: "R2345",
          status: "go-ahead",
          fields: { summary: "legitimate G215 plan review", ledgerRefs: ["goals:G1"] },
        });
        const incumbent = JSON.stringify(fixture.store.fetchItem("reviews", "R2345"));
        const completion = await directCompletionRecord();
        const result = await recordProtectedImplementationCompletion(fixture.store, DIRECT_TASK_AUTHORITY, completion, LIFECYCLE_PROVENANCE);
        expect(result).toEqual({ reviewRef: "reviews:R2347" });
        expect(JSON.stringify(fixture.store.fetchItem("reviews", "R2345"))).toBe(incumbent);
        expect(fixture.store.fetchItem("tasks", "T2345").status).toBe("done");
        expect(await recordProtectedImplementationCompletion(fixture.store, DIRECT_TASK_AUTHORITY, completion, LIFECYCLE_PROVENANCE)).toEqual(result);
      } finally { await fixture.dispose(); }
    });
    test("D492 replay: protected completion uses only its persisted binding and refuses changed evidence", async () => {
      const fixture = await build();
      try {
        await seedDirectOwnedTasks(fixture.store);
        const completion = await directCompletionRecord();
        const result = await recordProtectedImplementationCompletion(fixture.store, DIRECT_TASK_AUTHORITY, completion, LIFECYCLE_PROVENANCE);
        expect(result).toEqual({ reviewRef: "reviews:R1" });
        expect(fixture.store.fetchItem("tasks", "T2345")).toMatchObject({ status: "done", fields: {
          resultCommit: IMPLEMENTATION_RESULT,
        } });
        expect(fixture.store.fetchItem("reviews", "R1").status).toBe("go-ahead");
        expect(fixture.store.fetchItem("defects", "D1").status).toBe("resolved");
        expect(fixture.store.fetchItem("defects", "D4").status).toBe("resolved");
        expect(fixture.store.fetchItem("defects", "D2").status).toBe("open");
        expect(fixture.store.fetchItem("defects", "D90000").status).toBe("root-caused");
        expect(await recordProtectedImplementationCompletion(fixture.store, DIRECT_TASK_AUTHORITY, completion, LIFECYCLE_PROVENANCE)).toEqual(result);
        await expect(recordProtectedImplementationCompletion(fixture.store, DIRECT_TASK_AUTHORITY, { ...completion, resultCommit: "f".repeat(40) }, LIFECYCLE_PROVENANCE))
          .rejects.toThrow("terminal implementation review id belongs to different evidence");
      } finally { await fixture.dispose(); }
    });
    test("generic callers cannot create or alter a protected completion review binding through task fields", async () => {
      const fixture = await build();
      try {
        await seedDirectOwnedTasks(fixture.store);
        const task = fixture.store.fetchItem("tasks", "T2345");
        await expect(fixture.store.createItem("tasks", task.milestoneId, {
          id: "T2346",
          status: "wip",
          fields: { headline: "forged", implementationCompletionReview: "reviews:R1" },
        })).rejects.toThrow('unknown field "implementationCompletionReview"');
        await expect(fixture.store.updateItem("tasks", "T2345", {
          fields: { implementationCompletionReview: "reviews:R1" },
        })).rejects.toThrow('unknown field "implementationCompletionReview"');
      } finally { await fixture.dispose(); }
    });
    test("completion allocation preserves archived review identities and the lifetime counter", async () => {
      const fixture = await build();
      try {
        const archivedMilestone = await fixture.store.createMilestone({ title: "archived review" });
        await fixture.store.createItem("reviews", archivedMilestone.id, {
          id: "R2345",
          status: "go-ahead",
          fields: { summary: "historical review", ledgerRefs: ["goals:G1"] },
        });
        await fixture.store.updateMilestone(archivedMilestone.id, { status: "done" });
        await fixture.store.archiveMilestone(archivedMilestone.id, "historical review");
        await seedDirectOwnedTasks(fixture.store);
        const completion = await directCompletionRecord();
        await expect(recordProtectedImplementationCompletion(
          fixture.store,
          DIRECT_TASK_AUTHORITY,
          completion,
          LIFECYCLE_PROVENANCE,
        )).resolves.toEqual({ reviewRef: "reviews:R2347" });
        expect(fixture.store.fetch("reviews").counters.item).toBe(2347);
        const archived = await fixture.store.fetchArchive("reviews", archivedMilestone.id);
        expect(archived).toMatchObject({ kind: "group", milestone: { items: [{ id: "R2345" }] } });
      } finally { await fixture.dispose(); }
    });
  });
}
