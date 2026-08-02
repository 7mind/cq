/**
 * T978 (goal G94, milestone M316) — server-side dispatch-input assembly AGAINST
 * A REAL LEDGER, and the byte-equality proof that the cutover loses nothing.
 *
 * The claim T978 makes is a CUTOVER claim: prepare assembling the role input
 * server-side from refs must produce EXACTLY what the parent produced while it
 * acted as courier. So the load-bearing test here is not "the assembler returns
 * something plausible" — it is:
 *
 *   the input assembled from `{ roleId, taskId, round, priorReviewId, guidance }`
 *   is BYTE-EQUAL to what the parent previously rendered for the same task and
 *   round.
 *
 * The two sides are deliberately built by DIFFERENT code:
 *
 *   - the CUTOVER side calls `assembleDispatchInput` (in `@cq/config`) with refs
 *     only, over a {@link LedgerNarrativeSource} adapter on a real
 *     `InMemoryLedgerStore` seeded with the canonical ledgers;
 *   - the LEGACY side is {@link renderParentDispatchInput} below — a faithful
 *     transcription of the pre-cutover parent behaviour mandated by
 *     `commands/cq/implement/advance.md` §2 ("The prompt MUST carry: the task id
 *     + verbatim `headline`/`description`/`acceptance`, the branch
 *     `implement/<taskId>` and base commit, and (on a re-dispatch) the prior
 *     round's `criticism[]`"), composed against the field literal the T975
 *     inventory pins for this edge, and reading its narrative off the
 *     `projection: "full"` ITEMS the parent held in its own context. It shares no
 *     code with the assembler and spells its folded-guidance lines out
 *     literally, so a change to either side breaks the comparison.
 *
 * Negative controls accompany the equality assertions, so the comparison cannot
 * rot into a tautology: a single altered narrative byte, a dropped field, and a
 * reordered criticism list must all break it.
 *
 * The suite also pins T975's saving against regression from the CHILD side: the
 * `gen-agents`-baked `agents/<role>.md` definition — the artifact the harness
 * injects at the child's system boundary — must carry the role prompt and
 * contain NO role-prompt retrieval, for every dispatched role.
 *
 * This file lives in `@cq/ledger` because `@cq/ledger` depends on `@cq/config`
 * (never the reverse), so this is the lowest package that can see BOTH the real
 * store and the assembly contract. Path resolution mirrors the T975 block in
 * cq-parent-dispatch-inventory.test.ts: cq-assets is four levels up.
 */

import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ASSEMBLED_NARRATIVE_FIELDS,
  DISPATCHED_ROLE_SIDECARS,
  DISPATCH_INPUT_REFS_SCHEMA,
  DISPATCH_OVERLAY_REGISTRY,
  NATIVE_CLAUDE_CHILD_RETRIEVAL,
  ROLE_PROMPT_RETRIEVAL_OPERATIONS,
  assembleDispatchInput,
  assertNoRolePromptRetrieval,
  canonicalDispatchInputBytes,
  dispatchInputDigest,
  validateAgainstSchema,
  type DispatchInputAssembled,
  type DispatchInputAssembly,
  type DispatchInputRefs,
  type DispatchJSONValue,
  type DispatchNarrativeItem,
  type DispatchNarrativeSource,
  type ParentGuidance,
} from "@cq/config";
import { InMemoryLedgerStore, type Item } from "../src/index.js";

const ASSETS_ROOT = path.resolve(import.meta.dir, "../../../../cq-assets");
const PROJECT_KEY = "cq-t978-fixture";

const TASK_HEADLINE = "Assemble dispatch input server-side from refs";
const TASK_DESCRIPTION = [
  "The parent still reads task narrative into its own context purely to render",
  "it into the dispatch prompt. Prepare accepts refs and assembles the typed",
  "role input server-side instead.",
].join("\n");
const TASK_ACCEPTANCE =
  "A refs form is accepted; an inline-narrative form is rejected; the assembled input is byte-equal to the parent render.";
const REVIEW_CRITICISM = [
  "Mutation-test every guard and report the table.",
  "Prove the byte equality against the ledger, not against yourself.",
] as const;
const QUESTION_TEXT = "Where should an answered question's text land in the worker input?";
const QUESTION_ANSWER = "Fold it into priorCriticism[]; do not widen the role sidecar.";
const OPERATOR_NOTE = "Reproduce with a failing test before touching the fix.";

const COORDINATES = {
  worktreePath: "/tmp/wt-T978",
  baseCommit: "cd711a055f823e45a24393db284aa1b35e21afd9",
} as const;
const STARTING_COMMIT = "ef8119d2912390345fb79861e6dbf53648f65e89";

/**
 * The `@cq/config` narrative PORT, adapted onto a real ledger store. The store's
 * `fetchItem` throws for a missing id; the port's contract is `undefined`, so
 * translating that is the adapter's job — which is what turns an unresolvable ref
 * into a typed pre-launch rejection instead of an exception.
 *
 * Every read is recorded, so a test can assert exactly which ledger items prepare
 * touched.
 */
class LedgerNarrativeSource implements DispatchNarrativeSource {
  readonly reads: string[] = [];

  constructor(
    readonly projectKey: string,
    private readonly store: InMemoryLedgerStore,
  ) {}

  readItem(ledger: string, id: string): DispatchNarrativeItem | undefined {
    this.reads.push(`${ledger}:${id}`);
    let item: Item;
    try {
      item = this.store.fetchItem(ledger, id);
    } catch {
      return undefined;
    }
    return { id: item.id, status: item.status, fields: item.fields };
  }
}

interface Fixture {
  readonly store: InMemoryLedgerStore;
  readonly source: LedgerNarrativeSource;
  readonly task: Item;
  readonly review: Item;
  readonly question: Item;
}

async function buildFixture(): Promise<Fixture> {
  const store = new InMemoryLedgerStore();
  await store.init();
  const milestone = await store.createMilestone({
    title: "M316 — compact dispatch cutover",
    description: "Goal G94.",
  });
  const task = await store.createItem("tasks", milestone.id, {
    status: "wip",
    fields: {
      headline: TASK_HEADLINE,
      description: TASK_DESCRIPTION,
      acceptance: TASK_ACCEPTANCE,
    },
  });
  const review = await store.createItem("reviews", milestone.id, {
    status: "revise",
    fields: { summary: "round 1", criticism: [...REVIEW_CRITICISM] },
  });
  const question = await store.createItem("questions", milestone.id, {
    status: "answered",
    fields: { question: QUESTION_TEXT, answer: QUESTION_ANSWER },
  });
  return {
    store,
    source: new LedgerNarrativeSource(PROJECT_KEY, store),
    task,
    review,
    question,
  };
}

const fixture = await buildFixture();

/** A fresh recorder over the same store, so one test's read log is isolated. */
function recordingSource(): LedgerNarrativeSource {
  return new LedgerNarrativeSource(PROJECT_KEY, fixture.store);
}

function refsFor(overrides: Partial<DispatchInputRefs> = {}): DispatchInputRefs {
  return {
    roleId: "implement-worker",
    surface: "claude",
    projectKey: PROJECT_KEY,
    taskId: fixture.task.id,
    coordinates: { ...COORDINATES, branch: `implement/${fixture.task.id}` },
    round: 0,
    startingCommit: STARTING_COMMIT,
    ...overrides,
  };
}

function assemble(refs: DispatchInputRefs): DispatchInputAssembly {
  return assembleDispatchInput(refs, {
    source: fixture.source,
    registry: DISPATCH_OVERLAY_REGISTRY,
  });
}

function assembledOf(result: DispatchInputAssembly): DispatchInputAssembled {
  if (!result.accepted) {
    throw new Error(`expected an assembly, got ${result.reason}: ${result.detail}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// The LEGACY parent render — the pre-cutover behaviour, transcribed
// ---------------------------------------------------------------------------

/**
 * What the PARENT used to render, from the `projection: "full"` items it held in
 * its own context. Field set verbatim from the T975 inventory's implement-worker
 * literal: `{ taskId, headline, description, acceptance, worktreePath, branch,
 * baseCommit, round, startingCommit, priorCriticism? }`.
 *
 * `foldedGuidanceLines` are supplied by the CALLER, spelled out literally, which
 * is how the parent produced them — this file deliberately does NOT import the
 * assembler's fold helpers, so the folded wording is pinned from outside.
 */
function renderParentDispatchInput(
  task: Item,
  refs: {
    readonly coordinates: DispatchInputRefs["coordinates"];
    readonly round: number;
    readonly startingCommit: string;
  },
  priorReview?: Item,
  foldedGuidanceLines: readonly string[] = [],
): Record<string, DispatchJSONValue> {
  const criticism: string[] = [];
  if (priorReview !== undefined) {
    const stored = priorReview.fields.criticism;
    if (Array.isArray(stored)) {
      criticism.push(...stored);
    }
  }
  criticism.push(...foldedGuidanceLines);
  const rendered: Record<string, DispatchJSONValue> = {
    taskId: task.id,
    headline: task.fields.headline as string,
    description: task.fields.description as string,
    acceptance: task.fields.acceptance as string,
    worktreePath: refs.coordinates.worktreePath,
    branch: refs.coordinates.branch,
    baseCommit: refs.coordinates.baseCommit,
    round: refs.round,
    startingCommit: refs.startingCommit,
  };
  if (criticism.length > 0) {
    rendered.priorCriticism = criticism;
  }
  return rendered;
}

function expectByteEqual(
  assembled: DispatchInputAssembled,
  legacy: Record<string, DispatchJSONValue>,
): void {
  expect(canonicalDispatchInputBytes(assembled.input)).toEqual(canonicalDispatchInputBytes(legacy));
  expect(dispatchInputDigest(legacy)).toBe(assembled.inputDigest);
  expect(assembled.input).toEqual(legacy);
  expect(Object.keys(assembled.input as object).sort()).toEqual(Object.keys(legacy).sort());
}

describe("T978: server-side assembly is byte-equal to the pre-cutover parent render", () => {
  it("assembles a first-round input identical to what the parent used to render", () => {
    const refs = refsFor();
    const assembled = assembledOf(assemble(refs));
    const legacy = renderParentDispatchInput(fixture.task, refs);
    expectByteEqual(assembled, legacy);
    expect(assembled.assembledFrom).toEqual([`tasks:${fixture.task.id}`]);
  });

  it("assembles a re-dispatch input identical to the parent's, criticism included", () => {
    const refs = refsFor({ round: 1, priorReviewId: fixture.review.id });
    const assembled = assembledOf(assemble(refs));
    const legacy = renderParentDispatchInput(fixture.task, refs, fixture.review);
    expectByteEqual(assembled, legacy);
    expect(assembled.round).toBe(1);
    expect(
      (assembled.input as { readonly priorCriticism: readonly string[] }).priorCriticism,
    ).toEqual([...REVIEW_CRITICISM]);
  });

  it("assembles a guided re-dispatch identical to the parent's folded render", () => {
    const guidance: readonly ParentGuidance[] = [
      { kind: "answered-question", questionId: fixture.question.id },
      { kind: "operator-note", note: OPERATOR_NOTE },
    ];
    const refs = refsFor({ round: 2, priorReviewId: fixture.review.id, guidance });
    const assembled = assembledOf(assemble(refs));
    // The literal lines the parent used to compose, spelled out here.
    const legacy = renderParentDispatchInput(fixture.task, refs, fixture.review, [
      `answered question ${fixture.question.id}: ${QUESTION_ANSWER}`,
      `operator note: ${OPERATOR_NOTE}`,
    ]);
    expectByteEqual(assembled, legacy);
    expect(assembled.appliedGuidance).toEqual(guidance);
    expect(assembled.assembledFrom).toEqual([
      `tasks:${fixture.task.id}`,
      `reviews:${fixture.review.id}`,
      `questions:${fixture.question.id}`,
    ]);
  });

  // --- negative controls: the equality must be capable of FAILING ---
  it("the comparison catches a single altered narrative byte", () => {
    const refs = refsFor();
    const assembled = assembledOf(assemble(refs));
    const legacy = renderParentDispatchInput(fixture.task, refs);
    for (const field of ["headline", "description", "acceptance"] as const) {
      const altered = { ...legacy, [field]: `${legacy[field] as string} ` };
      expect(dispatchInputDigest(altered), field).not.toBe(assembled.inputDigest);
      expect(canonicalDispatchInputBytes(altered), field).not.toEqual(
        canonicalDispatchInputBytes(assembled.input),
      );
    }
  });

  it("the comparison catches a DROPPED narrative field — a lossy cutover", () => {
    const refs = refsFor();
    const assembled = assembledOf(assemble(refs));
    for (const field of ["headline", "description", "acceptance"] as const) {
      const lossy = renderParentDispatchInput(fixture.task, refs);
      delete lossy[field];
      expect(dispatchInputDigest(lossy), field).not.toBe(assembled.inputDigest);
    }
  });

  it("the comparison catches a reordered criticism list", () => {
    const refs = refsFor({ round: 1, priorReviewId: fixture.review.id });
    const assembled = assembledOf(assemble(refs));
    const reordered = renderParentDispatchInput(fixture.task, refs, {
      ...fixture.review,
      fields: { ...fixture.review.fields, criticism: [...REVIEW_CRITICISM].reverse() },
    });
    expect(dispatchInputDigest(reordered)).not.toBe(assembled.inputDigest);
  });
});

describe("T978: the parent never carries a narrative byte", () => {
  it("no refs form contains any narrative the assembled input carries", () => {
    const guidance: readonly ParentGuidance[] = [
      { kind: "answered-question", questionId: fixture.question.id },
      { kind: "operator-note", note: OPERATOR_NOTE },
    ];
    const refs = refsFor({ round: 2, priorReviewId: fixture.review.id, guidance });
    const assembled = assembledOf(assemble(refs));
    expect(assembled.parentCarriedNarrative).toBe(false);
    const refsJson = JSON.stringify(refs);
    for (const narrative of [
      TASK_HEADLINE,
      TASK_DESCRIPTION,
      TASK_ACCEPTANCE,
      QUESTION_TEXT,
      QUESTION_ANSWER,
      ...REVIEW_CRITICISM,
    ]) {
      expect(refsJson, narrative.slice(0, 32)).not.toContain(narrative);
    }
    // The operator note IS parent-authored — that is the whole point of the
    // typed bounded field — and it is the ONLY narrative-ish byte in the refs.
    expect(refsJson).toContain(OPERATOR_NOTE);
    // The refs form is exactly the pinned schema's shape.
    expect(validateAgainstSchema(DISPATCH_INPUT_REFS_SCHEMA, refs).ok).toBe(true);
  });

  it("prepare reads exactly the items it reports, and nothing more", () => {
    const isolated = recordingSource();
    const refs = refsFor({
      round: 2,
      priorReviewId: fixture.review.id,
      guidance: [{ kind: "answered-question", questionId: fixture.question.id }],
    });
    const result = assembleDispatchInput(refs, {
      source: isolated,
      registry: DISPATCH_OVERLAY_REGISTRY,
    });
    const assembled = assembledOf(result);
    expect(isolated.reads).toEqual([...assembled.assembledFrom]);
    expect(isolated.reads).toEqual([
      `tasks:${fixture.task.id}`,
      `reviews:${fixture.review.id}`,
      `questions:${fixture.question.id}`,
    ]);
  });

  it("an inline narrative field is refused against the real ledger too", () => {
    for (const field of ASSEMBLED_NARRATIVE_FIELDS) {
      const result = assembleDispatchInput(
        { ...refsFor(), [field]: "couriered by the parent" },
        { source: fixture.source, registry: DISPATCH_OVERLAY_REGISTRY },
      );
      if (result.accepted) {
        throw new Error(`expected ${field} to be refused inline`);
      }
      expect(result.reason, field).toBe("inline-narrative-courier");
    }
  });

  it("an unresolvable ref against the real ledger is a typed pre-launch rejection", () => {
    for (const [override, path] of [
      [{ taskId: "T999999" }, "refs.taskId"],
      [{ round: 1, priorReviewId: "R999999" }, "refs.priorReviewId"],
    ] as const) {
      const result = assembleDispatchInput(
        { ...refsFor(), ...override },
        { source: fixture.source, registry: DISPATCH_OVERLAY_REGISTRY },
      );
      if (result.accepted) {
        throw new Error(`expected ${path} to be unresolvable`);
      }
      expect(result.reason).toBe("unresolvable-ref");
      expect(result.path).toBe(path);
      expect(result.allocated).toBe(false);
    }
  });

  it("a cross-project ref is refused even though the task resolves here", () => {
    expect(fixture.source.readItem("tasks", fixture.task.id)).toBeDefined();
    const result = assembleDispatchInput(
      { ...refsFor(), projectKey: "a-different-repo" },
      { source: fixture.source, registry: DISPATCH_OVERLAY_REGISTRY },
    );
    if (result.accepted) {
      throw new Error("expected a cross-project rejection");
    }
    expect(result.reason).toBe("cross-project-ref");
  });
});

/** Every dispatched role's gen-agents-baked child definition, read once. */
const AGENT_DEFINITIONS: readonly (readonly [string, string])[] = await Promise.all(
  Object.keys(DISPATCHED_ROLE_SIDECARS).map(
    async (roleId) =>
      [roleId, await readFile(path.join(ASSETS_ROOT, "agents", `${roleId}.md`), "utf8")] as const,
  ),
);

describe("T978: a native Claude child performs NO role-prompt retrieval", () => {
  for (const [roleId, body] of AGENT_DEFINITIONS) {
    it(`agents/${roleId}.md carries the baked role prompt and fetches nothing`, () => {
      // The prompt IS baked in — that is why the child needs no retrieval.
      expect(body.length).toBeGreaterThan(500);
      expect(body).toContain(`name: ${roleId}`);
      const present = ROLE_PROMPT_RETRIEVAL_OPERATIONS.filter((operation) =>
        body.includes(operation),
      );
      expect(present).toEqual([]);
      expect(() => assertNoRolePromptRetrieval(`agents/${roleId}.md`, present)).not.toThrow();
    });
  }

  it("the declared native-edge retrieval profile is empty on BOTH ends", () => {
    expect(NATIVE_CLAUDE_CHILD_RETRIEVAL.childRolePromptRetrievalOperations).toEqual([]);
    expect(NATIVE_CLAUDE_CHILD_RETRIEVAL.parentRolePromptRetrievalOperations).toEqual([]);
    expect(NATIVE_CLAUDE_CHILD_RETRIEVAL.rolePromptInjectionBoundary).toBe(
      "gen-agents-baked-agent-definition",
    );
    expect(NATIVE_CLAUDE_CHILD_RETRIEVAL.childRetrievesAssembledInputByHandle).toBe(true);
  });

  it("the scanner FAILS on a reintroduced child-side prompt fetch", () => {
    const regressed = `${AGENT_DEFINITIONS[0]![1]}\n\nFirst, call \`fetch_prompt\` for your promptTemplate.\n`;
    const present = ROLE_PROMPT_RETRIEVAL_OPERATIONS.filter((operation) =>
      regressed.includes(operation),
    );
    expect(present).toEqual(["fetch_prompt", "promptTemplate"]);
    expect(() => assertNoRolePromptRetrieval("regressed-child", present)).toThrow(
      'role-prompt retrieval "fetch_prompt" is not performed on this edge',
    );
  });
});
