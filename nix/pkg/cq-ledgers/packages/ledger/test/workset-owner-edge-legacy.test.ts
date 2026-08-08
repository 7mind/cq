/**
 * T1951 — legacy / advisory ownership rules for the workset owner-edge matrix.
 *
 * Advisory `ledgerRefs` never establish ownership. Partial or malformed sealed
 * fields are ambiguous and fail closed. Only a complete sealed pair is
 * accepted as canonical ownership.
 */

import { describe, it, expect } from "bun:test";
import {
  WORKSET_OWNER_REF_FIELD,
  WORKSET_OWNER_EDGE_KIND_FIELD,
  ownershipFromLedgerRefs,
  inferLegacyOwnership,
  isAmbiguousLegacyOwnership,
  readCanonicalOwnership,
  type Item,
} from "../src/index.js";

function item(fields: Record<string, unknown>): Item {
  return {
    id: "X1",
    milestoneId: "M-AMBIENT",
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    fields: fields as Item["fields"],
  };
}

describe("workset owner-edge legacy — ledgerRefs never own", () => {
  it("ownershipFromLedgerRefs is total null", () => {
    expect(ownershipFromLedgerRefs(undefined)).toBeNull();
    expect(ownershipFromLedgerRefs([])).toBeNull();
    expect(ownershipFromLedgerRefs(["goals:G1"])).toBeNull();
    expect(ownershipFromLedgerRefs(["ideas:I1", "goals:G1", "reviews:R1"])).toBeNull();
  });

  it("inferLegacyOwnership ignores ledgerRefs-only items", () => {
    const legacy = item({
      ledgerRefs: ["goals:G1", "reviews:R9"],
      headline: "review-filed defect linked only by ledgerRefs",
    });
    expect(inferLegacyOwnership(legacy)).toBeNull();
    expect(isAmbiguousLegacyOwnership(legacy)).toBe(false);
    expect(readCanonicalOwnership(legacy)).toBeNull();
  });
});

describe("workset owner-edge legacy — sealed fields", () => {
  it("accepts a complete sealed owner pair", () => {
    const sealed = item({
      [WORKSET_OWNER_REF_FIELD]: "goals:G1",
      [WORKSET_OWNER_EDGE_KIND_FIELD]: "review-filed-defect",
      ledgerRefs: ["goals:G1", "reviews:R1"],
    });
    expect(inferLegacyOwnership(sealed)).toEqual({
      ownerRef: "goals:G1",
      edgeKind: "review-filed-defect",
    });
    expect(readCanonicalOwnership(sealed)).toEqual({
      ownerRef: "goals:G1",
      edgeKind: "review-filed-defect",
    });
    expect(isAmbiguousLegacyOwnership(sealed)).toBe(false);
  });

  it("treats partial sealed fields as ambiguous and excluded", () => {
    const refOnly = item({ [WORKSET_OWNER_REF_FIELD]: "goals:G1" });
    expect(inferLegacyOwnership(refOnly)).toBeNull();
    expect(isAmbiguousLegacyOwnership(refOnly)).toBe(true);
    expect(readCanonicalOwnership(refOnly)).toBeNull();

    const kindOnly = item({ [WORKSET_OWNER_EDGE_KIND_FIELD]: "review" });
    expect(inferLegacyOwnership(kindOnly)).toBeNull();
    expect(isAmbiguousLegacyOwnership(kindOnly)).toBe(true);
    expect(readCanonicalOwnership(kindOnly)).toBeNull();
  });

  it("treats malformed sealed pairs as ambiguous", () => {
    const badRef = item({
      [WORKSET_OWNER_REF_FIELD]: "not-a-ref",
      [WORKSET_OWNER_EDGE_KIND_FIELD]: "review",
    });
    expect(inferLegacyOwnership(badRef)).toBeNull();
    expect(isAmbiguousLegacyOwnership(badRef)).toBe(true);
    expect(readCanonicalOwnership(badRef)).toBeNull();

    const badKind = item({
      [WORKSET_OWNER_REF_FIELD]: "goals:G1",
      [WORKSET_OWNER_EDGE_KIND_FIELD]: "not-an-edge-kind",
    });
    expect(inferLegacyOwnership(badKind)).toBeNull();
    expect(isAmbiguousLegacyOwnership(badKind)).toBe(true);
    expect(readCanonicalOwnership(badKind)).toBeNull();
  });

  it("does not treat empty items as ambiguous", () => {
    const empty = item({ headline: "unrelated" });
    expect(inferLegacyOwnership(empty)).toBeNull();
    expect(isAmbiguousLegacyOwnership(empty)).toBe(false);
    expect(readCanonicalOwnership(empty)).toBeNull();
  });
});
