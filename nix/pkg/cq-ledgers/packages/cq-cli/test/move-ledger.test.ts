/**
 * `cq move-ledger` — RETIRED (T505).
 *
 * The fs<->git-object transplant (T354) migrated between two LEGACY primaries
 * that are no longer selectable at runtime; `cq migrate` (legacy → xdg)
 * supersedes it. The subcommand token stays recognised so an old invocation
 * gets a pointed, actionable error (naming `cq migrate`) instead of the
 * generic usage dump. This suite pins that repoint contract.
 */

import { describe, it, expect } from "bun:test";
import { dispatch, EXIT_USAGE, USAGE, type ConfirmIo, type DispatchIo } from "../src/main.js";

const silentConfirm: ConfirmIo = {
  isTty: false,
  out: () => {},
  err: () => {},
  prompt: async () => "",
};

function recordingIo(): DispatchIo & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return { outs, errs, out: (l) => outs.push(l), err: (l) => errs.push(l), confirm: silentConfirm };
}

describe("cq move-ledger (retired, T505)", () => {
  it("errors with exit 2 pointing at `cq migrate` (bare invocation)", async () => {
    const io = recordingIo();
    const outcome = await dispatch(["move-ledger"], io);
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(outcome.longRunning).toBe(false);
    const err = io.errs.join("\n");
    expect(err).toContain("cq migrate");
    expect(err).toContain("RETIRED");
    // The pointed error, not the generic usage dump.
    expect(err).not.toBe(USAGE);
  });

  it("errors identically regardless of the old flags (--to/--force/--cwd ignored)", async () => {
    const io = recordingIo();
    const outcome = await dispatch(
      ["move-ledger", "--to", "git", "--force", "--cwd", "/nonexistent"],
      io,
    );
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(io.errs.join("\n")).toContain("cq migrate");
  });

  it("USAGE documents the retirement pointing at cq migrate", () => {
    expect(USAGE).toContain("move-ledger");
    expect(USAGE).toContain("RETIRED");
  });
});
