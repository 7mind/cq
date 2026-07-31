/**
 * parseArgs ledger-root resolution: --cwd > $LEDGER_ROOT > process CWD, with
 * relative values resolved against the CWD. The CWD default is what lets one
 * global install serve per-repo ledgers.
 *
 * Also covers --tool-prefix parsing and validation (T379).
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "../src/main.js";

const savedEnv = process.env["LEDGER_ROOT"];
afterEach(() => {
  if (savedEnv === undefined) delete process.env["LEDGER_ROOT"];
  else process.env["LEDGER_ROOT"] = savedEnv;
});

describe("parseArgs ledger-root resolution", () => {
  it("defaults to the process CWD when nothing is given", () => {
    delete process.env["LEDGER_ROOT"];
    expect(parseArgs([]).cwd).toBe(process.cwd());
  });

  it("uses $LEDGER_ROOT when set and no --cwd", () => {
    process.env["LEDGER_ROOT"] = "/srv/ledgers";
    expect(parseArgs([]).cwd).toBe("/srv/ledgers");
  });

  it("--cwd takes precedence over $LEDGER_ROOT", () => {
    process.env["LEDGER_ROOT"] = "/srv/ledgers";
    expect(parseArgs(["--cwd", "/work/repo"]).cwd).toBe("/work/repo");
  });

  it("resolves a relative --cwd against the process CWD", () => {
    delete process.env["LEDGER_ROOT"];
    expect(parseArgs(["--cwd", "sub/dir"]).cwd).toBe(path.resolve("sub/dir"));
  });

  it("keeps an absolute --cwd unchanged and still parses --http", () => {
    const a = parseArgs(["--cwd", "/abs/root", "--http", "7777"]);
    expect(a.cwd).toBe("/abs/root");
    expect(a.http).toEqual({ host: "127.0.0.1", port: 7777 });
  });

  it("no longer recognises --reset / --yes (relocated to `cq reset`, T190)", () => {
    delete process.env["LEDGER_ROOT"];
    // The reset CLI surface moved to the `cq` CLI; ParsedArgs carries only
    // {cwd, http} now. parseArgs must NOT expose reset/yes, and the unknown
    // --reset/--yes/-y tokens are ignored (root still resolves normally).
    const a = parseArgs(["--cwd", "sub/dir", "--reset", "--yes"]);
    expect(a).not.toHaveProperty("reset");
    expect(a).not.toHaveProperty("yes");
    expect(a.cwd).toBe(path.resolve("sub/dir"));
    expect(parseArgs(["--reset", "-y"])).not.toHaveProperty("yes");
  });
});

describe("parseArgs --tool-prefix (T379)", () => {
  it("defaults toolPrefix to '' when flag is absent", () => {
    expect(parseArgs([]).toolPrefix).toBe("");
  });

  it("parses --tool-prefix <value> (space form)", () => {
    expect(parseArgs(["--tool-prefix", "myproj"]).toolPrefix).toBe("myproj");
  });

  it("parses --tool-prefix=<value> (equals form)", () => {
    expect(parseArgs(["--tool-prefix=myproj"]).toolPrefix).toBe("myproj");
  });

  it("throws when --tool-prefix is given without a value", () => {
    expect(() => parseArgs(["--tool-prefix"])).toThrow("--tool-prefix requires a value");
  });

  it("throws when the prefix contains an underscore (bad_prefix)", () => {
    expect(() => parseArgs(["--tool-prefix", "bad_prefix"])).toThrow();
  });

  it("throws when the prefix contains a hyphen", () => {
    expect(() => parseArgs(["--tool-prefix", "bad-prefix"])).toThrow();
  });

  it("accepts an alphanumeric prefix alongside --cwd and --http", () => {
    delete process.env["LEDGER_ROOT"];
    const a = parseArgs(["--tool-prefix", "proj1", "--cwd", "/my/root", "--http", "8888"]);
    expect(a.toolPrefix).toBe("proj1");
    expect(a.cwd).toBe("/my/root");
    expect(a.http).toEqual({ host: "127.0.0.1", port: 8888 });
  });
});

// Regression origin: tasks:T1329 acceptance (2026-07-31).
describe("parseArgs --tool-profile (T1329)", () => {
  it("defaults to the full compatibility profile", () => {
    expect(parseArgs([]).toolProfile).toBe("full");
  });

  it("parses the assigned role in space and equals forms", () => {
    expect(parseArgs(["--tool-profile", "plan-advance"]).toolProfile).toBe("plan-advance");
    expect(parseArgs(["--tool-profile=implement-worker"]).toolProfile).toBe("implement-worker");
  });

  it("fails before server construction for a missing or unknown profile", () => {
    expect(() => parseArgs(["--tool-profile"])).toThrow("--tool-profile requires a value");
    expect(() => parseArgs(["--tool-profile=unprofiled-role"])).toThrow(
      'unknown role tool profile "unprofiled-role"',
    );
  });
});

describe("parseArgs prompt surface selection (T655)", () => {
  it("parses explicit surface and root in space form", () => {
    const args = parseArgs(["--prompt-surface", "codex", "--prompt-root", "/nix/store/codex-root"]);
    expect(args.promptSurface).toBe("codex");
    expect(args.promptRoot).toBe("/nix/store/codex-root");
  });

  it("parses explicit surface and root in equals form", () => {
    const args = parseArgs(["--prompt-surface=pi", "--prompt-root=/nix/store/pi-root"]);
    expect(args.promptSurface).toBe("pi");
    expect(args.promptRoot).toBe("/nix/store/pi-root");
  });

  it("resolves a relative explicit root against the process CWD", () => {
    expect(parseArgs(["--prompt-root", "built/prompts"]).promptRoot).toBe(
      path.resolve("built/prompts"),
    );
  });

  it("rejects an invalid explicit surface before server construction", () => {
    expect(() => parseArgs(["--prompt-surface", "terminal"])).toThrow(
      'unsupported prompt surface "terminal"',
    );
  });

  it("rejects missing prompt selector values", () => {
    expect(() => parseArgs(["--prompt-surface"])).toThrow("--prompt-surface requires a value");
    expect(() => parseArgs(["--prompt-root"])).toThrow("--prompt-root requires a value");
  });
});
