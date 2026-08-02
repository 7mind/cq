import { describe, expect, test } from "bun:test";
import {
  ASSEMBLED_NARRATIVE_FIELDS,
  COMPACT_DISPATCH_REFS_LAUNCH_SCHEMA,
  DISPATCHED_ROLE_SIDECARS,
  DISPATCH_INPUT_REFS_FIELDS,
  DISPATCH_INPUT_REFS_SCHEMA,
  DISPATCH_LIFECYCLE_STATES,
  DISPATCH_OVERLAY_REGISTRY,
  DISPATCH_PREPARED_SCHEMA,
  DISPATCH_PRE_LAUNCH_OUTCOME,
  DISPATCH_PRE_LAUNCH_REJECTION_REASONS,
  DISPATCH_REF_ASSEMBLY_DEFERRED,
  DISPATCH_REF_ASSEMBLY_DEFERRED_TO,
  DispatchRefAssemblyError,
  FETCH_DISPATCH_RESULT_SCHEMA,
  NATIVE_CLAUDE_CHILD_RETRIEVAL,
  PARENT_GUIDANCE_KINDS,
  PARENT_GUIDANCE_MAX_ENTRIES,
  PARENT_GUIDANCE_NOTE_MAX_LENGTH,
  PROMPT_SURFACES,
  REFS_SUPPLIED_INPUT_FIELDS,
  REF_ASSEMBLED_ROLES,
  REF_ASSEMBLER_COVERAGE,
  REF_ASSEMBLY_LEDGERS,
  ROLE_PROMPT_RETRIEVAL_OPERATIONS,
  assembleDispatchInput,
  assembledNarrativeFieldsFor,
  assertNoRolePromptRetrieval,
  canonicalDispatchInputBytes,
  classifyDispatchOutcomeTag,
  compactDispatchRefsLaunchSchemaFor,
  createDispatchOverlayRegistry,
  dispatchInputDigest,
  foldAnsweredQuestion,
  foldOperatorNote,
  isDispatchInputAssembled,
  isDispatchPreLaunchRejection,
  readNarrativeField,
  validateAgainstSchema,
  type DispatchInputAssembled,
  type DispatchInputAssembly,
  type DispatchInputRefs,
  type DispatchJSONValue,
  type DispatchNarrativeItem,
  type DispatchNarrativeSource,
  type DispatchOverlayDefinition,
  type DispatchPreLaunchRejection,
  type FetchDispatchResult,
  type ParentGuidance,
} from "@cq/config";

/** Every `Object.prototype` property name that a naive membership test admits. */
const PROTOTYPE_NAMES = [
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "__proto__",
] as const;

const PROJECT = "cq-ledger-suite";
const OTHER_PROJECT = "some-other-repo";

const TASK_HEADLINE = "Assemble dispatch input server-side from refs";
const TASK_DESCRIPTION =
  "The parent passes ids it already holds; prepare reads the narrative from the ledger.";
const TASK_ACCEPTANCE =
  "A refs form is accepted and a form carrying the assembled narrative inline is rejected.";
const REVIEW_CRITICISM = ["Mutation-test every guard.", "Cite the assembled source refs."] as const;
const QUESTION_ANSWER = "Fold the answer into priorCriticism, do not add a schema field.";
const OPERATOR_NOTE = "Prefer the failing suite before the fix.";

const COORDINATES = {
  worktreePath: "/tmp/wt-T978",
  branch: "implement/T978",
  baseCommit: "cd711a055f823e45a24393db284aa1b35e21afd9",
} as const;
const STARTING_COMMIT = "ef8119cd35569977984f6dfc2bb27a9cbace2fc4";

function item(
  id: string,
  status: string,
  fields: Readonly<Record<string, string | readonly string[]>>,
): DispatchNarrativeItem {
  return { id, status, fields };
}

/** A contract-level narrative source. The real-ledger suite lives in @cq/ledger. */
class FixtureNarrativeSource implements DispatchNarrativeSource {
  constructor(
    readonly projectKey: string,
    private readonly items: ReadonlyMap<string, DispatchNarrativeItem>,
  ) {}

  readItem(ledger: string, id: string): DispatchNarrativeItem | undefined {
    return this.items.get(`${ledger}:${id}`);
  }
}

function sourceFor(projectKey: string = PROJECT): FixtureNarrativeSource {
  return new FixtureNarrativeSource(
    projectKey,
    new Map<string, DispatchNarrativeItem>([
      [
        "tasks:T978",
        item("T978", "wip", {
          headline: TASK_HEADLINE,
          description: TASK_DESCRIPTION,
          acceptance: TASK_ACCEPTANCE,
        }),
      ],
      ["tasks:T979", item("T979", "planned", { headline: "No acceptance authored yet" })],
      ["reviews:R42", item("R42", "revise", { criticism: [...REVIEW_CRITICISM] })],
      ["reviews:R43", item("R43", "go-ahead", { summary: "clean" })],
      [
        "questions:Q301",
        item("Q301", "answered", { question: "Fold where?", answer: QUESTION_ANSWER }),
      ],
      ["questions:Q302", item("Q302", "open", { question: "Still open" })],
      // Withdrawn, yet carrying answer TEXT: only the status check refuses this
      // one, so it is what keeps that check from being a dead guard.
      [
        "questions:Q303",
        item("Q303", "withdrawn", { question: "Superseded", answer: "a stale draft answer" }),
      ],
      // Answered, but with a blank answer: only the emptiness check refuses it.
      ["questions:Q304", item("Q304", "answered", { question: "Answered blank", answer: "   " })],
      // Answered with NO answer field at all: only the absence check refuses it.
      ["questions:Q305", item("Q305", "answered", { question: "Answered, unrecorded" })],
    ]),
  );
}

const REFS: DispatchInputRefs = {
  roleId: "implement-worker",
  surface: "claude",
  projectKey: PROJECT,
  taskId: "T978",
  coordinates: COORDINATES,
  round: 0,
  startingCommit: STARTING_COMMIT,
};

function assemble(
  overrides: Readonly<Record<string, unknown>> = {},
  options: {
    readonly source?: DispatchNarrativeSource;
    readonly registry?: typeof DISPATCH_OVERLAY_REGISTRY;
    readonly overlays?: readonly { readonly overlayId: string; readonly data: DispatchJSONValue }[];
  } = {},
): DispatchInputAssembly {
  return assembleDispatchInput(
    { ...REFS, ...overrides },
    {
      source: options.source ?? sourceFor(),
      registry: options.registry ?? DISPATCH_OVERLAY_REGISTRY,
      ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    },
  );
}

function assembledOf(result: DispatchInputAssembly): DispatchInputAssembled {
  expect(isDispatchInputAssembled(result)).toBe(true);
  if (!result.accepted) {
    throw new Error(`expected an assembly, got ${result.reason}: ${result.detail}`);
  }
  return result;
}

function rejectionOf(result: DispatchInputAssembly): DispatchPreLaunchRejection {
  expect(isDispatchPreLaunchRejection(result)).toBe(true);
  if (result.accepted) {
    throw new Error("expected a pre-launch rejection");
  }
  return result;
}

// --- Type-level proofs (mutating any of these breaks tsc, not just a test) ---
type Expect<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;
type NotAssignable<A, B> = [A] extends [B] ? false : true;

/** The refs form carries NO assembled-narrative key — the parent is not a courier. */
type _RefsCarryNoNarrative = Expect<
  IsNever<
    Extract<keyof DispatchInputRefs, "headline" | "description" | "acceptance" | "priorCriticism">
  >
>;
/** An assembly result can never claim the parent carried narrative. */
type _NarrativeFlagIsPinnedFalse = Expect<
  IsNever<Extract<DispatchInputAssembled["parentCarriedNarrative"], true>>
>;
/** An assembly is not a lifecycle-bearing fetch result, nor vice versa. */
type _AssemblyIsNotAState = Expect<NotAssignable<DispatchInputAssembled, FetchDispatchResult>>;
type _StateIsNotAnAssembly = Expect<NotAssignable<FetchDispatchResult, DispatchInputAssembled>>;

const TYPE_LEVEL_PROOFS: readonly [
  _RefsCarryNoNarrative,
  _NarrativeFlagIsPinnedFalse,
  _AssemblyIsNotAState,
  _StateIsNotAnAssembly,
] = [true, true, true, true];

describe("the refs-only launch form is schema-pinned and narrative-free", () => {
  test("the type-level proofs hold", () => {
    expect(TYPE_LEVEL_PROOFS).toEqual([true, true, true, true]);
  });

  test("a refs-only form is ACCEPTED by the pinned schema", () => {
    expect(validateAgainstSchema(DISPATCH_INPUT_REFS_SCHEMA, REFS).ok).toBe(true);
    expect(
      validateAgainstSchema(DISPATCH_INPUT_REFS_SCHEMA, {
        ...REFS,
        round: 2,
        priorReviewId: "R42",
        resolvedModel: "opus",
        guidance: [
          { kind: "answered-question", questionId: "Q301" },
          { kind: "operator-note", note: OPERATOR_NOTE },
        ],
      }).ok,
    ).toBe(true);
    expect(assemble().accepted).toBe(true);
  });

  test("round and startingCommit are required launch refs", () => {
    for (const field of ["round", "startingCommit"] as const) {
      const missing = { ...REFS } as Record<string, unknown>;
      delete missing[field];
      expect(validateAgainstSchema(DISPATCH_INPUT_REFS_SCHEMA, missing).ok, field).toBe(false);
      const rejection = rejectionOf(assembleDispatchInput(missing, {
        source: sourceFor(),
        registry: DISPATCH_OVERLAY_REGISTRY,
      }));
      expect(rejection.reason, field).toBe("invalid-refs-form");
      expect(rejection.path, field).toBe(`refs.${field}`);
    }
  });

  test("the closed key set is exactly the refs form, and carries no narrative", () => {
    expect(DISPATCH_INPUT_REFS_FIELDS).toEqual([
      "roleId",
      "surface",
      "projectKey",
      "taskId",
      "coordinates",
      "round",
      "startingCommit",
      "priorReviewId",
      "guidance",
      "resolvedModel",
    ]);
    const properties = Object.keys(
      (DISPATCH_INPUT_REFS_SCHEMA as { readonly properties: Readonly<Record<string, unknown>> })
        .properties,
    );
    expect(properties.sort()).toEqual([...DISPATCH_INPUT_REFS_FIELDS].sort());
    for (const field of DISPATCH_INPUT_REFS_FIELDS) {
      expect(ASSEMBLED_NARRATIVE_FIELDS, field).not.toContain(field);
    }
  });

  test("a form carrying the assembled narrative INLINE is REJECTED", () => {
    const inline: Readonly<Record<string, DispatchJSONValue>> = {
      headline: TASK_HEADLINE,
      description: TASK_DESCRIPTION,
      acceptance: TASK_ACCEPTANCE,
      priorCriticism: [...REVIEW_CRITICISM],
    };
    for (const [field, value] of Object.entries(inline)) {
      // Pinned by the schema …
      expect(
        validateAgainstSchema(DISPATCH_INPUT_REFS_SCHEMA, { ...REFS, [field]: value }).ok,
      ).toBe(false);
      // … and diagnosed by name at the assembly boundary.
      const rejection = rejectionOf(assemble({ [field]: value }));
      expect(rejection.reason, field).toBe("inline-narrative-courier");
      expect(rejection.path).toBe(`refs.${field}`);
      expect(rejection.detail).toBe(
        `"${field}" is assembled server-side from the ledger; the parent must not carry it inline`,
      );
    }
  });

  test("an unexpected non-narrative refs field is refused as a malformed form", () => {
    for (const field of ["promptSuffix", "extra", ...PROTOTYPE_NAMES]) {
      const rejection = rejectionOf(assemble({ [field]: "x" }));
      expect(rejection.reason, field).toBe("invalid-refs-form");
      expect(rejection.detail).toBe(`unexpected refs field "${field}"`);
    }
  });

  test("the refs launch envelope pins idempotency, timeout, and the empty overlay registry", () => {
    const launch = { refs: REFS, idempotencyKey: "T978-round-0", timeoutMs: 600_000 };
    expect(validateAgainstSchema(COMPACT_DISPATCH_REFS_LAUNCH_SCHEMA, launch).ok).toBe(true);
    for (const bad of [
      { ...launch, input: { taskId: "T978" } },
      { ...launch, promptTemplate: "you are an implement worker" },
      { ...launch, timeoutMs: 0 },
      { ...launch, idempotencyKey: "" },
      { refs: REFS, timeoutMs: 1 },
      { ...launch, overlays: [{ overlayId: "fixture-focus", data: { note: "x" } }] },
    ]) {
      expect(validateAgainstSchema(COMPACT_DISPATCH_REFS_LAUNCH_SCHEMA, bad).ok).toBe(false);
    }
    // A registry with a declared overlay widens ONLY the overlay list.
    const definition: DispatchOverlayDefinition = {
      overlayId: "fixture-focus",
      inputSchema: {
        type: "object",
        properties: { note: { type: "string", minLength: 1 } },
        required: ["note"],
        additionalProperties: false,
      },
      allowedRoles: ["implement-worker"],
      allowedSurfaces: ["claude"],
      render: (data) => `Focus: ${(data as { readonly note: string }).note}`,
    };
    const widened = compactDispatchRefsLaunchSchemaFor(createDispatchOverlayRegistry([definition]));
    expect(
      validateAgainstSchema(widened, {
        ...launch,
        overlays: [{ overlayId: "fixture-focus", data: { note: "x" } }],
      }).ok,
    ).toBe(true);
    expect(validateAgainstSchema(widened, { ...launch, input: {} }).ok).toBe(false);
  });
});

describe("the assembled-narrative field set is DERIVED from the role sidecars", () => {
  test("it is every ref-assembled role's inputSchema property the refs form does not supply", () => {
    const expected = new Set<string>();
    for (const roleId of REF_ASSEMBLED_ROLES) {
      const properties = (
        DISPATCHED_ROLE_SIDECARS[roleId].inputSchema as {
          readonly properties: Readonly<Record<string, unknown>>;
        }
      ).properties;
      for (const name of Object.keys(properties)) {
        if (!(REFS_SUPPLIED_INPUT_FIELDS as readonly string[]).includes(name)) {
          expected.add(name);
        }
      }
    }
    expect([...ASSEMBLED_NARRATIVE_FIELDS]).toEqual([...expected].sort());
    expect(ASSEMBLED_NARRATIVE_FIELDS).toEqual([
      "acceptance",
      "description",
      "headline",
      "priorCriticism",
    ]);
    for (const field of REFS_SUPPLIED_INPUT_FIELDS) {
      expect(ASSEMBLED_NARRATIVE_FIELDS, field).not.toContain(field);
    }
    // The four ARE the narrative `commands/cq/implement/advance.md` §2 used to
    // mandate the parent carry verbatim.
    expect(REFS_SUPPLIED_INPUT_FIELDS).toEqual([
      "taskId",
      "worktreePath",
      "branch",
      "baseCommit",
      "round",
      "startingCommit",
      "resolvedModel",
    ]);
  });

  test("the per-role view matches the implement-worker contract", () => {
    expect(assembledNarrativeFieldsFor("implement-worker")).toEqual([
      "acceptance",
      "description",
      "headline",
      "priorCriticism",
    ]);
  });

  test("no prototype-exposed role name resolves a phantom narrative set", () => {
    for (const roleId of [...PROTOTYPE_NAMES, "implement-reviewer", ""]) {
      expect(() => assembledNarrativeFieldsFor(roleId as never)).toThrow(DispatchRefAssemblyError);
      expect(() => assembledNarrativeFieldsFor(roleId as never)).toThrow(
        `roleId: no server-side ref assembler is declared for role "${roleId}"`,
      );
    }
  });
});

describe("server-side assembly reads the narrative the parent no longer carries", () => {
  test("it assembles the exact implement-worker input from the task item", () => {
    const assembled = assembledOf(assemble());
    expect(assembled.input).toEqual({
      taskId: "T978",
      headline: TASK_HEADLINE,
      description: TASK_DESCRIPTION,
      acceptance: TASK_ACCEPTANCE,
      ...COORDINATES,
      round: 0,
      startingCommit: STARTING_COMMIT,
    });
    expect(assembled.assembledFrom).toEqual(["tasks:T978"]);
    expect(assembled.roleId).toBe("implement-worker");
    expect(assembled.surface).toBe("claude");
    expect(assembled.projectKey).toBe(PROJECT);
    expect(assembled.round).toBe(0);
    expect(assembled.parentCarriedNarrative).toBe(false);
    expect(assembled.appliedGuidance).toEqual([]);
    expect(assembled.inputDigest).toBe(dispatchInputDigest(assembled.input));
  });

  test("it reads the prior round's criticism from the review, not from the parent", () => {
    const assembled = assembledOf(assemble({ round: 1, priorReviewId: "R42" }));
    expect(assembled.round).toBe(1);
    expect(assembled.assembledFrom).toEqual(["tasks:T978", "reviews:R42"]);
    expect(
      (assembled.input as { readonly priorCriticism: readonly string[] }).priorCriticism,
    ).toEqual([...REVIEW_CRITICISM]);
  });

  test("a review with no criticism yields no priorCriticism key at all", () => {
    const assembled = assembledOf(assemble({ round: 1, priorReviewId: "R43" }));
    expect(Object.hasOwn(assembled.input as object, "priorCriticism")).toBe(false);
  });

  test("round and the authoritative starting commit are assembled into every worker input", () => {
    const assembled = assembledOf(assemble({ round: 3, priorReviewId: "R42" }));
    expect(
      assembled.input as { readonly round: number; readonly startingCommit: string },
    ).toMatchObject({ round: 3, startingCommit: STARTING_COMMIT });
    expect(assembled.round).toBe(3);
  });

  test("the non-narrative resolvedModel passes through unchanged", () => {
    const assembled = assembledOf(assemble({ resolvedModel: "opus" }));
    expect((assembled.input as { readonly resolvedModel: string }).resolvedModel).toBe("opus");
  });

  test("assembly flows THROUGH T976's inside-prepare validation, not around it", () => {
    // T979 has no `acceptance` field, which the role's bound inputSchema
    // REQUIRES. Only validateDispatchInput can produce this reason, so the
    // assembled input demonstrably reached it.
    const missing = rejectionOf(assemble({ taskId: "T979" }));
    expect(missing.reason).toBe("invalid-role-input");
    expect(missing.path).toBe("input");

    // A branch outside the sidecar's pattern is likewise caught by validation.
    const badBranch = rejectionOf(assemble({ coordinates: { ...COORDINATES, branch: "main" } }));
    expect(badBranch.reason).toBe("invalid-role-input");

    // And so is an overlay the production registry does not declare (T684).
    const badOverlay = rejectionOf(
      assemble({}, { overlays: [{ overlayId: "fixture-focus", data: { note: "x" } }] }),
    );
    expect(badOverlay.reason).toBe("invalid-overlay-data");

    // A successful assembly carries that acceptance verbatim.
    const assembled = assembledOf(assemble());
    expect(assembled.validation).toEqual({
      accepted: true,
      roleId: "implement-worker",
      surface: "claude",
      sidecarVersion: DISPATCHED_ROLE_SIDECARS["implement-worker"].version,
      appliedOverlayIds: [],
    });
  });

  test("a native-isolation worktree-agent branch assembles too (D77)", () => {
    const assembled = assembledOf(
      assemble({ coordinates: { ...COORDINATES, branch: "worktree-agent-ac57caec" } }),
    );
    expect((assembled.input as { readonly branch: string }).branch).toBe("worktree-agent-ac57caec");
  });
});

describe("unresolvable and cross-project refs are typed PRE-LAUNCH failures", () => {
  test("an unresolvable task ref is rejected before launch", () => {
    const rejection = rejectionOf(assemble({ taskId: "T99999" }));
    expect(rejection.reason).toBe("unresolvable-ref");
    expect(rejection.path).toBe("refs.taskId");
    expect(rejection.detail).toBe('no such ledger item "tasks:T99999"');
    expect(rejection.allocated).toBe(false);
  });

  test("an unresolvable prior-review ref is rejected before launch", () => {
    const rejection = rejectionOf(assemble({ round: 1, priorReviewId: "R9999" }));
    expect(rejection.reason).toBe("unresolvable-ref");
    expect(rejection.path).toBe("refs.priorReviewId");
    expect(rejection.detail).toBe('no such ledger item "reviews:R9999"');
  });

  test("CROSS-PROJECT refs are rejected even when the id resolves in the bound project", () => {
    // The task DOES exist in the bound source — only the project scope differs,
    // so this can never degrade into a mere unresolvable-ref.
    expect(sourceFor().readItem("tasks", "T978")).toBeDefined();
    const rejection = rejectionOf(assemble({ projectKey: OTHER_PROJECT }));
    expect(rejection.reason).toBe("cross-project-ref");
    expect(rejection.path).toBe("refs.projectKey");
    expect(rejection.detail).toBe(
      `refs are scoped to project "${OTHER_PROJECT}" but prepare is bound to "${PROJECT}"`,
    );
    // Symmetrically: the same refs against a source bound elsewhere.
    expect(rejectionOf(assemble({}, { source: sourceFor(OTHER_PROJECT) })).reason).toBe(
      "cross-project-ref",
    );
  });

  test("a malformed project key is a malformed form, not a cross-project ref", () => {
    for (const projectKey of ["", "  ", "-leading-dash", "__proto__", 7, null]) {
      const rejection = rejectionOf(assemble({ projectKey }));
      expect(rejection.reason, String(projectKey)).toBe("invalid-refs-form");
      expect(rejection.path).toBe("refs.projectKey");
    }
    // A prototype name that happens to be a WELL-FORMED key is still scoped —
    // it can never match the bound project, so it is refused as cross-project.
    for (const projectKey of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      expect(rejectionOf(assemble({ projectKey })).reason, projectKey).toBe("cross-project-ref");
    }
  });

  test("a known role with NO declared assembler is refused, distinct from an unknown role", () => {
    expect(REF_ASSEMBLED_ROLES).toEqual(["implement-worker"]);
    for (const roleId of Object.keys(DISPATCHED_ROLE_SIDECARS)) {
      const result = assemble({ roleId });
      if (roleId === "implement-worker") {
        expect(result.accepted, roleId).toBe(true);
        continue;
      }
      const rejection = rejectionOf(result);
      expect(rejection.reason, roleId).toBe("no-ref-assembler");
      expect(rejection.detail).toBe(
        `no server-side ref assembler is declared for role "${roleId}"`,
      );
      // The pinned schema refuses it too.
      expect(validateAgainstSchema(DISPATCH_INPUT_REFS_SCHEMA, { ...REFS, roleId }).ok).toBe(false);
    }
    for (const roleId of ["advance", "", ...PROTOTYPE_NAMES]) {
      const rejection = rejectionOf(assemble({ roleId }));
      expect(rejection.reason, roleId).toBe("unknown-role");
      expect(rejection.detail).toBe(`unknown dispatched role "${roleId}"`);
    }
  });

  test("an unsupported surface and a malformed id or coordinate are refused", () => {
    for (const surface of ["terminal", 7, ...PROTOTYPE_NAMES]) {
      expect(rejectionOf(assemble({ surface })).reason, String(surface)).toBe(
        "unsupported-surface",
      );
    }
    for (const taskId of ["T", "978", "tasks:T978", 978, ...PROTOTYPE_NAMES]) {
      expect(rejectionOf(assemble({ taskId })).reason, String(taskId)).toBe("invalid-refs-form");
    }
    for (const priorReviewId of ["R", "42", "reviews:R42", 42]) {
      expect(rejectionOf(assemble({ priorReviewId })).reason, String(priorReviewId)).toBe(
        "invalid-refs-form",
      );
    }
    for (const round of [-1, 1.5, "1", Number.NaN]) {
      expect(rejectionOf(assemble({ round })).reason, String(round)).toBe("invalid-refs-form");
    }
    expect(rejectionOf(assemble({ coordinates: undefined })).path).toBe("refs.coordinates");
    for (const field of ["worktreePath", "branch", "baseCommit"] as const) {
      const rejection = rejectionOf(assemble({ coordinates: { ...COORDINATES, [field]: "  " } }));
      expect(rejection.reason, field).toBe("invalid-refs-form");
      expect(rejection.path).toBe(`refs.coordinates.${field}`);
    }
    for (const field of ["promptSuffix", ...PROTOTYPE_NAMES]) {
      const rejection = rejectionOf(assemble({ coordinates: { ...COORDINATES, [field]: "x" } }));
      expect(rejection.reason, field).toBe("invalid-refs-form");
      expect(rejection.detail).toBe(`unexpected coordinate field "${field}"`);
    }
    for (const refs of [null, "T978", 7, [REFS]]) {
      const result = assembleDispatchInput(refs, {
        source: sourceFor(),
        registry: DISPATCH_OVERLAY_REGISTRY,
      });
      expect(rejectionOf(result).detail).toBe("expected a refs form object");
    }
  });
});

describe("typed bounded parent guidance round-trips", () => {
  const GUIDANCE: readonly ParentGuidance[] = [
    { kind: "answered-question", questionId: "Q301" },
    { kind: "operator-note", note: OPERATOR_NOTE },
  ];

  test("an answered question's text is read from the LEDGER and folded in", () => {
    const assembled = assembledOf(assemble({ round: 2, priorReviewId: "R42", guidance: GUIDANCE }));
    expect(assembled.appliedGuidance).toEqual(GUIDANCE);
    expect(assembled.assembledFrom).toEqual(["tasks:T978", "reviews:R42", "questions:Q301"]);
    expect(
      (assembled.input as { readonly priorCriticism: readonly string[] }).priorCriticism,
    ).toEqual([
      ...REVIEW_CRITICISM,
      `answered question Q301: ${QUESTION_ANSWER}`,
      `operator note: ${OPERATOR_NOTE}`,
    ]);
    // The ANSWER text is nowhere in the refs the parent passed.
    expect(JSON.stringify({ ...REFS, guidance: GUIDANCE })).not.toContain(QUESTION_ANSWER);
  });

  test("the fold helpers are the single spelling of both folded forms", () => {
    expect(foldAnsweredQuestion("Q301", QUESTION_ANSWER)).toBe(
      `answered question Q301: ${QUESTION_ANSWER}`,
    );
    expect(foldOperatorNote(OPERATOR_NOTE)).toBe(`operator note: ${OPERATOR_NOTE}`);
  });

  test("guidance alone folds without a prior review", () => {
    const assembled = assembledOf(assemble({ guidance: [GUIDANCE[1]] }));
    expect(
      (assembled.input as { readonly priorCriticism: readonly string[] }).priorCriticism,
    ).toEqual([`operator note: ${OPERATOR_NOTE}`]);
    expect(assembled.assembledFrom).toEqual(["tasks:T978"]);
  });

  test("an unanswered or missing question ref is an unresolvable ref, not silent omission", () => {
    const open = rejectionOf(
      assemble({ guidance: [{ kind: "answered-question", questionId: "Q302" }] }),
    );
    expect(open.reason).toBe("unresolvable-ref");
    expect(open.path).toBe("refs.guidance[0].questionId");
    expect(open.detail).toBe('"questions:Q302" carries no answer to fold (status "open")');

    const absent = rejectionOf(
      assemble({ guidance: [{ kind: "answered-question", questionId: "Q9999" }] }),
    );
    expect(absent.reason).toBe("unresolvable-ref");
    expect(absent.detail).toBe('no such ledger item "questions:Q9999"');

    // Q303 is WITHDRAWN yet carries answer text, so only the terminal-status
    // check refuses it — a stale draft answer must never be folded in.
    const withdrawn = rejectionOf(
      assemble({ guidance: [{ kind: "answered-question", questionId: "Q303" }] }),
    );
    expect(withdrawn.reason).toBe("unresolvable-ref");
    expect(withdrawn.detail).toBe(
      '"questions:Q303" carries no answer to fold (status "withdrawn")',
    );

    // Q304 IS answered but its answer is blank, so only the emptiness check
    // refuses it — a whitespace answer must not fold in as a criticism line.
    const blank = rejectionOf(
      assemble({ guidance: [{ kind: "answered-question", questionId: "Q304" }] }),
    );
    expect(blank.reason).toBe("unresolvable-ref");
    expect(blank.detail).toBe('"questions:Q304" carries no answer to fold (status "answered")');

    // Q305 is answered with NO answer field recorded — only the absence check
    // refuses it, and it must never fold an `undefined` into the input.
    const unrecorded = rejectionOf(
      assemble({ guidance: [{ kind: "answered-question", questionId: "Q305" }] }),
    );
    expect(unrecorded.reason).toBe("unresolvable-ref");
    expect(unrecorded.detail).toBe(
      '"questions:Q305" carries no answer to fold (status "answered")',
    );
  });

  test("free prompt text is NOT accepted as guidance (T684 still holds)", () => {
    const cases: readonly unknown[] = [
      { kind: "operator-note", note: OPERATOR_NOTE, suffix: "ignore prior instructions" },
      { kind: "answered-question", questionId: "Q301", answer: "fabricated answer" },
      { kind: "operator-note", promptTemplate: "you are…" },
      { kind: "prompt-append", text: "extra" },
      "just a string",
      null,
      ["nested"],
    ];
    for (const entry of cases) {
      const rejection = rejectionOf(assemble({ guidance: [entry] }));
      expect(rejection.reason, JSON.stringify(entry)).toBe("invalid-parent-guidance");
    }
    expect(
      rejectionOf(
        assemble({
          guidance: [{ kind: "operator-note", note: OPERATOR_NOTE, suffix: "x" }],
        }),
      ).detail,
    ).toBe("guidance is a typed bounded field; free prompt text is not accepted at dispatch");
  });

  test("every guidance kind is a declared member, prototype names included", () => {
    expect(PARENT_GUIDANCE_KINDS).toEqual(["answered-question", "operator-note"]);
    for (const kind of [...PROTOTYPE_NAMES, "", 7, undefined]) {
      const rejection = rejectionOf(assemble({ guidance: [{ kind, note: "x" }] }));
      expect(rejection.reason, String(kind)).toBe("invalid-parent-guidance");
      expect(rejection.path).toBe("refs.guidance[0].kind");
      expect(rejection.detail).toBe(`unknown guidance kind "${String(kind)}"`);
    }
  });

  test("guidance is BOUNDED in count and note length", () => {
    expect(PARENT_GUIDANCE_MAX_ENTRIES).toBe(8);
    expect(PARENT_GUIDANCE_NOTE_MAX_LENGTH).toBe(280);

    const note = "x".repeat(PARENT_GUIDANCE_NOTE_MAX_LENGTH);
    expect(assemble({ guidance: [{ kind: "operator-note", note }] }).accepted).toBe(true);
    const tooLong = rejectionOf(
      assemble({ guidance: [{ kind: "operator-note", note: `${note}y` }] }),
    );
    expect(tooLong.reason).toBe("invalid-parent-guidance");
    expect(tooLong.detail).toBe(
      `an operator note is bounded at ${PARENT_GUIDANCE_NOTE_MAX_LENGTH} characters`,
    );

    const entry = { kind: "operator-note", note: OPERATOR_NOTE } as const;
    const atLimit = Array.from({ length: PARENT_GUIDANCE_MAX_ENTRIES }, () => entry);
    expect(assemble({ guidance: atLimit }).accepted).toBe(true);
    const overLimit = rejectionOf(assemble({ guidance: [...atLimit, entry] }));
    expect(overLimit.reason).toBe("invalid-parent-guidance");
    expect(overLimit.detail).toBe(
      `at most ${PARENT_GUIDANCE_MAX_ENTRIES} guidance entries may be folded into one dispatch`,
    );

    for (const bad of ["", "   "]) {
      const rejection = rejectionOf(assemble({ guidance: [{ kind: "operator-note", note: bad }] }));
      expect(rejection.detail).toBe("expected a non-empty operator note");
    }
    expect(rejectionOf(assemble({ guidance: "note" })).detail).toBe(
      "expected an array of typed guidance entries",
    );
    // The pinned schema bounds the same two dimensions.
    expect(
      validateAgainstSchema(DISPATCH_INPUT_REFS_SCHEMA, {
        ...REFS,
        guidance: [...atLimit, entry],
      }).ok,
    ).toBe(false);
    expect(
      validateAgainstSchema(DISPATCH_INPUT_REFS_SCHEMA, {
        ...REFS,
        guidance: [{ kind: "operator-note", note: `${note}y` }],
      }).ok,
    ).toBe(false);
  });
});

describe("no inherited Object.prototype member is ever read as ledger narrative", () => {
  test("a field name colliding with Object.prototype reads as ABSENT (the D169 class)", () => {
    const plain = item("T978", "wip", {} as Readonly<Record<string, string>>);
    for (const name of PROTOTYPE_NAMES) {
      expect(readNarrativeField(plain, name), name).toBeUndefined();
    }
    // And an OWN field of that name reads back verbatim, so the guard is
    // narrow: it refuses inheritance, not the literal name.
    const own = item("T978", "wip", { constructor: "an own field named constructor" });
    expect(readNarrativeField(own, "constructor")).toBe("an own field named constructor");
    expect(readNarrativeField(own, "toString")).toBeUndefined();
  });

  test("a rejection tag inherited through the prototype chain is NOT a rejection", () => {
    // The boundary guard must read an OWN `outcome`; a spoofed prototype must
    // not let an arbitrary object pass as a typed pre-launch rejection.
    const spoof = Object.create({ outcome: DISPATCH_PRE_LAUNCH_OUTCOME }) as {
      accepted: boolean;
    };
    spoof.accepted = false;
    expect(isDispatchPreLaunchRejection(spoof)).toBe(false);
    const own: { accepted: boolean } = { accepted: false };
    Object.assign(own, { outcome: DISPATCH_PRE_LAUNCH_OUTCOME });
    expect(isDispatchPreLaunchRejection(own)).toBe(true);
  });

  test("a non-string entry in a stored string[] field is dropped, not couriered", () => {
    const source = new FixtureNarrativeSource(
      PROJECT,
      new Map([
        [
          "tasks:T978",
          item("T978", "wip", {
            headline: TASK_HEADLINE,
            description: TASK_DESCRIPTION,
            acceptance: TASK_ACCEPTANCE,
          }),
        ],
        [
          "reviews:R42",
          item("R42", "revise", {
            criticism: [REVIEW_CRITICISM[0], 7, null, REVIEW_CRITICISM[1]] as never,
          }),
        ],
      ]),
    );
    const assembled = assembledOf(assemble({ round: 1, priorReviewId: "R42" }, { source }));
    expect(
      (assembled.input as { readonly priorCriticism: readonly string[] }).priorCriticism,
    ).toEqual([...REVIEW_CRITICISM]);
  });

  test("an item whose fields object inherits everything assembles nothing from it", () => {
    const source = new FixtureNarrativeSource(
      PROJECT,
      new Map([["tasks:T978", item("T978", "wip", {} as Readonly<Record<string, string>>)]]),
    );
    const rejection = rejectionOf(assemble({}, { source }));
    expect(rejection.reason).toBe("invalid-role-input");
  });
});

describe("canonical input bytes give the cutover a byte identity", () => {
  test("canonical bytes are independent of property construction order", () => {
    const a: DispatchJSONValue = { taskId: "T978", headline: TASK_HEADLINE, list: ["b", "a"] };
    const b: DispatchJSONValue = { list: ["b", "a"], headline: TASK_HEADLINE, taskId: "T978" };
    expect(canonicalDispatchInputBytes(a)).toEqual(canonicalDispatchInputBytes(b));
    expect(dispatchInputDigest(a)).toBe(dispatchInputDigest(b));
    // Array ORDER is content, not incidental.
    expect(dispatchInputDigest(a)).not.toBe(
      dispatchInputDigest({ ...a, list: ["a", "b"] } as DispatchJSONValue),
    );
  });

  test("a differing narrative byte changes the digest", () => {
    const assembled = assembledOf(assemble());
    const tampered = {
      ...(assembled.input as Readonly<Record<string, DispatchJSONValue>>),
      acceptance: `${TASK_ACCEPTANCE} `,
    };
    expect(dispatchInputDigest(tampered)).not.toBe(assembled.inputDigest);
    expect(assembled.inputDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a non-JSON value can never become a dispatch input", () => {
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, () => 1, Symbol("s")]) {
      expect(() => canonicalDispatchInputBytes(value as never)).toThrow(DispatchRefAssemblyError);
    }
    expect(() => canonicalDispatchInputBytes({ a: undefined } as never)).toThrow(
      "input.a: a undefined value is not JSON-serializable",
    );
    expect(() => canonicalDispatchInputBytes([Number.NaN] as never)).toThrow(
      "input[0]: a non-finite number is not JSON-serializable",
    );
  });
});

describe("a refs-assembly rejection is T976's rejection, not a lifecycle state", () => {
  test("it carries the pre-launch tag, allocates nothing, and has no state", () => {
    const rejection = rejectionOf(assemble({ taskId: "T99999" }));
    expect(rejection.outcome).toBe(DISPATCH_PRE_LAUNCH_OUTCOME);
    expect(rejection.allocated).toBe(false);
    expect(Object.keys(rejection).sort()).toEqual([
      "accepted",
      "allocated",
      "detail",
      "outcome",
      "path",
      "reason",
    ]);
    expect(Object.hasOwn(rejection, "state")).toBe(false);
    expect(Object.hasOwn(rejection, "attestationId")).toBe(false);
    expect(Object.hasOwn(rejection, "resultCapability")).toBe(false);
    expect(classifyDispatchOutcomeTag(rejection.outcome)).toBe("pre-launch-rejection");
    expect(validateAgainstSchema(FETCH_DISPATCH_RESULT_SCHEMA, rejection).ok).toBe(false);
    for (const state of DISPATCH_LIFECYCLE_STATES) {
      expect(validateAgainstSchema(FETCH_DISPATCH_RESULT_SCHEMA, { ...rejection, state }).ok).toBe(
        false,
      );
    }
  });

  test("an ACCEPTED assembly is not a prepared dispatch — assembly allocates nothing", () => {
    const assembled = assembledOf(assemble());
    expect(validateAgainstSchema(DISPATCH_PREPARED_SCHEMA, assembled).ok).toBe(false);
    expect(Object.hasOwn(assembled, "attestationId")).toBe(false);
    expect(Object.hasOwn(assembled, "resultCapability")).toBe(false);
  });

  test("the two pre-launch stages together cover the WHOLE closed reason set", () => {
    const source = sourceFor();
    const observed = new Set(
      [
        assemble({ roleId: "advance" }),
        assemble({ surface: "terminal" }),
        assemble({ taskId: "T979" }),
        assemble({}, { overlays: [{ overlayId: "fixture-focus", data: {} }] }),
        assemble({ extra: 1 }),
        assemble({ headline: "inline" }),
        assemble({ roleId: "implement-reviewer" }),
        assemble({ taskId: "T99999" }),
        assemble({ projectKey: OTHER_PROJECT }),
        assemble({ guidance: ["nope"] }),
      ].map((result) => {
        if (result.accepted) {
          throw new Error("expected a pre-launch rejection");
        }
        return result.reason;
      }),
    );
    expect(source.readItem("tasks", "T978")).toBeDefined();
    // The two T976-only placement reasons come from resolveDispatchInputValidator
    // (covered in dispatchInputValidation.test.ts) and the launch-envelope reason
    // from T685's prepare (covered in dispatchAttestation.test.ts); everything
    // else is here.
    const placementOnly = ["unknown-validator-placement", "undeclared-child-side-validation"];
    const prepareOnly = ["invalid-launch-envelope"];
    expect([...observed, ...placementOnly, ...prepareOnly].sort()).toEqual(
      [...DISPATCH_PRE_LAUNCH_REJECTION_REASONS].sort(),
    );
  });
});

describe("a native Claude child performs NO role-prompt retrieval (T975 must not regress)", () => {
  test("both ends of the native edge retrieve zero role prompts", () => {
    expect(NATIVE_CLAUDE_CHILD_RETRIEVAL.surface).toBe("claude");
    expect(PROMPT_SURFACES).toContain(NATIVE_CLAUDE_CHILD_RETRIEVAL.surface);
    expect(NATIVE_CLAUDE_CHILD_RETRIEVAL.rolePromptInjectionBoundary).toBe(
      "gen-agents-baked-agent-definition",
    );
    expect(NATIVE_CLAUDE_CHILD_RETRIEVAL.childRolePromptRetrievalOperations).toEqual([]);
    expect(NATIVE_CLAUDE_CHILD_RETRIEVAL.parentRolePromptRetrievalOperations).toEqual([]);
    expect(NATIVE_CLAUDE_CHILD_RETRIEVAL.childRetrievesAssembledInputByHandle).toBe(true);
    expect(NATIVE_CLAUDE_CHILD_RETRIEVAL.childRetrievalIsOneShot).toBe(true);
    expect(() =>
      assertNoRolePromptRetrieval(
        "claude-child",
        NATIVE_CLAUDE_CHILD_RETRIEVAL.childRolePromptRetrievalOperations,
      ),
    ).not.toThrow();
    expect(() =>
      assertNoRolePromptRetrieval(
        "claude-parent",
        NATIVE_CLAUDE_CHILD_RETRIEVAL.parentRolePromptRetrievalOperations,
      ),
    ).not.toThrow();
  });

  test("the assertion FAILS on a reintroduced retrieval, on either end", () => {
    expect(ROLE_PROMPT_RETRIEVAL_OPERATIONS).toEqual([
      "fetch_prompt",
      "prompt-catalog fetch",
      "promptTemplate",
    ]);
    for (const operation of ROLE_PROMPT_RETRIEVAL_OPERATIONS) {
      expect(() => assertNoRolePromptRetrieval("claude-child", [operation])).toThrow(
        DispatchRefAssemblyError,
      );
      expect(() =>
        assertNoRolePromptRetrieval("claude-child", ["store_result", operation]),
      ).toThrow(
        `claude-child[1]: role-prompt retrieval "${operation}" is not performed on this edge`,
      );
    }
    // Non-retrieval operations, and every prototype name, stay silent.
    expect(() =>
      assertNoRolePromptRetrieval("claude-child", [
        "store_result",
        "fetch_dispatch_result",
        ...PROTOTYPE_NAMES,
      ]),
    ).not.toThrow();
    expect(() => assertNoRolePromptRetrieval("claude-child", "fetch_prompt" as never)).toThrow(
      "expected a list of retrieval operations",
    );
  });
});

describe("what T978 defers to the runtime task", () => {
  test("the deferred work is recorded, not dropped", () => {
    expect(DISPATCH_REF_ASSEMBLY_DEFERRED_TO).toBe("T977");
    expect(DISPATCH_REF_ASSEMBLY_DEFERRED).toEqual([
      "one-shot-child-retrieval-of-the-assembled-input-by-handle",
      "stolen-or-foreign-capability-rejection",
      "second-retrieval-failure",
      "recorded-end-to-end-dispatch-showing-narrative-absent-from-parent-context",
    ]);
  });

  test("the declared assembled roles and the assembler table agree at import time", () => {
    expect(REF_ASSEMBLER_COVERAGE).toEqual([...REF_ASSEMBLED_ROLES].sort());
    // Every declared role therefore assembles rather than throwing.
    for (const roleId of REF_ASSEMBLED_ROLES) {
      expect(() => assemble({ roleId }), roleId).not.toThrow();
    }
  });

  test("the ledgers refs assembly reads are declared", () => {
    expect(REF_ASSEMBLY_LEDGERS).toEqual({
      tasks: "tasks",
      reviews: "reviews",
      questions: "questions",
    });
  });
});
