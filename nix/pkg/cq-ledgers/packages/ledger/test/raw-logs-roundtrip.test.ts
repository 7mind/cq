/**
 * Round-trip test for the rawLogs field on all six log-bearing ledger schemas
 * (goals / tasks / reviews / handoffs / defects / hypothesis).
 *
 * Verifies:
 *   1. rawLogs survives a serialize → parse cycle on all six ledgers.
 *   2. An item WITHOUT rawLogs still validates (optional field).
 *   3. Writing rawLogs to hypothesis and defects items succeeds without
 *      a SchemaValidationError (the primary guard against "unknown field").
 */

import { describe, it, expect, afterAll } from "bun:test";
import {
  InMemoryLedgerStore,
  parseLedger,
  serializeLedger,
  DEFECTS_SCHEMA,
  DEFECTS_LEDGER,
  TASKS_SCHEMA,
  TASKS_LEDGER,
  HYPOTHESIS_SCHEMA,
  HYPOTHESIS_LEDGER,
  GOALS_SCHEMA,
  GOALS_LEDGER,
  REVIEWS_SCHEMA,
  REVIEWS_LEDGER,
  HANDOFFS_SCHEMA,
  HANDOFFS_LEDGER,
  type Ledger,
} from "../src/index.js";

const RAW_LOG_PATH = "logs/raw/x.jsonl";

/** Build a minimal single-item in-memory ledger object for serialize/parse tests. */
function makeSingleItemLedger(
  id: string,
  schema: typeof DEFECTS_SCHEMA,
  fields: Record<string, unknown>,
  status: string,
): Ledger {
  return {
    id,
    schema,
    counters: { milestone: 1, item: 1 },
    milestones: [
      {
        id: "M1",
        title: "",
        description: "",
        items: [
          {
            id: `${schema.idPrefix}1`,
            milestoneId: "M1",
            status,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:01.000Z",
            fields: fields as Record<string, string | string[]>,
          },
        ],
      },
    ],
    archivePointers: [],
  };
}

describe("rawLogs field — serialize/parse round-trip on all six ledgers", () => {
  const cases = [
    {
      id: DEFECTS_LEDGER,
      schema: DEFECTS_SCHEMA,
      fields: { headline: "test defect", severity: "minor", rawLogs: [RAW_LOG_PATH] },
      status: "open",
    },
    {
      id: TASKS_LEDGER,
      schema: TASKS_SCHEMA,
      fields: { headline: "test task", rawLogs: [RAW_LOG_PATH] },
      status: "planned",
    },
    {
      id: HYPOTHESIS_LEDGER,
      schema: HYPOTHESIS_SCHEMA,
      fields: { headline: "test hypothesis", rawLogs: [RAW_LOG_PATH] },
      status: "open",
    },
    {
      id: GOALS_LEDGER,
      schema: GOALS_SCHEMA,
      fields: { title: "test goal", description: "desc", rawLogs: [RAW_LOG_PATH] },
      status: "clarifying",
    },
    {
      id: REVIEWS_LEDGER,
      schema: REVIEWS_SCHEMA,
      fields: { summary: "test review", rawLogs: [RAW_LOG_PATH] },
      status: "go-ahead",
    },
    {
      id: HANDOFFS_LEDGER,
      schema: HANDOFFS_SCHEMA,
      fields: { summary: "test handoff", rawLogs: [RAW_LOG_PATH] },
      status: "drained",
    },
  ] as const;

  for (const c of cases) {
    it(`${c.id}: rawLogs survives serialize → parse`, () => {
      const ledger = makeSingleItemLedger(c.id, c.schema, c.fields as Record<string, unknown>, c.status);
      const text = serializeLedger(ledger);
      const parsed = parseLedger(text, { schema: c.schema });
      const item = parsed.milestones[0]?.items[0];
      expect(item).toBeDefined();
      expect(item?.fields["rawLogs"]).toEqual([RAW_LOG_PATH]);
    });

    it(`${c.id}: item WITHOUT rawLogs still validates (optional)`, () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { rawLogs: _omit, ...fieldsWithout } = c.fields as any;
      const ledger = makeSingleItemLedger(c.id, c.schema, fieldsWithout as Record<string, unknown>, c.status);
      const text = serializeLedger(ledger);
      // Should not throw
      const parsed = parseLedger(text, { schema: c.schema });
      const item = parsed.milestones[0]?.items[0];
      expect(item?.fields["rawLogs"]).toBeUndefined();
    });
  }
});

describe("rawLogs field — no SchemaValidationError on store write (hypothesis + defects)", () => {
  afterAll(async () => {
    // no teardown needed for InMemoryLedgerStore
  });

  it("hypothesis item: rawLogs write does not throw SchemaValidationError", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    const m = await store.createMilestone({ title: "test milestone" });
    // Should NOT throw SchemaValidationError for rawLogs
    const item = await store.createItem(HYPOTHESIS_LEDGER, m.id, {
      status: "open",
      fields: {
        headline: "rawLogs test hypothesis",
        rawLogs: [RAW_LOG_PATH],
      },
    });
    expect(item.fields["rawLogs"]).toEqual([RAW_LOG_PATH]);
    await store.dispose();
  });

  it("defects item: rawLogs write does not throw SchemaValidationError", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    const m = await store.createMilestone({ title: "test milestone" });
    // Should NOT throw SchemaValidationError for rawLogs
    const item = await store.createItem(DEFECTS_LEDGER, m.id, {
      status: "open",
      fields: {
        headline: "rawLogs test defect",
        severity: "minor",
        rawLogs: [RAW_LOG_PATH],
      },
    });
    expect(item.fields["rawLogs"]).toEqual([RAW_LOG_PATH]);
    await store.dispose();
  });
});
