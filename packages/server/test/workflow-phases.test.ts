/**
 * wfl-1 — phase schema + dispatch-seam + protocol-extension tests.
 *
 * Verifies: each phase output schema accepts well-formed payloads and rejects
 * malformed ones; the PhaseSubagent seam is satisfiable by a fake; the new
 * `question.answer` client frame and the extended `workflow.event` statuses
 * round-trip through the protocol Zod unions.
 */

import { describe, it, expect } from "bun:test";
import {
  CLARIFY_REVIEW_SPEC,
  ClarifyReviewOutputSchema,
  PlanOutputSchema,
  PlanReviewOutputSchema,
  buildClarifyReviewPrompt,
  buildPlannerPrompt,
  buildPlanReviewPrompt,
  type PhaseSubagent,
  type PhaseSpec,
  type PhaseRequest,
} from "../src/workflow/index";
import { ClientFrame, ServerFrame } from "@cq/shared";

describe("phase output schemas", () => {
  it("ClarifyReviewOutputSchema accepts a clear verdict and a not-clear-with-questions verdict", () => {
    expect(ClarifyReviewOutputSchema.safeParse({ clear: true, contradictions: [], newQuestions: [] }).success).toBe(true);
    expect(
      ClarifyReviewOutputSchema.safeParse({
        clear: false,
        contradictions: ["A vs B"],
        newQuestions: [{ question: "Which one?", suggestions: ["A", "B"], recommendation: "A" }],
      }).success,
    ).toBe(true);
    // Missing required `clear`.
    expect(ClarifyReviewOutputSchema.safeParse({ contradictions: [], newQuestions: [] }).success).toBe(false);
    // Empty question string rejected.
    expect(
      ClarifyReviewOutputSchema.safeParse({ clear: false, contradictions: [], newQuestions: [{ question: "" }] }).success,
    ).toBe(false);
  });

  it("PlanOutputSchema requires ≥1 milestone and ≥1 task with a numeric milestoneRef", () => {
    expect(
      PlanOutputSchema.safeParse({
        milestones: [{ title: "Build", description: "do it" }],
        tasks: [{ milestoneRef: 0, headline: "T1", description: "d", acceptance: "passes" }],
      }).success,
    ).toBe(true);
    expect(PlanOutputSchema.safeParse({ milestones: [], tasks: [] }).success).toBe(false);
    // milestoneRef must be a non-negative integer.
    expect(
      PlanOutputSchema.safeParse({
        milestones: [{ title: "M", description: "d" }],
        tasks: [{ milestoneRef: -1, headline: "T", description: "d" }],
      }).success,
    ).toBe(false);
  });

  it("PlanReviewOutputSchema accepts satisfied + unsatisfied verdicts", () => {
    expect(PlanReviewOutputSchema.safeParse({ satisfied: true, findings: [], newQuestions: [] }).success).toBe(true);
    expect(
      PlanReviewOutputSchema.safeParse({
        satisfied: false,
        findings: [{ severity: "major", issue: "no tests", suggestion: "add tests" }],
        newQuestions: [],
      }).success,
    ).toBe(true);
  });
});

describe("phase prompt builders", () => {
  const qna = [
    { question: "Platforms?", context: "scope", answer: "web" },
    { question: "Encryption?", answer: "age" },
  ];
  it("clarify-review prompt names the tool and forbids ledger writes", () => {
    const p = buildClarifyReviewPrompt("a notes app", qna);
    expect(p).toContain("submit_clarify_review");
    expect(p).toContain("Do NOT write");
    expect(p).toContain("a notes app");
    expect(p).toContain("answer: web");
  });
  it("planner prompt names the tool and renders Q&A", () => {
    const p = buildPlannerPrompt("a notes app", qna);
    expect(p).toContain("submit_plan_doc");
    expect(p).toContain("milestoneRef");
  });
  it("plan-review prompt includes prior findings when present", () => {
    const p = buildPlanReviewPrompt(
      "a notes app",
      qna,
      { milestones: [{ title: "M", description: "d" }], tasks: [{ milestone: "M5", headline: "T", description: "d" }] },
      [{ severity: "major", issue: "x", suggestion: "y" }],
    );
    expect(p).toContain("submit_plan_review");
    expect(p).toContain("Prior round findings");
    expect(p).toContain("[major] x → y");
  });
});

describe("PhaseSubagent seam", () => {
  it("is satisfiable by a fake that returns canned, spec-validated output", async () => {
    const fake: PhaseSubagent = {
      async dispatch<O>(spec: PhaseSpec<O>, _req: PhaseRequest): Promise<O> {
        if (spec.toolName === CLARIFY_REVIEW_SPEC.toolName) {
          return { clear: true, contradictions: [], newQuestions: [] } as unknown as O;
        }
        throw new Error(`unexpected spec ${spec.toolName}`);
      },
    };
    const out = await fake.dispatch(CLARIFY_REVIEW_SPEC, { prompt: "x" });
    expect(out.clear).toBe(true);
  });
});

describe("protocol extensions", () => {
  it("question.answer round-trips through ClientFrame", () => {
    const frame = { type: "question.answer", seq: 1, ts: Date.now(), questionId: "Q3", answer: "web" };
    const parsed = ClientFrame.safeParse(frame);
    expect(parsed.success).toBe(true);
    // Empty answer rejected.
    expect(ClientFrame.safeParse({ ...frame, answer: "" }).success).toBe(false);
  });

  it("new workflow.event statuses round-trip through ServerFrame", () => {
    const wid = crypto.randomUUID();
    for (const status of ["clarifying", "planning", "reviewing", "planned", "escalated", "done"] as const) {
      const frame = { type: "workflow.event", seq: 1, ts: Date.now(), workflowId: wid, phase: "review", status };
      expect(ServerFrame.safeParse(frame).success).toBe(true);
    }
    // Unknown status rejected.
    expect(
      ServerFrame.safeParse({ type: "workflow.event", seq: 1, ts: Date.now(), workflowId: wid, phase: "review", status: "bogus" }).success,
    ).toBe(false);
  });

  it("the new phase labels round-trip", () => {
    const wid = crypto.randomUUID();
    for (const phase of ["produce", "clarify", "plan", "review"] as const) {
      const frame = { type: "workflow.event", seq: 1, ts: Date.now(), workflowId: wid, phase, status: "planning" };
      expect(ServerFrame.safeParse(frame).success).toBe(true);
    }
  });
});
