/**
 * refs.ts — `<ledger>:<id>` cross-ledger ref grammar (T549, G80/M245).
 *
 * Covers: bare→prefixed resolution (single- and multi-letter idPrefix),
 * prefixed idempotence, exact-alpha-prefix disambiguation (H5 vs HO5),
 * unknown-prefix / malformed-input rejection, and end-to-end resolution of
 * every canonical ledger prefix via `CANONICAL_LEDGERS`.
 */

import { describe, it, expect } from "bun:test";
import {
  parseRef,
  buildPrefixRegistry,
  canonicalizeRef,
  RefParseError,
} from "../src/refs.js";
import { CANONICAL_LEDGERS } from "../src/constants.js";
import type { LedgerSchema } from "../src/types.js";

const canonicalRegistry = buildPrefixRegistry(CANONICAL_LEDGERS);

describe("parseRef", () => {
  it("parses a bare id", () => {
    expect(parseRef("T523")).toEqual({ kind: "bare", bare: "T523" });
  });

  it("parses a multi-letter bare prefix", () => {
    expect(parseRef("HO4")).toEqual({ kind: "bare", bare: "HO4" });
  });

  it("parses a prefixed ref, splitting on the first colon", () => {
    expect(parseRef("tasks:T5")).toEqual({ kind: "prefixed", ledger: "tasks", id: "T5" });
  });

  it("splits only on the FIRST colon, folding extra colons into the id (then rejects them)", () => {
    expect(() => parseRef("tasks:T5:extra")).toThrow(RefParseError);
  });

  it.each(["", "t5", "tasks:", ":T5", "123"])("rejects malformed input %p", (raw) => {
    expect(() => parseRef(raw)).toThrow(RefParseError);
  });
});

describe("buildPrefixRegistry", () => {
  it("maps idPrefix to ledger name", () => {
    const schema: LedgerSchema = {
      statusValues: ["open"],
      terminalStatuses: [],
      idPrefix: "X",
      fields: {},
    };
    const registry = buildPrefixRegistry([{ name: "widgets", schema }]);
    expect(registry.get("X")).toBe("widgets");
  });

  it("defaults idPrefix to the first uppercase letter of the ledger name when schema.idPrefix is absent", () => {
    const schema: LedgerSchema = { statusValues: ["open"], terminalStatuses: [], fields: {} };
    const registry = buildPrefixRegistry([{ name: "widgets", schema }]);
    expect(registry.get("W")).toBe("widgets");
  });

  it("resolves every canonical ledger's idPrefix from CANONICAL_LEDGERS", () => {
    for (const { name, schema } of CANONICAL_LEDGERS) {
      const prefix = schema.idPrefix;
      expect(prefix).toBeDefined();
      expect(canonicalRegistry.get(prefix as string)).toBe(name);
    }
  });
});

describe("canonicalizeRef", () => {
  it("resolves a bare tasks id", () => {
    expect(canonicalizeRef("T523", canonicalRegistry)).toBe("tasks:T523");
  });

  it("resolves a bare defects id", () => {
    expect(canonicalizeRef("D84", canonicalRegistry)).toBe("defects:D84");
  });

  it("resolves a bare handoffs id (multi-letter idPrefix)", () => {
    expect(canonicalizeRef("HO4", canonicalRegistry)).toBe("handoffs:HO4");
  });

  it("is idempotent on an already-prefixed ref", () => {
    expect(canonicalizeRef("tasks:T5", canonicalRegistry)).toBe("tasks:T5");
  });

  it("distinguishes H5 (hypothesis) from HO5 (handoffs) by exact alpha-prefix match", () => {
    expect(canonicalizeRef("H5", canonicalRegistry)).toBe("hypothesis:H5");
    expect(canonicalizeRef("HO5", canonicalRegistry)).toBe("handoffs:HO5");
  });

  it("throws on an unknown alpha prefix", () => {
    expect(() => canonicalizeRef("Z9", canonicalRegistry)).toThrow(RefParseError);
  });

  it("throws on an unknown ledger name in an already-prefixed ref", () => {
    expect(() => canonicalizeRef("bogus:T5", canonicalRegistry)).toThrow(RefParseError);
  });

  it.each(["", "t5", "tasks:", ":T5", "123"])("throws on malformed input %p", (raw) => {
    expect(() => canonicalizeRef(raw, canonicalRegistry)).toThrow(RefParseError);
  });

  it("resolves every canonical ledger's idPrefix end-to-end via CANONICAL_LEDGERS", () => {
    for (const { name, schema } of CANONICAL_LEDGERS) {
      const prefix = schema.idPrefix as string;
      const bareId = `${prefix}1`;
      expect(canonicalizeRef(bareId, canonicalRegistry)).toBe(`${name}:${bareId}`);
    }
  });
});
