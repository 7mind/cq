import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { statusBucket, statusColor, isTerminal } from "../src/status.js";
import type { LedgerSchema } from "../src/types.js";
import { REVIEWS_SCHEMA } from "@cq/ledger";

// Resolve chalk via ink's dependency to force ANSI output in tests.
const inkPath = import.meta.resolve("ink");
const chalkPath = import.meta.resolve("chalk", inkPath);
const chalkMod = await import(chalkPath);
const chalk = chalkMod.default ?? chalkMod;

const tasks: LedgerSchema = {
  statusValues: ["planned", "wip", "done", "blocked", "abandoned"],
  terminalStatuses: ["done", "abandoned"],
  fields: {},
};

describe("status buckets", () => {
  it("classifies non-terminal statuses by vocabulary", () => {
    expect(statusBucket("planned", tasks)).toBe("start");
    expect(statusBucket("wip", tasks)).toBe("progress");
    expect(statusBucket("blocked", tasks)).toBe("blocked");
  });

  it("classifies terminal statuses as done vs dropped", () => {
    expect(statusBucket("done", tasks)).toBe("done");
    expect(statusBucket("abandoned", tasks)).toBe("dropped");
    expect(isTerminal("done", tasks)).toBe(true);
    expect(isTerminal("wip", tasks)).toBe(false);
  });

  it("falls back to start for unknown non-terminal statuses", () => {
    const custom: LedgerSchema = {
      statusValues: ["triage", "shipped"],
      terminalStatuses: ["shipped"],
      fields: {},
    };
    expect(statusBucket("triage", custom)).toBe("start");
    expect(statusBucket("shipped", custom)).toBe("done");
  });

  it("maps buckets to distinct ink colors; terminal-dropped is gray", () => {
    expect(statusColor("wip", tasks)).toBe("yellow");
    expect(statusColor("blocked", tasks)).toBe("red");
    expect(statusColor("done", tasks)).toBe("green");
    expect(statusColor("abandoned", tasks)).toBe("gray");
  });
});

describe("warning bucket (reviews schema)", () => {
  it("revise → warning", () => {
    expect(statusBucket("revise", REVIEWS_SCHEMA)).toBe("warning");
  });

  it("go-ahead → done", () => {
    expect(statusBucket("go-ahead", REVIEWS_SCHEMA)).toBe("done");
  });

  it("statusColor: revise → magenta (distinct from yellow used by progress)", () => {
    expect(statusColor("revise", REVIEWS_SCHEMA)).toBe("magenta");
  });

  it("statusColor: go-ahead → green (unchanged)", () => {
    expect(statusColor("go-ahead", REVIEWS_SCHEMA)).toBe("green");
  });
});

// ANSI magenta = [35m; green = [32m.  Force chalk.level=1 so ink
// emits escape codes even in a non-TTY test runner.
const ANSI_MAGENTA = "[35m";
const ANSI_GREEN = "[32m";

describe("ink badge color (warning bucket → magenta)", () => {
  let prevLevel: number;
  beforeAll(() => {
    prevLevel = (chalk as { level: number }).level;
    (chalk as { level: number }).level = 1;
  });
  afterAll(() => {
    (chalk as { level: number }).level = prevLevel;
  });

  it("renders revise badge in magenta (ANSI 35)", () => {
    const color = statusColor("revise", REVIEWS_SCHEMA); // "magenta"
    const r = render(<Text color={color}>revise</Text>);
    const frame = r.lastFrame() ?? "";
    r.unmount();
    expect(frame).toContain(ANSI_MAGENTA);
  });

  it("renders go-ahead badge in green (ANSI 32, unchanged)", () => {
    const color = statusColor("go-ahead", REVIEWS_SCHEMA); // "green"
    const r = render(<Text color={color}>go-ahead</Text>);
    const frame = r.lastFrame() ?? "";
    r.unmount();
    expect(frame).toContain(ANSI_GREEN);
  });
});
