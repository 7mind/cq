import { describe, expect, it } from "bun:test";
import {
  UsageTracker,
  measureUtf8JsonBytes,
  measureUtf8TextBytes,
} from "../src/usageStats.js";

describe("UsageTracker (T1508)", () => {
  it("empty snapshot has no endpoints and zero totals", () => {
    const tracker = new UsageTracker();
    expect(tracker.snapshot()).toEqual({
      endpoints: [],
      totals: { name: "totals", callCount: 0, bytesIn: 0, bytesOut: 0 },
    });
  });

  it("accumulates calls and bytes per endpoint and aggregates totals", () => {
    const tracker = new UsageTracker();
    tracker.record("fetch_ledger", 10, 100);
    tracker.record("fetch_ledger", 20, 200);
    tracker.record("update_item", 5, 50);
    const snapshot = tracker.snapshot();
    expect(snapshot.endpoints).toEqual([
      { name: "fetch_ledger", callCount: 2, bytesIn: 30, bytesOut: 300 },
      { name: "update_item", callCount: 1, bytesIn: 5, bytesOut: 50 },
    ]);
    expect(snapshot.totals).toEqual({ name: "totals", callCount: 3, bytesIn: 35, bytesOut: 350 });
  });

  it("sorts endpoints by name with a stable locale order", () => {
    const tracker = new UsageTracker();
    for (const name of ["update_item", "archive_milestone", "fetch_ledger", "create_item"]) {
      tracker.record(name, 1, 1);
    }
    expect(tracker.snapshot().endpoints.map((endpoint) => endpoint.name)).toEqual([
      "archive_milestone",
      "create_item",
      "fetch_ledger",
      "update_item",
    ]);
  });
});

describe("byte measurement helpers (T1508)", () => {
  it("measures multi-byte UTF-8 text in bytes, not characters", () => {
    expect(measureUtf8TextBytes("ascii")).toBe(5);
    expect(measureUtf8TextBytes("héllo")).toBe(6); // é is 2 bytes
    expect(measureUtf8TextBytes("日本語")).toBe(9); // 3 bytes per character
    expect(measureUtf8TextBytes("🚀")).toBe(4);
  });

  it("measures the canonical JSON serialization of a value in UTF-8 bytes", () => {
    expect(measureUtf8JsonBytes(null)).toBe(4);
    expect(measureUtf8JsonBytes({ a: 1 })).toBe(7);
    expect(measureUtf8JsonBytes("héllo")).toBe(8); // quotes + 6 bytes
    expect(measureUtf8JsonBytes([1, 2, 3])).toBe(7);
  });
});
