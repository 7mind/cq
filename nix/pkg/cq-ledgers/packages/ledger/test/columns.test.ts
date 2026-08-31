/**
 * Blackbox-Atomic unit tests for the pure column-model helpers (T60).
 * They drive the helpers with the canonical schemas / ledger names — no
 * store, no filesystem.
 */

import { describe, it, expect } from "bun:test";
import {
  eligibleColumnFields,
  defaultColumns,
  CANONICAL_LEDGERS,
  TASKS_SCHEMA,
  GOALS_SCHEMA,
  REVIEWS_SCHEMA,
  DEFECTS_SCHEMA,
  HYPOTHESIS_SCHEMA,
  QUESTIONS_SCHEMA,
  DECISIONS_SCHEMA,
  UPSTREAM_SCHEMA,
  MEMORIES_SCHEMA,
} from "../src/index.js";

describe("eligibleColumnFields", () => {
  it("includes a short field and excludes long/narrative + intrinsic columns", () => {
    const eligible = eligibleColumnFields(TASKS_SCHEMA);
    expect(eligible).toContain("suggestedModel");
    // long/narrative fields excluded
    expect(eligible).not.toContain("description");
    expect(eligible).not.toContain("completion");
    // always-shown intrinsic columns are never offered as extras
    expect(eligible).not.toContain("id");
    expect(eligible).not.toContain("status");
  });

  it("preserves schema field declaration order", () => {
    const eligible = eligibleColumnFields(TASKS_SCHEMA);
    const declared = Object.keys(TASKS_SCHEMA.fields);
    // eligible must be a subsequence of the declared field order
    let cursor = 0;
    for (const name of eligible) {
      cursor = declared.indexOf(name, cursor);
      expect(cursor).toBeGreaterThanOrEqual(0);
      cursor += 1;
    }
  });

  it("excludes the intrinsic `summary` field (reviews ledger)", () => {
    const eligible = eligibleColumnFields(REVIEWS_SCHEMA);
    expect(eligible).not.toContain("summary");
    expect(eligible).not.toContain("criticism");
  });

  it("excludes summary-source fields headline/title/question to prevent duplication with summary cell", () => {
    // headline: defects, tasks, hypothesis, decisions
    expect(eligibleColumnFields(DEFECTS_SCHEMA)).not.toContain("headline");
    expect(eligibleColumnFields(TASKS_SCHEMA)).not.toContain("headline");
    expect(eligibleColumnFields(HYPOTHESIS_SCHEMA)).not.toContain("headline");
    expect(eligibleColumnFields(DECISIONS_SCHEMA)).not.toContain("headline");

    // title: goals
    expect(eligibleColumnFields(GOALS_SCHEMA)).not.toContain("title");

    // question: questions ledger
    expect(eligibleColumnFields(QUESTIONS_SCHEMA)).not.toContain("question");
  });

  it("still includes genuine eligible fields when excluding summary-source fields", () => {
    expect(eligibleColumnFields(TASKS_SCHEMA)).toContain("suggestedModel");
    expect(eligibleColumnFields(DEFECTS_SCHEMA)).toContain("severity");
    expect(eligibleColumnFields(HYPOTHESIS_SCHEMA)).toContain("parentHypothesis");
  });

  it("excludes memory content from table-column choices", () => {
    expect(eligibleColumnFields(MEMORIES_SCHEMA)).toEqual(["tags", "sourceRefs"]);
  });

  it("keeps compact upstream fields eligible and excludes narrative, evidence, and log fields", () => {
    expect(eligibleColumnFields(UPSTREAM_SCHEMA)).toEqual([
      "package",
      "fixedVersion",
      "trackingUrl",
      "trackerKind",
      "reportingClassification",
      "severity",
      "lastCheckedAt",
      "lastCheckOutcome",
      "filingOperationId",
      "filingState",
      "filingClaimedAt",
      "suggestedModel",
    ]);
  });

  it("excludes every upstream list field by schema type", () => {
    const listFields = Object.entries(UPSTREAM_SCHEMA.fields)
      .filter(([, spec]) => spec.type === "string[]" || spec.type === "id[]")
      .map(([name]) => name);
    expect(listFields).toEqual([
      "affectedVersions",
      "priorArt",
      "reportUrls",
      "sessionLogs",
      "rawLogs",
      "sourceRefs",
      "blockedBy",
      "dependsOn",
      "ledgerRefs",
      "tags",
    ]);

    const eligible = new Set(eligibleColumnFields(UPSTREAM_SCHEMA));
    expect(listFields.filter((name) => eligible.has(name))).toEqual([]);
  });

  it("preserves the exact eligible-column policy of every pre-upstream canonical ledger", () => {
    const expected = {
      milestones: ["blockedBy", "dependsOn"],
      defects: [
        "severity",
        "sessionLogs",
        "rawLogs",
        "sourceRefs",
        "blockedBy",
        "dependsOn",
        "ledgerRefs",
        "tags",
        "suggestedModel",
      ],
      tasks: [
        "acceptance",
        "planDoc",
        "resultCommit",
        "severity",
        "sessionLogs",
        "rawLogs",
        "sourceRefs",
        "blockedBy",
        "dependsOn",
        "ledgerRefs",
        "tags",
        "suggestedModel",
      ],
      hypothesis: [
        "parentHypothesis",
        "sessionLogs",
        "rawLogs",
        "sourceRefs",
        "blockedBy",
        "dependsOn",
        "ledgerRefs",
        "tags",
        "suggestedModel",
      ],
      questions: [
        "suggestions",
        "recommendation",
        "sourceRefs",
        "blockedBy",
        "dependsOn",
        "ledgerRefs",
        "tags",
        "suggestedModel",
      ],
      decisions: [
        "supersedes",
        "landsIn",
        "sourceRefs",
        "blockedBy",
        "dependsOn",
        "ledgerRefs",
        "tags",
        "suggestedModel",
      ],
      goals: ["milestones", "grounding", "tags", "sourceRefs", "sessionLogs", "rawLogs"],
      reviews: [
        "new_questions",
        "defects",
        "implementationEvidence",
        "ledgerRefs",
        "tags",
        "sourceRefs",
        "sessionLogs",
        "rawLogs",
      ],
      handoffs: [
        "flow",
        "ledgerRefs",
        "blockingQuestions",
        "handoffReasons",
        "sessionLogs",
        "rawLogs",
        "tags",
        "sourceRefs",
      ],
      operatorActions: [
        "actionKey",
        "taskRef",
        "goalRef",
        "expectedOutputIdentity",
        "expectedEvidence",
        "revision",
        "revisionHistory",
        "acknowledgedOutputIdentity",
        "acknowledgedAt",
        "lastFailure",
        "verifiedAt",
        "verifiedRevision",
        "supersededAt",
        "supersededReason",
        "ledgerRefs",
      ],
      ideas: ["ledgerRefs"],
      memories: ["tags", "sourceRefs"],
      researches: [
        "scope",
        "findings",
        "conclusion",
        "recommendation",
        "sessionLogs",
        "rawLogs",
        "sourceRefs",
        "blockedBy",
        "dependsOn",
        "ledgerRefs",
        "tags",
        "suggestedModel",
      ],
    };

    expect(
      Object.fromEntries(
        CANONICAL_LEDGERS.filter(({ name }) => name !== "upstream").map(({ name, schema }) => [
          name,
          eligibleColumnFields(schema),
        ]),
      ),
    ).toEqual(expected);
  });
});

describe("defaultColumns", () => {
  it("defaults tasks to [suggestedModel]", () => {
    expect(defaultColumns("tasks")).toEqual(["suggestedModel"]);
  });

  it("defaults upstream to package and severity", () => {
    expect(defaultColumns("upstream")).toEqual(["package", "severity"]);
  });

  it("preserves the exact default-column policy of every pre-upstream canonical ledger", () => {
    for (const { name } of CANONICAL_LEDGERS.filter(({ name }) => name !== "upstream")) {
      expect(defaultColumns(name)).toEqual(name === "tasks" ? ["suggestedModel"] : []);
    }
  });

  it("every canonical default is itself an eligible column", () => {
    // a default extra column must be a field a UI is allowed to show
    for (const { name, schema } of CANONICAL_LEDGERS) {
      for (const column of defaultColumns(name)) {
        expect(eligibleColumnFields(schema)).toContain(column);
      }
    }
    expect(defaultColumns("goals")).toEqual([]);
  });
});
