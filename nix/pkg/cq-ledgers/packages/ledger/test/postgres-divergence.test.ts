/**
 * classifyCanonicalLedgers tests (T574, G81/M248) — the pure Pass-1
 * canonical-ledger schema-divergence classification PostgresLedgerStore.init()
 * uses. No Postgres server needed: fixtures are plain in-memory LedgerSchema
 * values, mirroring backup-reinit-init.test.ts's divergent-schema fixture
 * style but exercised against the extracted pure classifier directly.
 */

import { describe, expect, test } from "bun:test";
import type { LedgerSchema } from "../src/index.js";
import { classifyCanonicalLedgers } from "../src/store/postgres/divergence.js";

const SCHEMA_A: LedgerSchema = {
  statusValues: ["open", "closed"],
  terminalStatuses: ["closed"],
  idPrefix: "A",
  fields: {
    headline: { type: "string", required: true },
  },
};

const CANONICAL = [{ name: "widgets", schema: SCHEMA_A }];

describe("classifyCanonicalLedgers (T574)", () => {
  test("no persisted row for a canonical name -> missing", () => {
    const report = classifyCanonicalLedgers(new Map(), CANONICAL);
    expect(report).toEqual({ missing: ["widgets"], widened: [], divergent: [] });
  });

  test("persisted schema structurally equal to canon -> neither missing, widened, nor divergent", () => {
    const persisted = new Map([["widgets", { ...SCHEMA_A, fields: { ...SCHEMA_A.fields } }]]);
    const report = classifyCanonicalLedgers(persisted, CANONICAL);
    expect(report).toEqual({ missing: [], widened: [], divergent: [] });
  });

  test("persisted schema missing only an added-OPTIONAL field -> widened", () => {
    const canonWithOptional: LedgerSchema = {
      ...SCHEMA_A,
      fields: { ...SCHEMA_A.fields, notes: { type: "string", required: false } },
    };
    const persisted = new Map([["widgets", SCHEMA_A]]);
    const report = classifyCanonicalLedgers(persisted, [{ name: "widgets", schema: canonWithOptional }]);
    expect(report).toEqual({ missing: [], widened: ["widgets"], divergent: [] });
  });

  test("persisted schema with a different idPrefix -> divergent (not widened)", () => {
    const persisted = new Map([["widgets", { ...SCHEMA_A, idPrefix: "B" }]]);
    const report = classifyCanonicalLedgers(persisted, CANONICAL);
    expect(report).toEqual({ missing: [], widened: [], divergent: ["widgets"] });
  });

  test("persisted schema with an extra statusValues entry -> divergent", () => {
    const persisted = new Map([
      ["widgets", { ...SCHEMA_A, statusValues: [...SCHEMA_A.statusValues, "extra"] }],
    ]);
    const report = classifyCanonicalLedgers(persisted, CANONICAL);
    expect(report).toEqual({ missing: [], widened: [], divergent: ["widgets"] });
  });

  test("persisted schema missing a REQUIRED canon field (not just optional) -> divergent", () => {
    const canonWithRequired: LedgerSchema = {
      ...SCHEMA_A,
      fields: { ...SCHEMA_A.fields, mandatory: { type: "string", required: true } },
    };
    const persisted = new Map([["widgets", SCHEMA_A]]);
    const report = classifyCanonicalLedgers(persisted, [{ name: "widgets", schema: canonWithRequired }]);
    expect(report).toEqual({ missing: [], widened: [], divergent: ["widgets"] });
  });

  test("mixed set: one missing, one widened, one divergent, one equal — classified independently", () => {
    const equalSchema = SCHEMA_A;
    const widenedCanon: LedgerSchema = {
      ...SCHEMA_A,
      fields: { ...SCHEMA_A.fields, notes: { type: "string", required: false } },
    };
    const divergentSchema: LedgerSchema = { ...SCHEMA_A, idPrefix: "Z" };
    const canonical = [
      { name: "missing-one", schema: SCHEMA_A },
      { name: "widened-one", schema: widenedCanon },
      { name: "divergent-one", schema: SCHEMA_A },
      { name: "equal-one", schema: equalSchema },
    ];
    const persisted = new Map([
      ["widened-one", SCHEMA_A],
      ["divergent-one", divergentSchema],
      ["equal-one", equalSchema],
    ]);
    const report = classifyCanonicalLedgers(persisted, canonical);
    expect(report).toEqual({
      missing: ["missing-one"],
      widened: ["widened-one"],
      divergent: ["divergent-one"],
    });
  });

  test("defaults to CANONICAL_LEDGERS when no override is passed", () => {
    const report = classifyCanonicalLedgers(new Map());
    expect(report.missing.length).toBeGreaterThan(0);
    expect(report.widened).toEqual([]);
    expect(report.divergent).toEqual([]);
  });
});
