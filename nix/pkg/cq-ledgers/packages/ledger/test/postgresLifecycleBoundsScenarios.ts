import { strict as assert } from "node:assert";
import { materializeOperatorAction, recordProtectedImplementationCompletion, supersedeOperatorAction, type PlanFinalizeInput, type PlanPublishDraftInput } from "../src/index.js";
import { postgresLifecycleBoundsFixture } from "./postgresLifecycleBoundsMeasurement.js";
import { guardedPlanPostgresSurface } from "./guardedPlanPostgresFixture.js";
import { genericPostgresSurface } from "./genericPostgresFixture.js";
import { LIFECYCLE_CLAIM_INPUT, LIFECYCLE_PROVENANCE } from "./sqlitePlanLifecycleFixture.js";
import { OPERATOR_ACTION_ROWS, OPERATOR_ACKNOWLEDGE, OPERATOR_EVIDENCE, OPERATOR_REVISE, OPERATOR_COMPLETE, OPERATOR_SUPERSEDE } from "./operatorActionLifecycleContract.js";
import { DIRECT_OPERATOR_INPUT, DIRECT_SUPERSEDE_INPUT, DIRECT_TASK_AUTHORITY, directCompletionRecord, seedDirectOwnedTasks } from "./directOwnedLifecycleContract.js";

export async function postgresPlanBounds(size: number, guarded: boolean) {
  const fixture = await postgresLifecycleBoundsFixture(size);
  const plans = () => guarded ? guardedPlanPostgresSurface(fixture.store) : fixture.store;
  const capture = <Result>(name: string, invoke: () => Promise<Result>) => fixture.capture(name, invoke, null);
  try {
    if (guarded) await fixture.store.replaceWorksetRoots(["goals:G1"]);
    await fixture.warm();
    const claimed = await capture("claim", () => plans().claimPlan(LIFECYCLE_CLAIM_INPUT));
    assert(claimed.ok);
    const identity = { goalId: "G1", claimId: claimed.acknowledgement.claimId, generation: 1,
      ownerFenceToken: LIFECYCLE_CLAIM_INPUT.ownerFenceToken, ...LIFECYCLE_PROVENANCE };
    const publish: PlanPublishDraftInput = { ...identity, operationId: "publish", manifest: {
      milestones: [{ key: "delivery", title: "selected delivery" }], tasks: [{ key: "task", milestoneKey: "delivery", headline: "boundsuniquetask" }],
    } };
    const published = await capture("publish", () => plans().publishPlanDraft(publish));
    assert(published.ok);
    assert.equal((await fixture.peer.ftsSearch("boundsuniquetask"))[0]!.item.id, "T1");
    assert((await capture("replace", () => plans().publishPlanDraft({ ...publish, operationId: "replace" }))).ok);
    await guardedPlanPostgresSurface(fixture.store).owned.createOwned({ owner: { ledgerId: "goals", itemId: "G1" }, creationKind: "review", child: {
      ledgerId: "reviews", id: "R1", status: "go-ahead", fields: { planDraft: JSON.stringify({ goalId: "G1", claimId: identity.claimId, generation: 1, revision: 2 }) },
    } });
    const finalize: PlanFinalizeInput = { ...identity, operationId: "finalize", reviewId: "R1", draftRevision: 2,
      decision: { headline: "accepted" }, reviewDefects: { reviewId: "R1", defects: [{ key: "retained", headline: "retained observation", severity: "low" }] } };
    const finalized = await capture("finalize-with-defects", () => plans().finalizePlan(finalize));
    assert(finalized.ok);
    const followup = await capture("follow-up", () => plans().claimPlan({ ...LIFECYCLE_CLAIM_INPUT, purpose: "follow-up", claimRequestId: "follow-up", expectedGeneration: 1 }));
    assert(followup.ok);
    const release = { ...identity, generation: 2, claimId: followup.acknowledgement.claimId, operationId: "release", kind: "pause" as const,
      effect: { kind: "researches" as const, researches: [{ key: "probe", question: "measure before planning" }] } };
    const released = await capture("release-researches", () => plans().releasePlanClaim(release));
    assert(released.ok);
    await fixture.restart();
    for (const [name, invoke, expected] of [
      ["restart-claim-replay", () => plans().claimPlan(LIFECYCLE_CLAIM_INPUT), claimed],
      ["restart-publish-replay", () => plans().publishPlanDraft(publish), published],
      ["restart-finalize-replay", () => plans().finalizePlan(finalize), finalized],
      ["restart-release-replay", () => plans().releasePlanClaim(release), released],
    ] as const) assert.deepEqual(await capture<unknown>(name, invoke), { ...expected, replayed: true });
    return { observations: fixture.observations, diagnostics: fixture.diagnostics };
  } finally { await fixture.dispose(); }
}

export async function postgresOperatorBounds(size: number) {
  const fixture = await postgresLifecycleBoundsFixture(size);
  const { pool, projectKey, store } = fixture;
  const capture = (name: string, mutation: Parameters<typeof store.mutateOperatorAction>[0]) => fixture.capture(name, () => store.mutateOperatorAction(mutation), null);
  try {
    for (const suffix of ["1", "2"]) for (const { ledgerId, item } of OPERATOR_ACTION_ROWS) {
      await pool`INSERT INTO groups (project_key, ledger, id, title, description) VALUES (${projectKey}, ${ledgerId}, ${item.milestoneId}, '', '') ON CONFLICT DO NOTHING`;
      await pool`INSERT INTO items (project_key, ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
        VALUES (${projectKey}, ${ledgerId}, ${item.id.replace(/1$/, suffix)}, ${item.milestoneId}, ${item.status},
          ${JSON.stringify({ ...item.fields, ...(ledgerId === "operatorActions" ? { taskRef: `tasks:T${suffix}` } : {}) })},
          ${item.createdAt}, ${item.updatedAt}, ${item.author ?? null}, ${item.session ?? null})`;
    }
    await fixture.warm();
    await capture("refused-acknowledgement", { ...OPERATOR_ACKNOWLEDGE, outputIdentity: "wrong" });
    await capture("acknowledge", OPERATOR_ACKNOWLEDGE);
    await capture("acknowledge-replay", OPERATOR_ACKNOWLEDGE);
    await capture("failed-evidence", { ...OPERATOR_EVIDENCE, evidence: { ...OPERATOR_EVIDENCE.evidence, exitCode: 1 } });
    await capture("revise", OPERATOR_REVISE);
    await capture("acknowledge-revision", { ...OPERATOR_ACKNOWLEDGE, expectedRevision: 2, outputIdentity: "identity-2" });
    await capture("successful-evidence", { ...OPERATOR_EVIDENCE, expectedRevision: 2, evidence: { ...OPERATOR_EVIDENCE.evidence, command: "probe-2", outputIdentity: "identity-2" } });
    await capture("complete", { ...OPERATOR_COMPLETE, expectedRevision: 2 });
    await capture("supersede", { ...OPERATOR_SUPERSEDE, actionId: "OA2" });
    await capture("supersede-replay", { ...OPERATOR_SUPERSEDE, actionId: "OA2" });
    return { observations: fixture.observations, diagnostics: fixture.diagnostics };
  } finally { await fixture.dispose(); }
}

export async function postgresOwnedBounds(size: number) {
  const fixture = await postgresLifecycleBoundsFixture(size);
  const { store } = fixture;
  const guarded = guardedPlanPostgresSurface(store);
  const capture = <Result>(name: string, invoke: () => Promise<Result>) => fixture.capture(name, invoke, null);
  try {
    await fixture.warm();
    const idea = await capture("ownerless-idea", () => guarded.owned.createOwnerless({ ledgerId: "ideas", status: "open", fields: { title: "selected idea" } }));
    const defect = await capture("ownerless-defect", () => guarded.owned.createOwnerless({ ledgerId: "defects", status: "open", fields: { headline: "selected defect", severity: "high" } }));
    await store.replaceWorksetRoots([`ideas:${idea.id}`, `defects:${defect.id}`, "goals:G1"]);
    const fix = { defectId: defect.id, goal: { title: "selected fix", description: "selected fix" } };
    await capture("defect-fix-bundle", () => guarded.bundles.bootstrapDefectToFixGoal(fix));
    await capture("defect-fix-replay", () => guarded.bundles.bootstrapDefectToFixGoal(fix));
    await capture("idea-goal-bundle", () => guarded.bundles.bootstrapIdeaToGoal({ ideaId: idea.id, goal: { title: "selected goal", description: "selected goal" }, consumeIdea: true }));
    await capture("owned-question", () => guarded.owned.createOwned({ owner: { ledgerId: "goals", itemId: "G1" }, creationKind: "exact-gate-question",
      child: { ledgerId: "questions", status: "open", fields: { question: "select scope" } } }));
    return { observations: fixture.observations, diagnostics: fixture.diagnostics };
  } finally { await fixture.dispose(); }
}

export async function postgresDirectBounds(size: number, completion: Awaited<ReturnType<typeof directCompletionRecord>>) {
  const fixture = await postgresLifecycleBoundsFixture(size);
  const capture = <Result>(name: string, invoke: () => Promise<Result>) => fixture.capture(name, invoke, null);
  try {
    await seedDirectOwnedTasks(fixture.store);
    const task = fixture.store.fetchItem("tasks", "T1");
    await fixture.store.createItem("tasks", task.milestoneId, { id: "T2", status: "planned", fields: task.fields });
    await fixture.warm();
    await capture("materialize", () => materializeOperatorAction(fixture.store, DIRECT_OPERATOR_INPUT));
    await capture("materialize-replay", () => materializeOperatorAction(fixture.store, DIRECT_OPERATOR_INPUT));
    await fixture.capture("materialize-conflict", () => materializeOperatorAction(fixture.store, { ...DIRECT_OPERATOR_INPUT, expectedOutputIdentity: "different" }), /expectedOutputIdentity differs/);
    await capture("supersede-materialized", () => supersedeOperatorAction(fixture.store, DIRECT_SUPERSEDE_INPUT));
    await capture("supersede-materialized-replay", () => supersedeOperatorAction(fixture.store, DIRECT_SUPERSEDE_INPUT));
    const absent = { ...DIRECT_SUPERSEDE_INPUT, actionId: "OA2" };
    await capture("supersede-unmaterialized", () => supersedeOperatorAction(fixture.store, absent));
    await capture("supersede-unmaterialized-replay", () => supersedeOperatorAction(fixture.store, absent));
    const complete = () => recordProtectedImplementationCompletion(fixture.store, DIRECT_TASK_AUTHORITY, completion, LIFECYCLE_PROVENANCE);
    await capture("protected-completion", complete);
    await fixture.restart();
    await capture("restart-completion-replay", complete);
    await capture("restart-supersession-replay", () => supersedeOperatorAction(fixture.store, absent));
    await fixture.capture("completion-conflict", () => recordProtectedImplementationCompletion(fixture.store, DIRECT_TASK_AUTHORITY,
      { ...completion, resultCommit: "f".repeat(40) }, LIFECYCLE_PROVENANCE), /different evidence/);
    return { observations: fixture.observations, diagnostics: fixture.diagnostics };
  } finally { await fixture.dispose(); }
}

export async function postgresGenericBounds(size: number) {
  const fixture = await postgresLifecycleBoundsFixture(size);
  const { store } = fixture;
  const generic = genericPostgresSurface(store);
  const capture = <Result>(name: string, invoke: () => Promise<Result>) => fixture.capture(name, invoke, null);
  try {
    await fixture.warm();
    const milestone = await capture("create-milestone", () => generic.createMilestone({ title: "selected milestone" }));
    const task = await capture("create-task", () => generic.createItem("tasks", milestone.id, { status: "planned", fields: { headline: "selected task" } }));
    await store.replaceWorksetRoots([`tasks:${task.id}`]);
    await capture("update-task", () => generic.updateItem("tasks", task.id, { status: "wip" }));
    await capture("complete-task", () => generic.updateItem("tasks", task.id, { status: "done" }));
    await capture("reopen-task", () => generic.reopenItem("tasks", task.id, "planned"));
    await capture("recomplete-task", () => generic.updateItem("tasks", task.id, { status: "done" }));
    await store.replaceWorksetRoots([]);
    await capture("archive-terminal-items", () => generic.archiveTerminalItems(["tasks"], "selected tasks", "fail-on-active-gate"));
    await store.worksetStore().setRoots([`tasks:${task.id}`]);
    await capture("unarchive-item", () => generic.unarchiveItem("tasks", milestone.id, task.id));
    await store.replaceWorksetRoots([]);
    await capture("update-milestone", () => generic.updateMilestone(milestone.id, { title: "updated milestone" }));
    await capture("archive-milestone-batch", () => generic.executeFinalize([
      { id: "close", action: "close-milestone", targetId: milestone.id, targetStatus: "done" },
      { id: "archive", action: "archive-milestone", targetId: milestone.id, summary: "finished" },
    ]));
    await fixture.restart();
    await capture("restart-unarchive", () => genericPostgresSurface(fixture.store).unarchiveItem("tasks", milestone.id, task.id));
    return { observations: fixture.observations, diagnostics: fixture.diagnostics };
  } finally { await fixture.dispose(); }
}
