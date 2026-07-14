/**
 * `cq` argv dispatcher (T188 / T387 / T389).
 *
 * Asserts the routing contract without spawning the process:
 *   - no subcommand        => usage to stderr, exit 2, no handler invoked.
 *   - unknown subcommand   => usage to stderr, exit 2.
 *   - erase                => routes to its handler (refuses exit 2 on an
 *                             empty/nonexistent root: nothing to erase).
 *   - --cwd / $LEDGER_ROOT / CWD precedence for resolveRoot.
 *   - mode routing (T387): mcp|tui|web delegates verbatim; resolveRoot not invoked.
 *   - native-subcommand regression-guard (T389): native subcommands route to
 *     their handlers even when a mode-delegate recorder is injected.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  dispatch,
  parseSubcommandArgs,
  resolveRoot,
  EXIT_USAGE,
  USAGE,
  CQ_CONFIG_FILENAME,
  type ConfirmIo,
  type DispatchIo,
  type ModeDelegates,
} from "../src/main.js";

// ---------------------------------------------------------------------------
// Shared helpers (module-scoped — defined EXACTLY ONCE)
// ---------------------------------------------------------------------------

/**
 * A recording ModeDelegates stub: each mode records the argv arrays it was
 * called with.  All describe blocks that need it use THIS single definition.
 */
function recordingModes(): ModeDelegates & { calls: Record<string, readonly string[][]> } {
  const calls: Record<string, readonly string[][]> = { mcp: [], tui: [], web: [] };
  const record = (k: string) => async (argv: readonly string[]) => {
    (calls[k] as string[][]).push([...argv]);
  };
  return { calls, mcp: record("mcp"), tui: record("tui"), web: record("web") };
}

// Temp dirs created by (e) tests; cleaned up in afterAll.
const tempDirs: string[] = [];
afterAll(async () => {
  for (const d of tempDirs) {
    try {
      await rm(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup — swallow errors
    }
  }
});

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
    expect(outcome.longRunning).toBe(false);
    expect(io.errs.join("\n")).toBe(USAGE);
  });

  it("unknown subcommand prints usage to stderr and exits 2", async () => {
    const io = recordingDispatchIo();
    const outcome = await dispatch(["badcmd"], io);
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(outcome.longRunning).toBe(false);
    expect(io.errs.join("\n")).toBe(USAGE);
  });

  it("USAGE text includes all three modes and all six native subcommands", () => {
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
    expect(USAGE).toContain("log put");
  });

  it("routes erase to its handler (nonexistent root => refuse exit 2, nothing to erase)", async () => {
    const io = recordingDispatchIo();
    const root = path.join("/tmp", `cq-dispatch-erase-absent-${process.pid}-${Date.now()}`);
    const outcome = await dispatch(["erase", "--cwd", root, "--yes"], io);
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(outcome.longRunning).toBe(false);
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
  it("delegates each mode with argv.slice(1) verbatim, exit 0, longRunning true, no usage printed", async () => {
    for (const mode of ["mcp", "tui", "web"] as const) {
      const io = recordingDispatchIo();
      const modes = recordingModes();
      const outcome = await dispatch([mode, "--cwd", "X", "extra"], io, modes);
      expect(outcome.exitCode).toBe(0);
      expect(outcome.longRunning).toBe(true);
      expect(modes.calls[mode]).toEqual([["--cwd", "X", "extra"]]);
      // mode path performs no native parsing and prints nothing of its own.
      expect(io.errs).toEqual([]);
    }
  });

  it("passes nested post-mode tokens (cq mcp --tool-prefix myproj) verbatim", async () => {
    const io = recordingDispatchIo();
    const modes = recordingModes();
    const outcome = await dispatch(["mcp", "--tool-prefix", "myproj"], io, modes);
    expect(outcome.longRunning).toBe(true);
    expect(modes.calls["mcp"]).toEqual([["--tool-prefix", "myproj"]]);
  });

  it("forwards a bare mode (cq tui) as an empty argv", async () => {
    const io = recordingDispatchIo();
    const modes = recordingModes();
    const outcome = await dispatch(["tui"], io, modes);
    expect(outcome.longRunning).toBe(true);
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
      expect(parseSubcommandArgs(["--cwd=/a", "--yes"])).toEqual({ cwd: "/a", yes: true, force: false, session: null });
      expect(parseSubcommandArgs(["-y", "--cwd", "/b"])).toEqual({ cwd: "/b", yes: true, force: false, session: null });
      expect(parseSubcommandArgs(["--force"])).toEqual({ cwd: process.cwd(), yes: false, force: true, session: null });
      expect(parseSubcommandArgs([])).toEqual({ cwd: process.cwd(), yes: false, force: false, session: null });
      expect(parseSubcommandArgs(["--session", "s1"])).toEqual({ cwd: process.cwd(), yes: false, force: false, session: "s1" });
      expect(parseSubcommandArgs(["--session=s2"])).toEqual({ cwd: process.cwd(), yes: false, force: false, session: "s2" });
    } finally {
      if (prev !== undefined) process.env["LEDGER_ROOT"] = prev;
    }
  });

  it("throws when --cwd has no value", () => {
    expect(() => parseSubcommandArgs(["--cwd"])).toThrow(/--cwd requires a value/);
  });
});

/**
 * (c) MODE routing passes a RELATIVE --cwd VERBATIM to the delegate (T389).
 *
 * The MODE path calls `modes[mode](argv.slice(1))` directly — it does NOT call
 * `parseSubcommandArgs`, which is the only site that calls `resolveRoot`.
 * Therefore any relative `--cwd` value arrives at the delegate UNCHANGED.
 *
 * Direct proof: `resolveRoot("./rel/dir")` returns `path.resolve("./rel/dir")`
 * (an absolute path starting with '/').  If the delegate receives the original
 * relative string, it proves `resolveRoot` was never invoked on the mode path.
 */
describe("dispatch MODE routing — relative --cwd reaches delegate verbatim (T389 case c)", () => {
  const RELATIVE_CWD_SPACE = "./some/relative/path";
  const RELATIVE_CWD_EQ = "relative/no-dot";

  it("space form (--cwd <rel>): delegate receives the relative string unchanged, not an absolute path", async () => {
    const io = recordingDispatchIo();
    const modes = recordingModes();
    const outcome = await dispatch(["mcp", "--cwd", RELATIVE_CWD_SPACE, "extra"], io, modes);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.longRunning).toBe(true);
    expect(modes.calls["mcp"]).toEqual([["--cwd", RELATIVE_CWD_SPACE, "extra"]]);
    // resolveRoot(RELATIVE_CWD_SPACE) === path.resolve(RELATIVE_CWD_SPACE), which is
    // absolute (starts with '/').  The delegate received the relative string, so
    // resolveRoot was NOT called on the mode path.
    const resolvedEquivalent = path.resolve(RELATIVE_CWD_SPACE);
    expect(resolvedEquivalent).not.toBe(RELATIVE_CWD_SPACE); // sanity: resolve changes a relative path
    const deliveredArgv = modes.calls["mcp"]![0]!;
    expect(deliveredArgv).not.toContain(resolvedEquivalent); // the absolute form is absent
    expect(deliveredArgv).toContain(RELATIVE_CWD_SPACE);     // the relative form is present verbatim
  });

  it("= form (--cwd=<rel>): delegate receives the relative string unchanged, not an absolute path", async () => {
    const io = recordingDispatchIo();
    const modes = recordingModes();
    const outcome = await dispatch(["tui", `--cwd=${RELATIVE_CWD_EQ}`], io, modes);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.longRunning).toBe(true);
    expect(modes.calls["tui"]).toEqual([[`--cwd=${RELATIVE_CWD_EQ}`]]);
    const resolvedEquivalent = path.resolve(RELATIVE_CWD_EQ);
    expect(resolvedEquivalent).not.toBe(RELATIVE_CWD_EQ);
    const deliveredArgv = modes.calls["tui"]![0]!;
    expect(deliveredArgv.some((a) => a.includes(resolvedEquivalent))).toBe(false);
    expect(deliveredArgv).toContain(`--cwd=${RELATIVE_CWD_EQ}`);
  });
});

/**
 * (e) Native-subcommand regression-guard with injected ModeDelegates (T389).
 *
 * Injects a recordingModes() stub alongside each native dispatch call.  After
 * the call, `modes.calls` for every key MUST still be empty — confirming the
 * native subcommand path does NOT reach the mode delegate, even when one is
 * present.  The handler's own observable effect is also checked to confirm it
 * actually fired.
 */
describe("dispatch native subcommands — mode delegate never fires (T389 case e)", () => {
  it("init: routes to runInit; no mode delegate fired", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cq-t389-init-"));
    tempDirs.push(root);
    // Pin backend='xdg' with an explicit projectId (this plain tmp dir has no
    // git identity) and point XDG_STATE_HOME at a temp dir — irrelevant to
    // what THIS test asserts (dispatch routing, not backend selection), but
    // required for runInit's store construction to succeed (T505: the legacy
    // fs backend no longer constructs).
    await writeFile(
      path.join(root, CQ_CONFIG_FILENAME),
      '[ledger]\nbackend = "xdg"\nprojectId = "cq-t389-init"\n',
      "utf8",
    );
    const xdgHome = await mkdtemp(path.join(tmpdir(), "cq-t389-xdg-"));
    tempDirs.push(xdgHome);
    const prevStateHome = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = xdgHome;
    try {
      const io = recordingDispatchIo();
      const modes = recordingModes();
      const outcome = await dispatch(["init", "--cwd", root], io, modes);

      // handler fired: init succeeds (exit 0) and emits an "initialised" message
      expect(outcome.exitCode).toBe(0);
      expect(outcome.longRunning).toBe(false);
      expect(io.errs).toEqual([]);

      // mode delegates not touched
      expect(modes.calls["mcp"]).toEqual([]);
      expect(modes.calls["tui"]).toEqual([]);
      expect(modes.calls["web"]).toEqual([]);
    } finally {
      if (prevStateHome === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = prevStateHome;
    }
  });

  it("erase: routes to runErase (absent root → EXIT_USAGE); no mode delegate fired", async () => {
    // Use a non-existent path so erase refuses with "nothing to erase" (EXIT_USAGE).
    // No temp dir to create here — the path must not exist.
    const root = path.join(tmpdir(), `cq-t389-erase-absent-${process.pid}-${Date.now()}`);
    const io = recordingDispatchIo();
    const modes = recordingModes();
    const outcome = await dispatch(["erase", "--cwd", root, "--yes"], io, modes);

    // handler fired: erase refuses on an absent root
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(outcome.longRunning).toBe(false);
    expect(io.errs.join("\n")).toContain("nothing to erase");

    // mode delegates not touched
    expect(modes.calls["mcp"]).toEqual([]);
    expect(modes.calls["tui"]).toEqual([]);
    expect(modes.calls["web"]).toEqual([]);
  });

  it("advance-gate: routes to runAdvanceGate (no marker → allow, exit 0); no mode delegate fired", async () => {
    // Seed a fresh root and use a temp XDG_RUNTIME_DIR so no real marker is found.
    const root = await mkdtemp(path.join(tmpdir(), "cq-t389-gate-"));
    tempDirs.push(root);
    const runtimeDir = await mkdtemp(path.join(tmpdir(), "cq-t389-rt-"));
    tempDirs.push(runtimeDir);
    const prevXdg = process.env["XDG_RUNTIME_DIR"];
    process.env["XDG_RUNTIME_DIR"] = runtimeDir;
    try {
      const io = recordingDispatchIo();
      const modes = recordingModes();
      const outcome = await dispatch(
        ["advance-gate", "--cwd", root, "--session", "t389-test"],
        io,
        modes,
      );

      // handler fired: advance-gate exits (no marker → allow, not EXIT_USAGE)
      expect(outcome.exitCode).not.toBe(EXIT_USAGE);
      expect(outcome.longRunning).toBe(false);

      // mode delegates not touched
      expect(modes.calls["mcp"]).toEqual([]);
      expect(modes.calls["tui"]).toEqual([]);
      expect(modes.calls["web"]).toEqual([]);
    } finally {
      if (prevXdg === undefined) delete process.env["XDG_RUNTIME_DIR"];
      else process.env["XDG_RUNTIME_DIR"] = prevXdg;
    }
  });
});
