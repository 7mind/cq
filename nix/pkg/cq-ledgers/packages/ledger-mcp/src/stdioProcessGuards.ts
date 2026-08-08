/**
 * D293 / T2018 / T2019 — stdio MCP process guards.
 *
 * 1. Exclusive lock file per project so keep-alive reconnects replace the
 *    previous holder (SIGTERM + wait) instead of stacking forever — and instead
 *    of hard-failing Pi reconnect while a detached orphan still holds the lock.
 * 2. Parent-death poll: if the parent pid becomes 1 (reaped), exit so orphans
 *    cannot burn CPU for hours after the pi session is gone.
 * 3. Stdin EOF/close: exit when the client channel ends (detached keep-alive).
 */
import * as fs from "node:fs";
import * as path from "node:path";

const PARENT_POLL_MS = 2_000;
/** Soft-wait after SIGTERM before escalating to SIGKILL. */
const LOCK_TAKEOVER_WAIT_MS = 1_500;
const LOCK_TAKEOVER_POLL_MS = 50;

export interface StdioProcessGuards {
  readonly lockPath: string;
  release(): void;
}

function readHolderPid(lockPath: string): number | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8").trim();
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  // Linux: /proc lets us treat zombies as dead (kill(0) still succeeds until reaped).
  // Non-/proc hosts (Darwin): fall through to kill(0)/ESRCH — never treat missing
  // /proc as "dead" or takeover would skip signals and stack MCP instances.
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trimStart();
    const state = afterComm.charAt(0);
    if (state === "Z") return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Specific pid entry gone → dead. Missing /proc entirely → use kill(0).
    if (code === "ENOENT" && fs.existsSync("/proc")) return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sleepMs(ms: number): void {
  const end = Date.now() + ms;
  // Busy-wait is wrong; use Atomics.wait on a shared buffer if available,
  // else deasync-free Bun.sleepSync when present.
  const bunSleep = (globalThis as { Bun?: { sleepSync?: (n: number) => void } }).Bun?.sleepSync;
  if (typeof bunSleep === "function") {
    bunSleep(ms);
    return;
  }
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
  void end;
}

/**
 * Acquire an exclusive lock under `lockDir` named `mcp-stdio.lock`.
 *
 * If another live process holds it, send SIGTERM and wait briefly for release
 * (Pi keep-alive reconnect). Only then fail if the holder will not yield.
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
      const holderPid = readHolderPid(lockPath);
      if (holderPid === process.pid) {
        throw new Error(
          `ledger-mcp: stdio MCP lock already held in this process (${lockPath}).`,
        );
      }
      if (holderPid !== null && pidAlive(holderPid)) {
        // Takeover path for keep-alive reconnect / detached orphan (D293 fix).
        // Soft stop first, then SIGKILL — orphans often ignore polite signals once
        // stdin is already gone and the event loop is thrashing.
        try {
          process.kill(holderPid, "SIGTERM");
        } catch (killErr) {
          if ((killErr as NodeJS.ErrnoException).code !== "ESRCH") throw killErr;
        }
        const softDeadline = Date.now() + LOCK_TAKEOVER_WAIT_MS;
        while (Date.now() < softDeadline) {
          if (!pidAlive(holderPid)) break;
          sleepMs(LOCK_TAKEOVER_POLL_MS);
        }
        if (pidAlive(holderPid)) {
          try {
            process.kill(holderPid, "SIGKILL");
          } catch (killErr) {
            if ((killErr as NodeJS.ErrnoException).code !== "ESRCH") throw killErr;
          }
          const hardDeadline = Date.now() + 1_000;
          while (Date.now() < hardDeadline) {
            if (!pidAlive(holderPid)) break;
            sleepMs(LOCK_TAKEOVER_POLL_MS);
          }
        }
        if (pidAlive(holderPid)) {
          throw new Error(
            `ledger-mcp: another stdio MCP still holds ${lockPath} (pid ${holderPid}) ` +
              `after SIGTERM+SIGKILL. Stop it manually or remove a stuck lock.`,
          );
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

/**
 * Exit when the stdio client channel ends so a keep-alive orphan does not hold
 * the singleton lock forever after Pi drops the socket.
 */
export function startStdinEndWatcher(onEnd: () => void): () => void {
  const stdin = process.stdin;
  let done = false;
  const fire = (): void => {
    if (done) return;
    done = true;
    onEnd();
  };
  stdin.on("end", fire);
  stdin.on("close", fire);
  // Half-open sockets may not emit end promptly; also treat explicit destroy.
  stdin.on("error", fire);
  return () => {
    done = true;
    stdin.off("end", fire);
    stdin.off("close", fire);
    stdin.off("error", fire);
  };
}
