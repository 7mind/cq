import { describe, it, expect } from "bun:test";
import { statusBucket, statusColor, isTerminal } from "../src/status.js";
import type { LedgerSchema } from "../src/types.js";
import { REVIEWS_SCHEMA } from "@cq/ledger";

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
});
