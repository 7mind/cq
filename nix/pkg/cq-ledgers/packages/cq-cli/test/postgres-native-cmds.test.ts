import { describe, expect, it } from "bun:test";
import { parseConfig, CqConfigError } from "@cq/config";

describe("public backend=postgres native CLI retired (T736)", () => {
  it("cq.toml cannot name backend=postgres", () => {
    expect(() => parseConfig(`[ledger]\nbackend = "postgres"\n`)).toThrow(CqConfigError);
  });
});
