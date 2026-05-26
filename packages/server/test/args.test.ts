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
