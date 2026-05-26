import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/log/logger";
import type { Level } from "../src/log/logger";

// --- helpers ----------------------------------------------------------------

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cq-log-test-"));
}

function captureStdout(fn: () => void): string[] {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    const str = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    lines.push(str);
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return lines;
}

function parseJsonLine(line: string): Record<string, unknown> {
  return JSON.parse(line.trim()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe("createLogger — JSON validity", () => {
  it("info emits a single line of valid JSON with ts (number), level, msg", () => {
    const dir = tempDir();
    const before = Date.now();
    let captured = "";
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    };
    try {
      const logger = createLogger({ logDir: dir });
      logger.info("hello");
    } finally {
      process.stdout.write = orig;
    }
    const after = Date.now();

    const line = captured.trim();
    expect(line).not.toBe("");
    const obj = parseJsonLine(line);
    expect(typeof obj["ts"]).toBe("number");
    expect((obj["ts"] as number) >= before && (obj["ts"] as number) <= after).toBe(true);
    expect(obj["level"]).toBe("info");
    expect(obj["msg"]).toBe("hello");
  });

  it("extra keys are spread into the JSON object", () => {
    const dir = tempDir();
    const lines = captureStdout(() => {
      const logger = createLogger({ logDir: dir });
      logger.info("test", { host: "127.0.0.1", port: 5173 });
    });
    const obj = parseJsonLine(lines[0] ?? "");
    expect(obj["host"]).toBe("127.0.0.1");
    expect(obj["port"]).toBe(5173);
  });

  it("reserved keys in extra (ts, level, msg) lose — logger's values win", () => {
    const dir = tempDir();
    const lines = captureStdout(() => {
      const logger = createLogger({ logDir: dir });
      logger.warn("real-msg", { ts: 0, level: "debug", msg: "fake" } as Record<string, unknown>);
    });
    const obj = parseJsonLine(lines[0] ?? "");
    expect(obj["level"]).toBe("warn");
    expect(obj["msg"]).toBe("real-msg");
    expect((obj["ts"] as number)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe("createLogger — level filtering", () => {
  const cases: [Level, Level, boolean][] = [
    ["debug", "debug", true],
    ["debug", "info",  true],
    ["debug", "warn",  true],
    ["debug", "error", true],
    ["info",  "debug", false],
    ["info",  "info",  true],
    ["info",  "warn",  true],
    ["info",  "error", true],
    ["warn",  "debug", false],
    ["warn",  "info",  false],
    ["warn",  "warn",  true],
    ["warn",  "error", true],
    ["error", "debug", false],
    ["error", "info",  false],
    ["error", "warn",  false],
    ["error", "error", true],
  ];

  for (const [minLevel, emitLevel, shouldEmit] of cases) {
    it(`min=${minLevel} + emit=${emitLevel} → emitted=${shouldEmit}`, () => {
      const dir = tempDir();
      const lines = captureStdout(() => {
        const logger = createLogger({ level: minLevel, logDir: dir });
        logger[emitLevel]("x");
      });
      if (shouldEmit) {
        expect(lines.length).toBeGreaterThan(0);
        const obj = parseJsonLine(lines[0] ?? "");
        expect(obj["level"]).toBe(emitLevel);
      } else {
        expect(lines.length).toBe(0);
      }
    });
  }

  it("debug is suppressed at default level (info)", () => {
    const dir = tempDir();
    const lines = captureStdout(() => {
      const logger = createLogger({ logDir: dir });
      logger.debug("should not appear");
    });
    expect(lines.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("createLogger — file path", () => {
  it("log file is named cq-YYYYMMDD.log matching today", () => {
    const dir = tempDir();
    captureStdout(() => {
      const logger = createLogger({ logDir: dir });
      logger.info("file-path-test");
    });

    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = (now.getMonth() + 1).toString().padStart(2, "0");
    const dd = now.getDate().toString().padStart(2, "0");
    const expected = `cq-${yyyy}${mm}${dd}.log`;

    const files = fs.readdirSync(dir);
    expect(files).toContain(expected);
  });
});

// ---------------------------------------------------------------------------

describe("createLogger — daily rotation", () => {
  it("writing on day N then day N+1 creates two separate log files", () => {
    const dir = tempDir();

    // Day A: 2025-01-15 noon UTC
    const dayA = new Date("2025-01-15T12:00:00.000Z").getTime();
    // Day B: 2025-01-16 noon UTC (next local day — this test assumes UTC offset
    // won't shift the date; if it does the files may share a local date but the
    // rotation will still fire because the ts-derived day string changes).
    const dayB = new Date("2025-01-16T12:00:00.000Z").getTime();

    let callCount = 0;
    const clock = (): number => {
      callCount += 1;
      return callCount === 1 ? dayA : dayB;
    };

    captureStdout(() => {
      const logger = createLogger({ logDir: dir, clock });
      logger.info("day-a-message");
      logger.info("day-b-message");
    });

    const files = fs.readdirSync(dir).sort();
    expect(files.length).toBe(2);

    // Verify each file contains the right message
    const contentA = fs.readFileSync(path.join(dir, files[0]!), "utf8").trim();
    const contentB = fs.readFileSync(path.join(dir, files[1]!), "utf8").trim();
    const objA = parseJsonLine(contentA);
    const objB = parseJsonLine(contentB);
    expect(objA["msg"]).toBe("day-a-message");
    expect(objB["msg"]).toBe("day-b-message");
  });
});
