/**
 * Shared port-management helpers for ledger-tui test harnesses.
 *
 * freePort() — bind :0 on loopback, read the OS-assigned port, close the
 * listener. Has a theoretical TOCTOU window, but across repeated test runs
 * eliminates the fixed-port collision that causes intermittent "Unable to
 * connect" failures.
 *
 * spawnWithFreePort() — hardened replacement for the freePort()+spawn() pair.
 * Allocates a free port, spawns the server, and races waitForPort() against
 * the server process exiting (which indicates EADDRINUSE or another fatal
 * startup error). On failure it retries with a fresh port, eliminating the
 * close-then-rebind TOCTOU by recovering automatically when the port is
 * stolen between close() and the child's bind(). Callers that used
 *   port = await freePort(); proc = spawn({cmd:[..., String(port)]});
 * should switch to spawnWithFreePort() to get the hardened behaviour.
 *
 * waitForPort() — TCP-connect loop: waits until the target port accepts a
 * connection, proving the server's socket layer is live (not merely that the
 * HTTP handler has responded to one GET).
 */

import * as net from "node:net";
import { spawn, type Subprocess } from "bun";

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") return reject(new Error("no port"));
      const p = addr.port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

/** Subset of spawn() options relevant to the test harness (stdio + env). */
type SpawnIoOpts = {
  stdout?: "inherit" | "ignore" | "pipe";
  stderr?: "inherit" | "ignore" | "pipe";
  stdin?: "inherit" | "ignore" | "pipe";
  /**
   * Explicit child env. Bun's spawn() default env is a SNAPSHOT of the parent
   * env from process start — runtime `process.env` mutations (e.g. a test's
   * XDG_STATE_HOME override) do NOT propagate unless passed here explicitly
   * (`{ ...process.env }` at spawn time).
   */
  env?: Record<string, string | undefined>;
};

/**
 * Spawn a server subprocess on a dynamically allocated port, retrying on
 * EADDRINUSE (detected when the process exits before the port becomes
 * connectable). Returns { port, proc } once the port is accepting connections.
 *
 * @param makeCmd  Given a port number, returns the command array for spawn().
 * @param opts     spawn() stdio routing options.
 * @param maxTries Maximum allocation attempts before giving up (default 5).
 */
export async function spawnWithFreePort(
  makeCmd: (port: number) => string[],
  opts: SpawnIoOpts = {},
  maxTries = 5,
): Promise<{ port: number; proc: Subprocess }> {
  for (let attempt = 0; attempt < maxTries; attempt++) {
    const port = await freePort();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc = spawn({ cmd: makeCmd(port), ...(opts as any) }) as Subprocess;

    // Race: port comes up (server ready) vs process exits (startup failure).
    const outcome = await Promise.race([
      waitForPort(port, 40).then(() => "up" as const),
      proc.exited.then(() => "crashed" as const),
    ]);

    if (outcome === "up") {
      return { port, proc };
    }

    // Server crashed before accepting connections — likely EADDRINUSE.
    // The process has already exited; just continue to the next attempt.
  }
  throw new Error(`spawnWithFreePort: server failed to start after ${maxTries} attempts`);
}

export async function waitForPort(p: number, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const ok = await new Promise<boolean>((res) => {
      const s = net.connect(p, "127.0.0.1");
      s.on("connect", () => {
        s.end();
        res(true);
      });
      s.on("error", () => res(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server not up on ${p}`);
}
