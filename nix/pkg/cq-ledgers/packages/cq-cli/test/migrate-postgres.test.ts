import { describe, expect, it } from "bun:test";
import { dispatch, EXIT_USAGE } from "../src/main.js";

describe("cq migrate --to postgres is retired (T736)", () => {
  it("refuses the public postgres target", async () => {
    const errs: string[] = [];
    const outcome = await dispatch(["migrate", "--to", "postgres"], {
      out: () => undefined,
      err: (line) => errs.push(line),
      confirm: {
        isTty: false,
        out: () => undefined,
        err: () => undefined,
        prompt: async () => "",
      },
    });
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(errs.join("\n")).toMatch(/remote|--to postgres|retired/i);
  });
});
