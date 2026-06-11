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
  type ModeDelegates,
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

  it("USAGE text includes all three modes and all five native subcommands", () => {
    // modes
    expect(USAGE).toContain("mcp");
    expect(USAGE).toContain("tui");
    expect(USAGE).toContain("web");
    // native subcommands
    expect(USAGE).toContain("init");
    expect(USAGE).toContain("reset");
    expect(USAGE).toContain("erase");
    expect(USAGE).toContain("move-ledger");
    expect(USAGE).toContain("advance-gate");
  });

  it("routes erase to its handler (nonexistent root => refuse exit 2, nothing to erase)", async () => {
    const io = recordingDispatchIo();
    const root = path.join("/tmp", `cq-dispatch-erase-absent-${process.pid}-${Date.now()}`);
    const outcome = await dispatch(["erase", "--cwd", root, "--yes"], io);
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(io.errs.join("\n")).toContain("nothing to erase");
  });
});

/**
 * MODE routing (T387) — smoke check that mcp|tui|web delegate to the matching
 * product's `main` with the post-mode argv VERBATIM, before any native parsing.
 * The full routing matrix is T389; here we only assert the seam wiring with
 * mocked delegates so no real server / Ink render launches.
 */
describe("dispatch MODE routing (mcp|tui|web)", () => {
  function recordingModes(): ModeDelegates & { calls: Record<string, readonly string[][]> } {
    const calls: Record<string, readonly string[][]> = { mcp: [], tui: [], web: [] };
    const record = (k: string) => async (argv: readonly string[]) => {
      (calls[k] as string[][]).push([...argv]);
    };
    return { calls, mcp: record("mcp"), tui: record("tui"), web: record("web") };
  }

  it("delegates each mode with argv.slice(1) verbatim, exit 0, no usage printed", async () => {
    for (const mode of ["mcp", "tui", "web"] as const) {
      const io = recordingDispatchIo();
      const modes = recordingModes();
      const outcome = await dispatch([mode, "--cwd", "X", "extra"], io, modes);
      expect(outcome.exitCode).toBe(0);
      expect(modes.calls[mode]).toEqual([["--cwd", "X", "extra"]]);
      // mode path performs no native parsing and prints nothing of its own.
      expect(io.errs).toEqual([]);
    }
  });

  it("passes a nested subcommand (cq mcp restore --from-cache) verbatim", async () => {
    const io = recordingDispatchIo();
    const modes = recordingModes();
    await dispatch(["mcp", "restore", "--from-cache"], io, modes);
    expect(modes.calls["mcp"]).toEqual([["restore", "--from-cache"]]);
  });

  it("forwards a bare mode (cq tui) as an empty argv", async () => {
    const io = recordingDispatchIo();
    const modes = recordingModes();
    await dispatch(["tui"], io, modes);
    expect(modes.calls["tui"]).toEqual([[]]);
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
      expect(parseSubcommandArgs(["--cwd=/a", "--yes"])).toEqual({ cwd: "/a", yes: true, force: false, to: null, session: null });
      expect(parseSubcommandArgs(["-y", "--cwd", "/b"])).toEqual({ cwd: "/b", yes: true, force: false, to: null, session: null });
      expect(parseSubcommandArgs(["--force"])).toEqual({ cwd: process.cwd(), yes: false, force: true, to: null, session: null });
      expect(parseSubcommandArgs([])).toEqual({ cwd: process.cwd(), yes: false, force: false, to: null, session: null });
      expect(parseSubcommandArgs(["--to", "git"])).toEqual({ cwd: process.cwd(), yes: false, force: false, to: "git", session: null });
      expect(parseSubcommandArgs(["--to=local"])).toEqual({ cwd: process.cwd(), yes: false, force: false, to: "local", session: null });
      expect(parseSubcommandArgs(["--session", "s1"])).toEqual({ cwd: process.cwd(), yes: false, force: false, to: null, session: "s1" });
      expect(parseSubcommandArgs(["--session=s2"])).toEqual({ cwd: process.cwd(), yes: false, force: false, to: null, session: "s2" });
    } finally {
      if (prev !== undefined) process.env["LEDGER_ROOT"] = prev;
    }
  });

  it("throws when --cwd has no value", () => {
    expect(() => parseSubcommandArgs(["--cwd"])).toThrow(/--cwd requires a value/);
  });
});
