import { describe, expect, it } from "bun:test";
import { parseConfig, CqConfigError } from "@cq/config";
import { dispatch, EXIT_USAGE } from "../src/main.js";

describe("public backend=postgres CLI matrix retired (T736)", () => {
  it("cq.toml cannot name backend=postgres", () => {
    expect(() => parseConfig(`[ledger]\nbackend = "postgres"\n`)).toThrow(CqConfigError);
  });

  it("migrate --to postgres is refused", async () => {
    const outcome = await dispatch(["migrate", "--to", "postgres"], {
      out: () => undefined,
      err: () => undefined,
      confirm: {
        isTty: false,
        out: () => undefined,
        err: () => undefined,
        prompt: async () => "",
      },
    });
    expect(outcome.exitCode).toBe(EXIT_USAGE);
  });
});
