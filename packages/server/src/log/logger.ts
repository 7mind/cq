import fs from "node:fs";
import path from "node:path";

// ts is epoch ms; rotation boundary is local-day midnight, matching brief § 7 filename convention.

export type Level = "debug" | "info" | "warn" | "error";

export type Logger = {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
};

export type LoggerOptions = {
  /** Minimum level to emit. Defaults to CQ_LOG_LEVEL env var or "info". */
  level?: Level;
  /** Directory for daily log files. Defaults to "./var/log". */
  logDir?: string;
  /** Clock function for testability. Defaults to Date.now. */
  clock?: () => number;
};

const LEVEL_RANK: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function isLevel(value: string): value is Level {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

function resolveLevel(opt: Level | undefined): Level {
  if (opt !== undefined) return opt;
  const env = process.env["CQ_LOG_LEVEL"];
  if (env !== undefined && isLevel(env)) return env;
  return "info";
}

function dayString(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getFullYear().toString();
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const minLevel = resolveLevel(opts.level);
  const minRank = LEVEL_RANK[minLevel];
  const logDir = opts.logDir ?? "./var/log";
  const clock = opts.clock ?? Date.now;

  // Ensure log directory exists at construction time.
  fs.mkdirSync(logDir, { recursive: true });

  let currentDay = "";
  let currentFd: number | null = null;

  function getFilePath(day: string): string {
    return path.join(logDir, `cq-${day}.log`);
  }

  function rotate(day: string): void {
    if (currentFd !== null) {
      fs.closeSync(currentFd);
      currentFd = null;
    }
    const filePath = getFilePath(day);
    currentFd = fs.openSync(filePath, "a");
    currentDay = day;
  }

  function emit(level: Level, msg: string, extra?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < minRank) return;

    const ts = clock();
    const day = dayString(ts);

    if (day !== currentDay) {
      rotate(day);
    }

    // Reserved keys win: ts, level, msg are always ours. Strip any collision from extra
    // so the final object reads reserved fields first, then caller-provided fields.
    const safeExtra: Record<string, unknown> = {};
    if (extra !== undefined) {
      for (const k of Object.keys(extra)) {
        if (k !== "ts" && k !== "level" && k !== "msg") {
          safeExtra[k] = extra[k];
        }
      }
    }
    const line = JSON.stringify({ ts, level, msg, ...safeExtra }) + "\n";

    // Write to file
    if (currentFd !== null) {
      fs.writeSync(currentFd, line);
    }

    // Mirror to stdout
    process.stdout.write(line);
  }

  return {
    debug(msg, extra) { emit("debug", msg, extra); },
    info(msg, extra) { emit("info", msg, extra); },
    warn(msg, extra) { emit("warn", msg, extra); },
    error(msg, extra) { emit("error", msg, extra); },
  };
}
