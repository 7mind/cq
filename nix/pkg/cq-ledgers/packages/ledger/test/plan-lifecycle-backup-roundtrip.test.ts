/**
 * D139 — plan-lifecycle is a first-class BackupDump artifact across backends.
 *
 * REAL exporter→importer round-trip: claim → buildBackupDump → restore →
 * exact-retry claim → replayed:true with the same claimId through
 * xdg/sqlite (restoreDumpToXdg).
 *
 * D141 — raw managed-task fence is authority-only: updateItem(tasks→wip) does
 * not reject unsatisfied dependencies (readiness is orchestrator-side).
 *
 * D142 — SQLite divergence snapshots preserve committed plan lifecycle records.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  buildBackupDump,
  CANONICAL_LEDGERS,
  GOALS_LEDGER,
  MILESTONES_AMBIENT_ID,
  PLAN_REVIEW_DRAFT_FIELD,
  restoreDumpToXdg,
  REVIEWS_LEDGER,
  SqliteLedgerStore,
  TASKS_LEDGER,
  type LedgerStore,
  type PlanClaimInput,
  type PlanLifecycleStore,
  createTrustedWorksetManagementAuthority,
} from "../src/index.js";
import { injectSqliteSchemaDivergence, sqliteDivergenceBackupPath } from "./sqliteSchemaFixture.js";
import {
  PLAN_LIFECYCLE_DUMP_PATH,
  parsePlanLifecycleDump,
} from "../src/store/planLifecycleDump.js";
import { assertManagedTaskTransitionAllowed } from "../src/store/planLifecycleGuards.js";
import type { Item, Ledger } from "../src/types.js";
import { LedgerError } from "../src/types.js";

const OWNER = "B".repeat(22);
const PROVENANCE = { author: "d139", session: "d139-session" } as const;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function tmpRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function claimInput(requestId: string): PlanClaimInput {
  return {
    goalId: "G1",
    purpose: "initial",
    claimRequestId: requestId,
    ownerFenceToken: OWNER,
    expectedGeneration: null,
    ...PROVENANCE,
  };
}

async function seedGoal(store: Pick<LedgerStore, "createItem">): Promise<void> {
  await store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: "G1",
    status: "clarifying",
    fields: { title: "lifecycle dump", description: "round-trip fixture" },
    ...PROVENANCE,
  });
}

describe("D139 plan-lifecycle BackupDump round-trip", () => {
  test("xdg/sqlite: exporter→restoreDumpToXdg→exact-retry claim replays", async () => {
    const root = await tmpRoot("d139-xdg-");
    const dbPath = path.join(root, "ledger.db");
    const source = new SqliteLedgerStore({ dbPath });
    await source.init();
    await seedGoal(source);
    const input = claimInput("xdg-roundtrip");
    const first = await (source as SqliteLedgerStore & PlanLifecycleStore).claimPlan(input);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("claim failed");

    const dump = await buildBackupDump(source, null);
    await source.dispose();

    const lifecycleEntry = dump.find((file) => file.path === PLAN_LIFECYCLE_DUMP_PATH);
    expect(lifecycleEntry).toBeDefined();
    if (lifecycleEntry === undefined) throw new Error("lifecycle dump missing");
    expect(lifecycleEntry.content).not.toContain(OWNER);
    expect(parsePlanLifecycleDump(lifecycleEntry.content).claims.size).toBe(1);

    const targetDb = path.join(root, "restored.db");
    await restoreDumpToXdg({
      dbPath: targetDb,
      logsDir: null,
      dump,
      authority: createTrustedWorksetManagementAuthority(),
      overwriteAuthorized: false,
    });

    const restored = new SqliteLedgerStore({ dbPath: targetDb });
    await restored.init();
    try {
      const lifecycle = restored as SqliteLedgerStore & PlanLifecycleStore;
      const replay = await lifecycle.claimPlan(input);
      expect(replay).toEqual({ ...first, replayed: true });
      if (!replay.ok) throw new Error("replay failed");
      expect(replay.acknowledgement.claimId).toBe(first.acknowledgement.claimId);
    } finally {
      await restored.dispose();
    }
  });
});

describe("D141 raw managed-task fence is authority-only", () => {
  test("assertManagedTaskTransitionAllowed ignores dependency readiness", () => {
    const goals: Ledger = {
      id: GOALS_LEDGER,
      schema: CANONICAL_LEDGERS.find((c) => c.name === GOALS_LEDGER)!.schema,
      counters: { milestone: 0, item: 1 },
      milestones: [
        {
          id: MILESTONES_AMBIENT_ID,
          title: "",
          description: "",
          items: [
            {
              id: "G1",
              milestoneId: MILESTONES_AMBIENT_ID,
              status: "planned",
              fields: {
                title: "g",
                description: "d",
                planGeneration: "1",
                planFinalizedManifest: JSON.stringify({
                  revision: 1,
                  milestones: [{ id: "M1", key: "m" }],
                  tasks: [
                    { id: "T1", key: "a" },
                    { id: "T2", key: "b" },
                  ],
                }),
              },
              createdAt: "t",
              updatedAt: "t",
            },
          ],
        },
      ],
      archivePointers: [],
    };
    const task: Item = {
      id: "T2",
      milestoneId: "M1",
      status: "planned",
      fields: {
        headline: "B",
        ledgerRefs: ["goals:G1"],
        dependsOn: ["tasks:T1"],
      },
      createdAt: "t",
      updatedAt: "t",
    };
    // Authority-only: belonging to the finalized manifest is enough. No store
    // is consulted for dependency readiness, so unsatisfied deps cannot reject.
    expect(() =>
      assertManagedTaskTransitionAllowed(() => goals, task, "wip"),
    ).not.toThrow();

    // Still rejects when the task is NOT on the finalized manifest.
    const orphan: Item = {
      ...task,
      id: "T999",
    };
    expect(() =>
      assertManagedTaskTransitionAllowed(() => goals, orphan, "wip"),
    ).toThrow(LedgerError);
  });

  test("raw updateItem(tasks→wip) succeeds for a managed dependent task", async () => {
    const store = new SqliteLedgerStore({ dbPath: path.join(await tmpRoot("d141-auth-"), "ledger.db") });
    await store.init();
    try {
      await seedGoal(store);
      const claimed = await store.claimPlan(claimInput("d141-claim"));
      expect(claimed.ok).toBe(true);
      if (!claimed.ok) throw new Error("claim failed");
      const published = await store.publishPlanDraft({
        goalId: "G1",
        claimId: claimed.acknowledgement.claimId,
        generation: claimed.acknowledgement.generation,
        operationId: "pub",
        ownerFenceToken: OWNER,
        ...PROVENANCE,
        manifest: {
          milestones: [{ key: "m", title: "M" }],
          tasks: [
            { key: "a", milestoneKey: "m", headline: "A" },
            {
              key: "b",
              milestoneKey: "m",
              headline: "B",
              dependsOn: [{ kind: "draft-task", key: "a" }],
            },
          ],
        },
      });
      expect(published.ok).toBe(true);
      if (!published.ok) throw new Error("publish failed");
      const draft = {
        goalId: "G1",
        claimId: claimed.acknowledgement.claimId,
        generation: claimed.acknowledgement.generation,
        revision: published.acknowledgement.manifest.revision,
      };
      await store.createItem(REVIEWS_LEDGER, MILESTONES_AMBIENT_ID, {
        id: "R1",
        status: "go-ahead",
        fields: {
          summary: "ok",
          [PLAN_REVIEW_DRAFT_FIELD]: JSON.stringify(draft),
          ledgerRefs: [`${GOALS_LEDGER}:G1`],
        },
        ...PROVENANCE,
      });
      const finalized = await store.finalizePlan({
        goalId: "G1",
        claimId: claimed.acknowledgement.claimId,
        generation: claimed.acknowledgement.generation,
        operationId: "fin",
        ownerFenceToken: OWNER,
        ...PROVENANCE,
        reviewId: "R1",
        draftRevision: draft.revision,
        decision: { headline: "ship" },
      });
      expect(finalized.ok).toBe(true);
      if (!finalized.ok) throw new Error("finalize failed");

      const dependent = finalized.acknowledgement.manifest.tasks.find((t) => t.key === "b");
      expect(dependent).toBeDefined();

      // Fence is authority-only: unsatisfied deps do not block raw wip.
      const started = await store.updateItem(TASKS_LEDGER, dependent!.id, {
        status: "wip",
        ...PROVENANCE,
      });
      expect(started.status).toBe("wip");
    } finally {
      await store.dispose();
    }
  });
});

describe("D142 divergence backup includes plan-lifecycle artifacts", () => {
  test("SQLite snapshot preserves committed claims and operations before reinitialization", async () => {
    const root = await tmpRoot("d142-div-");
    const dbPath = path.join(root, "ledger.db");
    const timestamp = "2026-08-06T12:00:00.000Z";
    const source = new SqliteLedgerStore({ dbPath });
    await source.init();
    await seedGoal(source);
    const claimed = await source.claimPlan(claimInput("snapshot-claim"));
    if (!claimed.ok) throw new Error("snapshot claim failed");
    const published = await source.publishPlanDraft({
      goalId: "G1",
      claimId: claimed.acknowledgement.claimId,
      generation: claimed.acknowledgement.generation,
      operationId: "snapshot-publish",
      ownerFenceToken: OWNER,
      manifest: {
        milestones: [{ key: "m", title: "M" }],
        tasks: [{ key: "task", milestoneKey: "m", headline: "Snapshot task" }],
      },
      ...PROVENANCE,
    });
    expect(published.ok).toBe(true);
    await source.dispose();

    const records = (databasePath: string) => {
      const db = new Database(databasePath, { readonly: true });
      try {
        return {
          claims: db.query("SELECT scope, record_json FROM plan_claims ORDER BY scope").all(),
          operations: db.query("SELECT scope, record_json FROM plan_operations ORDER BY scope").all(),
        };
      } finally {
        db.close();
      }
    };
    const before = records(dbPath);
    expect(before.claims).toHaveLength(1);
    expect(before.operations.length).toBeGreaterThan(0);
    injectSqliteSchemaDivergence(dbPath);
    const reinitialized = new SqliteLedgerStore({
      dbPath,
      now: () => timestamp,
      onSchemaDivergence: "backup-reinit",
      allowDestructiveReinitOfPopulatedStore: true,
      worksetAuthority: createTrustedWorksetManagementAuthority(),
    });
    try {
      await reinitialized.init();
      expect(records(sqliteDivergenceBackupPath(dbPath, timestamp))).toEqual(before);
      expect(reinitialized.exportPlanLifecycleState()).toBeNull();
    } finally {
      await reinitialized.dispose();
    }
  });
});
