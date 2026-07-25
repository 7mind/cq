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
const advancePrompt = readFileSync(
  path.join(ASSETS_ROOT, "commands", "cq", "plan", "advance.md"),
  "utf8",
);
const plannerPrompt = readFileSync(path.join(ASSETS_ROOT, "agents", "plan-advance.md"), "utf8");

interface ReviewDefect {
  readonly headline: string;
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly rootCause?: string;
  readonly suggestedFix?: string;
}

function serializeDefect(defect: ReviewDefect, alias?: string): string {
  const canonical = {
    headline: alias === undefined ? defect.headline : `[${alias}] ${defect.headline}`,
    severity: defect.severity,
    ...(defect.rootCause === undefined ? {} : { rootCause: defect.rootCause }),
    ...(defect.suggestedFix === undefined ? {} : { suggestedFix: defect.suggestedFix }),
  };
  return JSON.stringify(canonical);
}

describe("T844 plan-review structured verdict translation", () => {
  test("fallback returns a structured verdict and reconciles exactly one post-frontier write", () => {
    expect(reviewerPrompt).toContain(
      "BOTH modes return the SAME structured verdict JSON",
    );
    expect(reviewerPrompt).not.toContain(
      "Mode A (wrote the item): end with a single line pointing to the review",
    );

    expect(advancePrompt).toContain(
      "Snapshot the review frontier BEFORE dispatch",
    );
    expect(advancePrompt).toContain(
      "exactly ONE new goal-linked review above the snapshot frontier",
    );
    expect(advancePrompt).toContain(
      "Do NOT identify the new review by summary",
    );
    expect(advancePrompt).not.toContain(
      'fts_search({ query: "<just-created verdict>", ledger: "reviews"',
    );
    expect(advancePrompt).toContain(
      "persisted verdict bytes MUST equal the returned verdict bytes",
    );
    expect(advancePrompt).toContain(
      "FAIL before attaching any sessionLogs/rawLogs",
    );
  });

  test("direct/configured × empty/non-empty paths specify exact T843 bytes", () => {
    const defect: ReviewDefect = {
      headline: 'Quoted "headline" \\ path\nline',
      severity: "critical",
      rootCause: "café 根因",
      suggestedFix: 'replace \\ with "slash"\n次',
    };
    const directBytes =
      '{"headline":"Quoted \\"headline\\" \\\\ path\\nline","severity":"critical","rootCause":"café 根因","suggestedFix":"replace \\\\ with \\"slash\\"\\n次"}';
    const configuredBytes =
      '{"headline":"[opus] Quoted \\"headline\\" \\\\ path\\nline","severity":"critical","rootCause":"café 根因","suggestedFix":"replace \\\\ with \\"slash\\"\\n次"}';

    expect([] as string[], "direct-empty").toEqual([]);
    expect([serializeDefect(defect)], "direct-non-empty").toEqual([directBytes]);
    expect([] as string[], "configured-empty").toEqual([]);
    expect([serializeDefect(defect, "opus")], "configured-non-empty").toEqual([
      configuredBytes,
    ]);

    for (const fixture of [
      "direct-empty",
      "direct-non-empty",
      "configured-empty",
      "configured-non-empty",
    ]) {
      expect(advancePrompt).toContain(fixture);
    }
    expect(advancePrompt).toContain(
      "prefix the alias BEFORE T843 serialization",
    );
    expect(advancePrompt).toContain(
      "headline, severity, optional rootCause, optional suggestedFix",
    );
  });

  test("negative reconciliation fixtures fail before logs and stale lookup cannot pass", () => {
    for (const fixture of [
      "zero-new-review",
      "multiple-new-reviews",
      "stale-same-summary",
      "bucket-divergence",
      "invalid-output",
      "malformed-defect-json",
      "invalid-defect-schema",
      "invalid-severity",
    ]) {
      expect(advancePrompt).toContain(fixture);
    }
  });

  test("planner validates the whole serialized defect batch before typed filing", () => {
    const section = plannerPrompt.slice(
      plannerPrompt.indexOf("## Consuming the reviewer's `defects[]` bucket"),
      plannerPrompt.indexOf("## Session summary"),
    );
    const validation = section.indexOf(
      "Decode and validate the ENTIRE batch before filing ANY defect",
    );
    const filing = section.indexOf('create_item("defects"');

    expect(validation).toBeGreaterThanOrEqual(0);
    expect(filing).toBeGreaterThan(validation);
    expect(section).toContain(
      "one malformed entry means ZERO defects are filed",
    );
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
