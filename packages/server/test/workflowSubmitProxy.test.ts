/**
 * Unit tests for WorkflowSubmitProxy (codexwf) — the cq-server side of the
 * Codex /plan structured-output relay.
 *
 * Proves the adversarial invariants:
 *  - correlates submitId → the registered dispatch + validates payload against
 *    THAT phase's schema;
 *  - a well-formed submit resolves the dispatch with the validated value and
 *    acks {ok:true};
 *  - a MALFORMED payload acks {ok:false,error}, does NOT resolve the dispatch
 *    (so no ledger write), and leaves it pending for a resubmit;
 *  - a phase mismatch acks {ok:false} and keeps the dispatch pending;
 *  - an unknown submitId acks {ok:false} (model tool returns, no hang);
 *  - reject() on teardown rejects the parked promise and drops the correlation.
 */

import { describe, it, expect } from "bun:test";
import { WorkflowSubmitProxy } from "../src/workflow/workflowSubmitProxy";
import { ProducerOutputSchema } from "../src/workflow/producer";
import { PlanOutputSchema } from "../src/workflow/phases";
import { noopLogger } from "./helpers/mockBridge";

type Ack = { submitId: string; ok: boolean; error?: string };

function makeProxy(): { proxy: WorkflowSubmitProxy; acks: Ack[] } {
  const acks: Ack[] = [];
  const proxy = new WorkflowSubmitProxy({
    logger: noopLogger,
    sendAck: (submitId, ok, error) => {
      const a: Ack = { submitId, ok };
      if (error !== undefined) a.error = error;
      acks.push(a);
    },
  });
  return { proxy, acks };
}

describe("WorkflowSubmitProxy — accept path", () => {
  it("validates a well-formed producer payload, resolves the dispatch, acks ok", async () => {
    const { proxy, acks } = makeProxy();
    const p = proxy.register("s-1", "produce", ProducerOutputSchema);
    expect(proxy.hasPending("s-1")).toBe(true);

    const payload = {
      goal: { title: "Notes app", description: "a notes app" },
      questions: [{ question: "which platform?", recommendation: "web" }],
    };
    proxy.onSubmit({ submitId: "s-1", phase: "produce", payload });

    const out = await p;
    expect(out).toEqual(payload);
    expect(acks).toEqual([{ submitId: "s-1", ok: true }]);
    // Correlation dropped on accept.
    expect(proxy.hasPending("s-1")).toBe(false);
  });

  it("strips unknown keys via the schema's parse (validated value, not raw)", async () => {
    const { proxy } = makeProxy();
    const p = proxy.register("s-strip", "plan", PlanOutputSchema);
    proxy.onSubmit({
      submitId: "s-strip",
      phase: "plan",
      payload: {
        milestones: [{ title: "m", description: "d", extra: "drop-me" }],
        tasks: [{ milestoneRef: 0, headline: "h", description: "dd" }],
      },
    });
    const out = (await p) as { milestones: Array<Record<string, unknown>> };
    expect(out.milestones[0]).toEqual({ title: "m", description: "d" });
  });
});

describe("WorkflowSubmitProxy — reject (malformed) path", () => {
  it("acks {ok:false} on a malformed payload and leaves the dispatch pending (no resolve)", async () => {
    const { proxy, acks } = makeProxy();
    let settled = false;
    const p = proxy.register("s-bad", "produce", ProducerOutputSchema);
    void p.then(() => { settled = true; }, () => { settled = true; });

    // Empty questions array violates ProducerOutputSchema (min 1).
    proxy.onSubmit({
      submitId: "s-bad",
      phase: "produce",
      payload: { goal: { title: "X", description: "x" }, questions: [] },
    });

    await Bun.sleep(0);
    expect(settled).toBe(false); // dispatch NOT resolved → no ledger write
    expect(proxy.hasPending("s-bad")).toBe(true); // still pending for a resubmit
    expect(acks).toHaveLength(1);
    expect(acks[0]!.ok).toBe(false);
    expect(acks[0]!.error).toBeDefined();

    // A corrected resubmit then lands.
    proxy.onSubmit({
      submitId: "s-bad",
      phase: "produce",
      payload: { goal: { title: "X", description: "x" }, questions: [{ question: "q?" }] },
    });
    const out = await p;
    expect(out).toEqual({ goal: { title: "X", description: "x" }, questions: [{ question: "q?" }] });
    expect(acks[1]).toEqual({ submitId: "s-bad", ok: true });
  });
});

describe("WorkflowSubmitProxy — phase mismatch", () => {
  it("acks {ok:false} when the relayed phase does not match the registered phase", async () => {
    const { proxy, acks } = makeProxy();
    proxy.register("s-mm", "produce", ProducerOutputSchema);
    proxy.onSubmit({
      submitId: "s-mm",
      phase: "plan",
      payload: { milestones: [{ title: "m", description: "d" }], tasks: [] },
    });
    expect(acks[0]!.ok).toBe(false);
    expect(acks[0]!.error).toContain("phase mismatch");
    expect(proxy.hasPending("s-mm")).toBe(true); // kept pending
  });
});

describe("WorkflowSubmitProxy — unknown submitId", () => {
  it("acks {ok:false} for a submit with no in-flight dispatch (no hang)", () => {
    const { proxy, acks } = makeProxy();
    proxy.onSubmit({ submitId: "ghost", phase: "produce", payload: {} });
    expect(acks).toEqual([
      { submitId: "ghost", ok: false, error: "no in-flight phase dispatch for this submit" },
    ]);
  });
});

describe("WorkflowSubmitProxy — teardown", () => {
  it("reject() rejects the parked promise and drops the correlation", async () => {
    const { proxy } = makeProxy();
    const p = proxy.register("s-td", "produce", ProducerOutputSchema);
    proxy.reject("s-td", "workflow torn down");
    await expect(p).rejects.toThrow("workflow torn down");
    expect(proxy.hasPending("s-td")).toBe(false);
  });

  it("a late submit after teardown is treated as unknown (acked false)", () => {
    const { proxy, acks } = makeProxy();
    // Swallow the expected teardown rejection so it is not an unhandled reject.
    proxy.register("s-late", "produce", ProducerOutputSchema).catch(() => {});
    proxy.reject("s-late", "torn down");
    proxy.onSubmit({ submitId: "s-late", phase: "produce", payload: { goal: { title: "X", description: "x" }, questions: [{ question: "q" }] } });
    expect(acks).toEqual([
      { submitId: "s-late", ok: false, error: "no in-flight phase dispatch for this submit" },
    ]);
  });

  it("re-registering a live submitId rejects the prior promise", async () => {
    const { proxy } = makeProxy();
    const p1 = proxy.register("dup", "produce", ProducerOutputSchema);
    const p2 = proxy.register("dup", "produce", ProducerOutputSchema);
    await expect(p1).rejects.toThrow("re-registered");
    proxy.onSubmit({ submitId: "dup", phase: "produce", payload: { goal: { title: "X", description: "x" }, questions: [{ question: "q" }] } });
    await expect(p2).resolves.toBeDefined();
  });
});
