/**
 * Regression guard — canon RELAXING an existing field from `required: true` to
 * `required: false` must be a safe FORWARD widening, not a divergence.
 *
 * Background: the cohort work (f87a84be5) relaxed `operatorActions.taskRef` and
 * `.goalRef` to optional and added three optional cohort fields. A store
 * written by any PRE-cohort build persists those two fields as REQUIRED, so
 * `schemaCompatible` — which demands `af.required === bf.required` for every
 * on-disk field — classed the store DIVERGENT and the default `'abort'` policy
 * refused to open it (`cq web` / `cq mcp` fatal: "existing operatorActions
 * ledger(s) have a different schema than their canonical bootstrap schema").
 *
 * A relaxation cannot invalidate stored data: every persisted item satisfied
 * the stricter rule, so it satisfies the looser one. Only the opposite
 * direction (canon TIGHTENING optional -> required) may stay divergent, since
 * existing items may lack the field.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { LedgerSchema } from "../src/types.js";
import {
  OPERATOR_ACTIONS_LEDGER,
  OPERATOR_ACTIONS_SCHEMA,
  REVIEWS_LEDGER,
} from "../src/constants.js";
import { schemaCompatible } from "../src/store/schemaCompat.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";
const now = (): string => FIXED_NOW;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** The pre-cohort `operatorActions` shape: taskRef/goalRef required, no cohort fields. */
function preCohortOperatorActionsSchema(): LedgerSchema {
  const schema = JSON.parse(JSON.stringify(OPERATOR_ACTIONS_SCHEMA)) as LedgerSchema;
  schema.fields["taskRef"] = { type: "id", required: true };
  schema.fields["goalRef"] = { type: "id", required: true };
  delete schema.fields["cohortBatchDigest"];
  delete schema.fields["cohortMemberRefs"];
  delete schema.fields["cohortGoalRefs"];
  return schema;
}

/**
 * Seed a store holding one review item, then rewrite its persisted
 * `operatorActions` schema to the pre-cohort shape — exactly what a store
 * written before f87a84be5 carries on disk.
 */
async function seedPreCohortStore(): Promise<{ dbPath: string; itemId: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "ledger-required-relaxation-"));
  dirs.push(dir);
  const dbPath = path.join(dir, "ledger.db");

  const seeded = new SqliteLedgerStore({ dbPath, now });
  await seeded.init();
  const milestone = await seeded.createMilestone({ title: "work predating the cohort schema" });
  const review = await seeded.createItem(REVIEWS_LEDGER, milestone.id, {
    status: "go-ahead",
    fields: { summary: "row written before canon relaxed taskRef/goalRef" },
  });
  await seeded.dispose();

  const db = openLedgerDb(dbPath);
  db.query("UPDATE ledgers SET schema_json = ? WHERE name = ?").run(
    JSON.stringify(preCohortOperatorActionsSchema()),
    OPERATOR_ACTIONS_LEDGER,
  );
  db.close();

  return { dbPath, itemId: review.id };
}

function persistedSchema(dbPath: string, ledger: string): LedgerSchema {
  const db = openLedgerDb(dbPath);
  const row = db
    .query("SELECT schema_json FROM ledgers WHERE name = ?")
    .get(ledger) as { schema_json: string };
  db.close();
  return JSON.parse(row.schema_json) as LedgerSchema;
}

describe("canon relaxing required -> optional", () => {
  test("is a compatible widening, not a divergence", () => {
    expect(schemaCompatible(preCohortOperatorActionsSchema(), OPERATOR_ACTIONS_SCHEMA)).toBe(true);
  });

  test("the opposite direction (canon tightening optional -> required) stays divergent", () => {
    const relaxedOnDisk = JSON.parse(JSON.stringify(OPERATOR_ACTIONS_SCHEMA)) as LedgerSchema;
    relaxedOnDisk.fields["summary"] = { type: "string", required: false };
    expect(schemaCompatible(relaxedOnDisk, OPERATOR_ACTIONS_SCHEMA)).toBe(false);
  });

  test("a pre-cohort store opens under the default abort policy", async () => {
    const { dbPath } = await seedPreCohortStore();
    const store = new SqliteLedgerStore({ dbPath, now });

    await expect(store.init()).resolves.toBeUndefined();
    await store.dispose();
  });

  test("the persisted schema is upgraded in place and every row survives", async () => {
    const { dbPath, itemId } = await seedPreCohortStore();
    const store = new SqliteLedgerStore({ dbPath, now });

    await store.init();
    await store.dispose();

    expect(persistedSchema(dbPath, OPERATOR_ACTIONS_LEDGER)).toEqual(OPERATOR_ACTIONS_SCHEMA);
    const db = openLedgerDb(dbPath);
    const row = db
      .query("SELECT fields_json FROM items WHERE ledger = ? AND id = ?")
      .get(REVIEWS_LEDGER, itemId) as { fields_json: string } | null;
    db.close();
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.fields_json).summary).toBe(
      "row written before canon relaxed taskRef/goalRef",
    );
  });

  test("no backup sibling is written, because nothing is destroyed", async () => {
    const { dbPath } = await seedPreCohortStore();
    const store = new SqliteLedgerStore({ dbPath, now });

    await store.init().catch(() => undefined);
    await store.dispose().catch(() => undefined);

    const entries = await readdir(path.dirname(dbPath));
    expect(entries.filter((e) => e.includes(".backup-"))).toEqual([]);
  });
});
