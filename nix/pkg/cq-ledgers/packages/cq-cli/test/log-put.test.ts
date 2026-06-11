/**
 * T406: `cq log put` — dispatch routing, arg parsing, and dest validation.
 *
 * Acceptance:
 *   - `cq log put --stdin --dest logs/raw/x.jsonl` routes to runLogPut with
 *     parsed { stdin: true, dest: 'logs/raw/x.jsonl' }.
 *   - Missing both src and --stdin errors (EXIT_USAGE).
 *   - `--dest foo/x` (not under logs/) errors (EXIT_USAGE).
 *   - `--dest logs/../secrets` exits non-zero with a usage error.
 *
 * Tests the dispatch seam (via dispatch()) and the low-level parser/validator
 * directly (parseLogPutArgs / validateLogDest), mirroring the move-ledger
 * routing test pattern.
 */

import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import { dispatch, EXIT_USAGE, USAGE, type ConfirmIo, type DispatchIo } from "../src/main.js";
import { parseLogPutArgs, validateLogDest } from "../src/logPut.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// USAGE / --help
// ---------------------------------------------------------------------------

describe("cq log put — USAGE", () => {
  it("USAGE text lists the log put subcommand", () => {
    expect(USAGE).toContain("log");
    expect(USAGE).toContain("log put");
  });

  it("unknown subcommand still prints USAGE (sanity)", async () => {
    const io = recordingIo();
    const outcome = await dispatch(["badcmd"], io);
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(io.errs.join("\n")).toBe(USAGE);
  });
});

// ---------------------------------------------------------------------------
// Dispatch routing
// ---------------------------------------------------------------------------

describe("cq log put — dispatch routing", () => {
  it("routes --stdin + --dest to runLogPut (not-yet-implemented response)", async () => {
    const io = recordingIo();
    const outcome = await dispatch(["log", "put", "--stdin", "--dest", "logs/raw/x.jsonl"], io);
    // runLogPut emits "not yet implemented" to stderr and returns exit 1.
    // The important assertion is that the dispatch ROUTED to runLogPut (not a
    // usage error from the dispatcher) and the parsed args were valid.
    expect(outcome.exitCode).not.toBe(EXIT_USAGE);
    expect(outcome.longRunning).toBe(false);
    // The error message comes from runLogPut's stub, not a parsing error.
    expect(io.errs.join("\n")).toContain("not yet implemented");
  });

  it("missing both src and --stdin errors with EXIT_USAGE", async () => {
    const io = recordingIo();
    const outcome = await dispatch(["log", "put", "--dest", "logs/raw/x.jsonl"], io);
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(io.errs.join("\n")).toMatch(/source path or --stdin is required/);
  });

  it("--dest not under logs/ errors with EXIT_USAGE", async () => {
    const io = recordingIo();
    const outcome = await dispatch(["log", "put", "--stdin", "--dest", "foo/x"], io);
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(io.errs.join("\n")).toMatch(/--dest must be under logs\//);
  });

  it("--dest logs/../secrets exits non-zero with a usage error", async () => {
    const io = recordingIo();
    const outcome = await dispatch(["log", "put", "--stdin", "--dest", "logs/../secrets"], io);
    expect(outcome.exitCode).not.toBe(0);
    // Must be a usage error (validation), not an internal error.
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(io.errs.join("\n")).toMatch(/--dest must be under logs\//);
  });

  it("missing --dest errors with EXIT_USAGE", async () => {
    const io = recordingIo();
    const outcome = await dispatch(["log", "put", "--stdin"], io);
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(io.errs.join("\n")).toMatch(/--dest.*is required/);
  });

  it("no sub-subcommand (cq log alone) errors with EXIT_USAGE", async () => {
    const io = recordingIo();
    const outcome = await dispatch(["log"], io);
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(io.errs.join("\n")).toMatch(/sub-subcommand is required/);
  });

  it("unknown sub-subcommand (cq log foo) errors with EXIT_USAGE", async () => {
    const io = recordingIo();
    const outcome = await dispatch(["log", "foo"], io);
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(io.errs.join("\n")).toMatch(/unknown sub-subcommand "foo"/);
  });
});

// ---------------------------------------------------------------------------
// parseLogPutArgs — unit tests
// ---------------------------------------------------------------------------

describe("parseLogPutArgs", () => {
  const cwd = process.cwd();

  it("parses --stdin + --dest", () => {
    const args = parseLogPutArgs(cwd, ["--stdin", "--dest", "logs/raw/x.jsonl"]);
    expect(args).toEqual({ cwd, stdin: true, src: undefined, dest: "logs/raw/x.jsonl" });
  });

  it("parses positional src + --dest", () => {
    const args = parseLogPutArgs(cwd, ["/tmp/foo.jsonl", "--dest", "logs/raw/out.jsonl"]);
    expect(args).toEqual({ cwd, stdin: false, src: "/tmp/foo.jsonl", dest: "logs/raw/out.jsonl" });
  });

  it("parses --dest=<value> form", () => {
    const args = parseLogPutArgs(cwd, ["--stdin", "--dest=logs/raw/x.jsonl"]);
    expect(args).toEqual({ cwd, stdin: true, src: undefined, dest: "logs/raw/x.jsonl" });
  });

  it("throws when both --stdin and src given", () => {
    expect(() => parseLogPutArgs(cwd, ["--stdin", "/tmp/foo.jsonl", "--dest", "logs/x.jsonl"])).toThrow(
      /--stdin and a source path are mutually exclusive/,
    );
  });

  it("throws when neither --stdin nor src given", () => {
    expect(() => parseLogPutArgs(cwd, ["--dest", "logs/x.jsonl"])).toThrow(
      /source path or --stdin is required/,
    );
  });

  it("throws when --dest is absent", () => {
    expect(() => parseLogPutArgs(cwd, ["--stdin"])).toThrow(/--dest.*is required/);
  });

  it("throws on unknown flag", () => {
    expect(() => parseLogPutArgs(cwd, ["--stdin", "--dest", "logs/x.jsonl", "--bogus"])).toThrow(
      /unknown flag "--bogus"/,
    );
  });

  it("skips --cwd and its value (consumed by top-level dispatcher)", () => {
    const args = parseLogPutArgs(cwd, ["--cwd", "/some/root", "--stdin", "--dest", "logs/x.jsonl"]);
    expect(args.stdin).toBe(true);
    expect(args.dest).toBe("logs/x.jsonl");
  });

  it("skips --cwd=<value> form", () => {
    const args = parseLogPutArgs(cwd, ["--cwd=/some/root", "--stdin", "--dest", "logs/x.jsonl"]);
    expect(args.stdin).toBe(true);
    expect(args.dest).toBe("logs/x.jsonl");
  });
});

// ---------------------------------------------------------------------------
// validateLogDest — unit tests
// ---------------------------------------------------------------------------

describe("validateLogDest", () => {
  it("accepts a valid logs/ path", () => {
    expect(validateLogDest("logs/raw/x.jsonl")).toBe("logs/raw/x.jsonl");
  });

  it("accepts a deeply nested logs/ path", () => {
    expect(validateLogDest("logs/a/b/c/d.jsonl")).toBe("logs/a/b/c/d.jsonl");
  });

  it("rejects an absolute path", () => {
    expect(() => validateLogDest("/logs/x.jsonl")).toThrow(/must be a relative path/);
  });

  it("rejects a path not under logs/", () => {
    expect(() => validateLogDest("foo/x")).toThrow(/must be under logs\//);
  });

  it("rejects an empty string", () => {
    expect(() => validateLogDest("")).toThrow(/must not be empty/);
  });

  it("rejects 'logs' alone (no sub-path)", () => {
    // path.normalize("logs") stays "logs"; does not start with "logs/"
    expect(() => validateLogDest("logs")).toThrow(/must be under logs\//);
  });

  it("rejects logs/../secrets (normalises out of logs/)", () => {
    expect(() => validateLogDest("logs/../secrets")).toThrow(/must be under logs\//);
  });

  it("rejects logs/./../../etc/passwd", () => {
    expect(() => validateLogDest("logs/./../../etc/passwd")).toThrow(/must be under logs\//);
  });

  it("normalises logs/./x to logs/x", () => {
    // path.posix.normalize("logs/./x") === "logs/x" (forward-slash on all platforms)
    expect(validateLogDest("logs/./x")).toBe(path.posix.normalize("logs/./x"));
    expect(validateLogDest("logs/./x")).toBe("logs/x");
  });
});
