/**
 * Round-trip + negative tests for the internal WS envelope.
 *
 * The schema is the contract between cq-server and cq-mcp. Any drift
 * here must be caught at the boundary, since both sides Zod-validate
 * before/after the wire.
 */

import { describe, it, expect } from "bun:test";
import {
  INTERNAL_WS_PATH,
  INTERNAL_WS_SUBPROTOCOL_PREFIX,
  InternalWsMessage,
  LedgerOp,
  WorkflowSubmitPhase,
} from "../src/internalProtocol.js";

describe("internalProtocol — constants", () => {
  it("INTERNAL_WS_PATH is the brief-confirmed value", () => {
    expect(INTERNAL_WS_PATH).toBe("/__internal/cq-mcp");
  });

  it("INTERNAL_WS_SUBPROTOCOL_PREFIX is `cq-internal`", () => {
    expect(INTERNAL_WS_SUBPROTOCOL_PREFIX).toBe("cq-internal");
  });
});

describe("internalProtocol — LedgerOp", () => {
  it("accepts create / update / archive", () => {
    expect(LedgerOp.parse("create")).toBe("create");
    expect(LedgerOp.parse("update")).toBe("update");
    expect(LedgerOp.parse("archive")).toBe("archive");
  });

  it("rejects unknown ops", () => {
    expect(() => LedgerOp.parse("delete")).toThrow();
    expect(() => LedgerOp.parse("")).toThrow();
  });
});

describe("internalProtocol — InternalWsMessage", () => {
  it("round-trips a well-formed ledger.changed envelope", () => {
    const msg = {
      type: "ledger.changed" as const,
      ledgerId: "defects",
      op: "update" as const,
      sourcePid: 12345,
    };
    const parsed = InternalWsMessage.parse(msg);
    expect(parsed).toEqual(msg);
    // Round-trip via JSON, the actual wire encoding.
    const wire = JSON.stringify(parsed);
    const decoded = InternalWsMessage.parse(JSON.parse(wire));
    expect(decoded).toEqual(msg);
  });

  it("rejects unknown discriminant `type` values", () => {
    const result = InternalWsMessage.safeParse({
      type: "future.unknown",
      ledgerId: "x",
      op: "create",
      sourcePid: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    expect(
      InternalWsMessage.safeParse({ type: "ledger.changed" }).success,
    ).toBe(false);
    expect(
      InternalWsMessage.safeParse({
        type: "ledger.changed",
        ledgerId: "x",
      }).success,
    ).toBe(false);
    expect(
      InternalWsMessage.safeParse({
        type: "ledger.changed",
        ledgerId: "x",
        op: "create",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty ledgerId", () => {
    const r = InternalWsMessage.safeParse({
      type: "ledger.changed",
      ledgerId: "",
      op: "create",
      sourcePid: 1,
    });
    expect(r.success).toBe(false);
  });

  it("rejects a negative or non-integer sourcePid", () => {
    expect(
      InternalWsMessage.safeParse({
        type: "ledger.changed",
        ledgerId: "x",
        op: "create",
        sourcePid: -1,
      }).success,
    ).toBe(false);
    expect(
      InternalWsMessage.safeParse({
        type: "ledger.changed",
        ledgerId: "x",
        op: "create",
        sourcePid: 1.5,
      }).success,
    ).toBe(false);
  });

  it("rejects wrong-typed fields", () => {
    expect(
      InternalWsMessage.safeParse({
        type: "ledger.changed",
        ledgerId: 42,
        op: "create",
        sourcePid: 1,
      }).success,
    ).toBe(false);
    expect(
      InternalWsMessage.safeParse({
        type: "ledger.changed",
        ledgerId: "x",
        op: 7,
        sourcePid: 1,
      }).success,
    ).toBe(false);
  });
});

describe("internalProtocol — ask.request (askproxy outer-14)", () => {
  const wellFormed = {
    type: "ask.request" as const,
    askId: "ask-1",
    toolUseId: "tu-abc",
    sessionId: "11111111-2222-3333-4444-555555555555",
    questions: [{ question: "Pick one", options: ["a", "b"] }],
    sourcePid: 4242,
  };

  it("round-trips a well-formed ask.request through JSON", () => {
    const parsed = InternalWsMessage.parse(wellFormed);
    expect(parsed).toEqual(wellFormed);
    const decoded = InternalWsMessage.parse(JSON.parse(JSON.stringify(parsed)));
    expect(decoded).toEqual(wellFormed);
  });

  it("accepts 1..4 questions and rejects empty / >4", () => {
    expect(
      InternalWsMessage.safeParse({ ...wellFormed, questions: [] }).success,
    ).toBe(false);
    expect(
      InternalWsMessage.safeParse({
        ...wellFormed,
        questions: [1, 2, 3, 4],
      }).success,
    ).toBe(true);
    expect(
      InternalWsMessage.safeParse({
        ...wellFormed,
        questions: [1, 2, 3, 4, 5],
      }).success,
    ).toBe(false);
  });

  it("rejects missing or empty askId / toolUseId / sessionId", () => {
    for (const key of ["askId", "toolUseId", "sessionId"] as const) {
      const missing: Record<string, unknown> = { ...wellFormed };
      delete missing[key];
      expect(InternalWsMessage.safeParse(missing).success).toBe(false);
      expect(
        InternalWsMessage.safeParse({ ...wellFormed, [key]: "" }).success,
      ).toBe(false);
    }
  });

  it("rejects a negative or non-integer sourcePid", () => {
    expect(
      InternalWsMessage.safeParse({ ...wellFormed, sourcePid: -1 }).success,
    ).toBe(false);
    expect(
      InternalWsMessage.safeParse({ ...wellFormed, sourcePid: 1.5 }).success,
    ).toBe(false);
  });
});

describe("internalProtocol — ask.reply (askproxy outer-14)", () => {
  const wellFormed = {
    type: "ask.reply" as const,
    askId: "ask-1",
    answers: { "Pick one": "a" },
    sourcePid: 99,
  };

  it("round-trips a well-formed ask.reply through JSON", () => {
    const parsed = InternalWsMessage.parse(wellFormed);
    expect(parsed).toEqual(wellFormed);
    const decoded = InternalWsMessage.parse(JSON.parse(JSON.stringify(parsed)));
    expect(decoded).toEqual(wellFormed);
  });

  it("accepts arbitrary answer value shapes (string / string[])", () => {
    const r = InternalWsMessage.safeParse({
      ...wellFormed,
      answers: { q1: "x", q2: ["a", "b"] },
    });
    expect(r.success).toBe(true);
  });

  it("accepts an empty answers map", () => {
    expect(
      InternalWsMessage.safeParse({ ...wellFormed, answers: {} }).success,
    ).toBe(true);
  });

  it("rejects missing or empty askId", () => {
    const missing: Record<string, unknown> = { ...wellFormed };
    delete missing["askId"];
    expect(InternalWsMessage.safeParse(missing).success).toBe(false);
    expect(
      InternalWsMessage.safeParse({ ...wellFormed, askId: "" }).success,
    ).toBe(false);
  });

  it("rejects answers that is not an object", () => {
    expect(
      InternalWsMessage.safeParse({ ...wellFormed, answers: "nope" }).success,
    ).toBe(false);
  });
});

describe("internalProtocol — WorkflowSubmitPhase (codexwf)", () => {
  it("accepts the four /plan phases", () => {
    for (const p of ["produce", "clarify_review", "plan", "plan_review"] as const) {
      expect(WorkflowSubmitPhase.parse(p)).toBe(p);
    }
  });

  it("rejects unknown phases", () => {
    expect(() => WorkflowSubmitPhase.parse("review")).toThrow();
    expect(() => WorkflowSubmitPhase.parse("")).toThrow();
  });
});

describe("internalProtocol — workflow.submit (codexwf relay)", () => {
  const wellFormed = {
    type: "workflow.submit" as const,
    submitId: "submit-7-1",
    phase: "produce" as const,
    payload: { goal: { title: "Notes app", description: "a notes app" }, questions: [{ question: "which platform?" }] },
    sourcePid: 4242,
  };

  it("round-trips a well-formed workflow.submit through JSON", () => {
    const parsed = InternalWsMessage.parse(wellFormed);
    expect(parsed).toEqual(wellFormed);
    const decoded = InternalWsMessage.parse(JSON.parse(JSON.stringify(parsed)));
    expect(decoded).toEqual(wellFormed);
  });

  it("carries an arbitrary (schema-agnostic) payload — validated server-side", () => {
    // The relay does NOT validate the per-phase shape; any JSON payload passes
    // the channel boundary and is validated by WorkflowSubmitProxy.
    for (const payload of [{}, { anything: 1 }, [1, 2], "str", 42, true, null]) {
      expect(
        InternalWsMessage.safeParse({ ...wellFormed, payload }).success,
      ).toBe(true);
    }
  });

  it("accepts each known phase discriminator", () => {
    for (const phase of ["produce", "clarify_review", "plan", "plan_review"] as const) {
      expect(InternalWsMessage.safeParse({ ...wellFormed, phase }).success).toBe(true);
    }
  });

  it("rejects an unknown phase", () => {
    expect(
      InternalWsMessage.safeParse({ ...wellFormed, phase: "review" }).success,
    ).toBe(false);
  });

  it("rejects missing or empty submitId", () => {
    const missing: Record<string, unknown> = { ...wellFormed };
    delete missing["submitId"];
    expect(InternalWsMessage.safeParse(missing).success).toBe(false);
    expect(
      InternalWsMessage.safeParse({ ...wellFormed, submitId: "" }).success,
    ).toBe(false);
  });

  it("rejects a negative or non-integer sourcePid", () => {
    expect(
      InternalWsMessage.safeParse({ ...wellFormed, sourcePid: -1 }).success,
    ).toBe(false);
    expect(
      InternalWsMessage.safeParse({ ...wellFormed, sourcePid: 1.5 }).success,
    ).toBe(false);
  });
});

describe("internalProtocol — workflow.submit_ack (codexwf relay)", () => {
  const okAck = {
    type: "workflow.submit_ack" as const,
    submitId: "submit-7-1",
    ok: true,
    sourcePid: 99,
  };
  const errAck = {
    type: "workflow.submit_ack" as const,
    submitId: "submit-7-1",
    ok: false,
    error: "payload failed validation: questions: array must contain at least 1 element",
    sourcePid: 99,
  };

  it("round-trips an ok ack (no error field) through JSON", () => {
    const parsed = InternalWsMessage.parse(okAck);
    expect(parsed).toEqual(okAck);
    const decoded = InternalWsMessage.parse(JSON.parse(JSON.stringify(parsed)));
    expect(decoded).toEqual(okAck);
  });

  it("round-trips an error ack (with error string) through JSON", () => {
    const parsed = InternalWsMessage.parse(errAck);
    expect(parsed).toEqual(errAck);
    const decoded = InternalWsMessage.parse(JSON.parse(JSON.stringify(parsed)));
    expect(decoded).toEqual(errAck);
  });

  it("requires the ok boolean", () => {
    const missing: Record<string, unknown> = { ...okAck };
    delete missing["ok"];
    expect(InternalWsMessage.safeParse(missing).success).toBe(false);
    expect(
      InternalWsMessage.safeParse({ ...okAck, ok: "yes" }).success,
    ).toBe(false);
  });

  it("rejects missing or empty submitId", () => {
    const missing: Record<string, unknown> = { ...okAck };
    delete missing["submitId"];
    expect(InternalWsMessage.safeParse(missing).success).toBe(false);
    expect(
      InternalWsMessage.safeParse({ ...okAck, submitId: "" }).success,
    ).toBe(false);
  });
});
