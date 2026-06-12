/**
 * Regression guard (T407) — an ADDED OPTIONAL field in a canonical schema must
 * NOT trigger a destructive backup-reinit when an EXISTING (pre-field) ledger
 * is loaded by a newer build.
 *
 * Background: T405 added the optional `rawLogs: string[]` field to all six
 * sessionLogs-bearing canonical schemas (goals/tasks/reviews/handoffs/defects/
 * hypothesis). A ledger that was written by a PRE-rawLogs build carries an
 * on-disk registry whose schemas are MISSING `rawLogs`. The schema-divergence
 * guard in `FsLedgerStore.init()` (`schemaCompatible`, formerly the strict
 * `schemasEqual`) must treat that on-disk schema as COMPATIBLE — the only
 * difference is canon ADDING an OPTIONAL field — and therefore must NOT
 * back up + reinit (which would destroy live ledger history).
 *
 * The fixture is the committed pre-rawLogs `examples/sample-ledger/docs/`
 * snapshot (its registry has `sessionLogs` but NOT `rawLogs`). We copy it into
 * a TEMP store root (never mutating the committed fixture) and init from it.
 *
 * If a future change makes init() treat the added-optional shape as divergent
 * (and therefore back up + empty the affected ledgers), these assertions FAIL.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, stat, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  GOALS_LEDGER,
  TASKS_LEDGER,
  CANONICAL_LEDGERS,
  serializeRegistry,
  parseRegistry,
  schemaCompatible,
  schemasEqual,
  GOALS_SCHEMA,
  type LedgerSchema,
  LEDGER_STORAGE_DIRNAME,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs)
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

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

/**
 * Seed a fresh temp store root with a PRE-rawLogs ledger that is otherwise
 * canonical, plus one live goals item and one live tasks item. This isolates
 * exactly the T405 added-optional-field scenario (the committed
 * examples/sample-ledger fixture is too stale — it predates `transitions` and
 * other widenings, so it would diverge on multiple axes).
 *
 * Construction: prime a REAL FsLedgerStore (current canon, WITH rawLogs), seed
 * two live items, dispose — yielding valid on-disk .md files and a registry. We
 * then REWRITE only the on-disk ledgers.yaml to STRIP `rawLogs` from every
 * schema, producing the exact pre-rawLogs on-disk state. The .md files do NOT
 * embed the schema, so they remain valid against the pre-rawLogs registry.
 */
async function seedPreRawLogsStore(): Promise<{
  root: string;
  docsDir: string;
  goalId: string;
  taskId: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-added-opt-"));
  dirs.push(root);
  const docsDir = path.join(root, LEDGER_STORAGE_DIRNAME);
  await mkdir(docsDir, { recursive: true });

  const seedStore = new FsLedgerStore({ root });
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

  // Downgrade the on-disk registry to the pre-rawLogs shape.
  const registryPath = path.join(docsDir, "ledgers.yaml");
  const current = parseRegistry(await readFile(registryPath, "utf8"));
  const downgraded = serializeRegistry({
    version: current.version,
    ledgers: current.ledgers.map((e) => ({ name: e.name, schema: stripRawLogs(e.schema) })),
  });
  await writeFile(registryPath, downgraded, "utf8");

  return { root, docsDir, goalId: goal.id, taskId: task.id };
}

// ---------------------------------------------------------------------------
// Fixture precondition — the seeded ledger is genuinely PRE-rawLogs but
// otherwise canonical (so the ONLY divergence axis is the added optional field)
// ---------------------------------------------------------------------------

describe("added-optional-field init — fixture is pre-rawLogs only", () => {
  it("the seeded registry lacks rawLogs but each schema is canon-compatible", async () => {
    const { docsDir } = await seedPreRawLogsStore();
    const text = await readFile(path.join(docsDir, "ledgers.yaml"), "utf8");
    const registry = parseRegistry(text);
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
});

// ---------------------------------------------------------------------------
// The guard — init() against the pre-rawLogs fixture is graceful: no backup,
// no reinit; live items survive and the in-memory schema is canonical.
// ---------------------------------------------------------------------------

describe("added-optional-field init — init() preserves pre-rawLogs ledger", () => {
  it("init() does NOT create a .cq/.backup/ dir", async () => {
    const { root, docsDir } = await seedPreRawLogsStore();
    const store = new FsLedgerStore({ root });
    await store.init();
    await store.dispose();

    const backupParent = path.join(docsDir, ".backup");
    let backupExists = false;
    try {
      await stat(backupParent);
      backupExists = true;
    } catch {
      // ENOENT expected — added-optional is compatible, no backup.
    }
    expect(backupExists).toBe(false);
  });

  it("init() preserves the pre-existing goals + tasks items on disk", async () => {
    const { root, docsDir, goalId, taskId } = await seedPreRawLogsStore();

    const store = new FsLedgerStore({ root });
    await store.init();
    await store.dispose();

    // A reinit would have rewritten these as empty fresh-canonical ledgers.
    const goalsAfter = await readFile(path.join(docsDir, `${GOALS_LEDGER}.md`), "utf8");
    const tasksAfter = await readFile(path.join(docsDir, `${TASKS_LEDGER}.md`), "utf8");
    expect(goalsAfter).toContain(goalId);
    expect(goalsAfter).toContain("must survive rawLogs widening");
    expect(tasksAfter).toContain(taskId);
  });

  it("the pre-existing items are readable after init()", async () => {
    const { root, goalId, taskId } = await seedPreRawLogsStore();
    const store = new FsLedgerStore({ root });
    await store.init();
    try {
      expect(store.fetchItem(GOALS_LEDGER, goalId).id).toBe(goalId);
      expect(store.fetchItem(TASKS_LEDGER, taskId).id).toBe(taskId);
    } finally {
      await store.dispose();
    }
  });

  it("the live in-memory goals schema is upgraded to canon (includes rawLogs)", async () => {
    const { root } = await seedPreRawLogsStore();
    const store = new FsLedgerStore({ root });
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
    const { root, docsDir } = await seedPreRawLogsStore();
    const store = new FsLedgerStore({ root });
    await store.init();
    await store.dispose();

    const registry = parseRegistry(await readFile(path.join(docsDir, "ledgers.yaml"), "utf8"));
    const goals = registry.ledgers.find((e) => e.name === GOALS_LEDGER);
    expect(goals).toBeDefined();
    expect(goals!.schema.fields[ADDED_OPTIONAL_FIELD]).toBeDefined();
  });
});
