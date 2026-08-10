import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {

  GOALS_LEDGER,
  GOALS_SCHEMA,
  InMemoryLedgerStore,
  MILESTONES_AMBIENT_ID,
  SqliteLedgerStore,
  buildBackupDump,
  replayPlanClaim,
  restoreDumpToXdg,
  type PlanClaimInput,
  type PlanLifecycleStore,
  type PlanReleaseInput,
  mintWorksetManagementAuthority,
} from "../src/index.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";

const roots: string[] = [];
const OWNER_A = "A".repeat(22);
const OWNER_B = "B".repeat(22);
const PROVENANCE = { author: "sqlite-test", session: "sqlite-session" } as const;
const RESET_NOW = "2026-01-01T00:00:00.000Z";

type SqliteLifecycleStore = SqliteLedgerStore & PlanLifecycleStore;

async function dbPath(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-plan-sqlite-targeted-"));
  roots.push(root);
  return path.join(root, "ledger.db");
}

async function stores(): Promise<{
  dbPath: string;
  first: SqliteLifecycleStore;
  second: SqliteLifecycleStore;
}> {
  const file = await dbPath();
  const first = new SqliteLedgerStore({ dbPath: file });
  const second = new SqliteLedgerStore({ dbPath: file });
  await first.init();
  await second.init();
  await first.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: "G1",
    status: "clarifying",
    fields: { title: "SQLite lifecycle", description: "transaction fixture" },
    ...PROVENANCE,
  });
  return {
    dbPath: file,
    first: first as SqliteLifecycleStore,
    second: second as SqliteLifecycleStore,
  };
}

function claimInput(
  requestId: string,
  ownerFenceToken: string,
): PlanClaimInput {
  return {
    goalId: "G1",
    purpose: "initial",
    claimRequestId: requestId,
    ownerFenceToken,
    expectedGeneration: null,
    ...PROVENANCE,
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("T850 SQLite lifecycle persistence", () => {
  test("adds lifecycle tables to an old database without disturbing ledger rows", async () => {
    const file = await dbPath();
    const seed = new SqliteLedgerStore({ dbPath: file });
    await seed.init();
    await seed.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: "G1",
      status: "clarifying",
      fields: { title: "preserved", description: "old schema row" },
      ...PROVENANCE,
    });
    await seed.dispose();

    const old = openLedgerDb(file);
    old.exec("DROP TABLE plan_operations");
    old.exec("DROP TABLE plan_claims");
    old.close();

    const reopened = new SqliteLedgerStore({ dbPath: file });
    await reopened.init();
    try {
      expect(reopened.fetchItem(GOALS_LEDGER, "G1").fields["title"]).toBe("preserved");
      const inspect = openLedgerDb(file);
      try {
        const tables = inspect
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'plan_%' ORDER BY name",
          )
          .all() as Array<{ name: string }>;
        expect(tables.map(({ name }) => name)).toEqual([
          "plan_claims",
          "plan_operations",
        ]);
      } finally {
        inspect.close();
      }
    } finally {
      await reopened.dispose();
    }
  });

  test("schema-divergence reset removes private replay records after preserving them in the backup", async () => {
    const file = await dbPath();
    const seed = new SqliteLedgerStore({ dbPath: file, now: () => RESET_NOW });
    await seed.init();
    await seed.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: "G1",
      status: "clarifying",
      fields: { title: "reset lifecycle", description: "divergence fixture" },
      ...PROVENANCE,
    });
    const lifecycle = seed as SqliteLifecycleStore;
    const input = claimInput("reset-claim", OWNER_A);
    const claimed = await lifecycle.claimPlan(input);
    if (!claimed.ok) throw new Error("claim failed");
    const releaseInput: PlanReleaseInput = {
      kind: "pause",
      goalId: "G1",
      claimId: claimed.acknowledgement.claimId,
      generation: claimed.acknowledgement.generation,
      operationId: "reset-release",
      ownerFenceToken: OWNER_A,
      ...PROVENANCE,
      effect: {
        kind: "questions",
        questions: [{ key: "reset", question: "Does reset remove private replay?" }],
      },
    };
    const released = await lifecycle.releasePlanClaim(releaseInput);
    if (!released.ok) throw new Error("release failed");
    await seed.dispose();

    const tamper = openLedgerDb(file);
    tamper
      .query("UPDATE ledgers SET schema_json = ? WHERE name = ?")
      .run(JSON.stringify({ ...GOALS_SCHEMA, idPrefix: "ZZ" }), GOALS_LEDGER);
    tamper.close();

    const reset = new SqliteLedgerStore({
      dbPath: file,
      now: () => RESET_NOW,
      onSchemaDivergence: "backup-reinit",
      // D170: this test DELIBERATELY reinitialises a populated store.
      allowDestructiveReinitOfPopulatedStore: true,
    });
    await reset.init();
    try {
      const resetLifecycle = reset as SqliteLifecycleStore;
      expect(await resetLifecycle.claimPlan(input)).toEqual({
        ok: false,
        conflict: { code: "goal-not-found", goalId: "G1" },
      });
      expect(await resetLifecycle.releasePlanClaim(releaseInput)).toEqual({
        ok: false,
        conflict: { code: "goal-not-found", goalId: "G1" },
      });
      const primary = openLedgerDb(file);
      try {
        expect(
          primary
            .query(
              `SELECT
                 (SELECT COUNT(*) FROM plan_claims) AS claims,
                 (SELECT COUNT(*) FROM plan_operations) AS operations`,
            )
            .get(),
        ).toEqual({ claims: 0, operations: 0 });
      } finally {
        primary.close();
      }

      const parsed = path.parse(file);
      const backupPath = path.join(
        parsed.dir,
        `${parsed.name}.backup-${RESET_NOW.replace(/:/g, "-")}${parsed.ext}`,
      );
      const backup = new Database(backupPath, { readonly: true });
      try {
        const claimRow = backup
          .query("SELECT record_json FROM plan_claims")
          .get() as { record_json: string } | null;
        expect(claimRow).not.toBeNull();
        expect(replayPlanClaim(JSON.parse(claimRow!.record_json), input)).toEqual({
          ...claimed,
          replayed: true,
        });

        const operationRow = backup
          .query("SELECT record_json FROM plan_operations")
          .get() as { record_json: string } | null;
        expect(operationRow).not.toBeNull();
        expect(JSON.parse(operationRow!.record_json)).toMatchObject({
          replay: {
            goalId: "G1",
            claimId: claimed.acknowledgement.claimId,
            generation: claimed.acknowledgement.generation,
            operationId: releaseInput.operationId,
            operation: "release",
          },
          acknowledgement: released.acknowledgement,
        });
      } finally {
        backup.close();
      }
    } finally {
      await reset.dispose();
    }
  });

  test("restore replaces stale private replay authority with the dump state", async () => {
    const file = await dbPath();
    const target = new SqliteLedgerStore({ dbPath: file });
    await target.init();
    await target.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: "G1",
      status: "clarifying",
      fields: { title: "stale restore goal", description: "must be replaced" },
      ...PROVENANCE,
    });
    const lifecycle = target as SqliteLifecycleStore;
    const input = claimInput("restore-claim", OWNER_A);
    const claimed = await lifecycle.claimPlan(input);
    if (!claimed.ok) throw new Error("claim failed");
    const releaseInput: PlanReleaseInput = {
      kind: "pause",
      goalId: "G1",
      claimId: claimed.acknowledgement.claimId,
      generation: claimed.acknowledgement.generation,
      operationId: "restore-release",
      ownerFenceToken: OWNER_A,
      ...PROVENANCE,
      effect: {
        kind: "questions",
        questions: [{ key: "restore", question: "Does restore replace stale authority?" }],
      },
    };
    const released = await lifecycle.releasePlanClaim(releaseInput);
    if (!released.ok) throw new Error("release failed");
    await target.dispose();

    const source = new InMemoryLedgerStore();
    await source.init();
    const dump = await buildBackupDump(source, null);
    await source.dispose();
    await restoreDumpToXdg({ dbPath: file, logsDir: null, dump, authority: mintWorksetManagementAuthority() });

    const restored = new SqliteLedgerStore({ dbPath: file });
    await restored.init();
    try {
      const restoredLifecycle = restored as SqliteLifecycleStore;
      expect(await restoredLifecycle.claimPlan(input)).toEqual({
        ok: false,
        conflict: { code: "goal-not-found", goalId: "G1" },
      });
      expect(await restoredLifecycle.releasePlanClaim(releaseInput)).toEqual({
        ok: false,
        conflict: { code: "goal-not-found", goalId: "G1" },
      });

      const inspect = openLedgerDb(file);
      try {
        expect(
          inspect
            .query(
              `SELECT
                 (SELECT COUNT(*) FROM plan_claims) AS claims,
                 (SELECT COUNT(*) FROM plan_operations) AS operations`,
            )
            .get(),
        ).toEqual({ claims: 0, operations: 0 });
      } finally {
        inspect.close();
      }
    } finally {
      await restored.dispose();
    }
  });

  test("fences simultaneous claims across two connections and persists no plaintext token", async () => {
    const fixture = await stores();
    try {
      const inputA = claimInput("claim-a", OWNER_A);
      const inputB = claimInput("claim-b", OWNER_B);
      const results = await Promise.all([
        fixture.first.claimPlan(inputA),
        fixture.second.claimPlan(inputB),
      ]);
      const winner = results.find((result) => result.ok);
      const loser = results.find((result) => !result.ok);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(loser).toMatchObject({ ok: false, conflict: { code: "claim-active" } });
      if (winner === undefined || !winner.ok) throw new Error("claim winner missing");

      const replay = await fixture.second.claimPlan(
        winner.acknowledgement.claimRequestId === inputA.claimRequestId
          ? inputA
          : inputB,
      );
      expect(replay).toEqual({ ...winner, replayed: true });

      const inspect = openLedgerDb(fixture.dbPath);
      try {
        const rows = inspect.query("SELECT record_json FROM plan_claims").all() as Array<{
          record_json: string;
        }>;
        const persisted = JSON.stringify(rows);
        expect(persisted).not.toContain(OWNER_A);
        expect(persisted).not.toContain(OWNER_B);
        expect(persisted).toContain("ownerFenceTokenVerifier");
      } finally {
        inspect.close();
      }
    } finally {
      await fixture.first.dispose();
      await fixture.second.dispose();
    }
  });

  test("commits an exact pause batch once and refreshes the acting store index", async () => {
    const fixture = await stores();
    try {
      const claimed = await fixture.first.claimPlan(claimInput("pause-claim", OWNER_A));
      if (!claimed.ok) throw new Error("claim failed");
      const input = {
        kind: "pause" as const,
        goalId: "G1",
        claimId: claimed.acknowledgement.claimId,
        generation: claimed.acknowledgement.generation,
        operationId: "pause-once",
        ownerFenceToken: OWNER_A,
        ...PROVENANCE,
        effect: {
          kind: "questions" as const,
          questions: [{ key: "choice", question: "Which SQLite choice?" }],
        },
        reviewDefects: {
          reviewId: "R1",
          defects: [{ key: "guard", headline: "Guard SQLite", severity: "high" as const }],
        },
      };
      const results = await Promise.all([
        fixture.second.releasePlanClaim(input),
        fixture.first.releasePlanClaim(input),
      ]);
      expect(results.every((result) => result.ok)).toBe(true);
      expect(results.map((result) => (result.ok ? result.replayed : null)).sort()).toEqual([
        false,
        true,
      ]);
      if (!results[0]?.ok || !results[1]?.ok) throw new Error("pause failed");
      expect(results[0].acknowledgement).toEqual(results[1].acknowledgement);

      const inspect = openLedgerDb(fixture.dbPath);
      try {
        const counts = inspect
          .query(
            "SELECT ledger, COUNT(*) AS count FROM items WHERE ledger IN ('questions', 'defects') GROUP BY ledger ORDER BY ledger",
          )
          .all() as Array<{ ledger: string; count: number }>;
        expect(counts).toEqual([
          { ledger: "defects", count: 1 },
          { ledger: "questions", count: 1 },
        ]);
        expect(
          inspect.query("SELECT COUNT(*) AS count FROM plan_operations").get(),
        ).toEqual({ count: 1 });
      } finally {
        inspect.close();
      }
      expect(
        (await fixture.first.ftsSearch("Which SQLite choice")).map(({ item }) => item.id),
      ).toContain("Q1");
    } finally {
      await fixture.first.dispose();
      await fixture.second.dispose();
    }
  });
});
