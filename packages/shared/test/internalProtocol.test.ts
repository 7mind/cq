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
      type: "ask.request",
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
