/**
 * Round-trip property test for the ledger parser/serializer.
 *
 * Builds a representative Ledger fixture (covering all field types, archive
 * pointers, multi-line strings, special-character strings), serializes it,
 * parses it back, and asserts structural equality.
 */

import { describe, it, expect } from "bun:test";
import {
  parseLedger,
  serializeLedger,
  parseArchive,
  serializeArchive,
  type Ledger,
  type LedgerSchema,
  type Milestone,
} from "../src/index.js";

const schema: LedgerSchema = {
  statusValues: ["open", "in-progress", "blocked", "resolved", "abandoned"],
  terminalStatuses: ["resolved", "abandoned"],
  fields: {
    severity: { type: "string", required: true },
    location: { type: "string", required: true },
    description: { type: "string", required: true },
    rootCause: { type: "string", required: false },
    fix: { type: "string", required: false },
    relatedIds: { type: "id[]", required: false },
    tags: { type: "string[]", required: false },
    foundAt: { type: "timestamp", required: false },
  },
};

function buildFixture(): Ledger {
  return {
    id: "defects",
    schema,
    counters: { milestone: 3, item: 27 },
    milestones: [
      {
        id: "M3",
        title: "third milestone — with em-dash in title",
        description: "A short description paragraph.\n\nWith a second paragraph.",
        items: [
          {
            id: "D25",
            milestoneId: "M3",
            status: "open",
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_001_000,
            fields: {
              severity: "minor",
              location: "packages/web/src/Stream.tsx",
              description: "Single-line description.",
              tags: ["ui", "stream"],
              foundAt: 1_700_000_000_000,
            },
          },
          {
            id: "D26",
            milestoneId: "M3",
            status: "resolved",
            createdAt: 1_700_000_002_000,
            updatedAt: 1_700_000_003_000,
            fields: {
              severity: "nit",
              location: "Header.tsx",
              description:
                "Multi-line description.\nLine two.\nLine three with: colons inside.",
              rootCause: "yaml: special characters [need] {escaping}",
              fix: "what changed",
              relatedIds: ["D24", "D25"],
            },
          },
        ],
      },
      {
        id: "M4",
        title: "empty milestone",
        description: "",
        items: [],
      },
    ],
    archivePointers: [
      { id: "M1", path: "./archive/defects/M1.md", summary: "M1 — initial spike (12 items, all resolved)" },
      { id: "M2", path: "./archive/defects/M2.md", summary: "M2 — schema rewrite (8 items)" },
    ],
  };
}

describe("parser round-trip", () => {
  it("serializes and re-parses a representative ledger losslessly", () => {
    const original = buildFixture();
    const text = serializeLedger(original);
    const parsed = parseLedger(text, { schema });
    expect(parsed.id).toBe(original.id);
    expect(parsed.counters).toEqual(original.counters);
    expect(parsed.archivePointers).toEqual(original.archivePointers);
    expect(parsed.milestones.length).toBe(original.milestones.length);
    for (let i = 0; i < original.milestones.length; i++) {
      const a = original.milestones[i];
      const b = parsed.milestones[i];
      expect(b).toBeDefined();
      if (a === undefined || b === undefined) continue;
      expect(b.id).toBe(a.id);
      expect(b.title).toBe(a.title);
      expect(b.description).toBe(a.description);
      expect(b.items.length).toBe(a.items.length);
      for (let j = 0; j < a.items.length; j++) {
        const ia = a.items[j];
        const ib = b.items[j];
        expect(ib).toBeDefined();
        if (ia === undefined || ib === undefined) continue;
        expect(ib.id).toBe(ia.id);
        expect(ib.status).toBe(ia.status);
        expect(ib.milestoneId).toBe(ia.milestoneId);
        expect(ib.createdAt).toBe(ia.createdAt);
        expect(ib.updatedAt).toBe(ia.updatedAt);
        expect(ib.fields).toEqual(ia.fields);
      }
    }
  });

  it("re-serializing a parsed ledger is byte-stable (idempotent)", () => {
    const original = buildFixture();
    const text1 = serializeLedger(original);
    const parsed1 = parseLedger(text1, { schema });
    const text2 = serializeLedger(parsed1);
    expect(text2).toBe(text1);
  });

  it("round-trips a ledger with no milestones and no archives", () => {
    const empty: Ledger = {
      id: "tasks",
      schema: {
        statusValues: ["open", "done"],
        terminalStatuses: ["done"],
        fields: {},
      },
      counters: { milestone: 0, item: 0 },
      milestones: [],
      archivePointers: [],
    };
    const text = serializeLedger(empty);
    const parsed = parseLedger(text, { schema: empty.schema });
    expect(parsed.id).toBe(empty.id);
    expect(parsed.counters).toEqual(empty.counters);
    expect(parsed.archivePointers).toEqual([]);
    expect(parsed.milestones).toEqual([]);
  });

  it("round-trips an archive milestone (no frontmatter)", () => {
    const m: Milestone = buildFixture().milestones[0] as Milestone;
    const text = serializeArchive(m);
    const parsed = parseArchive(text);
    expect(parsed.id).toBe(m.id);
    expect(parsed.title).toBe(m.title);
    expect(parsed.description).toBe(m.description);
    expect(parsed.items.length).toBe(m.items.length);
    for (let i = 0; i < m.items.length; i++) {
      const a = m.items[i];
      const b = parsed.items[i];
      if (a === undefined || b === undefined) continue;
      expect(b.id).toBe(a.id);
      expect(b.status).toBe(a.status);
      expect(b.fields).toEqual(a.fields);
    }
  });
});
