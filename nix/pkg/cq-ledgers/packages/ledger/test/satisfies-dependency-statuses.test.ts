/**
 * G80/T550 — declarative per-schema `satisfiesDependencyStatuses` (types.ts +
 * constants.ts). This task is declarative-only: no predicate/resolver
 * behavior is added or exercised here. Covers:
 *
 *  1. each canonical schema's declared list matches the locked table;
 *  2. abandoned/wontfix/withdrawn never appear in any declared list (design
 *     lock — an abandoned dependency never silently satisfies);
 *  3. reviews/handoffs/milestones declare NO satisfiesDependencyStatuses (the
 *     fallback / computed-rule cases);
 *  4. a REGRESSION guard: an existing SQLite store whose persisted
 *     `schema_json` PREDATES this field still opens cleanly via
 *     SqliteLedgerStore.init() — no divergence backup — and the canonical
 *     constant (the authoritative source for canonical ledger names) still
 *     yields the correct declaration regardless of what is persisted;
 *  5. the field round-trips through `createLedger` for a custom (non-
 *     canonical) ledger that declares it.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  CANONICAL_LEDGERS,
  DECISIONS_SCHEMA,
  DEFECTS_SCHEMA,
  GOALS_SCHEMA,
  HANDOFFS_SCHEMA,
  HYPOTHESIS_SCHEMA,
  IDEAS_SCHEMA,
  MILESTONES_SCHEMA,
  QUESTIONS_SCHEMA,
  RESEARCHES_SCHEMA,
  REVIEWS_SCHEMA,
  TASKS_SCHEMA,
  TASKS_LEDGER,
  type LedgerSchema,
} from "../src/index.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { ensureSchema } from "../src/store/sqlite/schema.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function freshDbDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ledger-satisfies-dep-"));
  dirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 1 + 2 — locked table + the abandoned/wontfix/withdrawn exclusion
// ---------------------------------------------------------------------------

describe("satisfiesDependencyStatuses — canonical declarations (G80 locked table)", () => {
  it("tasks: [\"done\"]", () => {
    expect(TASKS_SCHEMA.satisfiesDependencyStatuses).toEqual(["done"]);
  });

  it("defects: [\"resolved\"]", () => {
    expect(DEFECTS_SCHEMA.satisfiesDependencyStatuses).toEqual(["resolved"]);
  });

  it("questions: [\"answered\"]", () => {
    expect(QUESTIONS_SCHEMA.satisfiesDependencyStatuses).toEqual(["answered"]);
  });

  it("goals: [\"done\"]", () => {
    expect(GOALS_SCHEMA.satisfiesDependencyStatuses).toEqual(["done"]);
  });

  it("decisions: [\"locked\"]", () => {
    expect(DECISIONS_SCHEMA.satisfiesDependencyStatuses).toEqual(["locked"]);
  });

  it("hypothesis: [\"confirmed\"]", () => {
    expect(HYPOTHESIS_SCHEMA.satisfiesDependencyStatuses).toEqual(["confirmed"]);
  });

  it("ideas: [\"planned\"]", () => {
    expect(IDEAS_SCHEMA.satisfiesDependencyStatuses).toEqual(["planned"]);
  });

  it("researches: [\"concluded\"] (G80/M246, Q266 lock)", () => {
    expect(RESEARCHES_SCHEMA.satisfiesDependencyStatuses).toEqual(["concluded"]);
  });

  it("no schema's list contains an abandoned/wontfix/withdrawn-shaped status (design lock)", () => {
    const neverSatisfying = new Set(["abandoned", "wontfix", "withdrawn"]);
    for (const { schema } of CANONICAL_LEDGERS) {
      const declared = schema.satisfiesDependencyStatuses ?? [];
      for (const s of declared) {
        expect(neverSatisfying.has(s)).toBe(false);
      }
    }
  });

  it("every declared status is itself a valid statusValue AND terminal (satisfying implies terminal)", () => {
    for (const { schema } of CANONICAL_LEDGERS) {
      const declared = schema.satisfiesDependencyStatuses;
      if (declared === undefined) continue;
      for (const s of declared) {
        expect(schema.statusValues).toContain(s);
        expect(schema.terminalStatuses).toContain(s);
      }
    }
  });
});

describe("satisfiesDependencyStatuses — no declaration (fallback / computed-rule cases)", () => {
  it("milestones has NO declaration (computed all-tasks-terminal rule, special-cased in the predicate layer)", () => {
    expect(MILESTONES_SCHEMA.satisfiesDependencyStatuses).toBeUndefined();
  });

  it("reviews has NO declaration (falls under the fallback rule)", () => {
    expect(REVIEWS_SCHEMA.satisfiesDependencyStatuses).toBeUndefined();
  });

  it("handoffs has NO declaration (falls under the fallback rule)", () => {
    expect(HANDOFFS_SCHEMA.satisfiesDependencyStatuses).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4 — REGRESSION: a persisted schema_json predating the field still opens
// cleanly (no divergence backup), and the canonical constant is authoritative
// regardless of what is persisted.
// ---------------------------------------------------------------------------

/** Strip satisfiesDependencyStatuses to simulate a pre-G80 persisted schema. */
function stripSatisfiesDependencyStatuses(schema: LedgerSchema): LedgerSchema {
  if (schema.satisfiesDependencyStatuses === undefined) return schema;
  const { satisfiesDependencyStatuses: _drop, ...rest } = schema;
  void _drop;
  return rest;
}

async function seedPreG80SqliteStore(): Promise<{ dbPath: string }> {
  const dbPath = path.join(await freshDbDir(), "ledger.db");
  const db = openLedgerDb(dbPath);
  ensureSchema(db);
  const insert = db.query(
    "INSERT INTO ledgers (name, schema_json, milestone_counter, item_counter) VALUES (?, ?, 0, 0)",
  );
  for (const { name, schema } of CANONICAL_LEDGERS) {
    insert.run(name, JSON.stringify(stripSatisfiesDependencyStatuses(schema)));
  }
  db.close();
  return { dbPath };
}

describe("satisfiesDependencyStatuses — regression: pre-G80 persisted schema_json", () => {
  it("fixture precondition: the seeded tasks schema_json genuinely lacks the field", async () => {
    const { dbPath } = await seedPreG80SqliteStore();
    const db = openLedgerDb(dbPath);
    const row = db
      .query("SELECT schema_json FROM ledgers WHERE name = ?")
      .get(TASKS_LEDGER) as { schema_json: string };
    db.close();
    const persisted = JSON.parse(row.schema_json) as LedgerSchema;
    expect(persisted.satisfiesDependencyStatuses).toBeUndefined();
    expect(persisted.terminalStatuses).toEqual(TASKS_SCHEMA.terminalStatuses);
  });

  it("init() opens cleanly with NO divergence-backup sibling db file", async () => {
    const { dbPath } = await seedPreG80SqliteStore();
    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    await store.dispose();

    const dir = path.dirname(dbPath);
    const entries = await readdir(dir);
    // Divergence-backup naming (backupDivergentState): "<base>.backup-<ts>.db".
    const backups = entries.filter((f) => f.includes(".backup-"));
    expect(backups).toEqual([]);
  });

  it("init() preserves the pre-existing tasks row (no reinit wipe)", async () => {
    const { dbPath } = await seedPreG80SqliteStore();
    const seedStore = new SqliteLedgerStore({ dbPath });
    await seedStore.init();
    const milestone = await seedStore.createMilestone({ title: "pre-G80 seed milestone" });
    const task = await seedStore.createItem(TASKS_LEDGER, milestone.id, {
      status: "planned",
      fields: { headline: "pre-G80 task", description: "must survive schema widening" },
    });
    await seedStore.dispose();

    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    try {
      const fetched = store.fetchItem(TASKS_LEDGER, task.id);
      expect(fetched.id).toBe(task.id);
      expect(fetched.fields["headline"]).toBe("pre-G80 task");
    } finally {
      await store.dispose();
    }
  });

  it("the canonical TASKS_SCHEMA constant yields [\"done\"] regardless of the persisted (pre-G80) schema", async () => {
    await seedPreG80SqliteStore();
    // Authoritative-source rule (a): a resolver for a CANONICAL ledger name
    // reads the canonical constant, not the persisted/live schema — so the
    // answer is correct even though the persisted copy predates the field.
    expect(TASKS_SCHEMA.satisfiesDependencyStatuses).toEqual(["done"]);
  });
});

// ---------------------------------------------------------------------------
// 5 — round-trips through createLedger for a custom ledger that declares it.
// ---------------------------------------------------------------------------

describe("satisfiesDependencyStatuses — round-trips through createLedger for a custom ledger", () => {
  it("createLedger persists it and fetch() returns it unchanged", async () => {
    const dbPath = path.join(await freshDbDir(), "ledger.db");
    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    try {
      const customSchema: LedgerSchema = {
        statusValues: ["open", "closed"],
        terminalStatuses: ["closed"],
        satisfiesDependencyStatuses: ["closed"],
        idPrefix: "XD",
        fields: {
          title: { type: "string", required: true },
        },
      };
      await store.createLedger("xdeps", customSchema);
      const fetched = store.fetch("xdeps");
      expect(fetched.schema.satisfiesDependencyStatuses).toEqual(["closed"]);
    } finally {
      await store.dispose();
    }
  });

  it("survives a fresh store re-open against the same db file (persisted, not just in-memory)", async () => {
    const dbPath = path.join(await freshDbDir(), "ledger.db");
    const seedStore = new SqliteLedgerStore({ dbPath });
    await seedStore.init();
    const customSchema: LedgerSchema = {
      statusValues: ["proposed", "accepted", "rejected"],
      terminalStatuses: ["accepted", "rejected"],
      satisfiesDependencyStatuses: ["accepted"],
      idPrefix: "XA",
      fields: {
        title: { type: "string", required: true },
      },
    };
    await seedStore.createLedger("xaccepts", customSchema);
    await seedStore.dispose();

    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    try {
      const fetched = store.fetch("xaccepts");
      expect(fetched.schema.satisfiesDependencyStatuses).toEqual(["accepted"]);
      // "rejected" — the other terminal status — must NOT be in the list.
      expect(fetched.schema.satisfiesDependencyStatuses).not.toContain("rejected");
    } finally {
      await store.dispose();
    }
  });
});
