import { describe, it, expect } from "bun:test";
import {
  statusBucket,
  isTerminal,
  statusMatchesFilter,
  filterToValue,
  valueToFilter,
} from "../src/status";
import type { LedgerSchema } from "../src/types";
import { REVIEWS_SCHEMA } from "@cq/ledger";

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
