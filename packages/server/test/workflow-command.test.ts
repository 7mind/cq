/**
 * CommandRegistry parse unit tests (PR-wf-1).
 * Pure, total parsing: `/plan <text>`, `/plan G<id> <text>`, malformed.
 */

import { describe, it, expect } from "bun:test";
import { parsePlanCommand } from "../src/workflow/commandRegistry";
import { WorkflowStart, WorkflowEvent } from "@cq/shared";

describe("parsePlanCommand", () => {
  it("parses a new-goal /plan <text>", () => {
    const cmd = parsePlanCommand("let's build a notetaking app");
    expect(cmd.kind).toBe("plan_new");
    if (cmd.kind === "plan_new") {
      expect(cmd.text).toBe("let's build a notetaking app");
    }
  });

  it("trims surrounding whitespace on a new goal", () => {
    const cmd = parsePlanCommand("   build X   ");
    expect(cmd).toEqual({ kind: "plan_new", text: "build X" });
  });

  it("parses a continuation via explicit goalRef", () => {
    const cmd = parsePlanCommand("add encryption", "G3");
    expect(cmd).toEqual({ kind: "plan_continue", goalRef: "G3", text: "add encryption" });
  });

  it("parses a continuation via an inline leading G<id> token", () => {
    const cmd = parsePlanCommand("G12 add offline sync");
    expect(cmd).toEqual({ kind: "plan_continue", goalRef: "G12", text: "add offline sync" });
  });

  it("rejects empty text with no goalRef as malformed", () => {
    const cmd = parsePlanCommand("   ");
    expect(cmd.kind).toBe("malformed");
  });

  it("rejects a malformed goalRef", () => {
    const cmd = parsePlanCommand("do stuff", "G-bad");
    expect(cmd.kind).toBe("malformed");
  });

  it("rejects a continuation with goalRef but no text", () => {
    const cmd = parsePlanCommand("   ", "G1");
    expect(cmd.kind).toBe("malformed");
  });

  it("rejects an inline goalRef with no following text", () => {
    const cmd = parsePlanCommand("G7");
    expect(cmd.kind).toBe("malformed");
  });

  it("does not treat a non-G leading token as a goalRef", () => {
    const cmd = parsePlanCommand("Goal: build X");
    expect(cmd.kind).toBe("plan_new");
  });
});

describe("workflow protocol Zod round-trip", () => {
  it("round-trips WorkflowStart (new goal)", () => {
    const frame = {
      type: "workflow.start" as const,
      seq: 1,
      ts: Date.now(),
      kind: "plan" as const,
      text: "build X",
      platform: "claude" as const,
    };
    const parsed = WorkflowStart.parse(frame);
    expect(parsed).toEqual(frame);
  });

  it("round-trips WorkflowStart with goalRef (continuation)", () => {
    const frame = {
      type: "workflow.start" as const,
      seq: 2,
      ts: Date.now(),
      kind: "plan" as const,
      goalRef: "G1",
      text: "add feature",
    };
    expect(WorkflowStart.parse(frame)).toEqual(frame);
  });

  it("rejects a WorkflowStart with a non-plan kind", () => {
    expect(() =>
      WorkflowStart.parse({ type: "workflow.start", seq: 1, ts: 1, kind: "build", text: "x" }),
    ).toThrow();
  });

  it("round-trips each WorkflowEvent status", () => {
    const workflowId = crypto.randomUUID();
    for (const status of ["started", "producing", "questions_ready", "errored"] as const) {
      const frame = {
        type: "workflow.event" as const,
        seq: 0,
        ts: Date.now(),
        workflowId,
        phase: "produce" as const,
        status,
        ...(status === "questions_ready" ? { goalId: "G1", detail: "3 questions ready" } : {}),
      };
      expect(WorkflowEvent.parse(frame)).toEqual(frame);
    }
  });
});
