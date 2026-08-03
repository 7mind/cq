/**
 * T336 — proof-of-one-role for the typed prompt catalog.
 *
 * Verifies that plan-advance's input + output JSON Schemas (the storage-format
 * decision-3 sidecar) are VALID JSON Schema under the chosen validator (Ajv 8,
 * the validator decision), and that each schema ACCEPTS a valid example and
 * REJECTS an invalid one — the acceptance criterion for the foundational
 * design task.
 */

import { describe, expect, test } from "bun:test";
// The 2020-12 dialect entrypoint: the catalog schemas declare
// `$schema: …/draft/2020-12/schema`, so they must compile under Ajv's 2020 build
// (the default `ajv` export only knows draft-07).
import Ajv2020 from "ajv/dist/2020";
import {
  planAdvanceSidecar,
  PLAN_STEP_ACTIONS,
  type PromptCatalogEntry,
} from "@cq/config";

/** A fresh Ajv compiling draft 2020-12 schemas with strict structural checks. */
function newAjv(): Ajv2020 {
  // `strict: false` keeps Ajv from rejecting the `title`/`description`
  // annotation keywords on subschemas; `allErrors` aids debugging on failure.
  return new Ajv2020({ strict: false, allErrors: true });
}

describe("plan-advance schema sidecar (T336 proof-of-one-role)", () => {
  test("inputSchema compiles as valid JSON Schema", () => {
    const ajv = newAjv();
    // Ajv.compile throws on an invalid schema; a successful compile is the proof.
    const validate = ajv.compile(planAdvanceSidecar.inputSchema);
    expect(typeof validate).toBe("function");
  });

  test("outputSchema compiles as valid JSON Schema", () => {
    const ajv = newAjv();
    const validate = ajv.compile(planAdvanceSidecar.outputSchema);
    expect(typeof validate).toBe("function");
  });

  test("inputSchema ACCEPTS a valid example", () => {
    const validate = newAjv().compile(planAdvanceSidecar.inputSchema);
    expect(validate({ goalId: "G41" })).toBe(true);
    expect(validate({ goalId: "G41", candidateMode: true })).toBe(true);
  });

  test("inputSchema REJECTS invalid examples", () => {
    const validate = newAjv().compile(planAdvanceSidecar.inputSchema);
    // missing required goalId
    expect(validate({ candidateMode: true })).toBe(false);
    // malformed goal id (not G<digits>)
    expect(validate({ goalId: "41" })).toBe(false);
    // wrong type for candidateMode
    expect(validate({ goalId: "G41", candidateMode: "yes" })).toBe(false);
    // unknown property
    expect(validate({ goalId: "G41", extra: 1 })).toBe(false);
  });

  test("outputSchema ACCEPTS a valid DEFAULT-mode PlanStepResult per action", () => {
    const validate = newAjv().compile(planAdvanceSidecar.outputSchema);
    const manifest = {
      milestones: [{ key: "delivery", title: "Deliver" }],
      tasks: [
        {
          key: "contract",
          milestoneKey: "delivery",
          headline: "Publish the contract",
          ledgerRefs: ["goals:G41"],
        },
        {
          key: "impl",
          milestoneKey: "delivery",
          headline: "Implement it",
          acceptance: "bun run check green",
          suggestedModel: "standard",
          ledgerRefs: ["goals:G41"],
          dependsOn: [{ kind: "draft-task", key: "contract" }],
        },
      ],
    };
    const validByAction: Record<string, object> = {
      questions: {
        questions: [{ key: "scope", question: "Which packages?" }],
      },
      researches: {
        researches: [{ key: "bench", question: "Which store is fastest?" }],
      },
      draft: { manifest },
      finalize: {
        finalize: { reviewId: "R12", decision: { headline: "plan review: approved" } },
      },
      awaiting: {},
      noop: {},
    };
    for (const action of PLAN_STEP_ACTIONS) {
      const result = { mode: "default", action, ...validByAction[action] };
      expect(validate(result), `action ${action}`).toBe(true);
    }
    // defectsToFile is orthogonal — allowed on every action.
    const defectsToFile = {
      reviewId: "R12",
      defects: [{ key: "latent", headline: "Latent fault", severity: "high" }],
    };
    for (const action of PLAN_STEP_ACTIONS) {
      const result = { mode: "default", action, ...validByAction[action], defectsToFile };
      expect(validate(result), `action ${action} + defectsToFile`).toBe(true);
    }
  });

  test("outputSchema ACCEPTS a valid CANDIDATE-mode task-DAG", () => {
    const validate = newAjv().compile(planAdvanceSidecar.outputSchema);
    const candidate = {
      mode: "candidate",
      milestones: [{ title: "Foundational design" }],
      tasks: [
        {
          headline: "Design the typed prompt catalog",
          description: "Establish the typed catalog as the single source of truth.",
          acceptance: "bun run check is green and the proof test passes.",
          suggestedModel: "frontier",
          milestone: "Foundational design",
          ledgerRefs: ["goals:G41"],
        },
      ],
      rationale: "One foundational design milestone, then per-role generalisation.",
    };
    expect(validate(candidate)).toBe(true);
  });

  test("outputSchema REJECTS invalid examples", () => {
    const validate = newAjv().compile(planAdvanceSidecar.outputSchema);
    // unknown action
    expect(validate({ mode: "default", action: "in-progress" })).toBe(false);
    // questions action without its questions payload
    expect(validate({ mode: "default", action: "questions" })).toBe(false);
    // draft action without a manifest
    expect(validate({ mode: "default", action: "draft" })).toBe(false);
    // payload on a payload-less action
    expect(
      validate({
        mode: "default",
        action: "noop",
        questions: [{ key: "q", question: "x" }],
      }),
    ).toBe(false);
    // another action's payload mixed in
    expect(
      validate({
        mode: "default",
        action: "questions",
        questions: [{ key: "q", question: "x" }],
        manifest: {
          milestones: [{ key: "m", title: "M" }],
          tasks: [{ key: "t", milestoneKey: "m", headline: "h" }],
        },
      }),
    ).toBe(false);
    // candidate missing required rationale
    expect(validate({ mode: "candidate", milestones: [], tasks: [] })).toBe(false);
    // candidate task missing required acceptance
    expect(
      validate({
        mode: "candidate",
        milestones: [{ title: "M" }],
        tasks: [
          { headline: "x", suggestedModel: "fast", milestone: "M", ledgerRefs: [] },
        ],
        rationale: "r",
      }),
    ).toBe(false);
    // bad suggestedModel enum value
    expect(
      validate({
        mode: "candidate",
        milestones: [{ title: "M" }],
        tasks: [
          {
            headline: "x",
            acceptance: "a",
            suggestedModel: "ultra",
            milestone: "M",
            ledgerRefs: [],
          },
        ],
        rationale: "r",
      }),
    ).toBe(false);
    // bad severity in defectsToFile
    expect(
      validate({
        mode: "default",
        action: "noop",
        defectsToFile: {
          reviewId: "R1",
          defects: [{ key: "d", headline: "h", severity: "blocker" }],
        },
      }),
    ).toBe(false);
    // neither mode shape (mode mismatch with payload)
    expect(validate({ mode: "default" })).toBe(false);
    // unknown property on a default result
    expect(validate({ mode: "default", action: "noop", extra: 1 })).toBe(false);
  });
});

describe("PromptCatalogEntry type (T336)", () => {
  test("a dispatched-subagent entry carries the sidecar schemas", () => {
    // Compile-time proof that the type accepts a dispatched-subagent entry with
    // input/output schemas; runtime assertions guard the invariant.
    const entry: PromptCatalogEntry = {
      id: planAdvanceSidecar.id,
      kind: "dispatched-subagent",
      dispatched: true,
      tier: "frontier",
      version: planAdvanceSidecar.version,
      promptTemplate: "You are the plan-flow planner…",
      inputSchema: planAdvanceSidecar.inputSchema,
      outputSchema: planAdvanceSidecar.outputSchema,
    };
    expect(entry.dispatched).toBe(true);
    expect(entry.inputSchema).toBeDefined();
    expect(entry.outputSchema).toBeDefined();
  });

  test("an orchestrator-command entry has no parent-validated contract", () => {
    const entry: PromptCatalogEntry = {
      id: "advance",
      kind: "orchestrator-command",
      dispatched: false,
      tier: null,
      version: 1,
      promptTemplate: "Advance the whole flow…",
    };
    expect(entry.dispatched).toBe(false);
    expect(entry.inputSchema).toBeUndefined();
    expect(entry.outputSchema).toBeUndefined();
  });
});
