/**
 * D293 / T2018 / T2019 — stdio MCP process guards.
 *
 * 1. Exclusive lock file per project so a second keep-alive `cq mcp` fails
 *    fast instead of stacking (multiplicity was the thrash amplifier).
 * 2. Parent-death poll: if the parent pid becomes 1 (reaped), exit so orphans
 *    cannot burn CPU for hours after the pi session is gone.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const PARENT_POLL_MS = 2_000;

export interface StdioProcessGuards {
  readonly lockPath: string;
  release(): void;
}

/**
 * Acquire an exclusive lock under `lockDir` named `mcp-stdio.lock`.
 * If another live process holds it, throw with the holder pid.
 */
export function acquireStdioSingletonLock(lockDir: string): StdioProcessGuards {
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, "mcp-stdio.lock");

  const tryCreate = (): number => {
    try {
      return fs.openSync(lockPath, "wx");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      let holderPid: number | null = null;
      try {
        const raw = fs.readFileSync(lockPath, "utf8").trim();
        const parsed = JSON.parse(raw) as { pid?: unknown };
        if (typeof parsed.pid === "number") holderPid = parsed.pid;
      } catch {
        // unreadable — treat as stale
      }
      if (holderPid === process.pid) {
        throw new Error(
          `ledger-mcp: stdio MCP lock already held in this process (${lockPath}).`,
        );
      }
      if (holderPid !== null) {
        try {
          process.kill(holderPid, 0);
          throw new Error(
            `ledger-mcp: another stdio MCP already holds ${lockPath} (pid ${holderPid}). ` +
              "Refuse to stack keep-alive instances (D293). Stop the other process or remove a stale lock.",
          );
        } catch (killErr) {
          if (
            killErr instanceof Error &&
            killErr.message.startsWith("ledger-mcp: another stdio MCP")
          ) {
            throw killErr;
          }
          if ((killErr as NodeJS.ErrnoException).code !== "ESRCH") throw killErr;
          // stale lock — remove and retry
        }
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // race — retry open
      }
      return tryCreate();
    }
  };

  const fd = tryCreate();
  const payload = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`;
  fs.ftruncateSync(fd, 0);
  fs.writeSync(fd, payload);
  fs.fsyncSync(fd);

  return {
    lockPath,
    release(): void {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
      try {
        const raw = fs.readFileSync(lockPath, "utf8");
        const parsed = JSON.parse(raw) as { pid?: unknown };
        if (parsed.pid === process.pid) fs.unlinkSync(lockPath);
      } catch {
        // ignore
      }
    },
  };
}

/**
 * When the parent process disappears (ppid becomes 1), exit. Unref'd so it
 * does not alone keep the event loop alive.
 */
export function startParentDeathWatcher(onParentGone: () => void): () => void {
  const initialParent = process.ppid;
  if (initialParent <= 1) {
    return () => {};
  }
  const timer = setInterval(() => {
    if (process.ppid === 1 || process.ppid !== initialParent) {
      onParentGone();
    }
  }, PARENT_POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
