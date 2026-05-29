/**
 * Unit tests for CqMcpAskBroker — the cq-mcp two-slot race machine that
 * coordinates the `ask_user_question` tool handler (parks via `ask`) with
 * the inbound `ask.reply` channel handler (resolves via `reply`).
 *
 * Exercises both orderings of the race (ask-before-reply, reply-before-ask)
 * keyed by askId, plus reject-on-disconnect and answer normalisation.
 */

import { describe, it, expect } from "bun:test";
import { CqMcpAskBroker, normaliseAnswers } from "../src/askBroker";

describe("CqMcpAskBroker — ask-before-reply (normal path)", () => {
  it("resolves the parked ask when reply() arrives", async () => {
    const broker = new CqMcpAskBroker();
    const questions = [{ question: "Pick", options: ["a", "b"] }];
    const p = broker.ask("ask-1", questions);
    expect(broker.hasPending("ask-1")).toBe(true);

    const wasPending = broker.reply("ask-1", { Pick: "a" });
    expect(wasPending).toBe(true);
    expect(broker.hasPending("ask-1")).toBe(false);

    const out = await p;
    expect(out.questions).toEqual(questions);
    expect(out.answers).toEqual({ Pick: "a" });
  });
});

describe("CqMcpAskBroker — reply-before-ask (race path)", () => {
  it("buffers the reply and resolves the later ask immediately", async () => {
    const broker = new CqMcpAskBroker();
    const wasPending = broker.reply("ask-2", { Pick: "b" });
    expect(wasPending).toBe(false);
    expect(broker.hasBufferedReply("ask-2")).toBe(true);

    const out = await broker.ask("ask-2", [{ question: "Pick" }]);
    expect(out.answers).toEqual({ Pick: "b" });
    expect(broker.hasBufferedReply("ask-2")).toBe(false);
  });
});

describe("CqMcpAskBroker — askId isolation", () => {
  it("routes replies to the matching askId only", async () => {
    const broker = new CqMcpAskBroker();
    const p1 = broker.ask("ask-A", [{ q: 1 }]);
    const p2 = broker.ask("ask-B", [{ q: 2 }]);

    broker.reply("ask-B", { q: "answerB" });
    const outB = await p2;
    expect(outB.answers).toEqual({ q: "answerB" });
    expect(broker.hasPending("ask-A")).toBe(true);

    broker.reply("ask-A", { q: "answerA" });
    const outA = await p1;
    expect(outA.answers).toEqual({ q: "answerA" });
  });

  it("ignores a reply for an unknown askId by buffering it (no throw)", () => {
    const broker = new CqMcpAskBroker();
    expect(() => broker.reply("never-asked", { x: "y" })).not.toThrow();
    expect(broker.hasBufferedReply("never-asked")).toBe(true);
  });
});

describe("CqMcpAskBroker — reject-on-disconnect", () => {
  it("rejects all pending asks when rejectAll() fires", async () => {
    const broker = new CqMcpAskBroker();
    const p1 = broker.ask("ask-1", [{ q: 1 }]);
    const p2 = broker.ask("ask-2", [{ q: 2 }]);

    broker.rejectAll("channel closed");

    await expect(p1).rejects.toThrow("channel closed");
    await expect(p2).rejects.toThrow("channel closed");
    expect(broker.hasPending("ask-1")).toBe(false);
    expect(broker.hasPending("ask-2")).toBe(false);
  });

  it("clears buffered replies on rejectAll", () => {
    const broker = new CqMcpAskBroker();
    broker.reply("ask-1", { x: "y" });
    expect(broker.hasBufferedReply("ask-1")).toBe(true);
    broker.rejectAll();
    expect(broker.hasBufferedReply("ask-1")).toBe(false);
  });

  it("rejects a new ask() that races in after rejectAll (fail-fast)", async () => {
    const broker = new CqMcpAskBroker();
    broker.rejectAll();
    await expect(broker.ask("ask-late", [{ q: 1 }])).rejects.toThrow(
      "channel closed",
    );
  });
});

describe("CqMcpAskBroker — replace pending for same askId", () => {
  it("rejects the prior pending entry when a second ask reuses the askId", async () => {
    const broker = new CqMcpAskBroker();
    const p1 = broker.ask("dup", [{ q: 1 }]);
    const p2 = broker.ask("dup", [{ q: 2 }]);
    await expect(p1).rejects.toThrow("replaced");
    broker.reply("dup", { q: "ok" });
    const out = await p2;
    expect(out.answers).toEqual({ q: "ok" });
  });
});

describe("normaliseAnswers — lockstep with server AskBroker", () => {
  it("joins string[] with comma-space and passes strings through", () => {
    expect(normaliseAnswers({ a: ["x", "y"], b: "z" })).toEqual({
      a: "x, y",
      b: "z",
    });
  });

  it("coerces non-string scalars and nullish to String()", () => {
    expect(normaliseAnswers({ n: 7, u: null, d: undefined })).toEqual({
      n: "7",
      u: "",
      d: "",
    });
  });

  it("passes a free-text custom answer through unchanged (AskCard 'Other…')", () => {
    // The AskCard 'Other…' affordance puts the user's typed text into the
    // labels array as a plain string. It must reach the model unchanged.
    expect(
      normaliseAnswers({ "0": ["Markdown editor", "a bespoke WYSIWYG editor"] }),
    ).toEqual({ "0": "Markdown editor, a bespoke WYSIWYG editor" });
    // Radio 'Other…' → single custom string in the array.
    expect(normaliseAnswers({ "0": ["my entirely custom answer"] })).toEqual({
      "0": "my entirely custom answer",
    });
  });
});
