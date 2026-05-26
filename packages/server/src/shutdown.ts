/**
 * shutdown.ts — Graceful SIGTERM/SIGINT handler (PR-48).
 *
 * Sequence:
 *  1. markDraining() — refuse new WebSocket upgrades.
 *  2. bridge.interruptActive() — signal active SDK query to stop.
 *  3. Wait up to timeoutMs for the active session to drain (bridge.activeSessionId() === null).
 *     This step is bounded — a non-responsive SDK does not stretch shutdown past the timeout.
 *  4. Close all open WS sockets with code 1012 (service restart).
 *  5. persistence.close() — flush and close the SQLite database.
 *  6. Resolve.
 */

import type { Bridge } from "./agent/bridge";
import type { Persistence } from "./persist/Persistence.js";
import type { Logger } from "./log/logger";

export type ShutdownServer = {
  markDraining(): void;
  closeAllSockets(code: number, reason: string): void;
};

export type ShutdownOpts = {
  server: ShutdownServer;
  persistence: Persistence;
  bridge: Bridge;
  logger: Logger;
  timeoutMs: number;
};

/**
 * Execute the graceful shutdown sequence.
 * Resolves when the sequence is complete. Does NOT call process.exit() —
 * the caller is responsible for exiting.
 */
export async function startGracefulShutdown(opts: ShutdownOpts): Promise<void> {
  const { server, persistence, bridge, logger, timeoutMs } = opts;

  logger.info("shutdown.start", { timeoutMs });

  // Step 1: refuse new WebSocket upgrades.
  server.markDraining();

  // Step 2: interrupt the active SDK query.
  bridge.interruptActive();

  // Step 3: wait (bounded) for the active session to finish.
  const waitForIdle = (async () => {
    while (bridge.activeSessionId() !== null) {
      await sleep(20);
    }
  })();

  await Promise.race([waitForIdle, sleep(timeoutMs)]);

  if (bridge.activeSessionId() !== null) {
    logger.warn("shutdown.timeout_exceeded", {
      timeoutMs,
      activeSessionId: bridge.activeSessionId(),
    });
  }

  // Step 4: close all open WS connections with 1012 (service restart).
  server.closeAllSockets(1012, "service restart");
  logger.info("shutdown.sockets_closed");

  // Step 5: close the database.
  persistence.close();
  logger.info("shutdown.db_closed");

  logger.info("shutdown.done");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
