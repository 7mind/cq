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
import { mkdtemp, rm, writeFile, mkdir, readFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  InMemoryLedgerStore,
  parseLedger,
  serializeRegistry,
  parseRegistry,
  CANONICAL_LEDGERS,
  DEFECTS_LEDGER,
  TASKS_LEDGER,
  HYPOTHESIS_LEDGER,
  QUESTIONS_LEDGER,
  DECISIONS_LEDGER,
  GOALS_LEDGER,
  REVIEWS_LEDGER,
  REVIEWS_SCHEMA,
  HANDOFFS_LEDGER,
  HANDOFFS_SCHEMA,
  InvalidStatusError,
  SchemaValidationError,
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
  /**
   * Status to create the item with so the single `update` to `terminalStatus`
   * is a LEGAL transition under the F1 guard. Defaults to `firstStatus(ledger)`.
   * `goals` overrides it to `building` (the only state with a direct edge to
   * `done`); for the other ledgers the first status already reaches terminal
   * directly.
   */
  createStatus?: string;
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
    // F1: clarifying → done is illegal; create at `building`, which has a
    // direct legal edge to `done`.
    createStatus: "building",
  },
];

for (const factory of [inMem, fs_]) {
  describe(`canonical ledgers — lifecycle (${factory.name})`, () => {
    for (const c of CASES) {
      it(`${c.ledger}: create/update/fetch/search/archive`, async () => {
        const store = await factory.build();
        try {
          const m = await store.createMilestone({ title: `${c.ledger} milestone` });
          const created = await store.createItem(c.ledger, m.id, {
            status:
              c.update.status === undefined
                ? "open"
                : (c.createStatus ?? firstStatus(c.ledger)),
            fields: c.create,
          });
          expect(created.id).toBe(`${c.prefix}1`);
          expect(created.milestoneId).toBe(m.id);

          const fetched = store.fetchItem(c.ledger, created.id);
          expect(fetched.id).toBe(created.id);

          const hits = store.search(c.ledger, c.searchNeedle);
          expect(hits.map((i) => i.id)).toContain(created.id);

          // update to a terminal status + an optional field
          const updated = await store.updateItem(c.ledger, created.id, c.update);
          expect(updated.status).toBe(c.terminalStatus);

          // archive once the item is terminal; mark the milestone done too.
          await store.updateMilestone(m.id, { status: "done" });
          const ptr = await store.archiveMilestone(m.id, `${c.ledger} done`);
          expect(ptr.id).toBe(m.id);
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
        // `reviews` is excluded from CASES (verdict-as-status, no lifecycle
        // update step), so mint one directly to exercise the `R` prefix in
        // the cross-ledger uniqueness/prefix assertion.
        const review = await store.createItem(REVIEWS_LEDGER, m.id, {
          status: "go-ahead",
          fields: { criticism: ["looks fine"] },
        });
        expect(ids.has(review.id)).toBe(false);
        ids.add(review.id);
        // `handoffs` is also excluded from CASES (all-terminal, no lifecycle
        // update step), so mint one directly to exercise the `HO` prefix.
        const handoff = await store.createItem(HANDOFFS_LEDGER, m.id, {
          status: "drained",
          fields: { summary: "all tasks drained" },
        });
        expect(ids.has(handoff.id)).toBe(false);
        ids.add(handoff.id);
        expect(ids.size).toBe(CASES.length + 2);
        // Each id carries its ledger's distinct prefix (HO is a 2-char prefix).
        const prefixes = [...ids].map((id) => {
          const m2 = id.match(/^([A-Z]+)\d+$/);
          return m2 ? m2[1] : id;
        });
        expect(prefixes.sort()).toEqual(["D", "G", "H", "HO", "K", "Q", "R", "T"]);
      } finally {
        await store.dispose();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// F3 — reviews ledger: the item `status` IS the verdict. Both verdict statuses
// (`go-ahead`, `revise`) are terminal, so a review is an immutable one-round
// record (no update/transition step — that is what makes the standard CASES
// lifecycle shape inapplicable here). Status enforcement is generic, so an
// out-of-enum verdict throws InvalidStatusError with no review-specific code.
// ---------------------------------------------------------------------------

for (const factory of [inMem, fs_]) {
  describe(`reviews ledger — verdict-as-status (${factory.name})`, () => {
    it("creates a go-ahead review with new_questions/criticism/ledgerRefs and round-trips", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "reviews milestone" });
        const goal = await store.createItem(GOALS_LEDGER, m.id, {
          status: "clarifying",
          fields: { title: "Goal under review", description: "the goal" },
        });
        const created = await store.createItem(REVIEWS_LEDGER, m.id, {
          status: "go-ahead",
          fields: {
            new_questions: ["does the plan cover rollback?"],
            criticism: ["step 3 lacks a verification command"],
            ledgerRefs: [`${GOALS_LEDGER}:${goal.id}`],
          },
        });
        expect(created.id).toBe("R1");
        expect(created.status).toBe("go-ahead");

        const fetched = store.fetchItem(REVIEWS_LEDGER, created.id);
        expect(fetched.status).toBe("go-ahead");
        expect(fetched.fields["new_questions"]).toEqual(["does the plan cover rollback?"]);
        expect(fetched.fields["criticism"]).toEqual(["step 3 lacks a verification command"]);
        expect(fetched.fields["ledgerRefs"]).toEqual([`${GOALS_LEDGER}:${goal.id}`]);
      } finally {
        await store.dispose();
      }
    });

    it("creates a revise review", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "reviews milestone" });
        const created = await store.createItem(REVIEWS_LEDGER, m.id, {
          status: "revise",
          fields: { criticism: ["acceptance criteria are not testable"] },
        });
        expect(created.status).toBe("revise");
      } finally {
        await store.dispose();
      }
    });

    it("rejects an out-of-enum verdict status", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "reviews milestone" });
        await expect(
          store.createItem(REVIEWS_LEDGER, m.id, {
            status: "maybe",
            fields: { criticism: ["unsure"] },
          }),
        ).rejects.toThrow(InvalidStatusError);
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
    [HANDOFFS_LEDGER, HANDOFFS_SCHEMA],
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
      // Abort opt-out coverage (T95/T96): these 6 cases exercise the
      // `onSchemaDivergence:'abort'` policy — init() rejects loudly on
      // divergence so the operator must handle it.  The DEFAULT policy
      // (backup-reinit) is covered by backup-reinit-init.test.ts §1.
      const store = new FsLedgerStore({ root: dir, onSchemaDivergence: "abort" });
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
      const text2 = serializeLedger(parsed);
      const parsed2 = parseLedger(text2, { schema: fx.schema });
      expect(parsed2.milestones[0]?.items[0]?.fields).toEqual(item!.fields);
      expect(serializeLedger(parsed2)).toBe(text2);
    });
  }
});

// ---------------------------------------------------------------------------
// The bootstrapped milestones file renders the §8d `## active` header on a
// fresh cwd, and all canonical ledgers are present.
// ---------------------------------------------------------------------------

describe("fresh-cwd bootstrap shape", () => {
  it("writes `## active` in docs/milestones.md and provisions all canonical ledgers", async () => {
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

// ---------------------------------------------------------------------------
// D01 — the committed-in-repo `docs/ledgers.yaml` (a PURE schema registry,
// regenerated via `bun run regen-bootstrap`) must match canon. Booting an
// FsLedgerStore against a copy of it succeeds with NO BootstrapViolationError;
// the strict, order-significant divergence guard would fire if the on-disk
// registry omitted any canonical `transitions` map or diverged otherwise.
// ---------------------------------------------------------------------------

describe("repo docs/ledgers.yaml matches canon (no bootstrap divergence)", () => {
  it("boots against the regenerated on-disk registry", async () => {
    const repoRegistry = path.resolve(import.meta.dir, "../../../docs/ledgers.yaml");
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-canon-disk-"));
    dirs.push(dir);
    const docsDir = path.join(dir, "docs");
    await mkdir(docsDir, { recursive: true });
    await copyFile(repoRegistry, path.join(docsDir, "ledgers.yaml"));

    const store = new FsLedgerStore({ root: dir });
    // init() throws BootstrapViolationError on any divergence; reaching the
    // assertions proves the on-disk registry matches canon.
    await store.init();
    try {
      expect(store.enumerate()).toEqual(CANONICAL_LEDGERS.map((c) => c.name).sort());
    } finally {
      await store.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Req5 — REVIEWS_SCHEMA.fields.summary: all three registry copies must
// declare `summary` with type 'string' and required:false.
// ---------------------------------------------------------------------------

describe("Req5: reviews summary field — all three registry copies", () => {
  it("REVIEWS_SCHEMA constant has summary: { type: 'string', required: false }", () => {
    const f = REVIEWS_SCHEMA.fields["summary"];
    expect(f).toBeDefined();
    expect(f!.type).toBe("string");
    expect(f!.required).toBe(false);
  });

  it("docs/ledgers.yaml has reviews.fields.summary: { type: string, required: false }", async () => {
    const yamlPath = path.resolve(import.meta.dir, "../../../docs/ledgers.yaml");
    const text = await readFile(yamlPath, "utf8");
    const registry = parseRegistry(text);
    const reviews = registry.ledgers.find((e) => e.name === REVIEWS_LEDGER);
    expect(reviews).toBeDefined();
    const f = reviews!.schema.fields["summary"];
    expect(f).toBeDefined();
    expect(f!.type).toBe("string");
    expect(f!.required).toBe(false);
  });

  it("examples/sample-ledger/docs/ledgers.yaml has reviews.fields.summary: { type: string, required: false }", async () => {
    const yamlPath = path.resolve(import.meta.dir, "../../../examples/sample-ledger/docs/ledgers.yaml");
    const text = await readFile(yamlPath, "utf8");
    const registry = parseRegistry(text);
    const reviews = registry.ledgers.find((e) => e.name === REVIEWS_LEDGER);
    expect(reviews).toBeDefined();
    const f = reviews!.schema.fields["summary"];
    expect(f).toBeDefined();
    expect(f!.type).toBe("string");
    expect(f!.required).toBe(false);
  });

  it("existing reviews items with no summary still load/validate", async () => {
    const store = await inMem.build();
    try {
      const m = await store.createMilestone({ title: "backward-compat test" });
      // Create a review with NO summary field — must succeed (optional).
      const created = await store.createItem(REVIEWS_LEDGER, m.id, {
        status: "go-ahead",
        fields: { criticism: ["looks good; no summary provided"] },
      });
      expect(created.status).toBe("go-ahead");
      expect(created.fields["summary"]).toBeUndefined();
      const fetched = store.fetchItem(REVIEWS_LEDGER, created.id);
      expect(fetched.fields["summary"]).toBeUndefined();
    } finally {
      await store.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// T137 — HANDOFFS_SCHEMA shape + bootstrap + lifecycle (all-terminal).
// ---------------------------------------------------------------------------

describe("HANDOFFS_SCHEMA shape", () => {
  it("statusValues are exactly the 5 declared values", () => {
    expect(HANDOFFS_SCHEMA.statusValues).toEqual([
      "drained",
      "answers-required",
      "mixed",
      "illness-detected",
      "user-action-required",
    ]);
  });

  it("all five statusValues are terminal", () => {
    expect(HANDOFFS_SCHEMA.terminalStatuses).toEqual(HANDOFFS_SCHEMA.statusValues);
  });

  it("idPrefix is HO", () => {
    expect(HANDOFFS_SCHEMA.idPrefix).toBe("HO");
  });

  it("all transitions are empty arrays (all-terminal)", () => {
    expect(HANDOFFS_SCHEMA.transitions).toBeDefined();
    const transitions = HANDOFFS_SCHEMA.transitions!;
    for (const status of HANDOFFS_SCHEMA.statusValues) {
      expect(transitions[status]).toEqual([]);
    }
  });

  it("has exactly 8 fields: summary, flow, ledgerRefs, blockingQuestions, handoffReasons, sessionLogs, tags, sourceRefs", () => {
    const fieldNames = Object.keys(HANDOFFS_SCHEMA.fields).sort();
    expect(fieldNames).toEqual(
      ["blockingQuestions", "flow", "handoffReasons", "ledgerRefs", "sessionLogs", "sourceRefs", "summary", "tags"],
    );
  });

  it("summary is required:true, type:string", () => {
    const f = HANDOFFS_SCHEMA.fields["summary"];
    expect(f).toBeDefined();
    expect(f!.type).toBe("string");
    expect(f!.required).toBe(true);
  });

  it("flow is required:false, type:string", () => {
    const f = HANDOFFS_SCHEMA.fields["flow"];
    expect(f).toBeDefined();
    expect(f!.type).toBe("string");
    expect(f!.required).toBe(false);
  });

  it("ledgerRefs is required:false, type:id[]", () => {
    const f = HANDOFFS_SCHEMA.fields["ledgerRefs"];
    expect(f).toBeDefined();
    expect(f!.type).toBe("id[]");
    expect(f!.required).toBe(false);
  });

  it("blockingQuestions is required:false, type:id[]", () => {
    const f = HANDOFFS_SCHEMA.fields["blockingQuestions"];
    expect(f).toBeDefined();
    expect(f!.type).toBe("id[]");
    expect(f!.required).toBe(false);
  });

  it("handoffReasons is required:false, type:string[]", () => {
    const f = HANDOFFS_SCHEMA.fields["handoffReasons"];
    expect(f).toBeDefined();
    expect(f!.type).toBe("string[]");
    expect(f!.required).toBe(false);
  });

  it("CANONICAL_LEDGERS has 9 entries and handoffs is last", () => {
    expect(CANONICAL_LEDGERS).toHaveLength(9);
    expect(CANONICAL_LEDGERS[CANONICAL_LEDGERS.length - 1]!.name).toBe(HANDOFFS_LEDGER);
  });
});

for (const factory of [inMem, fs_]) {
  describe(`handoffs ledger — all-terminal lifecycle (${factory.name})`, () => {
    it("bootstraps a fresh handoffs ledger file and creates items with HO prefix", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "handoffs milestone" });
        const created = await store.createItem(HANDOFFS_LEDGER, m.id, {
          status: "drained",
          fields: {
            summary: "All DAG-ready tasks processed to completion.",
            flow: "implement",
            handoffReasons: [],
            tags: ["auto"],
          },
        });
        expect(created.id).toBe("HO1");
        expect(created.status).toBe("drained");
        expect(created.fields["summary"]).toBe("All DAG-ready tasks processed to completion.");
        expect(created.fields["flow"]).toBe("implement");

        const fetched = store.fetchItem(HANDOFFS_LEDGER, created.id);
        expect(fetched.id).toBe("HO1");
        expect(fetched.status).toBe("drained");
      } finally {
        await store.dispose();
      }
    });

    it("creates a mixed handoff with handoffReasons", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "mixed handoff" });
        const created = await store.createItem(HANDOFFS_LEDGER, m.id, {
          status: "mixed",
          fields: {
            summary: "Session stopped for multiple reasons.",
            handoffReasons: ["drained", "answers-required"],
          },
        });
        expect(created.status).toBe("mixed");
        expect(created.fields["handoffReasons"]).toEqual(["drained", "answers-required"]);
      } finally {
        await store.dispose();
      }
    });

    it("rejects an out-of-enum status", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "invalid handoff" });
        await expect(
          store.createItem(HANDOFFS_LEDGER, m.id, {
            status: "done",
            fields: { summary: "wrong status" },
          }),
        ).rejects.toThrow(InvalidStatusError);
      } finally {
        await store.dispose();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// T138 — sessionLogs field presence: present on work-producing ledgers
// (defects/tasks/hypothesis/goals/reviews/handoffs), absent on
// questions/decisions.
// ---------------------------------------------------------------------------

describe("T138: sessionLogs field presence on work-producing ledgers", () => {
  const SCHEMAS_WITH_SESSION_LOGS: Array<[string, LedgerSchema]> = [
    [DEFECTS_LEDGER, DEFECTS_SCHEMA],
    [TASKS_LEDGER, TASKS_SCHEMA],
    [HYPOTHESIS_LEDGER, HYPOTHESIS_SCHEMA],
    [GOALS_LEDGER, GOALS_SCHEMA],
    [REVIEWS_LEDGER, REVIEWS_SCHEMA],
    [HANDOFFS_LEDGER, HANDOFFS_SCHEMA],
  ];

  const SCHEMAS_WITHOUT_SESSION_LOGS: Array<[string, LedgerSchema]> = [
    [QUESTIONS_LEDGER, QUESTIONS_SCHEMA],
    [DECISIONS_LEDGER, DECISIONS_SCHEMA],
  ];

  for (const [name, schema] of SCHEMAS_WITH_SESSION_LOGS) {
    it(`${name}: has sessionLogs field (type:string[], required:false)`, () => {
      const f = schema.fields["sessionLogs"];
      expect(f).toBeDefined();
      expect(f!.type).toBe("string[]");
      expect(f!.required).toBe(false);
    });
  }

  for (const [name, schema] of SCHEMAS_WITHOUT_SESSION_LOGS) {
    it(`${name}: does NOT have sessionLogs field`, () => {
      expect(schema.fields["sessionLogs"]).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// T138 — create_item accepts sessionLogs on a task; rejects it on a question.
// ---------------------------------------------------------------------------

for (const factory of [inMem, fs_]) {
  describe(`T138: sessionLogs accepted on task, rejected on question (${factory.name})`, () => {
    it("accepts sessionLogs on a task create_item", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "T138 task milestone" });
        const created = await store.createItem(TASKS_LEDGER, m.id, {
          status: "planned",
          fields: {
            headline: "Task with session log",
            sessionLogs: ["docs/logs/20260603-120000-agent-abc.md"],
          },
        });
        expect(created.fields["sessionLogs"]).toEqual(["docs/logs/20260603-120000-agent-abc.md"]);
      } finally {
        await store.dispose();
      }
    });

    it("rejects sessionLogs on a question create_item (unknown field)", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "T138 question milestone" });
        await expect(
          store.createItem(QUESTIONS_LEDGER, m.id, {
            status: "open",
            fields: {
              question: "Should we add sessionLogs to questions?",
              sessionLogs: ["docs/logs/20260603-120000-agent-abc.md"],
            },
          }),
        ).rejects.toThrow(SchemaValidationError);
      } finally {
        await store.dispose();
      }
    });
  });
}
