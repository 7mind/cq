import { expect } from "bun:test";
import { LifecycleBoundsMeasurement, measureRejectedLifecycle } from "./lifecycleBoundsMeasurement.js";
import { assertSqliteAccessContract, createTrustedWorksetManagementAuthority, createWorksetGuardedPlanLifecycleStore, materializeOperatorAction, recordProtectedImplementationCompletion, supersedeOperatorAction, type PlanFinalizeInput, type PlanPublishDraftInput, type PlanReleaseInput, type SqliteLedgerStore } from "../src/index.js";
import type { OperatorActionLifecycleMutation } from "../src/store/operatorActionLifecycle.js";
import { claimScopeKey, operationScopeKey } from "../src/store/planLifecycleDump.js";
import { lifecycleClaim, lifecycleOperation } from "./lifecycleRowRepositoryContract.js";
import { DIRECT_OPERATOR_INPUT, DIRECT_SUPERSEDE_INPUT, DIRECT_TASK_AUTHORITY, directCompletionRecord, seedDirectOwnedTasks } from "./directOwnedLifecycleContract.js";
import { OPERATOR_ACKNOWLEDGE, OPERATOR_ACTION_ROWS, OPERATOR_COMPLETE, OPERATOR_EVIDENCE, OPERATOR_REVISE, OPERATOR_SUPERSEDE } from "./operatorActionLifecycleContract.js";
import { operatorActionSqliteFixture } from "./operatorActionSqliteFixture.js";
import { ownedLifecycleSqliteFixture, seedUnrelatedOwnedRows } from "./ownedLifecycleSqliteFixtures.js";
import { LIFECYCLE_CLAIM_INPUT, LIFECYCLE_NOW, LIFECYCLE_PROVENANCE, sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";

export async function lifecycleScalingFixture(unrelatedItems: number, unrelatedPrivateRecords: number) {
  const fixture = await sqlitePlanLifecycleFixture();
  const { store, db, accesses } = fixture;
  const measurement = new LifecycleBoundsMeasurement(fixture);
  const capture = async <T>(operation: () => Promise<T>, privateWrites: readonly string[]): Promise<T> => {
    measurement.start();
    const result = await operation();
    for (const access of accesses) assertSqliteAccessContract(access);
    expect(accesses.filter(({ mode, table }) => mode === "write" && table.startsWith("plan_"))
      .flatMap(({ table, rowKeys }) => rowKeys.map(() => table)).sort()).toEqual([...privateWrites].sort());
    measurement.finish(result);
    return result;
  };
  const insertItem = (ledgerId: string, id: string, milestoneId: string, status: string, fields: object): void => {
    db.query("INSERT OR IGNORE INTO groups (ledger, id, title, description) VALUES (?, ?, '', '')").run(ledgerId, milestoneId);
    db.query(`INSERT INTO items (ledger, id, milestone_id, status, fields_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(ledgerId, id, milestoneId, status, JSON.stringify(fields), LIFECYCLE_NOW, LIFECYCLE_NOW);
  };
  try {
    db.transaction(() => {
      db.query(`INSERT INTO archive_pointers (ledger, id, summary, title, status, archived_at)
        VALUES ('tasks', 'M-archive', '', '', 'done', ?)`).run(LIFECYCLE_NOW);
      const archived = db.query(`INSERT INTO archived_items
        (ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at)
        VALUES ('tasks', 'M-archive', ?, 'M-archive', 'done', '{"headline":"archived"}', ?, ?)`);
      archived.run("T90000", LIFECYCLE_NOW, LIFECYCLE_NOW);
      insertItem("tasks", "T90001", "M-incident", "planned", { headline: "incident", dependsOn: ["tasks:T1"] });
      insertItem("milestones", "M90001", "M-ACTIVE", "open", { title: "incident", blockedBy: ["milestones:M1"] });
      for (let index = 0; index < unrelatedItems; index += 1) {
        insertItem("tasks", `T${100000 + index}`, "M-unrelated", "planned", { headline: "unrelated" });
        archived.run(`T${200000 + index}`, LIFECYCLE_NOW, LIFECYCLE_NOW);
      }
      const insertClaim = db.query("INSERT INTO plan_claims (scope, record_json) VALUES (?, ?)");
      const insertOperation = db.query("INSERT INTO plan_operations (scope, record_json) VALUES (?, ?)");
      for (let index = 0; index < unrelatedPrivateRecords; index += 1) {
        const claim = lifecycleClaim(`G${10000 + index}`);
        insertClaim.run(claimScopeKey(claim.goalId, claim.claimRequestId), JSON.stringify(claim));
        const operation = lifecycleOperation(`unrelated-${index}`);
        operation.replay.goalId = claim.goalId;
        operation.replay.claimId = claim.claimId;
        const key = operation.replay;
        insertOperation.run(operationScopeKey(key.goalId, key.claimId, key.generation, key.operation, key.operationId), JSON.stringify(operation));
      }
    })();
    const claimed = await capture(() => store.claimPlan(LIFECYCLE_CLAIM_INPUT), ["plan_claims"]);
    if (!claimed.ok) throw new Error("claim failed");
    const identity = { goalId: "G1", claimId: claimed.acknowledgement.claimId, generation: 1, ownerFenceToken: LIFECYCLE_CLAIM_INPUT.ownerFenceToken, ...LIFECYCLE_PROVENANCE };
    const publish: PlanPublishDraftInput = {
      ...identity, operationId: "publish",
      manifest: {
        milestones: [{ key: "delivery", title: "delivery" }],
        tasks: [{ key: "implementation", milestoneKey: "delivery", headline: "implementation", dependsOn: [{ kind: "ledger", ref: "tasks:T90000" }] }],
      },
    };
    const published = await capture(() => store.publishPlanDraft(publish), ["plan_operations"]);
    if (!published.ok) throw new Error("publish failed");
    const replaced = await capture(() => store.publishPlanDraft({ ...publish, operationId: "replace" }), ["plan_operations"]);
    if (!replaced.ok) throw new Error("replacement failed");
    expect(store.fetchItem("tasks", "T1").status).toBe("abandoned");
    expect(store.fetchItem("tasks", "T90001").fields.dependsOn).toEqual([]);
    expect(store.fetchItem("milestones", "M90001").fields.blockedBy).toEqual([]);
    insertItem("reviews", "R1", "M-AMBIENT", "go-ahead", {
      headline: "approve", planDraft: JSON.stringify({ goalId: "G1", claimId: identity.claimId, generation: 1, revision: 2 }),
    });
    const finalize: PlanFinalizeInput = {
      ...identity, operationId: "finalize", reviewId: "R1", draftRevision: 2,
      decision: { headline: "accepted" },
      reviewDefects: { reviewId: "R1", defects: [{ key: "follow-up", headline: "retained observation", severity: "low" }] },
    };
    db.query(`CREATE TRIGGER fail_bounds_finalize BEFORE INSERT ON plan_operations WHEN NEW.operation_kind = 'finalize'
      BEGIN SELECT RAISE(ABORT, 'injected bounds finalize failure'); END`).run();
    await measureRejectedLifecycle(fixture, measurement, () => store.finalizePlan(finalize), /injected bounds finalize failure/);
    db.query("DROP TRIGGER fail_bounds_finalize").run();
    const finalized = await capture(() => store.finalizePlan(finalize), ["plan_claims", "plan_operations"]);
    if (!finalized.ok) throw new Error(`finalize failed: ${JSON.stringify(finalized)}`);
    insertItem("questions", "Q90000", "M-AMBIENT", "open", { question: "owned", ledgerRefs: ["goals:G1", "tasks:T2"] });
    insertItem("questions", "Q90001", "M-AMBIENT", "open", { question: "shared", ledgerRefs: ["tasks:T2", "goals:G2"] });
    insertItem("questions", "Q90002", "M-AMBIENT", "open", { question: "unrelated", ledgerRefs: ["goals:G2"] });
    const followUp = await capture(() => store.claimPlan({
      ...LIFECYCLE_CLAIM_INPUT, purpose: "follow-up", claimRequestId: "follow-up", expectedGeneration: 1,
    }), ["plan_claims"]);
    if (!followUp.ok) throw new Error("follow-up claim failed");
    expect(store.fetchItem("questions", "Q90000").status).toBe("withdrawn");
    expect(store.fetchItem("questions", "Q90001").fields.ledgerRefs).toEqual(["goals:G2"]);
    expect(store.fetchItem("questions", "Q90002").status).toBe("open");
    const release: PlanReleaseInput = {
      ...identity, claimId: followUp.acknowledgement.claimId, generation: 2, operationId: "release",
      kind: "pause", effect: { kind: "researches", researches: [{ key: "investigate", question: "Answer before planning" }] },
    };
    const released = await capture(() => store.releasePlanClaim(release), ["plan_claims", "plan_operations"]);
    if (!released.ok) throw new Error("release failed");
    const waiting = await capture(() => store.claimPlan({ ...LIFECYCLE_CLAIM_INPUT, claimRequestId: "waiting", expectedGeneration: 2 }), []);
    expect(waiting).toMatchObject({ ok: false, conflict: { code: "research-wait-active" } });

    await store.dispose();
    await store.init();
    for (const [operation, expected] of [
      [() => store.claimPlan(LIFECYCLE_CLAIM_INPUT), claimed],
      [() => store.publishPlanDraft(publish), published],
      [() => store.finalizePlan(finalize), finalized],
      [() => store.releasePlanClaim(release), released],
    ] as const) {
      const replay = await capture<unknown>(operation, []);
      expect(replay).toEqual({ ...expected, replayed: true });
      expect(accesses.filter(({ mode }) => mode === "write")).toEqual([]);
      expect(accesses.every(({ table }) => table === "plan_claims" || table === "plan_operations")).toBe(true);
    }
    return measurement.report();
  } finally { await fixture.dispose(); }
}

export async function operatorScalingFixture(unrelatedRows: number) {
  const secondAction = OPERATOR_ACTION_ROWS.map(({ ledgerId, item }) => ({ ledgerId, item: {
    ...item, id: item.id.replace(/1$/, "2"),
    fields: { ...item.fields, ...(ledgerId === "operatorActions" ? { taskRef: "tasks:T2" } : {}) },
  } }));
  const fixture = await operatorActionSqliteFixture([...OPERATOR_ACTION_ROWS, ...secondAction]);
  const { db, accesses } = fixture;
  const measurement = new LifecycleBoundsMeasurement(fixture);
  const capture = async (mutation: OperatorActionLifecycleMutation, itemKeys: readonly string[], writes: readonly string[]) => {
    measurement.start();
    const result = await fixture.mutate(mutation);
    for (const access of accesses) assertSqliteAccessContract(access);
    expect(accesses.filter(({ table }) => table.startsWith("plan_") || table === "archived_items")).toEqual([]);
    expect(accesses.filter(({ table, mode }) => table === "items" && mode === "read").flatMap(({ rowKeys }) => rowKeys).sort()).toEqual([...itemKeys].sort());
    expect(accesses.filter(({ table, mode }) => table === "items" && mode === "write").flatMap(({ rowKeys }) => rowKeys).sort()).toEqual([...writes].sort());
    measurement.finish(result);
  };
  try {
    db.transaction(() => {
      db.query("INSERT INTO groups (ledger, id, title, description) VALUES ('tasks', 'M-unrelated', '', '')").run();
      db.query(`INSERT INTO archive_pointers (ledger, id, summary, title, status, archived_at)
        VALUES ('tasks', 'M-archive', '', '', 'done', ?)`).run(LIFECYCLE_NOW);
      const active = db.query(`INSERT INTO items (ledger, id, milestone_id, status, fields_json, created_at, updated_at)
        VALUES ('tasks', ?, 'M-unrelated', 'planned', '{"headline":"unrelated"}', ?, ?)`);
      const archived = db.query(`INSERT INTO archived_items (ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at)
        VALUES ('tasks', 'M-archive', ?, 'M-archive', 'done', '{"headline":"unrelated"}', ?, ?)`);
      const privateClaim = db.query("INSERT INTO plan_claims (scope, record_json) VALUES (?, ?)");
      const privateOperation = db.query("INSERT INTO plan_operations (scope, record_json) VALUES (?, ?)");
      for (let index = 0; index < unrelatedRows; index += 1) {
        active.run(`T${100000 + index}`, LIFECYCLE_NOW, LIFECYCLE_NOW);
        archived.run(`T${200000 + index}`, LIFECYCLE_NOW, LIFECYCLE_NOW);
        if (index < 2_000) {
          const claim = lifecycleClaim(`G${10000 + index}`);
          privateClaim.run(claimScopeKey(claim.goalId, claim.claimRequestId), JSON.stringify(claim));
          const operation = lifecycleOperation(`unrelated-${index}`);
          operation.replay.goalId = claim.goalId;
          operation.replay.claimId = claim.claimId;
          const key = operation.replay;
          privateOperation.run(operationScopeKey(key.goalId, key.claimId, key.generation, key.operation, key.operationId), JSON.stringify(operation));
        }
      }
    })();
    const actionOnly = ["operatorActions:OA1"];
    const revised = [...actionOnly, "tasks:T1", "handoffs:HO1"];
    await capture({ ...OPERATOR_ACKNOWLEDGE, outputIdentity: "wrong" }, actionOnly, []);
    await capture(OPERATOR_ACKNOWLEDGE, actionOnly, actionOnly);
    await capture({ ...OPERATOR_EVIDENCE, evidence: { ...OPERATOR_EVIDENCE.evidence, exitCode: 1 } }, actionOnly, actionOnly);
    await capture(OPERATOR_REVISE, revised, revised);
    await capture({ ...OPERATOR_ACKNOWLEDGE, expectedRevision: 2, outputIdentity: "identity-2" }, actionOnly, actionOnly);
    await capture({ ...OPERATOR_EVIDENCE, expectedRevision: 2, evidence: { ...OPERATOR_EVIDENCE.evidence, command: "probe-2", outputIdentity: "identity-2" } }, actionOnly, actionOnly);
    await capture({ ...OPERATOR_COMPLETE, expectedRevision: 2 }, [...actionOnly, "tasks:T1"], [...actionOnly, "tasks:T1"]);
    await capture({ ...OPERATOR_SUPERSEDE, actionId: "OA2" }, ["operatorActions:OA2", "tasks:T2"], ["operatorActions:OA2", "tasks:T2"]);
    await capture({ ...OPERATOR_SUPERSEDE, actionId: "OA2" }, ["operatorActions:OA2", "tasks:T2"], []);
    return measurement.report();
  } finally { await fixture.dispose(); }
}

export async function admittedOwnedScalingFixture(unrelatedRows: number) {
  const fixture = await ownedLifecycleSqliteFixture();
  const { store, db, accesses, guarded } = fixture;
  const measurement = new LifecycleBoundsMeasurement(fixture);
  const capture = async <T>(operation: () => Promise<T>): Promise<T> => {
    measurement.start();
    const result = await operation();
    for (const access of accesses) assertSqliteAccessContract(access);
    expect(accesses.filter(({ table }) => table.startsWith("plan_") || table === "archived_items")).toEqual([]);
    const admissionReads = accesses.filter(({ table }) => table === "workset_admissions");
    expect(admissionReads).toHaveLength(1);
    expect(admissionReads[0]!.rowKeys).toEqual(admissionReads[0]!.keyedPredicate.keys);
    measurement.finish(result);
    return result;
  };
  try {
    seedUnrelatedOwnedRows(db, unrelatedRows);
    const idea = await capture(() => guarded.owned.createOwnerless({ ledgerId: "ideas", status: "open", fields: { title: "selected idea" } }));
    const defect = await capture(() => guarded.owned.createOwnerless({ ledgerId: "defects", status: "open", fields: { headline: "selected defect", severity: "high" } }));
    await store.replaceWorksetRoots([`ideas:${idea.id}`, `defects:${defect.id}`, "goals:G1"]);
    const fix = { defectId: defect.id, goal: { title: "fix", description: "owned fix" } };
    await capture(() => guarded.bundles.bootstrapDefectToFixGoal(fix));
    await capture(() => guarded.bundles.bootstrapDefectToFixGoal(fix));
    expect(accesses.filter(({ mode }) => mode === "write")).toEqual([]);
    await capture(() => guarded.bundles.bootstrapIdeaToGoal({ ideaId: idea.id, goal: { title: "idea goal", description: "owned idea" }, consumeIdea: true }));
    await capture(() => guarded.owned.createOwned({
      owner: { ledgerId: "goals", itemId: "G1" }, creationKind: "exact-gate-question",
      child: { ledgerId: "questions", status: "open", fields: { question: "selected owner" } },
    }));
    return measurement.report();
  } finally { await fixture.dispose(); }
}

export async function directOwnedScalingFixture(unrelatedRows: number, completion: Awaited<ReturnType<typeof directCompletionRecord>>) {
  const fixture = await sqlitePlanLifecycleFixture();
  const { store, db, accesses } = fixture;
  const measurement = new LifecycleBoundsMeasurement(fixture);
  const capture = async (operation: () => Promise<unknown>): Promise<void> => {
    measurement.start();
    const result = await operation();
    for (const access of accesses) assertSqliteAccessContract(access);
    expect(accesses.filter(({ table }) => table.startsWith("plan_") || table === "archived_items")).toEqual([]);
    measurement.finish(result);
  };
  try {
    await seedDirectOwnedTasks(store);
    seedUnrelatedOwnedRows(db, unrelatedRows);
    await capture(() => materializeOperatorAction(store, DIRECT_OPERATOR_INPUT));
    await capture(() => materializeOperatorAction(store, DIRECT_OPERATOR_INPUT));
    expect(accesses.filter(({ mode }) => mode === "write")).toEqual([]);
    await capture(() => supersedeOperatorAction(store, DIRECT_SUPERSEDE_INPUT));
    await capture(() => supersedeOperatorAction(store, DIRECT_SUPERSEDE_INPUT));
    expect(accesses.filter(({ mode }) => mode === "write")).toEqual([]);
    await capture(() => recordProtectedImplementationCompletion(store, DIRECT_TASK_AUTHORITY, completion, LIFECYCLE_PROVENANCE));
    const changedItems = accesses.filter(({ table, mode }) => table === "items" && mode === "write").flatMap(({ rowKeys }) => rowKeys).sort();
    expect(changedItems).toEqual(["defects:D1", "defects:D4", "reviews:R2345", "tasks:T2345"]);
    await store.dispose();
    await store.init();
    await capture(() => recordProtectedImplementationCompletion(store, DIRECT_TASK_AUTHORITY, completion, LIFECYCLE_PROVENANCE));
    expect(accesses.filter(({ mode }) => mode === "write")).toEqual([]);
    return measurement.report();
  } finally { await fixture.dispose(); }
}

export function guardedPlanSurface(store: SqliteLedgerStore) {
  return createWorksetGuardedPlanLifecycleStore({
    rawStore: store, worksetStore: store.worksetStore(), invocationAuthority: createTrustedWorksetManagementAuthority(),
    runOwnedTransaction: (mutate, context) => store.runAtomicOwnedMutation(mutate, context),
    runPlanLifecycleTransaction: (context, mutate) => store.runAtomicWorksetPlanLifecycleMutation(context, mutate),
  });
}

export async function guardedPlanSqliteFixture() {
  const fixture = await sqlitePlanLifecycleFixture();
  return { ...fixture, guarded: guardedPlanSurface(fixture.store) };
}

export async function guardedScalingFixture(unrelatedRows: number) {
  const fixture = await guardedPlanSqliteFixture();
  const { store, db, accesses } = fixture;
  let guarded = fixture.guarded;
  const measurement = new LifecycleBoundsMeasurement(fixture);
  const capture = async <T>(operation: () => Promise<T>, privateWrites: readonly string[]): Promise<T> => {
    measurement.start();
    const result = await operation();
    for (const access of accesses) assertSqliteAccessContract(access);
    expect(accesses.filter(({ mode, table }) => mode === "write" && table.startsWith("plan_"))
      .flatMap(({ table, rowKeys }) => rowKeys.map(() => table)).sort()).toEqual([...privateWrites].sort());
    const grantReads = accesses.filter(({ table }) => table === "workset_admissions");
    expect(grantReads).toHaveLength(1);
    expect(grantReads[0]!.rowKeys).toEqual(grantReads[0]!.keyedPredicate.keys);
    measurement.finish(result);
    return result;
  };
  try {
    seedUnrelatedOwnedRows(db, unrelatedRows);
    await store.replaceWorksetRoots(["goals:G1"]);
    const claimed = await capture(() => guarded.claimPlan(LIFECYCLE_CLAIM_INPUT), ["plan_claims"]);
    if (!claimed.ok) throw new Error("guarded claim failed");
    const identity = { goalId: "G1", claimId: claimed.acknowledgement.claimId, generation: 1,
      ownerFenceToken: LIFECYCLE_CLAIM_INPUT.ownerFenceToken, ...LIFECYCLE_PROVENANCE };
    const publish: PlanPublishDraftInput = { ...identity, operationId: "guarded-publish", manifest: {
      milestones: [{ key: "delivery", title: "delivery" }], tasks: [{ key: "task", milestoneKey: "delivery", headline: "task" }],
    } };
    const published = await capture(() => guarded.publishPlanDraft(publish), ["plan_operations"]);
    expect(published.ok).toBe(true);
    const replaced = await capture(() => guarded.publishPlanDraft({ ...publish, operationId: "guarded-replace" }), ["plan_operations"]);
    expect(replaced.ok).toBe(true);
    await guarded.owned.createOwned({ owner: { ledgerId: "goals", itemId: "G1" }, creationKind: "review", child: {
      ledgerId: "reviews", id: "R1", status: "go-ahead", fields: {
        planDraft: JSON.stringify({ goalId: "G1", claimId: identity.claimId, generation: 1, revision: 2 }),
      },
    } });
    const finalize: PlanFinalizeInput = { ...identity, operationId: "guarded-finalize", reviewId: "R1", draftRevision: 2,
      decision: { headline: "approved" }, reviewDefects: { reviewId: "R1", defects: [{ key: "follow-up", headline: "retained", severity: "low" }] },
    };
    const finalized = await capture(() => guarded.finalizePlan(finalize), ["plan_claims", "plan_operations"]);
    expect(finalized.ok).toBe(true);
    const followUp = await capture(() => guarded.claimPlan({ ...LIFECYCLE_CLAIM_INPUT, purpose: "follow-up", expectedGeneration: 1, claimRequestId: "guarded-follow-up" }), ["plan_claims"]);
    if (!followUp.ok) throw new Error(`guarded follow-up failed: ${JSON.stringify(followUp)}`);
    const release: PlanReleaseInput = { ...identity, generation: 2, claimId: followUp.acknowledgement.claimId, operationId: "guarded-release",
      kind: "pause", effect: { kind: "questions", questions: [{ key: "decision", question: "Choose scope" }] },
    };
    const released = await capture(() => guarded.releasePlanClaim(release), ["plan_claims", "plan_operations"]);
    expect(released.ok).toBe(true);
    await store.dispose();
    await store.init();
    guarded = guardedPlanSurface(store);
    for (const [operation, expected] of [
      [() => guarded.claimPlan(LIFECYCLE_CLAIM_INPUT), claimed], [() => guarded.publishPlanDraft(publish), published],
      [() => guarded.finalizePlan(finalize), finalized], [() => guarded.releasePlanClaim(release), released],
    ] as const) {
      expect(await capture<unknown>(operation, [])).toEqual({ ...expected, replayed: true });
      expect(accesses.filter(({ mode }) => mode === "write")).toEqual([]);
    }
    return measurement.report();
  } finally { await fixture.dispose(); }
}
