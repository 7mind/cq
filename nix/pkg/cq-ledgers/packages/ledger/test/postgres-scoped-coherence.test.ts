import { describe, expect, test } from "bun:test";
import { createTrustedWorksetManagementAuthority, materializeOperatorAction, supersedeOperatorAction } from "../src/index.js";
import { buildBackupDump } from "../src/store/backupExporter.js";
import { restoreDumpToPostgres } from "../src/store/postgres/restoreImporter.js";
import { claimScopeKey, operationScopeKey } from "../src/store/planLifecycleDump.js";
import { postgresCoherenceFixture } from "./postgresCoherenceFixture.js";
import { guardedPlanPostgresSurface } from "./guardedPlanPostgresFixture.js";
import { genericPostgresSurface } from "./genericPostgresFixture.js";
import { LIFECYCLE_CLAIM_INPUT, LIFECYCLE_PROVENANCE } from "./sqlitePlanLifecycleFixture.js";
import { OPERATOR_ACTION_ROWS, OPERATOR_ACKNOWLEDGE, OPERATOR_EVIDENCE, OPERATOR_REVISE, OPERATOR_COMPLETE, OPERATOR_SUPERSEDE } from "./operatorActionLifecycleContract.js";
import { DIRECT_OPERATOR_INPUT, DIRECT_SUPERSEDE_INPUT, seedDirectOwnedTasks } from "./directOwnedLifecycleContract.js";

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL exact projection and peer coherence [T5924 Behavioral-Active Effectual-GoodCommunication]", () => {
  for (const guarded of [false, true]) for (const terminal of ["release", "finalize"] as const) test(`native and guarded ${terminal} share exact public/private deltas (guarded=${guarded})`, async () => {
    const fixture = await postgresCoherenceFixture();
    const { store, capture } = fixture;
    try {
      const plans = guarded ? guardedPlanPostgresSurface(store) : store;
      if (guarded) await store.replaceWorksetRoots(["goals:G1"]);
      const claim = await capture(() => plans.claimPlan(LIFECYCLE_CLAIM_INPUT), ["goals:G1"], [`plan_claims:${claimScopeKey("G1", LIFECYCLE_CLAIM_INPUT.claimRequestId)}`]);
      if (!claim.ok) throw new Error("coherence claim failed");
      await capture(() => plans.claimPlan(LIFECYCLE_CLAIM_INPUT), [], []);
      const publication = { goalId: "G1", claimId: claim.acknowledgement.claimId, generation: 1, ownerFenceToken: LIFECYCLE_CLAIM_INPUT.ownerFenceToken,
        operationId: "publish", ...LIFECYCLE_PROVENANCE, manifest: {
          milestones: [{ key: "m", title: "coherent milestone" }], tasks: [{ key: "t", milestoneKey: "m", headline: "coherenttaskunique" }],
        } };
      const operationKey = (operation: string, id: string) => `plan_operations:${operationScopeKey("G1", claim.acknowledgement.claimId, 1, operation, id)}`;
      const result = await capture(() => plans.publishPlanDraft(publication), ["goals:G1", "milestones:M1", "tasks:T1"], [operationKey("publish-draft", "publish")]);
      expect(result.ok).toBe(true);
      await fixture.peer.invalidate("tasks");
      expect((await fixture.peer.ftsSearch("coherenttaskunique")).map(({ item }) => item.id)).toEqual(["T1"]);
      await capture(() => plans.publishPlanDraft(publication), [], []);
      const identity = { goalId: "G1", claimId: claim.acknowledgement.claimId, generation: 1,
        ownerFenceToken: LIFECYCLE_CLAIM_INPUT.ownerFenceToken, ...LIFECYCLE_PROVENANCE };
      const claimKey = `plan_claims:${claimScopeKey("G1", LIFECYCLE_CLAIM_INPUT.claimRequestId)}`;
      if (terminal === "release") {
        const release = { ...identity, operationId: "release", kind: "pause" as const,
          effect: { kind: "questions" as const, questions: [{ key: "q", question: "coherentquestion" }] } };
        expect((await capture(() => plans.releasePlanClaim(release), ["goals:G1", "questions:Q1"], [claimKey, operationKey("release", "release")])).ok).toBe(true);
        await capture(() => plans.releasePlanClaim(release), [], []);
      } else {
        await guardedPlanPostgresSurface(store).owned.createOwned({ owner: { ledgerId: "goals", itemId: "G1" }, creationKind: "review", child: {
          ledgerId: "reviews", id: "R1", status: "go-ahead", fields: { planDraft: JSON.stringify({ goalId: identity.goalId, claimId: identity.claimId, generation: 1, revision: 1 }) },
        } });
        const finalize = { ...identity, operationId: "finalize", reviewId: "R1", draftRevision: 1, decision: { headline: "coherentdecision" } };
        expect((await capture(() => plans.finalizePlan(finalize), ["goals:G1", "milestones:M1", "tasks:T1", "decisions:K1"], [claimKey, operationKey("finalize", "finalize")])).ok).toBe(true);
        await capture(() => plans.finalizePlan(finalize), [], []);
      }
    } finally { await fixture.dispose(); }
  });

  test("owned intake and generic updates publish only their exact keys", async () => {
    const fixture = await postgresCoherenceFixture();
    try {
      const guarded = guardedPlanPostgresSurface(fixture.store);
      await fixture.capture(() => guarded.owned.createOwnerless({ ledgerId: "ideas", status: "open", fields: { title: "coherentidea" } }), ["ideas:I1"], []);
      await fixture.capture(() => genericPostgresSurface(fixture.store).updateItem("ideas", "I1", { fields: { title: "updatedcoherentidea" } }), ["ideas:I1"], []);
      expect((await fixture.peer.ftsSearch("updatedcoherentidea")).map(({ item }) => item.id)).toEqual(["I1"]);
    } finally { await fixture.dispose(); }
  });

  test("operator-action variants publish their exact documents without ledger rebuilds", async () => {
    const fixture = await postgresCoherenceFixture();
    const { store, capture, pool, projectKey } = fixture;
    try {
      for (const suffix of ["1", "2"]) for (const { ledgerId, item } of OPERATOR_ACTION_ROWS) {
        await pool`INSERT INTO groups (project_key, ledger, id, title, description) VALUES (${projectKey}, ${ledgerId}, ${item.milestoneId}, '', '') ON CONFLICT DO NOTHING`;
        await pool`INSERT INTO items (project_key, ledger, id, milestone_id, status, fields_json, created_at, updated_at)
          VALUES (${projectKey}, ${ledgerId}, ${item.id.replace(/1$/, suffix)}, ${item.milestoneId}, ${item.status},
            ${JSON.stringify({ ...item.fields, ...(ledgerId === "operatorActions" ? { taskRef: `tasks:T${suffix}` } : {}) })}, ${item.createdAt}, ${item.updatedAt})`;
      }
      await store.reloadCommittedState();
      await fixture.peer.reloadCommittedState();
      await capture(() => store.mutateOperatorAction({ ...OPERATOR_ACKNOWLEDGE, outputIdentity: "wrong" }), [], []);
      await capture(() => store.mutateOperatorAction(OPERATOR_ACKNOWLEDGE), ["operatorActions:OA1"], []);
      await capture(() => store.mutateOperatorAction(OPERATOR_ACKNOWLEDGE), [], []);
      await capture(() => store.mutateOperatorAction({ ...OPERATOR_EVIDENCE, evidence: { ...OPERATOR_EVIDENCE.evidence, exitCode: 1 } }), ["operatorActions:OA1"], []);
      await capture(() => store.mutateOperatorAction(OPERATOR_REVISE), ["operatorActions:OA1", "tasks:T1", "handoffs:HO1"], []);
      await capture(() => store.mutateOperatorAction({ ...OPERATOR_ACKNOWLEDGE, expectedRevision: 2, outputIdentity: "identity-2" }), ["operatorActions:OA1"], []);
      await capture(() => store.mutateOperatorAction({ ...OPERATOR_EVIDENCE, expectedRevision: 2, evidence: { ...OPERATOR_EVIDENCE.evidence, command: "probe-2", outputIdentity: "identity-2" } }), ["operatorActions:OA1"], []);
      await capture(() => store.mutateOperatorAction({ ...OPERATOR_COMPLETE, expectedRevision: 2 }), ["operatorActions:OA1", "tasks:T1"], []);
      await capture(() => store.mutateOperatorAction({ ...OPERATOR_SUPERSEDE, actionId: "OA2" }), ["operatorActions:OA2", "tasks:T2"], []);
      await capture(() => store.mutateOperatorAction({ ...OPERATOR_SUPERSEDE, actionId: "OA2" }), [], []);
    } finally { await fixture.dispose(); }
  });

  test("direct consumers publish materialization and supersession as coherent bundles", async () => {
    const fixture = await postgresCoherenceFixture();
    try {
      await seedDirectOwnedTasks(fixture.store);
      await fixture.capture(() => materializeOperatorAction(fixture.store, DIRECT_OPERATOR_INPUT), ["operatorActions:OA1", "handoffs:HO1"], []);
      await fixture.capture(() => materializeOperatorAction(fixture.store, DIRECT_OPERATOR_INPUT), [], []);
      await fixture.capture(() => supersedeOperatorAction(fixture.store, DIRECT_SUPERSEDE_INPUT), ["operatorActions:OA1", "tasks:T1"], []);
    } finally { await fixture.dispose(); }
  });

  test("administrative reset refreshes both local and peer caches through an explicit recovery snapshot", async () => {
    const fixture = await postgresCoherenceFixture();
    try {
      await fixture.store.resetTenant({ authority: createTrustedWorksetManagementAuthority() });
      expect(() => fixture.store.fetchItem("goals", "G1")).toThrow();
      await fixture.peer.invalidate("goals");
      expect(() => fixture.peer.fetchItem("goals", "G1")).toThrow();
      expect(await fixture.peer.ftsSearch("coherent")).toEqual([]);
    } finally { await fixture.dispose(); }
  });

  test("restore into a live tenant invalidates old rows and publishes restored rows together", async () => {
    const fixture = await postgresCoherenceFixture();
    try {
      const dump = await buildBackupDump(fixture.store, null);
      await fixture.store.createItem("ideas", "M-AMBIENT", { id: "I1", status: "open", fields: { title: "discardedafterrestore" } });
      await fixture.peer.invalidate("ideas");
      await restoreDumpToPostgres({ pool: fixture.pool, projectKey: fixture.projectKey, dump,
        authority: createTrustedWorksetManagementAuthority(), overwriteAuthorized: true });
      await fixture.peer.invalidate("ideas");
      expect(() => fixture.peer.fetchItem("ideas", "I1")).toThrow();
      expect(fixture.peer.fetchItem("goals", "G1").status).toBe("clarifying");
      expect(await fixture.peer.ftsSearch("discardedafterrestore")).toEqual([]);
    } finally { await fixture.dispose(); }
  });
});
