/**
 * `cq` argv dispatcher (T188).
 *
 * Asserts the routing contract without spawning the process:
 *   - no subcommand        => usage to stderr, exit 2, no handler invoked.
 *   - unknown subcommand   => usage to stderr, exit 2.
 *   - erase                => routes to its handler (refuses exit 2 on an
 *                             empty/nonexistent root: nothing to erase).
 *   - --cwd / $LEDGER_ROOT / CWD precedence for resolveRoot.
 */

import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import {
  dispatch,
  parseSubcommandArgs,
  resolveRoot,
  EXIT_USAGE,
  USAGE,
  type ConfirmIo,
  type DispatchIo,
} from "../src/main.js";

const silentConfirm: ConfirmIo = {
  isTty: false,
  out: () => {},
  err: () => {},
  prompt: async () => "",
};

function recordingDispatchIo(): DispatchIo & { errs: string[] } {
  const errs: string[] = [];
  return { errs, out: () => {}, err: (l) => errs.push(l), confirm: silentConfirm };
}

describe("dispatch", () => {
  it("no subcommand prints usage to stderr and exits 2", async () => {
    const io = recordingDispatchIo();
    const outcome = await dispatch([], io);
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(io.errs.join("\n")).toBe(USAGE);
  });

  it("unknown subcommand prints usage to stderr and exits 2", async () => {
    const io = recordingDispatchIo();
    const outcome = await dispatch(["badcmd"], io);
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(io.errs.join("\n")).toBe(USAGE);
  });

  it("routes erase to its handler (nonexistent root => refuse exit 2, nothing to erase)", async () => {
    const io = recordingDispatchIo();
    const root = path.join("/tmp", `cq-dispatch-erase-absent-${process.pid}-${Date.now()}`);
    const outcome = await dispatch(["erase", "--cwd", root, "--yes"], io);
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(io.errs.join("\n")).toContain("nothing to erase");
  });
});

describe("resolveRoot precedence (--cwd > $LEDGER_ROOT > CWD)", () => {
  const ENV = "LEDGER_ROOT";

  it("uses --cwd when provided, resolved to absolute", () => {
    const prev = process.env[ENV];
    process.env[ENV] = "/from/env";
    try {
      expect(resolveRoot("/from/arg")).toBe("/from/arg");
      // relative --cwd resolves against the process CWD
      expect(resolveRoot("rel/dir")).toBe(path.resolve("rel/dir"));
    } finally {
      if (prev === undefined) delete process.env[ENV];
      else process.env[ENV] = prev;
    }
  });

  it("falls back to $LEDGER_ROOT when --cwd is absent/empty", () => {
    const prev = process.env[ENV];
    process.env[ENV] = "/from/env";
    try {
      expect(resolveRoot(undefined)).toBe("/from/env");
      expect(resolveRoot("")).toBe("/from/env");
    } finally {
      if (prev === undefined) delete process.env[ENV];
      else process.env[ENV] = prev;
    }
  });

  it("falls back to process CWD when neither is set", () => {
    const prev = process.env[ENV];
    delete process.env[ENV];
    try {
      expect(resolveRoot(undefined)).toBe(process.cwd());
    } finally {
      if (prev !== undefined) process.env[ENV] = prev;
    }
  });
});

describe("parseSubcommandArgs", () => {
  it("parses --yes/-y and --cwd=<path>", () => {
    const prev = process.env["LEDGER_ROOT"];
    delete process.env["LEDGER_ROOT"];
    try {
      expect(parseSubcommandArgs(["--cwd=/a", "--yes"])).toEqual({ cwd: "/a", yes: true, force: false });
      expect(parseSubcommandArgs(["-y", "--cwd", "/b"])).toEqual({ cwd: "/b", yes: true, force: false });
      expect(parseSubcommandArgs(["--force"])).toEqual({ cwd: process.cwd(), yes: false, force: true });
      expect(parseSubcommandArgs([])).toEqual({ cwd: process.cwd(), yes: false, force: false });
    } finally {
      if (prev !== undefined) process.env["LEDGER_ROOT"] = prev;
    }
  });

  it("throws when --cwd has no value", () => {
    expect(() => parseSubcommandArgs(["--cwd"])).toThrow(/--cwd requires a value/);
  });
});
