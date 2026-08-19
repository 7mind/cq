import { describe, expect, it } from "bun:test";
import { parseConfig, CqConfigError } from "@cq/config";

describe("cq mcp --http over backend=postgres retired (T736)", () => {
  it("cq.toml cannot name backend=postgres", () => {
    expect(() => parseConfig(`[ledger]\nbackend = "postgres"\n`)).toThrow(CqConfigError);
  });
});
