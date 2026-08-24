import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  GOALS_LEDGER,
  REVIEWS_LEDGER,
  SqliteLedgerStore,
  TASKS_LEDGER,
  recordProtectedImplementationCompletion,
} from "../src/index.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import {
  IMPLEMENTATION_BASE,
  IMPLEMENTATION_RESULT,
  createImplementationEvidenceFixture,
  prepareImplementationCompletion,
} from "./implementationEvidenceTestSupport.js";

const roots: string[] = [];
const stores: SqliteLedgerStore[] = [];

afterAll(async () => {
  for (const store of stores) await store.dispose().catch(() => undefined);
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("protected implementation completion SQLite transaction [Behavioral-Active Sociable-Atomic]", () => {
  test("a task-write failpoint rolls back its paired terminal review and permits an exact retry", async () => {
    const fixture = await createImplementationEvidenceFixture();
    const prepared = await prepareImplementationCompletion(fixture, "sqlite-completion");
    await fixture.service.markMergeStarted(prepared.completionRef, IMPLEMENTATION_BASE);
    fixture.setHead(IMPLEMENTATION_RESULT);
    await fixture.service.markMerged(prepared.completionRef, IMPLEMENTATION_RESULT);
    const completion = (await fixture.store.snapshot()).completions[prepared.completionRef]!;

    const root = await mkdtemp(path.join(tmpdir(), "implementation-completion-sqlite-"));
    roots.push(root);
    const dbPath = path.join(root, "ledger.db");
    const ledger = new SqliteLedgerStore({ dbPath });
    stores.push(ledger);
    await ledger.init();
    const milestone = await ledger.createMilestone({ title: "protected completion" });
    await ledger.createItem(GOALS_LEDGER, milestone.id, {
      id: "G1",
      status: "building",
      fields: { title: "goal", description: "goal" },
    });
    await ledger.createItem(TASKS_LEDGER, milestone.id, {
      id: "T2345",
      status: "wip",
      fields: { headline: "transactional completion" },
    });

    const injector = openLedgerDb(dbPath);
    injector.exec(`
      CREATE TRIGGER fail_protected_task_completion
      BEFORE INSERT ON items
      WHEN NEW.ledger = 'tasks' AND NEW.id = 'T2345' AND NEW.status = 'done'
      BEGIN
        SELECT RAISE(ABORT, 'injected protected task completion failure');
      END
    `);
    injector.close();

    const task = {
      taskRef: "tasks:T2345",
      ownerGoalRef: "goals:G1",
      status: "wip",
      finalizedManifest: "manifest-v1\n",
    } as const;
    await expect(
      recordProtectedImplementationCompletion(ledger, task, completion, { author: "parent" }),
    ).rejects.toThrow("injected protected task completion failure");
    expect(ledger.fetchItem(TASKS_LEDGER, "T2345").status).toBe("wip");
    expect(() => ledger.fetchItem(REVIEWS_LEDGER, "R2345")).toThrow();

    const cleanup = openLedgerDb(dbPath);
    cleanup.exec("DROP TRIGGER fail_protected_task_completion");
    cleanup.close();
    expect(
      await recordProtectedImplementationCompletion(ledger, task, completion, {
        author: "parent",
      }),
    ).toEqual({ reviewRef: "reviews:R2345" });
    expect(ledger.fetchItem(TASKS_LEDGER, "T2345")).toMatchObject({
      status: "done",
      fields: { resultCommit: IMPLEMENTATION_RESULT },
    });
    expect(ledger.fetchItem(REVIEWS_LEDGER, "R2345").status).toBe("go-ahead");
  });
});
