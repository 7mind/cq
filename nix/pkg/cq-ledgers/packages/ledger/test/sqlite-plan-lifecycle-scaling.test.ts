import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLedgerStore, assertSqliteAccessContract, type PlanPublishDraftInput, type PlanFinalizeInput, type PlanReleaseInput, type SqliteAccessRecord } from "../src/index.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { claimScopeKey, operationScopeKey } from "../src/store/planLifecycleDump.js";
import { lifecycleClaim, lifecycleOperation } from "./lifecycleRowRepositoryContract.js";
import { LIFECYCLE_CLAIM_INPUT, LIFECYCLE_NOW, LIFECYCLE_PROVENANCE, sqlitePlanLifecycleFixture } from "./sqlitePlanLifecycleFixture.js";

test("sqlite plan lifecycle uses keyed row plans", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqlite-plan-lifecycle-scaling-"));
  const dbPath = join(root, "ledger.db");
  const store = new SqliteLedgerStore({ dbPath });
  await store.init();
  const probe = openLedgerDb(dbPath);
  try {
    for (const id of ["G1", "G2"]) {
      await store.createItem("goals", "M-AMBIENT", {
        id,
        status: "clarifying",
        fields: { title: id, description: "keyed lifecycle regression" },
      });
    }
    const claim = (goalId: string) => store.claimPlan({
      goalId,
      purpose: "initial",
      claimRequestId: `request-${goalId}`,
      ownerFenceToken: "A".repeat(43),
      expectedGeneration: null,
      author: "T5542",
      session: "sqlite-plan-lifecycle-scaling",
    });
    expect((await claim("G2")).ok).toBe(true);
    probe.exec(`
      CREATE TABLE observed_lifecycle_writes (record_kind TEXT NOT NULL, goal_id TEXT NOT NULL);
      CREATE TRIGGER observe_unrelated_claim_update AFTER UPDATE ON plan_claims
      WHEN json_extract(NEW.record_json, '$.goalId') = 'G2'
      BEGIN INSERT INTO observed_lifecycle_writes VALUES ('claim', 'G2'); END;
      CREATE TRIGGER observe_unrelated_goal_insert AFTER INSERT ON items
      WHEN NEW.ledger = 'goals' AND NEW.id = 'G2'
      BEGIN INSERT INTO observed_lifecycle_writes VALUES ('goal', 'G2'); END;
      CREATE TRIGGER observe_unrelated_goal_update AFTER UPDATE ON items
      WHEN NEW.ledger = 'goals' AND NEW.id = 'G2'
      BEGIN INSERT INTO observed_lifecycle_writes VALUES ('goal', 'G2'); END;
    `);
    expect((await claim("G1")).ok).toBe(true);
    expect(probe.query("SELECT record_kind, goal_id FROM observed_lifecycle_writes").all()).toEqual([]);
  } finally {
    probe.close();
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

async function lifecycleScalingFixture(unrelatedItems: number, unrelatedPrivateRecords: number) {
  const fixture = await sqlitePlanLifecycleFixture();
  const { store, db, accesses } = fixture;
  const observed: { result: unknown; accesses: SqliteAccessRecord[] }[] = [];
  const capture = async <T>(operation: () => Promise<T>, privateWrites: readonly string[]): Promise<T> => {
    accesses.length = 0;
    const result = await operation();
    for (const access of accesses) assertSqliteAccessContract(access);
    expect(accesses.filter(({ mode, table }) => mode === "write" && table.startsWith("plan_"))
      .flatMap(({ table, rowKeys }) => rowKeys.map(() => table)).sort()).toEqual([...privateWrites].sort());
    observed.push({ result, accesses: structuredClone(accesses) });
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
    return observed;
  } finally { await fixture.dispose(); }
}

test("all keyed lifecycle operations retain identical access keys and writes with 20k active, 20k archived and 2k private records [Behavioral-Active Blackbox-GoodCommunication]", async () => {
  expect(await lifecycleScalingFixture(20_000, 2_000)).toEqual(await lifecycleScalingFixture(0, 0));
}, 30_000);

test("legacy adoption keeps group insertion and item insertion order, not declared or lexical order [T5542]", async () => {
  const fixture = await sqlitePlanLifecycleFixture();
  const { store, db } = fixture;
  try {
    for (const id of ["M2", "M1"]) {
      db.query("INSERT INTO groups (ledger, id, title, description) VALUES ('tasks', ?, '', '')").run(id);
    }
    for (const [id, group] of [["T10", "M2"], ["T3", "M1"], ["T2", "M2"]]) {
      db.query(`INSERT INTO items (ledger, id, milestone_id, status, fields_json, created_at, updated_at)
        VALUES ('tasks', ?, ?, 'planned', '{"headline":"legacy"}', ?, ?)`).run(id!, group!, LIFECYCLE_NOW, LIFECYCLE_NOW);
    }
    db.query("UPDATE items SET fields_json = json_set(fields_json, '$.milestones', json(?)) WHERE ledger = 'goals' AND id = 'G1'")
      .run(JSON.stringify(["M1", "M2"]));
    const result = await store.claimPlan(LIFECYCLE_CLAIM_INPUT);
    expect(result).toMatchObject({ ok: true, acknowledgement: {
      adoptedManifest: { milestoneIds: ["M1", "M2"], taskIds: ["T10", "T2", "T3"] },
    } });
  } finally { await fixture.dispose(); }
});

test("prospective allocation skips occupied ids and preserves pre-existing empty group metadata [T5542]", async () => {
  const fixture = await sqlitePlanLifecycleFixture();
  const { store, db } = fixture;
  try {
    await store.createItem("tasks", "M-AMBIENT", { id: "T1", status: "planned", fields: { headline: "occupied" } });
    db.query("UPDATE ledgers SET item_counter = 0 WHERE name = 'tasks'").run();
    db.query("INSERT INTO groups (ledger, id, title, description) VALUES ('tasks', 'M1', 'retained', 'retained description')").run();
    expect((await store.claimPlan(LIFECYCLE_CLAIM_INPUT)).ok).toBe(true);
    const result = await store.publishPlanDraft({
      goalId: "G1", claimId: "claim_G1_1", generation: 1,
      ownerFenceToken: LIFECYCLE_CLAIM_INPUT.ownerFenceToken, operationId: "publish", ...LIFECYCLE_PROVENANCE,
      manifest: {
        milestones: [{ key: "delivery", title: "delivery" }],
        tasks: [
          { key: "first", milestoneKey: "delivery", headline: "first" },
          { key: "second", milestoneKey: "delivery", headline: "second", dependsOn: [{ kind: "draft-task", key: "first" }] },
        ],
      },
    });
    expect(result).toMatchObject({ ok: true, acknowledgement: { manifest: {
      tasks: [{ key: "first", id: "T2" }, { key: "second", id: "T3" }],
    } } });
    expect(store.fetchItem("tasks", "T1").fields.headline).toBe("occupied");
    expect(store.fetchItem("tasks", "T3").fields.dependsOn).toEqual(["tasks:T2"]);
    expect(db.query("SELECT title, description FROM groups WHERE ledger = 'tasks' AND id = 'M1'").get())
      .toEqual({ title: "retained", description: "retained description" });
  } finally { await fixture.dispose(); }
});
