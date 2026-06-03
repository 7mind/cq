/**
 * Unit tests for the pure projection helpers (T142):
 *  - projectCompact: strips all COMPACT_PROJECTION_DENYLIST fields.
 *  - paginate: returns correct stable slices and total counts.
 *
 * No store, no filesystem — pure function tests only.
 */

import { describe, it, expect } from "bun:test";
import type { Item } from "../src/types.js";
import {
  projectCompact,
  paginate,
  COMPACT_PROJECTION_DENYLIST,
  LONG_FIELD_DENYLIST,
  PROJECTION_EXTRA_DENYLIST,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(id: string, fields: Item["fields"]): Item {
  return {
    id,
    milestoneId: "M1",
    status: "open",
    fields,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// COMPACT_PROJECTION_DENYLIST composition
// ---------------------------------------------------------------------------

describe("COMPACT_PROJECTION_DENYLIST", () => {
  it("is a superset of LONG_FIELD_DENYLIST", () => {
    for (const field of LONG_FIELD_DENYLIST) {
      expect(COMPACT_PROJECTION_DENYLIST.has(field)).toBe(true);
    }
  });

  it("includes every PROJECTION_EXTRA_DENYLIST field", () => {
    for (const field of PROJECTION_EXTRA_DENYLIST) {
      expect(COMPACT_PROJECTION_DENYLIST.has(field)).toBe(true);
    }
  });

  it("contains the goals-specific grounding field", () => {
    expect(COMPACT_PROJECTION_DENYLIST.has("grounding")).toBe(true);
  });

  it("contains the questions-specific recommendation and suggestions fields", () => {
    expect(COMPACT_PROJECTION_DENYLIST.has("recommendation")).toBe(true);
    expect(COMPACT_PROJECTION_DENYLIST.has("suggestions")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// projectCompact — goals item with large grounding blob
// ---------------------------------------------------------------------------

describe("projectCompact — goals item", () => {
  const largeGrounding = "x".repeat(10_000);

  const goalsItem = makeItem("G1", {
    title: "Improve throughput",
    description: "Add projection helpers",
    grounding: largeGrounding,
    tags: ["perf"],
  });

  it("strips grounding from a goals item", () => {
    const projected = projectCompact(goalsItem);
    expect(projected.fields).not.toHaveProperty("grounding");
  });

  it("retains title, tags, and other short fields", () => {
    const projected = projectCompact(goalsItem);
    expect(projected.fields.title).toBe("Improve throughput");
    expect(projected.fields.tags).toEqual(["perf"]);
  });

  it("projected item is smaller than the original (no large blob)", () => {
    const projected = projectCompact(goalsItem);
    const originalSize = JSON.stringify(goalsItem).length;
    const projectedSize = JSON.stringify(projected).length;
    expect(projectedSize).toBeLessThan(originalSize);
    // The projected payload must be far smaller when the blob is stripped
    expect(projectedSize).toBeLessThan(originalSize / 10);
  });

  it("strips description (base denylist) as well", () => {
    const projected = projectCompact(goalsItem);
    expect(projected.fields).not.toHaveProperty("description");
  });

  it("preserves intrinsic item properties", () => {
    const projected = projectCompact(goalsItem);
    expect(projected.id).toBe("G1");
    expect(projected.status).toBe("open");
    expect(projected.milestoneId).toBe("M1");
    expect(projected.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(projected.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// projectCompact — questions item with recommendation + suggestions
// ---------------------------------------------------------------------------

describe("projectCompact — questions item", () => {
  const longRecommendation = "r".repeat(5_000);
  const manySuggestions = Array.from({ length: 50 }, (_, i) => `suggestion-${i}`);

  const questionsItem = makeItem("Q42", {
    question: "Which projection fields to strip?",
    context: "See Q76 for background",
    recommendation: longRecommendation,
    suggestions: manySuggestions,
    answer: "All long narrative fields",
    tags: ["projection"],
  });

  it("strips recommendation", () => {
    const projected = projectCompact(questionsItem);
    expect(projected.fields).not.toHaveProperty("recommendation");
  });

  it("strips suggestions", () => {
    const projected = projectCompact(questionsItem);
    expect(projected.fields).not.toHaveProperty("suggestions");
  });

  it("strips context (base denylist) and answer (base denylist)", () => {
    const projected = projectCompact(questionsItem);
    expect(projected.fields).not.toHaveProperty("context");
    expect(projected.fields).not.toHaveProperty("answer");
  });

  it("retains question and tags", () => {
    const projected = projectCompact(questionsItem);
    expect(projected.fields.question).toBe("Which projection fields to strip?");
    expect(projected.fields.tags).toEqual(["projection"]);
  });

  it("projected item is substantially smaller than the original", () => {
    const projected = projectCompact(questionsItem);
    const originalSize = JSON.stringify(questionsItem).length;
    const projectedSize = JSON.stringify(projected).length;
    expect(projectedSize).toBeLessThan(originalSize / 5);
  });
});

// ---------------------------------------------------------------------------
// projectCompact — item with every denylist field present
// ---------------------------------------------------------------------------

describe("projectCompact — all denylist fields stripped", () => {
  // Construct a single item that carries every field from COMPACT_PROJECTION_DENYLIST
  // plus a safe short field ("safeField") that must survive.
  const allDenyFields: Item["fields"] = {};
  for (const field of COMPACT_PROJECTION_DENYLIST) {
    allDenyFields[field] = `value-of-${field}`;
  }
  const item = makeItem("T99", { ...allDenyFields, safeField: "keep-me" });

  it("strips every field in COMPACT_PROJECTION_DENYLIST", () => {
    const projected = projectCompact(item);
    for (const field of COMPACT_PROJECTION_DENYLIST) {
      expect(projected.fields).not.toHaveProperty(field);
    }
  });

  it("retains the safe short field", () => {
    const projected = projectCompact(item);
    expect(projected.fields.safeField).toBe("keep-me");
  });
});

// ---------------------------------------------------------------------------
// projectCompact — does not mutate the original item
// ---------------------------------------------------------------------------

describe("projectCompact — immutability", () => {
  it("does not mutate the input item", () => {
    const item = makeItem("D5", {
      headline: "Bug in parser",
      description: "Long description here",
      rootCause: "Off-by-one error",
    });
    projectCompact(item);
    // Original item is unchanged
    expect(item.fields).toHaveProperty("description");
    expect(item.fields).toHaveProperty("rootCause");
  });
});

// ---------------------------------------------------------------------------
// paginate — basic slicing
// ---------------------------------------------------------------------------

describe("paginate", () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]; // 10 elements

  it("returns correct total", () => {
    const result = paginate(items, 0, 5);
    expect(result.total).toBe(10);
  });

  it("slices from offset with limit", () => {
    const result = paginate(items, 2, 3);
    expect(result.items).toEqual([2, 3, 4]);
    expect(result.total).toBe(10);
  });

  it("offset=0, limit=all returns everything", () => {
    const result = paginate(items, 0, 10);
    expect(result.items).toEqual(items);
  });

  it("undefined limit returns all items from offset", () => {
    const result = paginate(items, 3);
    expect(result.items).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(result.total).toBe(10);
  });

  it("limit=0 returns all items from offset", () => {
    const result = paginate(items, 3, 0);
    expect(result.items).toEqual([3, 4, 5, 6, 7, 8, 9]);
  });

  it("offset beyond end returns empty slice with correct total", () => {
    const result = paginate(items, 100, 5);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(10);
  });

  it("negative offset is clamped to 0", () => {
    const result = paginate(items, -5, 3);
    expect(result.items).toEqual([0, 1, 2]);
    expect(result.total).toBe(10);
  });

  it("limit that exceeds remaining items is clamped to end", () => {
    const result = paginate(items, 8, 100);
    expect(result.items).toEqual([8, 9]);
    expect(result.total).toBe(10);
  });

  it("empty array returns empty slice with total=0", () => {
    const result = paginate([], 0, 10);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("last page boundary", () => {
    // 10 items, page size 3: last page = offset 9, limit 3 → one item
    const result = paginate(items, 9, 3);
    expect(result.items).toEqual([9]);
    expect(result.total).toBe(10);
  });

  it("preserves stable ordering (no sort applied)", () => {
    const unsorted = [5, 3, 8, 1, 4];
    const result = paginate(unsorted, 1, 3);
    expect(result.items).toEqual([3, 8, 1]);
  });
});
