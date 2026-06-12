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
  IDEAS_LEDGER,
  IDEAS_SCHEMA,
  MILESTONES_AMBIENT_ID,
  InvalidStatusError,
  InvalidTransitionError,
  SchemaValidationError,
  BootstrapViolationError,
  DEFECTS_SCHEMA,
  TASKS_SCHEMA,
  HYPOTHESIS_SCHEMA,
  QUESTIONS_SCHEMA,
  DECISIONS_SCHEMA,
  GOALS_SCHEMA,
  type LedgerSchema,
  type LedgerStore,
  type FieldValue,
  LEDGER_STORAGE_DIRNAME,
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
  {
    ledger: IDEAS_LEDGER,
    prefix: "I",
    create: { title: "Cross-nav from idea to seeded goal", description: "Link a consumed idea to its goal" },
    update: { status: "discarded", fields: { description: "superseded by an existing goal" } },
    searchNeedle: "cross-nav",
    terminalStatus: "discarded",
    // open → discarded is a legal direct edge; `open` is the first status.
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
        expect(prefixes.sort()).toEqual(["D", "G", "H", "HO", "I", "K", "Q", "R", "T"]);
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
    [IDEAS_LEDGER, IDEAS_SCHEMA],
  ];

  for (const [name] of schemas) {
    it(`divergence guard fires for a hand-edited ${name} schema`, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "ledger-canon-div-"));
      dirs.push(dir);
      const docsDir = path.join(dir, LEDGER_STORAGE_DIRNAME);
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
    const milestonesMd = await readFile(path.join(dir, LEDGER_STORAGE_DIRNAME, "milestones.md"), "utf8");
    expect(milestonesMd).toContain("\n## active\n");
    expect(milestonesMd).not.toContain("M0 —");
    expect(milestonesMd).toContain("### M-AMBIENT — open");
  });
});

// ---------------------------------------------------------------------------
// D47 — the committed-in-repo `docs/ledgers.yaml` (a PURE schema registry,
// regenerated via `bun run regen-bootstrap`) must match canon such that any
// structural divergence is LOUD (throws BootstrapViolationError) and
// `bun run check` fails. Three sub-tests cover this:
//
//   1. Primary: boot with onSchemaDivergence:'abort' against the real committed
//      fixture — proves the fixture is in sync (throws on divergence).
//   2. Byte-equality: the committed fixture BYTE-EQUALS what regen-bootstrap
//      would emit — catches serialisation-order / field-order drift.
//   3. Reproduce-first: a deliberately stale fixture DOES throw under abort-mode
//      (proving the guard catches drift) but does NOT throw under the old default
//      backup-reinit mode (proving the pre-fix test was silent).
// ---------------------------------------------------------------------------

describe("repo docs/ledgers.yaml matches canon (no bootstrap divergence)", () => {
  it("boots against the regenerated on-disk registry with abort mode", async () => {
    const repoRegistry = path.resolve(import.meta.dir, "../../../docs/ledgers.yaml");
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-canon-disk-"));
    dirs.push(dir);
    const docsDir = path.join(dir, LEDGER_STORAGE_DIRNAME);
    await mkdir(docsDir, { recursive: true });
    await copyFile(repoRegistry, path.join(docsDir, "ledgers.yaml"));

    // onSchemaDivergence:'abort' makes init() throw BootstrapViolationError on
    // any structural divergence; reaching the assertions proves the committed
    // fixture matches canon exactly. The old default 'backup-reinit' mode would
    // silently self-heal a stale fixture, masking drift.
    const store = new FsLedgerStore({ root: dir, onSchemaDivergence: "abort" });
    await store.init();
    try {
      expect(store.enumerate()).toEqual(CANONICAL_LEDGERS.map((c) => c.name).sort());
    } finally {
      await store.dispose();
    }
  });

  it("committed docs/ledgers.yaml byte-equals what regen-bootstrap emits", async () => {
    const repoRegistry = path.resolve(import.meta.dir, "../../../docs/ledgers.yaml");
    const committedText = await readFile(repoRegistry, "utf8");
    const expectedText = serializeRegistry({
      version: 1,
      ledgers: CANONICAL_LEDGERS.map((c) => ({ name: c.name, schema: c.schema })),
    });
    expect(committedText).toBe(expectedText);
  });

  it("abort-mode throws on a deliberately stale fixture; default backup-reinit does not (D47 reproduce-first)", async () => {
    // Build a stale variant: serialize a registry where the decisions schema has
    // one field's `required` flipped (false → true). The resulting YAML parses
    // successfully (valid schema, transitions unchanged) but schemasEqual returns
    // false against the real canonical schema → divergent[] is non-empty.
    const staleText = serializeRegistry({
      version: 1,
      ledgers: CANONICAL_LEDGERS.map((c) => {
        if (c.name !== DECISIONS_LEDGER) return { name: c.name, schema: c.schema };
        // Flip decisions.rationale.required to produce a parseable divergence.
        return {
          name: c.name,
          schema: {
            ...c.schema,
            fields: {
              ...c.schema.fields,
              rationale: { type: "string" as const, required: true },
            },
          },
        };
      }),
    });

    // Part A — abort mode MUST throw BootstrapViolationError for the stale fixture.
    {
      const dir = await mkdtemp(path.join(tmpdir(), "ledger-canon-stale-abort-"));
      dirs.push(dir);
      const docsDir = path.join(dir, LEDGER_STORAGE_DIRNAME);
      await mkdir(docsDir, { recursive: true });
      await writeFile(path.join(docsDir, "ledgers.yaml"), staleText, "utf8");
      const store = new FsLedgerStore({ root: dir, onSchemaDivergence: "abort" });
      await expect(store.init()).rejects.toBeInstanceOf(BootstrapViolationError);
    }

    // Part B — the old default backup-reinit mode silently heals the stale fixture
    // and does NOT throw, proving the pre-fix test was inadequate.
    {
      const dir = await mkdtemp(path.join(tmpdir(), "ledger-canon-stale-reinit-"));
      dirs.push(dir);
      const docsDir = path.join(dir, LEDGER_STORAGE_DIRNAME);
      await mkdir(docsDir, { recursive: true });
      await writeFile(path.join(docsDir, "ledgers.yaml"), staleText, "utf8");
      const store = new FsLedgerStore({ root: dir }); // default: 'backup-reinit'
      // Must NOT throw — it self-heals silently (the D47 defect).
      await store.init();
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

  it("has exactly 9 fields: summary, flow, ledgerRefs, blockingQuestions, handoffReasons, sessionLogs, rawLogs, tags, sourceRefs", () => {
    const fieldNames = Object.keys(HANDOFFS_SCHEMA.fields).sort();
    expect(fieldNames).toEqual(
      ["blockingQuestions", "flow", "handoffReasons", "ledgerRefs", "rawLogs", "sessionLogs", "sourceRefs", "summary", "tags"],
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

  it("CANONICAL_LEDGERS has 10 entries and ideas is last", () => {
    expect(CANONICAL_LEDGERS).toHaveLength(10);
    expect(CANONICAL_LEDGERS[CANONICAL_LEDGERS.length - 1]!.name).toBe(IDEAS_LEDGER);
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
            // D39: a `mixed` handoff REQUIRES a non-empty blockingQuestions[].
            blockingQuestions: ["Which env should the deploy target?"],
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

    // T258 — store-API smoke proof that assertHandoffInvariants is wired into
    // the create path (the comprehensive dual-adapter matrix lives in T259).
    it("rejects a mixed handoff with an empty blockingQuestions array (D39 create-path)", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "empty-bq handoff" });
        await expect(
          store.createItem(HANDOFFS_LEDGER, m.id, {
            status: "mixed",
            fields: { summary: "x", blockingQuestions: [] },
          }),
        ).rejects.toThrow(SchemaValidationError);
        // The same create with a non-empty blockingQuestions[] SUCCEEDS.
        const ok = await store.createItem(HANDOFFS_LEDGER, m.id, {
          status: "mixed",
          fields: { summary: "x", blockingQuestions: ["Q1"] },
        });
        expect(ok.status).toBe("mixed");
        expect(ok.fields["blockingQuestions"]).toEqual(["Q1"]);
      } finally {
        await store.dispose();
      }
    });

    // T258 — store-API smoke proof of the update-path wiring: a field-only
    // patch may not empty blockingQuestions on an already-mixed handoff.
    it("rejects an update that empties blockingQuestions on a mixed handoff (D39 update-path)", async () => {
      const store = await factory.build();
      try {
        const m = await store.createMilestone({ title: "update-path handoff" });
        const created = await store.createItem(HANDOFFS_LEDGER, m.id, {
          status: "mixed",
          fields: { summary: "x", blockingQuestions: ["Q1"] },
        });
        await expect(
          store.updateItem(HANDOFFS_LEDGER, created.id, {
            fields: { blockingQuestions: [] },
          }),
        ).rejects.toThrow(SchemaValidationError);
        // The original item is unmodified — the failed update did not commit.
        const fetched = store.fetchItem(HANDOFFS_LEDGER, created.id);
        expect(fetched.fields["blockingQuestions"]).toEqual(["Q1"]);
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

// ---------------------------------------------------------------------------
// T255 (a) — HANDOFFS_SCHEMA explicit `user-action-required` token assertions.
// These tests would have failed before T245 (the token did not exist).
// ---------------------------------------------------------------------------

describe("T255(a): HANDOFFS_SCHEMA user-action-required token", () => {
  it("statusValues contains user-action-required", () => {
    expect(HANDOFFS_SCHEMA.statusValues).toContain("user-action-required");
  });

  it("terminalStatuses contains user-action-required", () => {
    expect(HANDOFFS_SCHEMA.terminalStatuses).toContain("user-action-required");
  });

  it("transitions has a user-action-required entry that is an empty array", () => {
    expect(HANDOFFS_SCHEMA.transitions).toBeDefined();
    const transitions = HANDOFFS_SCHEMA.transitions!;
    expect(Object.prototype.hasOwnProperty.call(transitions, "user-action-required")).toBe(true);
    expect(transitions["user-action-required"]).toEqual([]);
  });

  it("terminal-check via terminalStatuses membership reports user-action-required as terminal", () => {
    // The schema-level terminal check is: terminalStatuses.includes(status).
    expect(HANDOFFS_SCHEMA.terminalStatuses.includes("user-action-required")).toBe(true);
  });

  it("the other four tokens (drained, answers-required, mixed, illness-detected) also satisfy the same assertions", () => {
    const others = ["drained", "answers-required", "mixed", "illness-detected"] as const;
    for (const token of others) {
      expect(HANDOFFS_SCHEMA.statusValues).toContain(token);
      expect(HANDOFFS_SCHEMA.terminalStatuses).toContain(token);
      expect(HANDOFFS_SCHEMA.transitions![token]).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// T255 (b) — Four-table grep-invariant: all four cq command-prompt advance.md
// files must contain the literal token `user-action-required`. This guards
// against a future prompt edit silently dropping the status row.
//
// Path resolution: cq-assets lives at nix/pkg/cq-assets/ in the repo root.
// From this test file's dir (nix/pkg/cq-ledgers/packages/ledger/test/), that
// is four levels up (../../../../) then into cq-assets/commands/cq/.
// ---------------------------------------------------------------------------

describe("T255(b): four-table prompt grep invariant — user-action-required", () => {
  const cqCommandsRoot = path.resolve(import.meta.dir, "../../../../cq-assets/commands/cq");

  const promptFiles = [
    path.join(cqCommandsRoot, "advance.md"),
    path.join(cqCommandsRoot, "plan", "advance.md"),
    path.join(cqCommandsRoot, "investigate", "advance.md"),
    path.join(cqCommandsRoot, "implement", "advance.md"),
  ];

  for (const filePath of promptFiles) {
    const label = filePath.replace(/.*\/commands\/cq\//, "cq/");
    it(`${label} contains the literal token user-action-required`, async () => {
      const text = await readFile(filePath, "utf8");
      expect(text).toContain("user-action-required");
    });
  }
});

// ---------------------------------------------------------------------------
// T264 — D39 stop-discipline grep-invariant: all four cq command-prompt
// advance.md files must contain BOTH D39 marker tokens. This is the
// regression guard ensuring a future prompt edit cannot silently drop the
// turn-vs-run + euphemism-blocklist enforcement.
//
// Token set 1 (turn-vs-run clause): `NOT a run-stop`
// Token set 2 (euphemism self-check): `predicates still TRUE`
//
// 2 token sets × 4 files = 8 cells; all must be present.
// ---------------------------------------------------------------------------

describe("T264: D39 stop-discipline grep invariant — turn-vs-run + euphemism-blocklist", () => {
  const cqCommandsRoot = path.resolve(import.meta.dir, "../../../../cq-assets/commands/cq");

  const promptFiles = [
    path.join(cqCommandsRoot, "advance.md"),
    path.join(cqCommandsRoot, "plan", "advance.md"),
    path.join(cqCommandsRoot, "investigate", "advance.md"),
    path.join(cqCommandsRoot, "implement", "advance.md"),
  ];

  const markers: Array<{ token: string; description: string }> = [
    { token: "NOT a run-stop", description: "turn-vs-run clause marker" },
    { token: "predicates still TRUE", description: "euphemism-blocklist self-check marker" },
  ];

  for (const filePath of promptFiles) {
    for (const { token, description } of markers) {
      const label = filePath.replace(/.*\/commands\/cq\//, "cq/");
      it(`${label} contains the ${description}: "${token}"`, async () => {
        const text = await readFile(filePath, "utf8");
        expect(text).toContain(token);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// D43 — prompt-hardening grep-invariants for T301-T304: each marker is
// asserted against exactly ONE file (file-scoped, not a repo-wide grep).
//
// Cell 1 (T301): implement-worker.md — worktree-confinement Boundary.
//   Marker: `MUST NOT run git against the main checkout`
// Cell 2 (T302): plan/advance.md — commit-after-planning-lock checkpoint.
//   Marker: `after the planning-lock`
// Cell 3 (T303): implement/advance.md — commit-after-every-merge-back checkpoint.
//   Marker: `after every task merge-back`
// Cell 4 (T304): advance.md — chained-path clause (absent from implement/advance.md,
//   confirming file-specificity).
//   Marker: `it fires even when the implement sub-flow runs chained under`
//
// Path resolution: same pattern as T255/T264 above.
//   cq-assets/commands/cq/  → path.resolve(import.meta.dir, "../../../../cq-assets/commands/cq")
//   cq-assets/agents/       → path.resolve(import.meta.dir, "../../../../cq-assets/agents")
// ---------------------------------------------------------------------------

describe("D43: T301-T304 prompt-hardening grep invariants — file-scoped", () => {
  const cqCommandsRoot = path.resolve(import.meta.dir, "../../../../cq-assets/commands/cq");
  const cqAgentsRoot = path.resolve(import.meta.dir, "../../../../cq-assets/agents");

  it("D43/T301: implement-worker.md contains worktree-confinement Boundary marker", async () => {
    const text = await readFile(path.join(cqAgentsRoot, "implement-worker.md"), "utf8");
    expect(text).toContain("MUST NOT run git against the main checkout");
  });

  it("D43/T302: plan/advance.md contains commit-after-planning-lock checkpoint marker", async () => {
    const text = await readFile(path.join(cqCommandsRoot, "plan", "advance.md"), "utf8");
    expect(text).toContain("after the planning-lock");
  });

  it("D43/T303: implement/advance.md contains commit-after-every-merge-back checkpoint marker", async () => {
    const text = await readFile(path.join(cqCommandsRoot, "implement", "advance.md"), "utf8");
    expect(text).toContain("after every task merge-back");
  });

  it("D43/T304: advance.md contains chained-path clause marker (file-specific, absent from implement/advance.md)", async () => {
    const text = await readFile(path.join(cqCommandsRoot, "advance.md"), "utf8");
    expect(text).toContain("it fires even when the implement sub-flow runs chained under");
  });
});

// ---------------------------------------------------------------------------
// G38 item 1a — prompt-hardening grep-invariants: post-done cleanup + start
// sweep markers in the source files, and all three markers present in the
// committed gen.ts (freshness guard).
//
// Sources checked:
//   cq-assets/commands/cq/implement/advance.md  — two markers
//   cq-assets/agents/implement-worker.md        — one marker
//   packages/ledger-web/src/agentsCatalogue.gen.ts — all three (gen guard)
// ---------------------------------------------------------------------------

describe("G38 item 1a prompt-hardening grep invariants — file-scoped", () => {
  const cqCommandsRoot = path.resolve(import.meta.dir, "../../../../cq-assets/commands/cq");
  const cqAgentsRoot = path.resolve(import.meta.dir, "../../../../cq-assets/agents");
  const genTsPath = path.resolve(import.meta.dir, "../../ledger-web/src/agentsCatalogue.gen.ts");

  it("G38-1a: implement/advance.md contains post-done-cleanup marker", async () => {
    const text = await readFile(path.join(cqCommandsRoot, "implement", "advance.md"), "utf8");
    expect(text).toContain("G38-1a-post-done-cleanup");
  });

  it("G38-1a: implement/advance.md contains start-sweep marker", async () => {
    const text = await readFile(path.join(cqCommandsRoot, "implement", "advance.md"), "utf8");
    expect(text).toContain("G38-1a-start-sweep");
  });

  it("G38-1a: implement-worker.md contains worker-ephemeral marker", async () => {
    const text = await readFile(path.join(cqAgentsRoot, "implement-worker.md"), "utf8");
    expect(text).toContain("G38-1a-worker-ephemeral");
  });

  it("G38-1a: agentsCatalogue.gen.ts contains all three markers (freshness guard)", async () => {
    const text = await readFile(genTsPath, "utf8");
    expect(text).toContain("G38-1a-post-done-cleanup");
    expect(text).toContain("G38-1a-start-sweep");
    expect(text).toContain("G38-1a-worker-ephemeral");
  });
});

// ---------------------------------------------------------------------------
// T335 — ideas ledger (Q188): schema shape, bootstrap presence, the
// open/postponed/planned/discarded lifecycle (incl. illegal-transition guard),
// and the M-AMBIENT flat-list attachment model (no per-idea user milestone).
// ---------------------------------------------------------------------------

describe("T335: IDEAS_SCHEMA shape", () => {
  it("statusValues are exactly open, planned, discarded, postponed", () => {
    expect(IDEAS_SCHEMA.statusValues).toEqual(["open", "planned", "discarded", "postponed"]);
  });

  it("terminalStatuses are exactly planned + discarded", () => {
    expect(IDEAS_SCHEMA.terminalStatuses).toEqual(["planned", "discarded"]);
  });

  it("idPrefix is I", () => {
    expect(IDEAS_SCHEMA.idPrefix).toBe("I");
  });

  it("declares exactly two fields: title (required), description (optional)", () => {
    expect(Object.keys(IDEAS_SCHEMA.fields).sort()).toEqual(["description", "title"]);
    expect(IDEAS_SCHEMA.fields["title"]).toEqual({ type: "string", required: true });
    expect(IDEAS_SCHEMA.fields["description"]).toEqual({ type: "string", required: false });
  });

  it("declares NO required milestone field beyond the ambient attachment", () => {
    // The ambient attachment is supplied by the store (createItem's milestoneId
    // argument), NOT by a schema field. No field named `milestone(s)` exists,
    // and the only required field is `title`.
    expect(IDEAS_SCHEMA.fields["milestone"]).toBeUndefined();
    expect(IDEAS_SCHEMA.fields["milestones"]).toBeUndefined();
    const required = Object.entries(IDEAS_SCHEMA.fields)
      .filter(([, f]) => f.required)
      .map(([name]) => name);
    expect(required).toEqual(["title"]);
  });

  it("transitions: planned + discarded are terminal (empty); open + postponed route correctly", () => {
    const t = IDEAS_SCHEMA.transitions!;
    expect(t["open"]).toEqual(["planned", "discarded", "postponed"]);
    expect(t["postponed"]).toEqual(["open", "planned", "discarded"]);
    expect(t["planned"]).toEqual([]);
    expect(t["discarded"]).toEqual([]);
  });

  it("CANONICAL_LEDGERS includes ideas", () => {
    expect(CANONICAL_LEDGERS.map((c) => c.name)).toContain(IDEAS_LEDGER);
  });
});

describe("T335: ideas ledger — fresh FsLedgerStore bootstrap + lifecycle + flat M-AMBIENT attachment", () => {
  it("bootstraps `ideas` with the expected schema and exercises the full lifecycle", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-ideas-"));
    dirs.push(dir);
    const store = new FsLedgerStore({ root: dir });
    await store.init();
    try {
      // (1) the ledger exists with the canonical schema after a fresh bootstrap.
      expect(store.enumerate()).toContain(IDEAS_LEDGER);

      // (2) create an idea under the ambient M-AMBIENT with title+description,
      //     status open.
      const idea = await store.createItem(IDEAS_LEDGER, MILESTONES_AMBIENT_ID, {
        status: "open",
        fields: { title: "Adopt the ideas ledger", description: "Capture loose ideas here" },
      });
      expect(idea.id).toBe("I1");
      expect(idea.status).toBe("open");
      expect(idea.milestoneId).toBe(MILESTONES_AMBIENT_ID);
      expect(idea.fields["title"]).toBe("Adopt the ideas ledger");
      expect(idea.fields["description"]).toBe("Capture loose ideas here");

      // (3a) open → postponed → open (reversible hold).
      const postponed = await store.updateItem(IDEAS_LEDGER, idea.id, { status: "postponed" });
      expect(postponed.status).toBe("postponed");
      const reopened = await store.updateItem(IDEAS_LEDGER, idea.id, { status: "open" });
      expect(reopened.status).toBe("open");

      // (3b) open → planned (consume-an-idea; terminal).
      const planned = await store.updateItem(IDEAS_LEDGER, idea.id, { status: "planned" });
      expect(planned.status).toBe("planned");

      // (4) illegal transitions throw. planned is terminal → planned→open illegal.
      await expect(
        store.updateItem(IDEAS_LEDGER, idea.id, { status: "open" }),
      ).rejects.toThrow(InvalidTransitionError);

      // discarded is terminal → discarded→open illegal. Use a second idea.
      const idea2 = await store.createItem(IDEAS_LEDGER, MILESTONES_AMBIENT_ID, {
        status: "open",
        fields: { title: "An idea to discard" },
      });
      await store.updateItem(IDEAS_LEDGER, idea2.id, { status: "discarded" });
      await expect(
        store.updateItem(IDEAS_LEDGER, idea2.id, { status: "open" }),
      ).rejects.toThrow(InvalidTransitionError);
    } finally {
      await store.dispose();
    }
  });

  it("ideas attach ONLY to the ambient M-AMBIENT (no user milestone) and enumerate as a FLAT list", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-ideas-flat-"));
    dirs.push(dir);
    const store = new FsLedgerStore({ root: dir });
    await store.init();
    try {
      // A user milestone exists, but ideas must NOT attach to it.
      const userMilestone = await store.createMilestone({ title: "a user milestone" });

      const a = await store.createItem(IDEAS_LEDGER, MILESTONES_AMBIENT_ID, {
        status: "open",
        fields: { title: "idea A" },
      });
      const b = await store.createItem(IDEAS_LEDGER, MILESTONES_AMBIENT_ID, {
        status: "open",
        fields: { title: "idea B" },
      });

      // Each created idea's milestone association is the ambient one ONLY.
      expect(a.milestoneId).toBe(MILESTONES_AMBIENT_ID);
      expect(b.milestoneId).toBe(MILESTONES_AMBIENT_ID);

      // The user milestone carries NO ideas (flat-list lives under M-AMBIENT).
      const userGrouped = store.listMilestoneItems(userMilestone.id);
      expect(userGrouped[IDEAS_LEDGER]).toBeUndefined();

      // Under M-AMBIENT the ideas enumerate as a single FLAT array (no nesting,
      // no per-idea sub-milestone) — exactly the goals/T83 pattern.
      const ambientGrouped = store.listMilestoneItems(MILESTONES_AMBIENT_ID);
      const ideaList = ambientGrouped[IDEAS_LEDGER];
      expect(Array.isArray(ideaList)).toBe(true);
      expect(ideaList!.map((i) => i.id).sort()).toEqual(["I1", "I2"]);
    } finally {
      await store.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// T340 — /cq:plan idea-id grammar (Q188): structural grep-invariants over the
// command-prompt markdown. plan.md must document (1) the I-id token grammar
// (the /^I\d+$/ rule) and the EITHER-idea-ids-OR-free-text (no-interleave) rule,
// (2) the named consume-an-idea sub-procedure with its four steps
// (fetch → seed verbatim → bidirectional ledgerRefs link → idea→planned), and
// (3) one-goal-per-idea stated explicitly. follow-up.md must REFERENCE the
// sub-procedure (DRY) rather than re-derive it.
//
// Path resolution mirrors T255/T264/D43 above: cq-assets lives four levels up.
// ---------------------------------------------------------------------------

describe("T340: /cq:plan idea-id grammar — structural grep invariants", () => {
  const cqCommandsRoot = path.resolve(import.meta.dir, "../../../../cq-assets/commands/cq");
  const planMd = path.join(cqCommandsRoot, "plan.md");
  const followUpMd = path.join(cqCommandsRoot, "plan", "follow-up.md");

  it("plan.md documents the I-id token grammar section (/^I\\d+$/)", async () => {
    const text = await readFile(planMd, "utf8");
    expect(text).toContain("## Argument grammar");
    expect(text).toContain("/^I\\d+$/");
  });

  it("plan.md states the EITHER-idea-ids-OR-free-text, no-interleave rule", async () => {
    const text = await readFile(planMd, "utf8");
    expect(text).toContain("no interleave");
    expect(text).toContain("mutually-exclusive");
  });

  it("plan.md defines the named consume-an-idea sub-procedure with its four steps", async () => {
    const text = await readFile(planMd, "utf8");
    expect(text).toContain("## Consume-an-idea sub-procedure");
    // (i) fetch the idea
    expect(text).toContain('fetch_item("ideas", I)');
    // (ii) seed description VERBATIM from the idea
    expect(text).toContain("VERBATIM from the idea");
    // (iii) bidirectional ledgerRefs link (goal↔idea)
    expect(text).toContain('"ideas:<I>"');
    expect(text).toContain('"goals:<G>"');
    // (iv) idea → planned
    expect(text).toContain('update_item("ideas", I, status: "planned")');
  });

  it("plan.md states one-goal-per-idea explicitly", async () => {
    const text = await readFile(planMd, "utf8");
    expect(text).toContain("ONE goal PER idea");
  });

  it("follow-up.md references the consume-an-idea sub-procedure (DRY, not re-derived)", async () => {
    const text = await readFile(followUpMd, "utf8");
    expect(text).toContain("Consume-an-idea sub-procedure");
    expect(text).toContain("plan.md");
  });
});

// ---------------------------------------------------------------------------
// T342 — /cq:plan:follow-up idea-ids grammar (G35 I01 …): structural grep
// invariants over follow-up.md (and its committed gen.ts embedding). follow-up.md
// must document (1) the argument grammar — first token = target goal id, the
// remaining /^I\d+$/ tokens = idea-ids (vs free text, no interleave) — and that
// each idea's title+description is APPENDED as new scope onto the existing goal
// via the pre-existing follow-up re-open path; (2) it must REFERENCE (by
// name/anchor) plan.md's shared §Consume-an-idea sub-procedure for the link +
// idea→planned transition, NOT re-derive that procedure text. The committed
// agentsCatalogue.gen.ts must carry the same grammar markers (freshness guard:
// `bun run gen-agents` was re-run after editing the asset).
// ---------------------------------------------------------------------------

describe("T342: /cq:plan:follow-up idea-ids grammar — structural grep invariants", () => {
  const cqCommandsRoot = path.resolve(import.meta.dir, "../../../../cq-assets/commands/cq");
  const followUpMd = path.join(cqCommandsRoot, "plan", "follow-up.md");
  const genTsPath = path.resolve(import.meta.dir, "../../ledger-web/src/agentsCatalogue.gen.ts");

  it("follow-up.md documents the <goalId>-then-idea-ids argument grammar (first token = goal id; remaining /^I\\d+$/ = ideas)", async () => {
    const text = await readFile(followUpMd, "utf8");
    expect(text).toContain("## Argument grammar");
    // first token is the target goal id
    expect(text).toContain("target goal id");
    // remaining tokens are idea-ids by the /^I\d+$/ rule
    expect(text).toContain("/^I\\d+$/");
    // mutually-exclusive with free text, no interleave (mirrors plan.md)
    expect(text).toContain("mutually-exclusive");
    expect(text).toContain("no interleave");
  });

  it("follow-up.md appends each idea's title+description as new scope via the existing re-open path", async () => {
    const text = await readFile(followUpMd, "utf8");
    // each idea's title + description is appended as new scope
    expect(text).toContain("title + description");
    expect(text).toContain("new scope");
    // reusing the pre-existing follow-up re-open path (not a new re-open semantics)
    expect(text).toContain("re-open path");
    // appends onto the SAME existing target goal G (not a new goal)
    expect(text).toContain("Consume-an-idea-into-this-goal");
  });

  it("follow-up.md references plan.md's shared consume-an-idea sub-procedure for the link + idea→planned transition (DRY, not re-derived)", async () => {
    const text = await readFile(followUpMd, "utf8");
    // cross-reference by name/anchor to plan.md's canonical sub-procedure
    expect(text).toContain("§Consume-an-idea sub-procedure defined in `/cq:plan` (`plan.md`)");
    // the bidirectional link refs + the idea→planned flip are mentioned as the
    // reused (not re-derived) steps
    expect(text).toContain("goals:<G>");
    expect(text).toContain("ideas:<I>");
    expect(text).toContain('update_item("ideas", I, status: "planned")');
    // explicit DRY statement: do not re-derive the sub-procedure here
    expect(text).toContain("DRY");
  });

  it("free-text follow-up is still supported", async () => {
    const text = await readFile(followUpMd, "utf8");
    expect(text).toContain("Free-text mode");
  });

  it("agentsCatalogue.gen.ts carries the follow-up grammar markers (freshness guard)", async () => {
    const text = await readFile(genTsPath, "utf8");
    expect(text).toContain("Argument grammar");
    expect(text).toContain("Consume-an-idea-into-this-goal");
    expect(text).toContain("target goal id");
  });
});

// ---------------------------------------------------------------------------
// T345 — every DISPATCHED-SUBAGENT role is wired through the typed prompt
// catalog (G41). Two structural grep-invariants over the cq-assets markdown:
//
// (1) NO-DUPLICATED-PROSE-ioSchema: a dispatched role's hand-authored
//     `## Catalogue` `ioSchema:` block must NOT restate the JSON shape its TYPED
//     inputSchema/outputSchema (the @cq/config sidecar) now supersedes. The
//     removed prose took the form of a JSON-object literal listing the schema's
//     field names (e.g. `output JSON: {taskId, status, ...}`); the invariant
//     forbids any `ioSchema` line containing such a brace-delimited field-list,
//     and REQUIRES the typed-contract POINTER line in its place. Scoped to the 7
//     dispatched roles ONLY — orchestrator-command roles carry no typed schema,
//     so their prose ioSchema (which may still restate a JSON shape) is exempt.
//
// (2) EACH-DISPATCH-SITE documents the validate-in → run → validate-out flow for
//     its dispatched subagents, MIRRORING the T344 plan-advance proof: each of
//     the three enumerated dispatch-site command files carries a
//     `Catalog-driven dispatch (G41 — <role>)` marker per subagent it dispatches.
//
// Path resolution mirrors the T255/T264/D43/T340 blocks above.
// ---------------------------------------------------------------------------

describe("T345: dispatched roles wired through the typed prompt catalog — grep invariants", () => {
  const cqAgentsRoot = path.resolve(import.meta.dir, "../../../../cq-assets/agents");
  const cqCommandsRoot = path.resolve(import.meta.dir, "../../../../cq-assets/commands/cq");

  /** The 7 dispatched-subagent role asset basenames (non-null agentTierKey). */
  const dispatchedRoles = [
    "plan-advance",
    "plan-reviewer",
    "implement-worker",
    "implement-reviewer",
    "implement-conflict-resolver",
    "investigate-explorer",
    "investigate-prober",
  ];

  /** The literal typed-contract pointer line authored in place of the duplicated shape. */
  const pointerMarker =
    "see the role's inputSchema/outputSchema in the prompt catalog";

  /**
   * Extract the `- "…"` items of a role asset's `## Catalogue` `ioSchema:` list.
   * Pure string slice of the fenced-yaml block (same shape parseCatalogueBlock
   * reads), so the test depends on nothing but the asset text.
   */
  function extractIoSchemaLines(markdown: string): string[] {
    const fence = markdown.match(/## Catalogue\s*```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```/);
    if (!fence) throw new Error("no ## Catalogue fenced block");
    const yaml = fence[1] ?? "";
    const lines = yaml.split(/\r?\n/);
    const out: string[] = [];
    let inIoSchema = false;
    for (const line of lines) {
      if (/^ioSchema:\s*$/.test(line)) {
        inIoSchema = true;
        continue;
      }
      // A new top-level key ends the ioSchema list.
      if (inIoSchema && /^[A-Za-z][A-Za-z0-9_]*:\s*$/.test(line)) break;
      if (inIoSchema) {
        const item = line.match(/^\s*-\s+(.*\S)\s*$/);
        if (item) out.push(item[1]!);
      }
    }
    return out;
  }

  for (const role of dispatchedRoles) {
    it(`${role}.md ioSchema carries the typed-contract pointer (not a duplicated JSON shape)`, async () => {
      const text = await readFile(path.join(cqAgentsRoot, `${role}.md`), "utf8");
      const ioLines = extractIoSchemaLines(text);
      expect(ioLines.length).toBeGreaterThan(0);
      // The pointer line is present.
      expect(ioLines.some((l) => l.includes(pointerMarker))).toBe(true);
      // No line restates the typed JSON shape: a brace-delimited, comma-bearing
      // field-list (e.g. `{taskId, status, resultCommit, …}`) is exactly the
      // prose the typed schema now supersedes. The pointer line has no braces.
      const shapeLiteral = /\{[^}]*,[^}]*\}/;
      for (const l of ioLines) {
        expect(shapeLiteral.test(l)).toBe(false);
      }
    });
  }

  // Each enumerated dispatch site documents the catalog-driven dispatch for the
  // subagent(s) it spawns (mirroring T344's plan-advance block). plan-advance's
  // own block was authored in T344; T345 adds the siblings.
  const dispatchSiteMarkers: Array<{ file: string; roles: string[] }> = [
    { file: path.join(cqCommandsRoot, "plan", "advance.md"), roles: ["plan-advance", "plan-reviewer"] },
    {
      file: path.join(cqCommandsRoot, "implement", "advance.md"),
      roles: ["implement-worker", "implement-reviewer", "implement-conflict-resolver"],
    },
    {
      file: path.join(cqCommandsRoot, "investigate", "advance.md"),
      roles: ["investigate-explorer", "investigate-prober"],
    },
  ];

  for (const { file, roles } of dispatchSiteMarkers) {
    const label = file.replace(/.*\/commands\/cq\//, "cq/");
    for (const role of roles) {
      it(`${label} documents catalog-driven dispatch for ${role}`, async () => {
        const text = await readFile(file, "utf8");
        // plan-advance's own block was authored by T344 with the original
        // `(G41, Q185 steps a–g) — the proof path` marker (T345 must NOT retouch
        // it); the sibling roles T345 adds carry the uniform `(G41 — <role>)`
        // site marker. Either marker form proves the block is present.
        expect(
          text.includes(`Catalog-driven dispatch (G41 — ${role})`) ||
            (role === "plan-advance" && text.includes("Catalog-driven dispatch (G41, Q185 steps a–g)")),
        ).toBe(true);
        // and the validate-in / run / validate-out tool calls for that role.
        expect(text).toContain(`fetch_prompt("${role}")`);
        expect(text).toContain(`validate_input("${role}", input)`);
        expect(text).toContain(`validate_output("${role}",`);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// T365 — G44 advance.md grep-invariant: the top-level advance.md must contain
// the five load-bearing G44 enforcement strings so they cannot silently regress.
//
// Pinned strings (read from the current advance.md; mirrors D39's T264 guard):
//   (1) §Bootstrap marker-drop: the `touch` command that drops the run-active
//       sentinel file at run start.
//   (2) §The one write marker-unlink: the `rm -f` command that removes the
//       sentinel after the terminal handoff is written.
//   (3) §Stop-condition gate external-signal escape format: `external-signal:`
//       (the prefix the gate greps for to allow a genuine context-exhaustion stop).
//   (4) §Stop-condition gate Stop-hook cross-reference: `claudeStopGateHook`
//       (the hook name that mechanically enforces the gate for Claude Code runs).
//   (5) §Bootstrap derive_predicates detection instruction:
//       `mcp__ledger__derive_predicates` (the authoritative predicate-source tool).
//
// 5 tokens × 1 file = 5 cells; all must be present.
// Path resolution mirrors T255/T264/D43/T340/T345: cq-assets is four levels up.
// ---------------------------------------------------------------------------

describe("T365: G44 advance.md grep-invariant — marker-lifecycle + external-signal + derive_predicates", () => {
  const cqCommandsRoot = path.resolve(import.meta.dir, "../../../../cq-assets/commands/cq");
  const advanceMd = path.join(cqCommandsRoot, "advance.md");

  const markers: Array<{ token: string; description: string }> = [
    {
      token: 'touch "${XDG_RUNTIME_DIR:-/tmp}/cq-advance-active-$CLAUDE_CODE_SESSION_ID"',
      description: "§Bootstrap marker-drop (touch sentinel at run start)",
    },
    {
      token: 'rm -f "${XDG_RUNTIME_DIR:-/tmp}/cq-advance-active-$CLAUDE_CODE_SESSION_ID"',
      description: "§The one write marker-unlink (rm -f sentinel after terminal handoff)",
    },
    {
      token: "external-signal:",
      description: "§Stop-condition gate external-signal escape format",
    },
    {
      token: "claudeStopGateHook",
      description: "§Stop-condition gate Stop-hook cross-reference",
    },
    {
      token: "mcp__ledger__derive_predicates",
      description: "§Bootstrap derive_predicates detection instruction",
    },
  ];

  for (const { token, description } of markers) {
    it(`cq/advance.md contains ${description}: "${token}"`, async () => {
      const text = await readFile(advanceMd, "utf8");
      expect(text).toContain(token);
    });
  }
});
