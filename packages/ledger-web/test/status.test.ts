import { describe, it, expect } from "bun:test";
import {
  statusBucket,
  isTerminal,
  statusMatchesFilter,
  filterToValue,
  valueToFilter,
  BUCKET_HEX,
  type StatusBucket,
} from "../src/status";
import type { LedgerSchema } from "../src/types";
import { REVIEWS_SCHEMA } from "@cq/ledger";

// The complete StatusBucket union, spelled out so the test fails to compile if
// a member is added/removed without updating BUCKET_HEX (the `satisfies` below
// pins this list to the union).
const ALL_BUCKETS = [
  "start",
  "progress",
  "ready",
  "blocked",
  "done",
  "dropped",
  "warning",
] as const satisfies readonly StatusBucket[];

const bugs: LedgerSchema = {
  statusValues: ["open", "wip", "closed"],
  terminalStatuses: ["closed"],
  fields: {},
};

describe("web status helper", () => {
  it("buckets statuses (terminal → done, blocked, progress, start)", () => {
    expect(statusBucket("open", bugs)).toBe("start");
    expect(statusBucket("wip", bugs)).toBe("progress");
    expect(statusBucket("closed", bugs)).toBe("done");
    const tasks: LedgerSchema = {
      statusValues: ["planned", "blocked", "abandoned"],
      terminalStatuses: ["abandoned"],
      fields: {},
    };
    expect(statusBucket("blocked", tasks)).toBe("blocked");
    expect(statusBucket("abandoned", tasks)).toBe("dropped");
  });

  it("matches the filter predicates", () => {
    expect(statusMatchesFilter("open", bugs, { kind: "all" })).toBe(true);
    expect(statusMatchesFilter("open", bugs, { kind: "active" })).toBe(true);
    expect(statusMatchesFilter("closed", bugs, { kind: "active" })).toBe(false);
    expect(statusMatchesFilter("closed", bugs, { kind: "terminal" })).toBe(true);
    expect(statusMatchesFilter("wip", bugs, { kind: "status", value: "wip" })).toBe(true);
    expect(statusMatchesFilter("open", bugs, { kind: "status", value: "wip" })).toBe(false);
    expect(isTerminal("closed", bugs)).toBe(true);
  });

  it("round-trips a filter through its <select> value", () => {
    expect(valueToFilter(filterToValue({ kind: "all" }))).toEqual({ kind: "all" });
    expect(valueToFilter(filterToValue({ kind: "terminal" }))).toEqual({ kind: "terminal" });
    expect(valueToFilter(filterToValue({ kind: "status", value: "wip" }))).toEqual({
      kind: "status",
      value: "wip",
    });
  });
});

describe("warning bucket (reviews schema)", () => {
  it("revise → warning", () => {
    expect(statusBucket("revise", REVIEWS_SCHEMA)).toBe("warning");
  });

  it("go-ahead → done", () => {
    expect(statusBucket("go-ahead", REVIEWS_SCHEMA)).toBe("done");
  });
});

describe("BUCKET_HEX palette", () => {
  it("has exactly one entry per StatusBucket union member", () => {
    expect(new Set(Object.keys(BUCKET_HEX))).toEqual(new Set(ALL_BUCKETS));
    expect(Object.keys(BUCKET_HEX).length).toBe(ALL_BUCKETS.length);
  });

  it("has a warning entry (amber/orange per Q34)", () => {
    expect(BUCKET_HEX.warning).toBe("#e0a341");
  });

  it("maps every bucket to a hex color", () => {
    for (const bucket of ALL_BUCKETS) {
      expect(BUCKET_HEX[bucket]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
