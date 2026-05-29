/**
 * Unit tests for CqMcpSubmitBroker — the cq-mcp two-slot race machine that
 * coordinates the `submit_workflow_phase` tool handler (parks via `submit`)
 * with the inbound `workflow.submit_ack` channel handler (resolves via `ack`).
 *
 * Exercises both orderings of the race (submit-before-ack, ack-before-submit)
 * keyed by submitId, plus reject-on-disconnect and submitId isolation. Mirrors
 * askBroker.test.ts (the same race machine, keyed by submitId).
 */

import { describe, it, expect } from "bun:test";
import { CqMcpSubmitBroker } from "../src/submitBroker";

describe("CqMcpSubmitBroker — submit-before-ack (normal path)", () => {
  it("resolves the parked submit when ack() arrives ok", async () => {
    const broker = new CqMcpSubmitBroker();
    const p = broker.submit("submit-1");
    expect(broker.hasPending("submit-1")).toBe(true);

    const wasPending = broker.ack("submit-1", { ok: true });
    expect(wasPending).toBe(true);
    expect(broker.hasPending("submit-1")).toBe(false);

    const out = await p;
    expect(out).toEqual({ ok: true });
  });

  it("resolves the parked submit when ack() arrives with an error", async () => {
    const broker = new CqMcpSubmitBroker();
    const p = broker.submit("submit-err");
    broker.ack("submit-err", { ok: false, error: "payload invalid" });
    const out = await p;
    expect(out).toEqual({ ok: false, error: "payload invalid" });
  });
});

describe("CqMcpSubmitBroker — ack-before-submit (race path)", () => {
  it("buffers the ack and resolves the later submit immediately", async () => {
    const broker = new CqMcpSubmitBroker();
    const wasPending = broker.ack("submit-2", { ok: true });
    expect(wasPending).toBe(false);
    expect(broker.hasBufferedAck("submit-2")).toBe(true);

    const out = await broker.submit("submit-2");
    expect(out).toEqual({ ok: true });
    expect(broker.hasBufferedAck("submit-2")).toBe(false);
  });
});

describe("CqMcpSubmitBroker — submitId isolation", () => {
  it("routes acks to the matching submitId only", async () => {
    const broker = new CqMcpSubmitBroker();
    const pA = broker.submit("submit-A");
    const pB = broker.submit("submit-B");

    broker.ack("submit-B", { ok: true });
    expect(await pB).toEqual({ ok: true });
    expect(broker.hasPending("submit-A")).toBe(true);

    broker.ack("submit-A", { ok: false, error: "x" });
    expect(await pA).toEqual({ ok: false, error: "x" });
  });

  it("buffers an ack for an unknown submitId without throwing", () => {
    const broker = new CqMcpSubmitBroker();
    expect(() => broker.ack("never-submitted", { ok: true })).not.toThrow();
    expect(broker.hasBufferedAck("never-submitted")).toBe(true);
  });
});

describe("CqMcpSubmitBroker — reject-on-disconnect", () => {
  it("rejects all pending submits when rejectAll() fires", async () => {
    const broker = new CqMcpSubmitBroker();
    const p1 = broker.submit("submit-1");
    const p2 = broker.submit("submit-2");

    broker.rejectAll("channel closed");

    await expect(p1).rejects.toThrow("channel closed");
    await expect(p2).rejects.toThrow("channel closed");
    expect(broker.hasPending("submit-1")).toBe(false);
    expect(broker.hasPending("submit-2")).toBe(false);
  });

  it("clears buffered acks on rejectAll", () => {
    const broker = new CqMcpSubmitBroker();
    broker.ack("submit-1", { ok: true });
    expect(broker.hasBufferedAck("submit-1")).toBe(true);
    broker.rejectAll();
    expect(broker.hasBufferedAck("submit-1")).toBe(false);
  });

  it("rejects a new submit() that races in after rejectAll (fail-fast)", async () => {
    const broker = new CqMcpSubmitBroker();
    broker.rejectAll();
    await expect(broker.submit("submit-late")).rejects.toThrow("channel closed");
  });
});

describe("CqMcpSubmitBroker — replace pending for same submitId", () => {
  it("rejects the prior pending entry when a second submit reuses the submitId", async () => {
    const broker = new CqMcpSubmitBroker();
    const p1 = broker.submit("dup");
    const p2 = broker.submit("dup");
    await expect(p1).rejects.toThrow("replaced");
    broker.ack("dup", { ok: true });
    expect(await p2).toEqual({ ok: true });
  });
});
