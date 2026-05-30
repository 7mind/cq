/**
 * Canonical-ledger coverage (canon cycle, §2-5b + B).
 *
 * For every bootstrapped non-milestones canonical ledger, drive a full
 * create / update / fetch / search / archive lifecycle against BOTH
 * adapters (dual-tests), exercising each ledger's required + a couple of
 * optional fields and its auto-allocated `<idPrefix><n>` ids.
 *
 * Also: a parser round-trip of each ledger's worked example from §11 of
 * the design doc (used as on-disk fixtures), and a bootstrap-idempotence +
 * schema-divergence-guard check per ledger.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  InMemoryLedgerStore,
  parseLedger,
  serializeRegistry,
  CANONICAL_LEDGERS,
  DEFECTS_LEDGER,
  TASKS_LEDGER,
  HYPOTHESIS_LEDGER,
  QUESTIONS_LEDGER,
  DECISIONS_LEDGER,
  GOALS_LEDGER,
  DEFECTS_SCHEMA,
  TASKS_SCHEMA,
  HYPOTHESIS_SCHEMA,
  QUESTIONS_SCHEMA,
  DECISIONS_SCHEMA,
  GOALS_SCHEMA,
  type LedgerSchema,
  type LedgerStore,
  type FieldValue,
} from "../src/index.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

interface Factory {
  name: string;
  build(): Promise<LedgerStore>;
}

const inMem: Factory = {
  name: "InMemoryLedgerStore",
  async build() {
    const store = new InMemoryLedgerStore({});
    await store.init();
    return store;
  },
};
const fs_: Factory = {
  name: "FsLedgerStore",
  async build() {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-canon-"));
    dirs.push(dir);
    const store = new FsLedgerStore({ root: dir });
    await store.init();
    return store;
  },
};

/**
 * Per-ledger lifecycle fixture: required-field create input, an optional
 * field to update, the expected `<prefix>1` id, and a terminal status.
 */
interface LedgerCase {
  ledger: string;
  prefix: string;
  create: Record<string, FieldValue>;
  update: { status?: string; fields?: Record<string, FieldValue> };
  searchNeedle: string; // substring present in a created field
  terminalStatus: string;
}

const CASES: LedgerCase[] = [
  {
    ledger: DEFECTS_LEDGER,
    prefix: "D",
    create: { headline: "Esc closes the wrong layer", severity: "minor", tags: ["clarification-required"] },
    update: { status: "resolved", fields: { fix: "stopPropagation at SettingsPopup.tsx:54" } },
    searchNeedle: "esc closes",
    terminalStatus: "resolved",
  },
  {
    ledger: TASKS_LEDGER,
    prefix: "T",
    create: { headline: "Move SettingsPopup persistence to URL hash", acceptance: "round-trip test passes" },
    update: { status: "done", fields: { resultCommit: "8328355" } },
    searchNeedle: "settingspopup",
    terminalStatus: "done",
  },
  {
    ledger: HYPOTHESIS_LEDGER,
    prefix: "H",
    create: { headline: "Codex SDK blocks in-process MCP by design", evidence: ["E1 [correct] dist/index.d.ts:239"] },
    update: { status: "confirmed", fields: { rationale: "rests on E1.correct + E3.correct" } },
    searchNeedle: "codex sdk blocks",
    terminalStatus: "confirmed",
  },
  {
    ledger: QUESTIONS_LEDGER,
    prefix: "Q",
    create: { question: "Should settings migrate from localStorage on first hash load?", suggestions: ["hash wins (recommended)"] },
    update: { status: "answered", fields: { answer: "hash wins; localStorage mirrored" } },
    searchNeedle: "localstorage",
    terminalStatus: "answered",
  },
  {
    ledger: DECISIONS_LEDGER,
    prefix: "K",
    create: { headline: "Item IDs globally unique across all ledgers", rationale: "prefix uniqueness" },
    update: { status: "locked", fields: { landsIn: ["T20"] } },
    searchNeedle: "globally unique",
    terminalStatus: "locked",
  },
  {
    ledger: GOALS_LEDGER,
    prefix: "G",
    create: { title: "Ship canonical ledgers", description: "Ship the canonical ledgers", milestones: ["M-AMBIENT"] },
    update: { status: "done", fields: { tags: ["open-ended"] } },
    searchNeedle: "canonical ledgers",
    terminalStatus: "done",
  },
];

for (const factory of [inMem, fs_]) {
  describe(`canonical ledgers — lifecycle (${factory.name})`, () => {
    for (const c of CASES) {
      it(`${c.ledger}: create/update/fetch/search/archive`, async () => {
        const store = await factory.build();
        try {
          const m = await store.createMilestone({ title: `${c.ledger} milestone` });
          // create — id is <prefix>1.
          const created = await store.createItem(c.ledger, m.id, {
            status: c.update.status === undefined ? "open" : firstStatus(c.ledger),
            fields: c.create,
          });
          expect(created.id).toBe(`${c.prefix}1`);
          expect(created.milestoneId).toBe(m.id);

          // fetch
          const fetched = store.fetchItem(c.ledger, created.id);
          expect(fetched.id).toBe(created.id);

          // search (substring across fields)
          const hits = store.search(c.ledger, c.searchNeedle);
          expect(hits.map((i) => i.id)).toContain(created.id);

          // update to a terminal status + an optional field
          const updated = await store.updateItem(c.ledger, created.id, c.update);
          expect(updated.status).toBe(c.terminalStatus);

          // archive the milestone now that the item is terminal; mark the
          // milestone done too.
          await store.updateMilestone(m.id, { status: "done" });
          const ptr = await store.archiveMilestone(m.id, `${c.ledger} done`);
          expect(ptr.id).toBe(m.id);
          // The ledger's active group is gone; the archive is readable.
          const arch = await store.fetchArchive(c.ledger, m.id);
          expect(arch.kind).toBe("group");
          if (arch.kind === "group") {
            expect(arch.milestone.items.map((i) => i.id)).toEqual([created.id]);
          }
        } finally {
          await store.dispose();
        }
      });
    }

    it("global id uniqueness: one item per canonical ledger, all distinct ids", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "uniqueness" });
        const ids = new Set<string>();
        for (const c of CASES) {
          const it = await store.createItem(c.ledger, m.id, {
            status: firstStatus(c.ledger),
            fields: c.create,
          });
          expect(ids.has(it.id)).toBe(false);
          ids.add(it.id);
        }
        expect(ids.size).toBe(CASES.length);
        // Each id carries its ledger's distinct prefix.
        expect([...ids].map((id) => id[0]).sort()).toEqual(["D", "G", "H", "K", "Q", "T"]);
      } finally {
        await store.dispose();
      }
    });
  });
}

/** First non-terminal status to create an item with, per ledger. */
function firstStatus(ledger: string): string {
  const schema = CANONICAL_LEDGERS.find((c) => c.name === ledger)?.schema;
  if (schema === undefined) throw new Error(`no schema for ${ledger}`);
  return schema.statusValues[0]!;
}

// ---------------------------------------------------------------------------
// Bootstrap idempotence + schema-divergence guard, per canonical ledger.
// ---------------------------------------------------------------------------

describe("bootstrap idempotence + divergence guard", () => {
  it("re-init against the same dir is a no-op (idempotent)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-canon-idem-"));
    dirs.push(dir);
    const a = new FsLedgerStore({ root: dir });
    await a.init();
    const before = a.enumerate();
    await a.dispose();
    const b = new FsLedgerStore({ root: dir });
    await b.init();
    expect(b.enumerate()).toEqual(before);
    await b.dispose();
  });

  const schemas: Array<[string, LedgerSchema]> = [
    [DEFECTS_LEDGER, DEFECTS_SCHEMA],
    [TASKS_LEDGER, TASKS_SCHEMA],
    [HYPOTHESIS_LEDGER, HYPOTHESIS_SCHEMA],
    [QUESTIONS_LEDGER, QUESTIONS_SCHEMA],
    [DECISIONS_LEDGER, DECISIONS_SCHEMA],
    [GOALS_LEDGER, GOALS_SCHEMA],
  ];

  for (const [name] of schemas) {
    it(`divergence guard fires for a hand-edited ${name} schema`, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "ledger-canon-div-"));
      dirs.push(dir);
      const docsDir = path.join(dir, "docs");
      await mkdir(docsDir, { recursive: true });
      // Write a registry whose `name` entry has a DIVERGENT-but-VALID
      // schema (an extra status value — still a superset that passes
      // validateSchema), forcing the bootstrap guard to refuse start.
      const divergent = CANONICAL_LEDGERS.map((c) => {
        if (c.name !== name) return { name: c.name, schema: c.schema };
        return {
          name: c.name,
          schema: { ...c.schema, statusValues: [...c.schema.statusValues, "extra-status"] },
        };
      });
      await writeFile(
        path.join(docsDir, "ledgers.yaml"),
        serializeRegistry({ version: 1, ledgers: divergent }),
        "utf8",
      );
      const store = new FsLedgerStore({ root: dir });
      await expect(store.init()).rejects.toThrow(/different schema/);
    });
  }
});

// ---------------------------------------------------------------------------
// §11 worked-example parser round-trips. Each fixture is the design doc's
// on-disk form; we assert parse → serialize → parse is stable and the
// key fields survive.
// ---------------------------------------------------------------------------

describe("§11 worked-example parser round-trips", () => {
  const FIXTURES: Array<{ name: string; schema: LedgerSchema; text: string; assertItem: (fields: Record<string, FieldValue>) => void }> = [
    {
      name: DEFECTS_LEDGER,
      schema: DEFECTS_SCHEMA,
      text: `---\nledger: defects\ncounters:\n  milestone: 0\n  item: 9\narchives: []\n---\n\n# defects\n\n## M12\n\n### D8 — open\n\n- createdAt: 2026-05-28T11:08:00.000Z\n- updatedAt: 2026-05-28T15:42:00.000Z\n- headline: Popup loses focus on Esc when a nested select is open\n- severity: minor\n- sourceRefs: ["packages/web/src/chat/SettingsPopup.tsx:54-89"]\n- blockedBy: ["Q4"]\n- ledgerRefs: ["hypothesis:H3"]\n- tags: ["clarification-required"]\n- suggestedModel: hands\n`,
      assertItem: (f) => {
        expect(f["headline"]).toContain("Popup loses focus");
        expect(f["severity"]).toBe("minor");
        expect(f["blockedBy"]).toEqual(["Q4"]);
        expect(f["ledgerRefs"]).toEqual(["hypothesis:H3"]);
      },
    },
    {
      name: TASKS_LEDGER,
      schema: TASKS_SCHEMA,
      text: `---\nledger: tasks\ncounters:\n  milestone: 0\n  item: 21\narchives: []\n---\n\n# tasks\n\n## M13\n\n### T20 — planned\n\n- createdAt: 2026-05-28T20:15:00.000Z\n- updatedAt: 2026-05-28T20:15:00.000Z\n- headline: Add idPrefix + global item-id uniqueness to @cq/ledger\n- planDoc: docs/drafts/20260528-2129-canonical-ledger-schemas.md\n- dependsOn: ["T21"]\n- severity: major\n- suggestedModel: brain\n`,
      assertItem: (f) => {
        expect(f["headline"]).toContain("idPrefix");
        expect(f["dependsOn"]).toEqual(["T21"]);
        expect(f["severity"]).toBe("major");
      },
    },
    {
      name: HYPOTHESIS_LEDGER,
      schema: HYPOTHESIS_SCHEMA,
      text: `---\nledger: hypothesis\ncounters:\n  milestone: 0\n  item: 5\narchives: []\n---\n\n# hypothesis\n\n## M12\n\n### H3 — uncertain\n\n- createdAt: 2026-05-28T14:01:00.000Z\n- updatedAt: 2026-05-28T19:20:00.000Z\n- headline: Codex SDK blocks in-process MCP injection by API design, not version\n- evidence: ["E1 [correct] dist/index.d.ts:239 no mcpServers", "E2 [incorrect] alpha-2 still absent"]\n- dependsOn: ["H1"]\n- tags: ["open-ended"]\n- suggestedModel: brain\n`,
      assertItem: (f) => {
        expect(f["headline"]).toContain("Codex SDK blocks");
        expect(Array.isArray(f["evidence"]) && f["evidence"].length).toBe(2);
        expect(f["dependsOn"]).toEqual(["H1"]);
      },
    },
    {
      name: QUESTIONS_LEDGER,
      schema: QUESTIONS_SCHEMA,
      text: `---\nledger: questions\ncounters:\n  milestone: 0\n  item: 5\narchives: []\n---\n\n# questions\n\n## M12\n\n### Q4 — open\n\n- createdAt: 2026-05-28T11:10:00.000Z\n- updatedAt: 2026-05-28T11:10:00.000Z\n- question: Should SettingsPopup state migrate from localStorage when the user first loads a URL hash?\n- suggestions: ["URL hash wins (recommended)", "localStorage wins"]\n- recommendation: URL hash wins\n- ledgerRefs: ["tasks:T19", "defects:D8"]\n- tags: ["clarification-required"]\n`,
      assertItem: (f) => {
        expect(f["question"]).toContain("SettingsPopup");
        expect(Array.isArray(f["suggestions"]) && f["suggestions"].length).toBe(2);
        expect(f["ledgerRefs"]).toEqual(["tasks:T19", "defects:D8"]);
      },
    },
    {
      name: DECISIONS_LEDGER,
      schema: DECISIONS_SCHEMA,
      text: `---\nledger: decisions\ncounters:\n  milestone: 0\n  item: 4\narchives: []\n---\n\n# decisions\n\n## M13\n\n### K4 — locked\n\n- createdAt: 2026-05-28T20:30:00.000Z\n- updatedAt: 2026-05-28T20:30:00.000Z\n- headline: Item IDs globally unique across all ledgers\n- landsIn: ["T20"]\n- supersedes: []\n- ledgerRefs: ["hypothesis:H3"]\n- suggestedModel: brain\n`,
      assertItem: (f) => {
        expect(f["headline"]).toContain("globally unique");
        expect(f["landsIn"]).toEqual(["T20"]);
        expect(f["supersedes"]).toEqual([]);
      },
    },
    {
      name: GOALS_LEDGER,
      schema: GOALS_SCHEMA,
      text: `---\nledger: goals\ncounters:\n  milestone: 0\n  item: 1\narchives: []\n---\n\n# goals\n\n## M13\n\n### G1 — planned\n\n- createdAt: 2026-05-28T20:30:00.000Z\n- updatedAt: 2026-05-28T20:30:00.000Z\n- title: Skills onto canonical ledgers\n- description: Move the four skills onto the canonical ledgers\n- milestones: ["M13"]\n- tags: ["open-ended"]\n`,
      assertItem: (f) => {
        expect(f["title"]).toContain("canonical ledgers");
        expect(f["description"]).toContain("canonical ledgers");
        expect(f["milestones"]).toEqual(["M13"]);
      },
    },
  ];

  for (const fx of FIXTURES) {
    it(`${fx.name}: parse → serialize → parse is stable and fields survive`, async () => {
      const { serializeLedger } = await import("../src/index.js");
      const parsed = parseLedger(fx.text, { schema: fx.schema });
      const item = parsed.milestones[0]?.items[0];
      expect(item).toBeDefined();
      fx.assertItem(item!.fields);
      // Round-trip stability.
      const text2 = serializeLedger(parsed);
      const parsed2 = parseLedger(text2, { schema: fx.schema });
      expect(parsed2.milestones[0]?.items[0]?.fields).toEqual(item!.fields);
      expect(serializeLedger(parsed2)).toBe(text2);
    });
  }
});

// ---------------------------------------------------------------------------
// The bootstrapped milestones file renders the §8d `## active` header on a
// fresh cwd, and all seven canonical ledgers are present.
// ---------------------------------------------------------------------------

describe("fresh-cwd bootstrap shape", () => {
  it("writes `## active` in docs/milestones.md and provisions all seven ledgers", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-canon-fresh-"));
    dirs.push(dir);
    const store = new FsLedgerStore({ root: dir });
    await store.init();
    expect(store.enumerate()).toEqual(
      CANONICAL_LEDGERS.map((c) => c.name).sort(),
    );
    await store.dispose();
    const milestonesMd = await readFile(path.join(dir, "docs", "milestones.md"), "utf8");
    expect(milestonesMd).toContain("\n## active\n");
    expect(milestonesMd).not.toContain("M0 —");
    expect(milestonesMd).toContain("### M-AMBIENT — open");
  });
});
