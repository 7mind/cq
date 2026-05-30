import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import type { Args } from "../src/args";

// We dynamically import to allow process.exit mocking per test
async function importParseArgs() {
  const mod = await import("../src/args");
  return mod.parseArgs;
}

describe("parseArgs", () => {
  let exitCode: number | undefined;
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(() => {
    exitCode = undefined;
    stdoutOutput = "";
    stderrOutput = "";
  });

  it("returns defaults when given an empty argv", async () => {
    const parseArgs = await importParseArgs();
    const result = parseArgs([]);
    expect(result.cwd).toBe(process.cwd());
    expect(result.host).toBe("127.0.0.1");
    expect(result.port).toBe(5173);
    expect(result.db).toBe("./var/db/cq.sqlite");
  });

  it("parses all four flags correctly", async () => {
    const parseArgs = await importParseArgs();
    const result: Args = parseArgs([
      "--cwd", "/tmp",
      "--host", "0.0.0.0",
      "--port", "8080",
      "--db", "/data/cq.sqlite",
    ]);
    expect(result.cwd).toBe("/tmp");
    expect(result.host).toBe("0.0.0.0");
    expect(result.port).toBe(8080);
    expect(result.db).toBe("/data/cq.sqlite");
  });

  it("parses --port as an integer", async () => {
    const parseArgs = await importParseArgs();
    const result = parseArgs(["--port", "3000"]);
    expect(typeof result.port).toBe("number");
    expect(Number.isInteger(result.port)).toBe(true);
    expect(result.port).toBe(3000);
  });

  it("rejects non-integer --port and calls process.exit(1)", async () => {
    const parseArgs = await importParseArgs();
    const exitSpy = spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      exitCode = typeof code === "number" ? code : 1;
      throw new Error("process.exit called");
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((data: string | Uint8Array) => {
      stderrOutput += typeof data === "string" ? data : "";
      return true;
    });

    try {
      parseArgs(["--port", "abc"]);
    } catch {
      // swallow the thrown error from mocked exit
    }

    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain("--port");

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("rejects an unknown flag and calls process.exit(1)", async () => {
    const parseArgs = await importParseArgs();
    const exitSpy = spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      exitCode = typeof code === "number" ? code : 1;
      throw new Error("process.exit called");
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((data: string | Uint8Array) => {
      stderrOutput += typeof data === "string" ? data : "";
      return true;
    });

    try {
      parseArgs(["--unknown-flag"]);
    } catch {
      // swallow
    }

    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain("unknown flag");

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("--help prints usage to stdout and exits 0", async () => {
    const parseArgs = await importParseArgs();
    const exitSpy = spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      exitCode = typeof code === "number" ? code : 0;
      throw new Error("process.exit called");
    });
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((data: string | Uint8Array) => {
      stdoutOutput += typeof data === "string" ? data : "";
      return true;
    });

    try {
      parseArgs(["--help"]);
    } catch {
      // swallow
    }

    expect(exitCode).toBe(0);
    expect(stdoutOutput).toContain("--cwd");
    expect(stdoutOutput).toContain("--host");
    expect(stdoutOutput).toContain("--port");
    expect(stdoutOutput).toContain("--db");

    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it("returns a frozen (Readonly) object", async () => {
    const parseArgs = await importParseArgs();
    const result = parseArgs([]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("--dev flag sets dev: true", async () => {
    const parseArgs = await importParseArgs();
    const result = parseArgs(["--dev"]);
    expect(result.dev).toBe(true);
  });

  it("dev defaults to false when --dev is not passed", async () => {
    const parseArgs = await importParseArgs();
    const result = parseArgs([]);
    expect(result.dev).toBe(false);
  });

  afterEach(() => {
    exitCode = undefined;
  });
});

describe("parseInvocation", () => {
  async function importParseInvocation() {
    const mod = await import("../src/args");
    return mod.parseInvocation;
  }

  it("routes a normal flag invocation to the server (unchanged Args)", async () => {
    const parseInvocation = await importParseInvocation();
    const inv = parseInvocation(["--cwd", "/tmp", "--port", "8080"]);
    expect(inv.kind).toBe("server");
    if (inv.kind !== "server") throw new Error("expected server invocation");
    expect(inv.args.cwd).toBe("/tmp");
    expect(inv.args.port).toBe(8080);
    expect(inv.args.dev).toBe(false);
  });

  it("routes an empty argv to the server with defaults", async () => {
    const parseInvocation = await importParseInvocation();
    const inv = parseInvocation([]);
    expect(inv.kind).toBe("server");
    if (inv.kind !== "server") throw new Error("expected server invocation");
    expect(inv.args.cwd).toBe(process.cwd());
  });

  it("routes --dev to the server with dev: true", async () => {
    const parseInvocation = await importParseInvocation();
    const inv = parseInvocation(["--dev", "--host", "0.0.0.0"]);
    expect(inv.kind).toBe("server");
    if (inv.kind !== "server") throw new Error("expected server invocation");
    expect(inv.args.dev).toBe(true);
    expect(inv.args.host).toBe("0.0.0.0");
  });

  it("routes a leading `reset` positional to the reset subcommand", async () => {
    const parseInvocation = await importParseInvocation();
    const inv = parseInvocation(["reset"]);
    expect(inv.kind).toBe("reset");
    if (inv.kind !== "reset") throw new Error("expected reset invocation");
    expect(inv.opts.cwd).toBe(process.cwd());
    expect(inv.opts.yes).toBe(false);
    expect(inv.opts.backup).toBe(true);
  });

  it("parses reset flags: --cwd, --yes, --no-backup", async () => {
    const parseInvocation = await importParseInvocation();
    const inv = parseInvocation(["reset", "--cwd", "/tmp/x", "--yes", "--no-backup"]);
    expect(inv.kind).toBe("reset");
    if (inv.kind !== "reset") throw new Error("expected reset invocation");
    expect(inv.opts.cwd).toBe("/tmp/x");
    expect(inv.opts.yes).toBe(true);
    expect(inv.opts.backup).toBe(false);
  });

  it("treats `reset` only as the FIRST token (a flagged invocation stays server)", async () => {
    const parseInvocation = await importParseInvocation();
    // `--cwd reset` means cwd=\"reset\", a server invocation — NOT the subcommand.
    const inv = parseInvocation(["--cwd", "reset"]);
    expect(inv.kind).toBe("server");
    if (inv.kind !== "server") throw new Error("expected server invocation");
    expect(inv.args.cwd).toBe("reset");
  });

  it("rejects an unknown reset flag with exit(1)", async () => {
    const parseInvocation = await importParseInvocation();
    let code: number | undefined;
    let err = "";
    const exitSpy = spyOn(process, "exit").mockImplementation((c?: number | string | null) => {
      code = typeof c === "number" ? c : 1;
      throw new Error("process.exit called");
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((d: string | Uint8Array) => {
      err += typeof d === "string" ? d : "";
      return true;
    });
    try {
      parseInvocation(["reset", "--bogus"]);
    } catch {
      // swallow
    }
    expect(code).toBe(1);
    expect(err).toContain("unknown reset flag");
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("returns frozen invocation objects", async () => {
    const parseInvocation = await importParseInvocation();
    const server = parseInvocation([]);
    const reset = parseInvocation(["reset"]);
    expect(Object.isFrozen(server)).toBe(true);
    expect(Object.isFrozen(reset)).toBe(true);
  });
});
