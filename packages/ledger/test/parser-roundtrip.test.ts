/**
 * Round-trip property test for the ledger parser/serializer (msunify shape).
 *
 * Two fixtures:
 *   - A non-milestones ledger (defects) — depth-2 headings are bare
 *     `## <id>` with NO title or description.
 *   - The milestones ledger — depth-2 heading is `## M0 — active`;
 *     depth-3 items carry the four-key shape (title/description/blocked/depends).
 *
 * Each fixture is serialized, re-parsed, and asserted equal. The
 * non-milestones serialize+parse path also asserts that the legacy
 * em-dash form `## M3 — title` would fail to parse with a clear error.
 */

import { describe, it, expect } from "bun:test";
import {
  parseLedger,
  serializeLedger,
  parseArchive,
  serializeArchive,
  parseMilestoneItemArchive,
  serializeMilestoneItemArchive,
  type Ledger,
  type LedgerSchema,
  type Milestone,
  MILESTONES_LEDGER,
  MILESTONES_SCHEMA,
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_ACTIVE_GROUP_TITLE,
} from "../src/index.js";

const defectsSchema: LedgerSchema = {
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

function buildDefectsFixture(): Ledger {
  return {
    id: "defects",
    schema: defectsSchema,
    counters: { milestone: 0, item: 27 },
    milestones: [
      {
        id: "M3",
        // Non-milestones depth-2: title + description stay empty.
        title: "",
        description: "",
        items: [
          {
            id: "D25",
            milestoneId: "M3",
            status: "open",
            createdAt: "2023-11-14T22:13:20.000Z",
            updatedAt: "2023-11-14T22:13:21.000Z",
            fields: {
              severity: "minor",
              location: "packages/web/src/Stream.tsx",
              description: "Single-line description.",
              tags: ["ui", "stream"],
              foundAt: "2023-11-14T22:13:20.000Z",
            },
          },
          {
            id: "D26",
            milestoneId: "M3",
            status: "resolved",
            createdAt: "2023-11-14T22:13:22.000Z",
            updatedAt: "2023-11-14T22:13:23.000Z",
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
        title: "",
        description: "",
        items: [],
      },
    ],
    archivePointers: [
      { id: "M1", path: "./archive/defects/M1.md", summary: "M1 archive" },
      { id: "M2", path: "./archive/defects/M2.md", summary: "M2 archive" },
    ],
  };
}

function buildMilestonesFixture(): Ledger {
  return {
    id: MILESTONES_LEDGER,
    schema: MILESTONES_SCHEMA,
    counters: { milestone: 0, item: 3 },
    milestones: [
      {
        id: MILESTONES_ACTIVE_GROUP_ID,
        title: MILESTONES_ACTIVE_GROUP_TITLE,
        description: "",
        items: [
          {
            id: "M1",
            milestoneId: MILESTONES_ACTIVE_GROUP_ID,
            status: "open",
            createdAt: "2026-05-28T20:30:00.000Z",
            updatedAt: "2026-05-28T20:30:00.000Z",
            fields: {
              title: "first milestone",
              description: "First milestone description.",
              blocked: ["D7"],
              depends: ["M0"],
            },
          },
          {
            id: "M2",
            milestoneId: MILESTONES_ACTIVE_GROUP_ID,
            status: "done",
            createdAt: "2026-05-28T20:31:00.000Z",
            updatedAt: "2026-05-28T20:31:00.000Z",
            fields: {
              title: "shipped",
            },
          },
        ],
      },
    ],
    archivePointers: [
      { id: "M0-archived", path: "./archive/milestones/M0-archived.md", summary: "n/a" },
    ],
  };
}

describe("parser round-trip — non-milestones ledger", () => {
  it("serializes and re-parses a representative ledger losslessly", () => {
    const original = buildDefectsFixture();
    const text = serializeLedger(original);
    const parsed = parseLedger(text, { schema: defectsSchema });
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
      expect(b.title).toBe(a.title); // both empty
      expect(b.description).toBe(a.description); // both empty
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
    const original = buildDefectsFixture();
    const text1 = serializeLedger(original);
    const parsed1 = parseLedger(text1, { schema: defectsSchema });
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

  it("legacy em-dash depth-2 headers fail to parse with a clear migration error", () => {
    // Hand-built legacy fixture.
    const legacy = `---\nledger: defects\ncounters:\n  milestone: 0\n  item: 0\narchives: []\n---\n\n# defects\n\n## M3 — legacy title\n`;
    expect(() => parseLedger(legacy, { schema: defectsSchema })).toThrow(/msunify/i);
  });

  it("round-trips a per-group archive (non-milestones)", () => {
    const m: Milestone = buildDefectsFixture().milestones[0] as Milestone;
    const text = serializeArchive(m);
    const parsed = parseArchive(text);
    expect(parsed.id).toBe(m.id);
    expect(parsed.title).toBe(""); // always empty for group archives
    expect(parsed.description).toBe("");
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

describe("parser round-trip — milestones ledger", () => {
  it("serializes and re-parses the bootstrap ledger losslessly", () => {
    const original = buildMilestonesFixture();
    const text = serializeLedger(original);
    const parsed = parseLedger(text, {
      schema: MILESTONES_SCHEMA,
      isMilestonesLedger: true,
    });
    expect(parsed.id).toBe(MILESTONES_LEDGER);
    expect(parsed.counters).toEqual(original.counters);
    expect(parsed.archivePointers).toEqual(original.archivePointers);
    expect(parsed.milestones.length).toBe(1);
    const g = parsed.milestones[0];
    expect(g?.id).toBe(MILESTONES_ACTIVE_GROUP_ID);
    expect(g?.title).toBe(MILESTONES_ACTIVE_GROUP_TITLE);
    expect(g?.items.length).toBe(2);
    const m1 = g?.items[0];
    expect(m1?.id).toBe("M1");
    expect(m1?.fields["title"]).toBe("first milestone");
    expect(m1?.fields["blocked"]).toEqual(["D7"]);
  });

  it("re-serializing a parsed milestones ledger is byte-stable (idempotent)", () => {
    const original = buildMilestonesFixture();
    const text1 = serializeLedger(original);
    const parsed1 = parseLedger(text1, {
      schema: MILESTONES_SCHEMA,
      isMilestonesLedger: true,
    });
    const text2 = serializeLedger(parsed1);
    expect(text2).toBe(text1);
  });

  it("parser rejects > 1 depth-2 groups in the milestones ledger", () => {
    const bad = `---\nledger: ${MILESTONES_LEDGER}\ncounters:\n  milestone: 0\n  item: 0\narchives: []\n---\n\n# ${MILESTONES_LEDGER}\n\n## M0 — active\n\n## M1 — extra\n`;
    expect(() =>
      parseLedger(bad, { schema: MILESTONES_SCHEMA, isMilestonesLedger: true }),
    ).toThrow(/exactly one/);
  });

  it("parser rejects a non-M0 depth-2 group in the milestones ledger", () => {
    const bad = `---\nledger: ${MILESTONES_LEDGER}\ncounters:\n  milestone: 0\n  item: 0\narchives: []\n---\n\n# ${MILESTONES_LEDGER}\n\n## Mwrong — something\n`;
    expect(() =>
      parseLedger(bad, { schema: MILESTONES_SCHEMA, isMilestonesLedger: true }),
    ).toThrow(/M0/);
  });

  it("milestones-item archive round-trips", () => {
    const item = buildMilestonesFixture().milestones[0]?.items[0];
    if (item === undefined) throw new Error("missing fixture item");
    const text = serializeMilestoneItemArchive(item);
    const parsed = parseMilestoneItemArchive(text);
    expect(parsed.id).toBe(item.id);
    expect(parsed.status).toBe(item.status);
    expect(parsed.fields).toEqual(item.fields);
    expect(parsed.createdAt).toBe(item.createdAt);
    expect(parsed.updatedAt).toBe(item.updatedAt);
  });

  it("parser rejects non-ISO createdAt / updatedAt", () => {
    const bad = `---\nledger: defects\ncounters:\n  milestone: 0\n  item: 1\narchives: []\n---\n\n# defects\n\n## M3\n\n### D1 — open\n\n- createdAt: 1700000000000\n- updatedAt: 1700000000000\n`;
    expect(() => parseLedger(bad, { schema: defectsSchema })).toThrow(/ISO 8601/);
  });
});
