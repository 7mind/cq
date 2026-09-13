/**
 * Regression guard (T407) — an ADDED OPTIONAL field in a canonical schema must
 * NOT trigger a destructive backup-reinit when an EXISTING (pre-field) ledger
 * is loaded by a newer build.
 *
 * Background: T405 added the optional `rawLogs: string[]` field to all six
 * sessionLogs-bearing canonical schemas (goals/tasks/reviews/handoffs/defects/
 * hypothesis). A ledger that was written by a PRE-rawLogs build carries an
 * on-disk registry whose schemas are MISSING `rawLogs`. The schema-divergence
 * guard in `SqliteLedgerStore.init()` (`schemaCompatible`, formerly the strict
 * `schemasEqual`) must treat that on-disk schema as COMPATIBLE — the only
 * difference is canon ADDING an OPTIONAL field — and therefore must NOT
 * back up + reinit (which would destroy live ledger history).
 *
 * The fixture seeds a temporary SQLite store, then narrows only its persisted
 * schemas to the pre-field shape before reopening it.
 *
 * If a future change makes init() treat the added-optional shape as divergent
 * (and therefore back up + empty the affected ledgers), these assertions FAIL.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  GOALS_LEDGER,
  REVIEWS_LEDGER,
  REVIEWS_SCHEMA,
  TASKS_LEDGER,
  CANONICAL_LEDGERS,
  schemaCompatible,
  schemasEqual,
  GOALS_SCHEMA,
  HYPOTHESIS_SCHEMA,
  HYPOTHESIS_LEDGER,
  SqliteLedgerStore,
  type LedgerSchema,
} from "../src/index.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs)
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

interface PersistedSchema {
  readonly name: string;
  readonly schema: LedgerSchema;
}

function readRegistry(dbPath: string): { ledgers: PersistedSchema[] } {
  const db = openLedgerDb(dbPath);
  try {
    const rows = db.query<{ name: string; schema_json: string }, []>(
      "SELECT name, schema_json FROM ledgers ORDER BY name",
    ).all();
    return { ledgers: rows.map(({ name, schema_json }) => ({
      name, schema: JSON.parse(schema_json) as LedgerSchema,
    })) };
  } finally {
    db.close();
  }
}

function writeSchemas(dbPath: string, entries: readonly PersistedSchema[]): void {
  const db = openLedgerDb(dbPath);
  try {
    db.transaction(() => {
      for (const { name, schema } of entries) {
        db.query("UPDATE ledgers SET schema_json = ? WHERE name = ?").run(JSON.stringify(schema), name);
      }
    })();
  } finally {
    db.close();
  }
}

/** The optional field T405 added to the six sessionLogs-bearing schemas. */
const ADDED_OPTIONAL_FIELD = "rawLogs";

/** Strip the T405-added optional field from a schema (pre-rawLogs shape). */
function stripRawLogs(schema: LedgerSchema): LedgerSchema {
  if (schema.fields[ADDED_OPTIONAL_FIELD] === undefined) return schema;
  const fields = Object.fromEntries(
    Object.entries(schema.fields).filter(([k]) => k !== ADDED_OPTIONAL_FIELD),
  );
  return { ...schema, fields };
}

function preInconclusiveHypothesisSchema(): LedgerSchema {
  const schema = structuredClone(HYPOTHESIS_SCHEMA);
  schema.statusValues = schema.statusValues.filter((status) => status !== "inconclusive");
  schema.terminalStatuses = schema.terminalStatuses.filter(
    (status) => status !== "inconclusive",
  );
  schema.transitions = Object.fromEntries(
    Object.entries(schema.transitions ?? {})
      .filter(([status]) => status !== "inconclusive")
      .map(([status, targets]) => [
        status,
        targets.filter((target) => target !== "inconclusive"),
      ]),
  );
  return schema;
}

/**
 * Seed a fresh temp store root with a PRE-rawLogs ledger that is otherwise
 * canonical, plus one live goals item and one live tasks item. This isolates
 * exactly the T405 added-optional-field scenario (the committed
 * examples/sample-ledger fixture is too stale — it predates `transitions` and
 * other widenings, so it would diverge on multiple axes).
 *
 * Construction: seed current canonical SQLite rows, then remove rawLogs only
 * from the persisted schema metadata. Item rows remain unchanged.
 */
async function seedPreRawLogsStore(): Promise<{
  root: string;
  dbPath: string;
  goalId: string;
  taskId: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-added-opt-"));
  dirs.push(root);
  const dbPath = path.join(root, "ledger.db");

  const seedStore = new SqliteLedgerStore({ dbPath });
  await seedStore.init();
  const m = await seedStore.createMilestone({ title: "pre-rawLogs seed milestone" });
  const goal = await seedStore.createItem(GOALS_LEDGER, m.id, {
    status: "clarifying",
    fields: { title: "pre-rawLogs goal", description: "must survive rawLogs widening" },
  });
  const task = await seedStore.createItem(TASKS_LEDGER, m.id, {
    status: "planned",
    fields: { headline: "pre-rawLogs task", description: "must survive rawLogs widening" },
  });
  await seedStore.dispose();

  const current = readRegistry(dbPath);
  writeSchemas(dbPath, current.ledgers.map((entry) => ({
    name: entry.name, schema: stripRawLogs(entry.schema),
  })));

  return { root, dbPath, goalId: goal.id, taskId: task.id };
}

// ---------------------------------------------------------------------------
// Fixture precondition — the seeded ledger is genuinely PRE-rawLogs but
// otherwise canonical (so the ONLY divergence axis is the added optional field)
// ---------------------------------------------------------------------------

describe("added-optional-field init — fixture is pre-rawLogs only", () => {
  it("the seeded registry lacks rawLogs but each schema is canon-compatible", async () => {
    const { dbPath } = await seedPreRawLogsStore();
    const registry = readRegistry(dbPath);
    for (const c of CANONICAL_LEDGERS) {
      const e = registry.ledgers.find((x) => x.name === c.name);
      expect(e).toBeDefined();
      expect(e!.schema.fields[ADDED_OPTIONAL_FIELD]).toBeUndefined();
      // The ONLY difference from canon is the missing optional field, so the
      // pre-rawLogs shape must be compatible with (but not equal to, when the
      // ledger is one of the six) the current canonical schema.
      expect(schemaCompatible(e!.schema, c.schema)).toBe(true);
      const hasRawLogs = c.schema.fields[ADDED_OPTIONAL_FIELD] !== undefined;
      expect(schemasEqual(e!.schema, c.schema)).toBe(!hasRawLogs);
    }
  });
});

// ---------------------------------------------------------------------------
// schemaCompatible unit coverage — added-optional is compatible; other
// differences (added REQUIRED, removed field, type/required change) are NOT.
// ---------------------------------------------------------------------------

describe("schemaCompatible — added-optional-field tolerance", () => {
  it("on-disk schema missing only an optional canon field is compatible", () => {
    const canon = GOALS_SCHEMA;
    const onDisk: typeof canon = {
      ...canon,
      fields: Object.fromEntries(
        Object.entries(canon.fields).filter(([k]) => k !== "rawLogs"),
      ),
    };
    // Sanity: the on-disk shape differs (rawLogs absent) so strict equality fails.
    expect(schemasEqual(onDisk, canon)).toBe(false);
    // But compatibility tolerates the added OPTIONAL field.
    expect(schemaCompatible(onDisk, canon)).toBe(true);
  });

  it("identical schemas are compatible", () => {
    expect(schemaCompatible(GOALS_SCHEMA, GOALS_SCHEMA)).toBe(true);
  });

  it("an on-disk field absent from canon is NOT compatible", () => {
    const canon = GOALS_SCHEMA;
    const onDisk: typeof canon = {
      ...canon,
      fields: { ...canon.fields, extraOnDisk: { type: "string", required: false } },
    };
    expect(schemaCompatible(onDisk, canon)).toBe(false);
  });

  it("an added REQUIRED canon field is NOT compatible", () => {
    const onDisk: typeof GOALS_SCHEMA = {
      ...GOALS_SCHEMA,
      fields: Object.fromEntries(
        Object.entries(GOALS_SCHEMA.fields).filter(([k]) => k !== "rawLogs"),
      ),
    };
    const canon: typeof GOALS_SCHEMA = {
      ...GOALS_SCHEMA,
      fields: { ...onDisk.fields, mandatory: { type: "string", required: true } },
    };
    expect(schemaCompatible(onDisk, canon)).toBe(false);
  });

  it("a differing statusValues set is NOT compatible", () => {
    const canon: typeof GOALS_SCHEMA = {
      ...GOALS_SCHEMA,
      statusValues: [...GOALS_SCHEMA.statusValues, "extra-status"],
    };
    expect(schemaCompatible(GOALS_SCHEMA, canon)).toBe(false);
  });

  it("an append-only terminal status and its transitions are compatible [M328/M335]", () => {
    const onDisk = preInconclusiveHypothesisSchema();

    expect(schemasEqual(onDisk, HYPOTHESIS_SCHEMA)).toBe(false);
    expect(schemaCompatible(onDisk, HYPOTHESIS_SCHEMA)).toBe(true);
    expect(schemaCompatible(HYPOTHESIS_SCHEMA, onDisk)).toBe(false);
  });
});

describe("append-only status widening — SQLite preservation", () => {
  it("upgrades the pre-inconclusive schema in place without losing an item", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ledger-status-widening-"));
    dirs.push(root);
    const dbPath = path.join(root, "ledger.db");
    const seed = new SqliteLedgerStore({ dbPath });
    await seed.init();
    const milestone = await seed.createMilestone({ title: "status widening" });
    const hypothesis = await seed.createItem(HYPOTHESIS_LEDGER, milestone.id, {
      status: "uncertain",
      fields: { headline: "survives widening" },
    });
    await seed.dispose();

    const db = openLedgerDb(dbPath);
    db.query("UPDATE ledgers SET schema_json = ? WHERE name = ?").run(
      JSON.stringify(preInconclusiveHypothesisSchema()),
      HYPOTHESIS_LEDGER,
    );
    db.close();

    const reopened = new SqliteLedgerStore({ dbPath, onSchemaDivergence: "abort" });
    await reopened.init();
    try {
      expect(reopened.fetchItem(HYPOTHESIS_LEDGER, hypothesis.id).status).toBe("uncertain");
      expect(reopened.fetch(HYPOTHESIS_LEDGER).schema).toEqual(HYPOTHESIS_SCHEMA);
    } finally {
      await reopened.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// The guard — init() against the pre-rawLogs fixture is graceful: no backup,
// no reinit; live items survive and the in-memory schema is canonical.
// ---------------------------------------------------------------------------

describe("added-optional-field init — init() preserves pre-rawLogs ledger", () => {
  it("init() does NOT create a divergence snapshot", async () => {
    const { root, dbPath } = await seedPreRawLogsStore();
    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    await store.dispose();

    expect((await readdir(root)).filter((name) => name.startsWith("ledger.backup-"))).toEqual([]);
  });

  it("init() preserves the pre-existing goals + tasks items on disk", async () => {
    const { dbPath, goalId, taskId } = await seedPreRawLogsStore();

    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    await store.dispose();

    const db = openLedgerDb(dbPath);
    try {
      const rows = db.query<{ id: string; fields_json: string }, [string, string]>(
        "SELECT id, fields_json FROM items WHERE ledger IN (?, ?) ORDER BY id",
      ).all(GOALS_LEDGER, TASKS_LEDGER);
      expect(rows.map(({ id }) => id)).toEqual([goalId, taskId]);
      expect(rows.map(({ fields_json }) => fields_json).join("\n")).toContain("must survive rawLogs widening");
    } finally {
      db.close();
    }
  });

  it("the pre-existing items are readable after init()", async () => {
    const { dbPath, goalId, taskId } = await seedPreRawLogsStore();
    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    try {
      expect(store.fetchItem(GOALS_LEDGER, goalId).id).toBe(goalId);
      expect(store.fetchItem(TASKS_LEDGER, taskId).id).toBe(taskId);
    } finally {
      await store.dispose();
    }
  });

  it("the live in-memory goals schema is upgraded to canon (includes rawLogs)", async () => {
    const { dbPath } = await seedPreRawLogsStore();
    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    try {
      const goals = store.fetch(GOALS_LEDGER);
      // After a compatible load the in-memory schema carries the canonical
      // (rawLogs-bearing) shape, so new items may use the field.
      expect(goals.schema.fields["rawLogs"]).toBeDefined();
      expect(goals.schema.fields["rawLogs"]!.required).toBe(false);
    } finally {
      await store.dispose();
    }
  });

  it("the on-disk registry is upgraded to canon (rawLogs persisted) after load", async () => {
    const { dbPath } = await seedPreRawLogsStore();
    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    await store.dispose();

    const registry = readRegistry(dbPath);
    const goals = registry.ledgers.find((e) => e.name === GOALS_LEDGER);
    expect(goals).toBeDefined();
    expect(goals!.schema.fields[ADDED_OPTIONAL_FIELD]).toBeDefined();
  });
});

describe("T843 reviews.defects widening — SQLite preservation", () => {
  it("upgrades a pre-field registry in place without backup or item loss", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ledger-pre-review-defects-"));
    dirs.push(root);
    const dbPath = path.join(root, "ledger.db");
    const seeded = new SqliteLedgerStore({ dbPath });
    await seeded.init();
    const milestone = await seeded.createMilestone({ title: "pre-defects review" });
    const review = await seeded.createItem(REVIEWS_LEDGER, milestone.id, {
      status: "revise",
      fields: { summary: "must survive defects widening" },
    });
    await seeded.dispose();

    const registry = readRegistry(dbPath);
    writeSchemas(dbPath, registry.ledgers.map((entry) => {
      if (entry.name !== REVIEWS_LEDGER) return entry;
      const schema = structuredClone(entry.schema);
      delete schema.fields["defects"];
      return { name: entry.name, schema };
    }));

    const reopened = new SqliteLedgerStore({ dbPath });
    await reopened.init();
    try {
      expect(reopened.fetchItem(REVIEWS_LEDGER, review.id).fields["summary"]).toBe(
        "must survive defects widening",
      );
      expect(reopened.fetch(REVIEWS_LEDGER).schema).toEqual(REVIEWS_SCHEMA);
      expect((await readdir(root)).filter((name) => name.startsWith("ledger.backup-"))).toEqual([]);
      const upgraded = readRegistry(dbPath);
      expect(upgraded.ledgers.find((entry) => entry.name === REVIEWS_LEDGER)?.schema).toEqual(
        REVIEWS_SCHEMA,
      );
    } finally {
      await reopened.dispose();
    }
  });
});
