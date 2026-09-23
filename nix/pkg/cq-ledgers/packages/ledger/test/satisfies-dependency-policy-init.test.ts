/**
 * Regression guard (D406) — `satisfiesDependencyStatuses` is part of schema
 * IDENTITY, so a canonical change to it must be DETECTED as a divergence and
 * then persisted, rather than silently ignored.
 *
 * Background: `schemasEqual` compared idPrefix, statuses, fields and
 * transitions but never `satisfiesDependencyStatuses`. Every durable adapter
 * reconciles a canonical schema only under `!schemasEqual`, so a policy-only
 * canonical change was classified EQUAL and bypassed every rewrite path — the
 * store kept serving the stale dependency-gating policy for the life of the
 * database, with no divergence report and no way to notice.
 *
 * The change is nonetheless SAFE in place: which statuses satisfy a dependency
 * is gating policy, not item validity, so no stored row can be invalidated by
 * it. It must therefore be a compatible widening (no destructive backup-reinit)
 * that still round-trips into the persisted schema.
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
import { schemaCompatible, schemasEqual } from "../src/store/schemaCompat.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";
const now = (): string => FIXED_NOW;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * The `operatorActions` shape as written before canon declared its
 * dependency-satisfaction policy: identical in every other respect, so the
 * ONLY difference from canon is the policy field itself.
 */
function prePolicyOperatorActionsSchema(): LedgerSchema {
  const schema = JSON.parse(JSON.stringify(OPERATOR_ACTIONS_SCHEMA)) as LedgerSchema;
  delete schema.satisfiesDependencyStatuses;
  return schema;
}

/** The same shape, but declaring a DIFFERENT policy than canon. */
function divergentPolicyOperatorActionsSchema(): LedgerSchema {
  const schema = JSON.parse(JSON.stringify(OPERATOR_ACTIONS_SCHEMA)) as LedgerSchema;
  schema.satisfiesDependencyStatuses = ["verified", "superseded"];
  return schema;
}

async function seedStoreWithPersistedSchema(
  ledgerSchema: LedgerSchema,
): Promise<{ dbPath: string; itemId: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "ledger-satisfies-policy-"));
  dirs.push(dir);
  const dbPath = path.join(dir, "ledger.db");

  const seeded = new SqliteLedgerStore({ dbPath, now });
  await seeded.init();
  const milestone = await seeded.createMilestone({ title: "work predating the policy" });
  const review = await seeded.createItem(REVIEWS_LEDGER, milestone.id, {
    status: "go-ahead",
    fields: { summary: "row written before canon declared the policy" },
  });
  await seeded.dispose();

  const db = openLedgerDb(dbPath);
  db.query("UPDATE ledgers SET schema_json = ? WHERE name = ?").run(
    JSON.stringify(ledgerSchema),
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

describe("canonical satisfiesDependencyStatuses policy change", () => {
  test("an absent on-disk policy is NOT equal to canon's declared policy", () => {
    expect(schemasEqual(prePolicyOperatorActionsSchema(), OPERATOR_ACTIONS_SCHEMA)).toBe(false);
  });

  test("a different on-disk policy is NOT equal to canon's declared policy", () => {
    expect(schemasEqual(divergentPolicyOperatorActionsSchema(), OPERATOR_ACTIONS_SCHEMA)).toBe(
      false,
    );
  });

  test("absence is distinct from an empty declaration", () => {
    const absent = prePolicyOperatorActionsSchema();
    const empty = JSON.parse(JSON.stringify(OPERATOR_ACTIONS_SCHEMA)) as LedgerSchema;
    empty.satisfiesDependencyStatuses = [];
    // Absence means "every terminal status satisfies"; an empty list means
    // "nothing satisfies". They are different policies.
    expect(schemasEqual(absent, empty)).toBe(false);
  });

  test("a policy-only change is a compatible widening, not a destructive divergence", () => {
    expect(schemaCompatible(prePolicyOperatorActionsSchema(), OPERATOR_ACTIONS_SCHEMA)).toBe(true);
    expect(schemaCompatible(divergentPolicyOperatorActionsSchema(), OPERATOR_ACTIONS_SCHEMA)).toBe(
      true,
    );
  });

  for (const [label, seedSchema] of [
    ["absent", prePolicyOperatorActionsSchema],
    ["divergent", divergentPolicyOperatorActionsSchema],
  ] as const) {
    test(`a store with the ${label} policy opens under the default abort policy`, async () => {
      const { dbPath } = await seedStoreWithPersistedSchema(seedSchema());
      const store = new SqliteLedgerStore({ dbPath, now });

      await expect(store.init()).resolves.toBeUndefined();
      await store.dispose();
    });

    test(`the ${label} policy is upgraded in place and every row survives`, async () => {
      const { dbPath, itemId } = await seedStoreWithPersistedSchema(seedSchema());
      const store = new SqliteLedgerStore({ dbPath, now });

      await store.init();
      await store.dispose();

      // The actual consequence of the defect: without detection there is no
      // reconciliation, so the stale policy survives the reopen.
      expect(persistedSchema(dbPath, OPERATOR_ACTIONS_LEDGER).satisfiesDependencyStatuses).toEqual(
        OPERATOR_ACTIONS_SCHEMA.satisfiesDependencyStatuses,
      );
      expect(persistedSchema(dbPath, OPERATOR_ACTIONS_LEDGER)).toEqual(OPERATOR_ACTIONS_SCHEMA);

      const db = openLedgerDb(dbPath);
      const row = db
        .query("SELECT fields_json FROM items WHERE ledger = ? AND id = ?")
        .get(REVIEWS_LEDGER, itemId) as { fields_json: string } | null;
      db.close();
      expect(row).not.toBeNull();
      expect(JSON.parse(row!.fields_json).summary).toBe(
        "row written before canon declared the policy",
      );
    });

    test(`no backup sibling is written for the ${label} policy, because nothing is destroyed`, async () => {
      const { dbPath } = await seedStoreWithPersistedSchema(seedSchema());
      const store = new SqliteLedgerStore({ dbPath, now });

      await store.init().catch(() => undefined);
      await store.dispose().catch(() => undefined);

      const entries = await readdir(path.dirname(dbPath));
      expect(entries.filter((e) => e.includes(".backup-"))).toEqual([]);
    });
  }
});
