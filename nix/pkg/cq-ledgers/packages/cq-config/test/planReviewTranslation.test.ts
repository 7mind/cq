import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { planReviewerSidecar } from "../src/index.js";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ASSETS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "cq-assets");
const reviewerPrompt = readFileSync(
  path.join(ASSETS_ROOT, "agents", "plan-reviewer.md"),
  "utf8",
);
const reviewPrompt = readFileSync(
  path.join(ASSETS_ROOT, "commands", "cq", "plan-review.md"),
  "utf8",
);
const advancePrompt = readFileSync(
  path.join(ASSETS_ROOT, "commands", "cq", "plan", "advance.md"),
  "utf8",
);
const plannerPrompt = readFileSync(path.join(ASSETS_ROOT, "agents", "plan-advance.md"), "utf8");

const SEVERITIES = ["low", "medium", "high", "critical"] as const;
type Severity = (typeof SEVERITIES)[number];
type ReviewVerdict = "go-ahead" | "revise";

interface ReviewDefect {
  readonly headline: string;
  readonly severity: Severity;
  readonly rootCause?: string;
  readonly suggestedFix?: string;
}

interface StructuredVerdict {
  readonly summary: string;
  readonly verdict: ReviewVerdict;
  readonly new_questions: readonly string[];
  readonly criticism: readonly string[];
  readonly defects: readonly ReviewDefect[];
}

interface PersistedReview {
  readonly id: string;
  status: unknown;
  readonly fields: {
    summary: unknown;
    new_questions: unknown;
    criticism: unknown;
    defects: unknown;
    ledgerRefs: unknown;
  };
}

interface SideEffects {
  readonly attachedLogs: string[];
  readonly filedDefects: ReviewDefect[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} missing ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has extra field ${key}`);
  }
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be a string[]`);
  }
  return [...value];
}

function normalizeDefect(value: unknown): ReviewDefect {
  const defect = record(value, "defect");
  requireExactKeys(
    defect,
    ["headline", "severity"],
    ["rootCause", "suggestedFix"],
    "defect",
  );
  if (typeof defect["headline"] !== "string" || defect["headline"].length === 0) {
    throw new Error("defect headline must be a non-empty string");
  }
  if (
    typeof defect["severity"] !== "string" ||
    !(SEVERITIES as readonly string[]).includes(defect["severity"])
  ) {
    throw new Error("defect severity is invalid");
  }
  if (Object.hasOwn(defect, "rootCause") && typeof defect["rootCause"] !== "string") {
    throw new Error("defect rootCause must be a string");
  }
  if (Object.hasOwn(defect, "suggestedFix") && typeof defect["suggestedFix"] !== "string") {
    throw new Error("defect suggestedFix must be a string");
  }

  return {
    headline: defect["headline"],
    severity: defect["severity"] as Severity,
    ...(Object.hasOwn(defect, "rootCause")
      ? { rootCause: defect["rootCause"] as string }
      : {}),
    ...(Object.hasOwn(defect, "suggestedFix")
      ? { suggestedFix: defect["suggestedFix"] as string }
      : {}),
  };
}

function normalizeVerdict(value: unknown): StructuredVerdict {
  const verdict = record(value, "verdict");
  requireExactKeys(
    verdict,
    ["summary", "verdict", "new_questions", "criticism", "defects"],
    [],
    "verdict",
  );
  if (typeof verdict["summary"] !== "string") throw new Error("summary must be a string");
  if (verdict["verdict"] !== "go-ahead" && verdict["verdict"] !== "revise") {
    throw new Error("verdict status is invalid");
  }
  if (!Array.isArray(verdict["defects"])) throw new Error("defects must be an array");

  const normalized: StructuredVerdict = {
    summary: verdict["summary"],
    verdict: verdict["verdict"],
    new_questions: stringArray(verdict["new_questions"], "new_questions"),
    criticism: stringArray(verdict["criticism"], "criticism"),
    defects: verdict["defects"].map(normalizeDefect),
  };
  const hasBlockingFinding =
    normalized.new_questions.length > 0 || normalized.criticism.length > 0;
  if (normalized.verdict === "go-ahead" && hasBlockingFinding) {
    throw new Error("go-ahead cannot carry blocking findings");
  }
  if (normalized.verdict === "revise" && !hasBlockingFinding) {
    throw new Error("revise requires a blocking finding");
  }
  return normalized;
}

function serializeDefect(defect: unknown, alias?: string): string {
  const normalized = normalizeDefect(defect);
  return JSON.stringify({
    headline:
      alias === undefined ? normalized.headline : `[${alias}] ${normalized.headline}`,
    severity: normalized.severity,
    ...(normalized.rootCause === undefined ? {} : { rootCause: normalized.rootCause }),
    ...(normalized.suggestedFix === undefined
      ? {}
      : { suggestedFix: normalized.suggestedFix }),
  });
}

function preflightPersistedDefects(value: unknown): ReviewDefect[] {
  const serialized = stringArray(value, "persisted defects");
  return serialized.map((entry) => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(entry);
    } catch {
      throw new Error("persisted defect is malformed JSON");
    }
    const normalized = normalizeDefect(decoded);
    if (JSON.stringify(normalized) !== entry) {
      throw new Error("persisted defect is not canonical T843 JSON");
    }
    return normalized;
  });
}

function persistedReview(
  id: string,
  verdict: StructuredVerdict,
  goalRef = "goals:G1",
): PersistedReview {
  const normalized = normalizeVerdict(verdict);
  return {
    id,
    status: normalized.verdict,
    fields: {
      summary: normalized.summary,
      new_questions: [...normalized.new_questions],
      criticism: [...normalized.criticism],
      defects: normalized.defects.map((defect) => serializeDefect(defect)),
      ledgerRefs: [goalRef],
    },
  };
}

function reviewNumber(id: string): number {
  const match = /^R([0-9]+)$/.exec(id);
  if (match === null) throw new Error(`invalid review id ${id}`);
  return Number(match[1]);
}

function normalizePersistedReview(review: PersistedReview): StructuredVerdict {
  return normalizeVerdict({
    summary: review.fields.summary,
    verdict: review.status,
    new_questions: review.fields.new_questions,
    criticism: review.fields.criticism,
    defects: preflightPersistedDefects(review.fields.defects),
  });
}

function runFallbackRound(input: {
  readonly frontier: number;
  readonly goalRef: string;
  readonly reviews: readonly PersistedReview[];
  readonly returned: unknown;
  readonly effects: SideEffects;
}): { readonly reviewId: string; readonly persistedDefects: readonly string[] } {
  const returned = normalizeVerdict(input.returned);
  const postFrontier = input.reviews.filter((review) => {
    const refs = stringArray(review.fields.ledgerRefs, "ledgerRefs");
    return refs.includes(input.goalRef) && reviewNumber(review.id) > input.frontier;
  });
  if (postFrontier.length !== 1) {
    throw new Error(`expected one post-frontier review, got ${postFrontier.length}`);
  }

  const recovered = postFrontier[0]!;
  const persisted = normalizePersistedReview(recovered);
  if (JSON.stringify(returned) !== JSON.stringify(persisted)) {
    throw new Error("returned and persisted verdicts diverged");
  }

  input.effects.attachedLogs.push(recovered.id);
  for (const defect of persisted.defects) input.effects.filedDefects.push(defect);
  return {
    reviewId: recovered.id,
    persistedDefects: stringArray(recovered.fields.defects, "persisted defects"),
  };
}

function aggregateConfigured(
  aliases: readonly string[],
  returnedByAlias: ReadonlyMap<string, unknown>,
): {
  readonly status: ReviewVerdict;
  readonly new_questions: readonly string[];
  readonly criticism: readonly string[];
  readonly defects: readonly string[];
} {
  const verdicts = aliases.map((alias) => {
    if (!returnedByAlias.has(alias)) throw new Error(`missing verdict for ${alias}`);
    return { alias, verdict: normalizeVerdict(returnedByAlias.get(alias)) };
  });
  if (verdicts.length === 0) throw new Error("configured panel has no survivors");

  const status: ReviewVerdict = verdicts.some(({ verdict }) => verdict.verdict === "revise")
    ? "revise"
    : "go-ahead";
  const newQuestions = verdicts.flatMap(({ alias, verdict }) =>
    verdict.new_questions.map((finding) => `[${alias}] ${finding}`),
  );
  const criticism = verdicts.flatMap(({ alias, verdict }) =>
    verdict.criticism.map((finding) => `[${alias}] ${finding}`),
  );
  const defects = verdicts.flatMap(({ alias, verdict }) =>
    verdict.defects.map((defect) => serializeDefect(defect, alias)),
  );
  preflightPersistedDefects(defects);
  normalizeVerdict({
    summary: "configured aggregate",
    verdict: status,
    new_questions: newQuestions,
    criticism,
    defects: preflightPersistedDefects(defects),
  });
  return { status, new_questions: newQuestions, criticism, defects };
}

function runPersistedDefectConsumption(
  serialized: readonly string[],
  roundEffects: SideEffects,
): void {
  const decoded = preflightPersistedDefects(serialized);
  roundEffects.attachedLogs.push("planner-consumption");
  for (const defect of decoded) roundEffects.filedDefects.push(defect);
}

function effects(): SideEffects {
  return { attachedLogs: [], filedDefects: [] };
}

const EMPTY_VERDICT: StructuredVerdict = {
  summary: "approved",
  verdict: "go-ahead",
  new_questions: [],
  criticism: [],
  defects: [],
};

const FULL_DEFECT: ReviewDefect = {
  headline: 'Quoted "headline" \\ path\nline',
  severity: "critical",
  rootCause: "café 根因",
  suggestedFix: 'replace \\ with "slash"\n次',
};

describe("T844 executable plan-review reconciliation", () => {
  test("fallback empty/non-empty paths persist exact T843 bytes and attach after success", () => {
    const emptyEffects = effects();
    const empty = runFallbackRound({
      frontier: 0,
      goalRef: "goals:G1",
      reviews: [persistedReview("R1", EMPTY_VERDICT)],
      returned: EMPTY_VERDICT,
      effects: emptyEffects,
    });
    expect(empty.persistedDefects, "direct-empty").toEqual([]);
    expect(emptyEffects).toEqual({ attachedLogs: ["R1"], filedDefects: [] });

    const directVerdict: StructuredVerdict = {
      ...EMPTY_VERDICT,
      defects: [FULL_DEFECT],
    };
    const directEffects = effects();
    const direct = runFallbackRound({
      frontier: 1,
      goalRef: "goals:G1",
      reviews: [persistedReview("R2", directVerdict)],
      returned: directVerdict,
      effects: directEffects,
    });
    expect(direct.persistedDefects, "direct-non-empty").toEqual([
      '{"headline":"Quoted \\"headline\\" \\\\ path\\nline","severity":"critical","rootCause":"café 根因","suggestedFix":"replace \\\\ with \\"slash\\"\\n次"}',
    ]);
    expect(directEffects).toEqual({
      attachedLogs: ["R2"],
      filedDefects: [FULL_DEFECT],
    });
  });

  test("configured empty/non-empty paths use configured alias order before serialization", () => {
    const empty = aggregateConfigured(
      ["opus", "grok"],
      new Map([
        ["grok", EMPTY_VERDICT],
        ["opus", EMPTY_VERDICT],
      ]),
    );
    expect(empty.defects, "configured-empty").toEqual([]);

    const nonEmpty = aggregateConfigured(
      ["opus", "grok"],
      new Map([
        ["grok", { ...EMPTY_VERDICT, defects: [{ headline: "g", severity: "low" }] }],
        ["opus", { ...EMPTY_VERDICT, defects: [FULL_DEFECT] }],
      ]),
    );
    expect(nonEmpty.defects, "configured-non-empty").toEqual([
      '{"headline":"[opus] Quoted \\"headline\\" \\\\ path\\nline","severity":"critical","rootCause":"café 根因","suggestedFix":"replace \\\\ with \\"slash\\"\\n次"}',
      '{"headline":"[grok] g","severity":"low"}',
    ]);
  });

  test("fallback accepts a sidecar-valid returned defect with reordered keys", () => {
    const reordered = JSON.parse(
      '{"severity":"high","suggestedFix":"fix","headline":"h","rootCause":"cause"}',
    ) as ReviewDefect;
    const returned: StructuredVerdict = { ...EMPTY_VERDICT, defects: [reordered] };
    const roundEffects = effects();

    expect(
      runFallbackRound({
        frontier: 8,
        goalRef: "goals:G1",
        reviews: [persistedReview("R9", returned)],
        returned,
        effects: roundEffects,
      }).persistedDefects,
    ).toEqual([
      '{"headline":"h","severity":"high","rootCause":"cause","suggestedFix":"fix"}',
    ]);
    expect(roundEffects.attachedLogs).toEqual(["R9"]);
  });

  test("zero/multiple/stale frontier and every bucket divergence fail before side effects", () => {
    const base: StructuredVerdict = {
      summary: "revise it",
      verdict: "revise",
      new_questions: [],
      criticism: ["fix ordering"],
      defects: [{ headline: "latent", severity: "medium" }],
    };
    const scenarios: Array<{
      readonly name: string;
      readonly frontier: number;
      readonly reviews: PersistedReview[];
      readonly returned: unknown;
    }> = [
      { name: "zero-new-review", frontier: 1, reviews: [], returned: base },
      {
        name: "multiple-new-reviews",
        frontier: 1,
        reviews: [persistedReview("R2", base), persistedReview("R3", base)],
        returned: base,
      },
      {
        name: "stale-same-summary",
        frontier: 4,
        reviews: [persistedReview("R4", base)],
        returned: base,
      },
      {
        name: "summary-divergence",
        frontier: 4,
        reviews: [
          {
            ...persistedReview("R5", base),
            fields: { ...persistedReview("R5", base).fields, summary: "different" },
          },
        ],
        returned: base,
      },
      {
        name: "verdict-divergence",
        frontier: 4,
        reviews: [{ ...persistedReview("R5", base), status: "go-ahead" }],
        returned: base,
      },
      {
        name: "new_questions-divergence",
        frontier: 4,
        reviews: [
          {
            ...persistedReview("R5", base),
            fields: {
              ...persistedReview("R5", base).fields,
              new_questions: ["question?"],
            },
          },
        ],
        returned: base,
      },
      {
        name: "criticism-divergence",
        frontier: 4,
        reviews: [
          {
            ...persistedReview("R5", base),
            fields: {
              ...persistedReview("R5", base).fields,
              criticism: ["different"],
            },
          },
        ],
        returned: base,
      },
      {
        name: "defects-divergence",
        frontier: 4,
        reviews: [
          {
            ...persistedReview("R5", base),
            fields: {
              ...persistedReview("R5", base).fields,
              defects: [serializeDefect({ headline: "different", severity: "medium" })],
            },
          },
        ],
        returned: base,
      },
    ];

    for (const scenario of scenarios) {
      const roundEffects = effects();
      expect(
        () =>
          runFallbackRound({
            frontier: scenario.frontier,
            goalRef: "goals:G1",
            reviews: scenario.reviews,
            returned: scenario.returned,
            effects: roundEffects,
          }),
        scenario.name,
      ).toThrow();
      expect(roundEffects, scenario.name).toEqual({
        attachedLogs: [],
        filedDefects: [],
      });
    }
  });

  test("invalid output and malformed/schema/severity persisted entries fail before side effects", () => {
    const valid = persistedReview("R1", EMPTY_VERDICT);
    const scenarios: Array<{ readonly name: string; readonly review: PersistedReview; returned: unknown }> = [
      {
        name: "invalid-output",
        review: valid,
        returned: { ...EMPTY_VERDICT, unexpected: true },
      },
      {
        name: "malformed-defect-json",
        review: {
          ...valid,
          fields: { ...valid.fields, defects: ["{"] },
        },
        returned: EMPTY_VERDICT,
      },
      {
        name: "invalid-defect-schema",
        review: {
          ...valid,
          fields: {
            ...valid.fields,
            defects: ['{"headline":"h","severity":"high","extra":"x"}'],
          },
        },
        returned: EMPTY_VERDICT,
      },
      {
        name: "invalid-severity",
        review: {
          ...valid,
          fields: {
            ...valid.fields,
            defects: ['{"headline":"h","severity":"urgent"}'],
          },
        },
        returned: EMPTY_VERDICT,
      },
    ];

    for (const scenario of scenarios) {
      const roundEffects = effects();
      expect(
        () =>
          runFallbackRound({
            frontier: 0,
            goalRef: "goals:G1",
            reviews: [scenario.review],
            returned: scenario.returned,
            effects: roundEffects,
          }),
        scenario.name,
      ).toThrow();
      expect(roundEffects, scenario.name).toEqual({
        attachedLogs: [],
        filedDefects: [],
      });
    }
  });

  test("one bad mixed-batch entry files nothing; a valid batch files typed defects in order", () => {
    const first = serializeDefect({ headline: "first", severity: "low" });
    const second = serializeDefect({
      headline: "second",
      severity: "high",
      rootCause: "cause",
    });
    const failureEffects = effects();

    expect(
      () => runPersistedDefectConsumption([first, "{"], failureEffects),
      "one-bad-batch-entry",
    ).toThrow();
    expect(failureEffects).toEqual({ attachedLogs: [], filedDefects: [] });

    const successEffects = effects();
    runPersistedDefectConsumption([first, second], successEffects);
    expect(successEffects).toEqual({
      attachedLogs: ["planner-consumption"],
      filedDefects: [
        { headline: "first", severity: "low" },
        { headline: "second", severity: "high", rootCause: "cause" },
      ],
    });
  });
});

describe("T844 prompt and sidecar projection", () => {
  test("canonical prompts specify structured fallback normalization and preflight ordering", () => {
    expect(reviewerPrompt).toContain("return the identical structured");
    expect(reviewerPrompt).not.toContain(
      "Mode A (wrote the item): end with a single line pointing to the review",
    );
    expect(advancePrompt).toContain("Snapshot the highest goal-linked review id before dispatch");
    expect(advancePrompt).toContain("require exactly one new goal-linked review above the snapshot");
    expect(advancePrompt).toMatch(/canonical\s+serialized defect objects/);
    expect(reviewPrompt).toContain(
      "parse and canonically reconstruct the entire batch before side effects",
    );
    // T854: the planner no longer files defects itself — it RETURNS the
    // validated batch as `defectsToFile` and the orchestrator supplies it as
    // the SAME guarded operation's `reviewDefects`. Pin the new receipt-check
    // → preflight → include ordering invariants (the old planner-side
    // `create_item("defects"…)` filing path is gone).
    expect(plannerPrompt).toContain("### Review defects");
    expect(plannerPrompt).toContain("If any receipt exists, omit `defectsToFile`");
    expect(plannerPrompt).toContain("parse the entire batch");
    expect(plannerPrompt).toContain("One invalid entry");
    expect(plannerPrompt).not.toContain('create_item("defects"');

    const section = plannerPrompt.slice(
      plannerPrompt.indexOf("### Review defects"),
      plannerPrompt.indexOf("## Candidate mode"),
    );
    expect(section.indexOf("If any receipt exists")).toBeLessThan(
      section.indexOf("parse the entire batch"),
    );
    expect(
      section.indexOf("parse the entire batch"),
    ).toBeLessThan(section.indexOf("return `defectsToFile`"));
  });

  test("the catalog sidecar remains a structured-object verdict contract", () => {
    const output = planReviewerSidecar.outputSchema as {
      readonly properties: {
        readonly defects: {
          readonly type: string;
          readonly items: {
            readonly type: string;
            readonly required: readonly string[];
            readonly properties: {
              readonly severity: { readonly enum: readonly string[] };
            };
          };
        };
      };
    };

    expect(output.properties.defects.type).toBe("array");
    expect(output.properties.defects.items.type).toBe("object");
    expect(output.properties.defects.items.required).toEqual(["headline", "severity"]);
    expect(output.properties.defects.items.properties.severity.enum).toEqual([
      "low",
      "medium",
      "high",
      "critical",
    ]);
  });
});
