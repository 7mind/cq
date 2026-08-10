/**
 * Stdio MCP process-lifetime guards.
 *
 * 1. Parent-death poll: if the launch parent exits, exit so orphans
 *    cannot burn CPU for hours after the pi session is gone.
 * 2. Stdin EOF: exit when the client channel ends (detached keep-alive).
 */
import * as fs from "node:fs";

const PARENT_POLL_MS = 2_000;

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

/**
 * When the *launch parent* dies, exit. Unref'd so it does not alone keep the
 * event loop alive.
 *
 * Important: do NOT treat `ppid !== initialParent` as death. Under Pi keep-alive
 * and some supervisors the MCP is reparented (often to pid 1/2) while the
 * client socket is still live; exiting on reparent caused "Failed to reconnect:
 * Connection closed (ledger-mcp: serving …)" right after startup.
 */
export function startParentDeathWatcher(onParentGone: () => void): () => void {
  const initialParent = process.ppid;
  if (initialParent <= 1) {
    return () => {};
  }
  const timer = setInterval(() => {
    // True orphan: init/reaper adopted us AND the original parent is gone.
    if (!pidAlive(initialParent)) {
      onParentGone();
    }
  }, PARENT_POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Exit when the stdio client channel reaches EOF so a keep-alive orphan does
 * not survive after its client drops the pipe.
 *
 * Only `end` (EOF). Do not listen for `error`/`close` — those fire on transient
 * socket hiccups and on some runtimes during connect, which killed a freshly
 * started server and surfaced as reconnect failures with the "serving…" banner
 * still on stderr.
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
  return () => {
    done = true;
    stdin.off("end", fire);
  };
}
