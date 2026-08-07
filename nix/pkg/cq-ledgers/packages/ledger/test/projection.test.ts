/**
 * Unit tests for paginate (T142). Legacy denylist projector removed (wire allowlist is sole compact authority).
 */

import { describe, it, expect } from "bun:test";
import { paginate } from "../src/index.js";

describe("paginate", () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

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
});
