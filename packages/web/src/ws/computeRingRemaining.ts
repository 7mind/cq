/**
 * computeRingRemaining.ts — pure function that maps ManagerStats + now → ring phase.
 *
 * Returns the current "waiting phase" that the countdown ring should display, or
 * null when no waiting phase is active (ring should be hidden).
 *
 * Priority order (highest to lowest):
 *   1. connect  — active connection is NEW and the connect timeout is running.
 *   2. pong     — active connection is ALIVE with at least one pending ping.
 *   3. stale    — active connection is STALE and the stale grace period is running.
 *   4. reconnect — no ALIVE connection exists but nextRetryAt is set.
 *   5. null     — none of the above; ring is hidden.
 *
 * PR-14: [ws P3-i-4].
 */

import type { ManagerStats } from "./Manager";

export type RingPhase = "connect" | "pong" | "stale" | "reconnect";

export interface RingInfo {
  /** Which waiting phase is active. */
  phase: RingPhase;
  /** Remaining time in this phase (ms). Always ≥ 0. */
  remaining: number;
  /** Total duration of this phase (ms). Always > 0. */
  total: number;
}

/**
 * Compute the ring phase for the current instant.
 *
 * @param stats   Latest ManagerStats snapshot.
 * @param opts    Configuration values (timeout durations) used during phase timing.
 * @param now     Current epoch time in ms (Date.now() or injected for testing).
 * @returns RingInfo for the active phase, or null if no ring should be shown.
 */
export function computeRingRemaining(
  stats: ManagerStats,
  opts: {
    connectTimeoutMs: number;
    pongTimeoutMs: number;
    staleGraceMs: number;
  },
  now: number,
): RingInfo | null {
  // Find the active connection (if any)
  const activeConn = stats.activeConnectionId !== null
    ? stats.connections.find((c) => c.id === stats.activeConnectionId) ?? null
    : null;

  // 1. connect: active connection is NEW with a running connect timeout
  if (activeConn !== null && activeConn.state === "NEW" && activeConn.connectedAt !== null) {
    const total = opts.connectTimeoutMs;
    const elapsed = now - activeConn.connectedAt;
    const remaining = Math.max(0, total - elapsed);
    return { phase: "connect", remaining, total };
  }

  // 2. pong: active connection is ALIVE with an in-flight ping
  if (
    activeConn !== null &&
    activeConn.state === "ALIVE" &&
    activeConn.oldestPendingPingSentAt !== null
  ) {
    const total = opts.pongTimeoutMs;
    const elapsed = now - activeConn.oldestPendingPingSentAt;
    const remaining = Math.max(0, total - elapsed);
    return { phase: "pong", remaining, total };
  }

  // 3. stale: active connection is STALE with the stale grace period running
  if (activeConn !== null && activeConn.state === "STALE" && activeConn.enteredStaleAt !== null) {
    const total = opts.staleGraceMs;
    const elapsed = now - activeConn.enteredStaleAt;
    const remaining = Math.max(0, total - elapsed);
    return { phase: "stale", remaining, total };
  }

  // 4. reconnect: no ALIVE connection, nextRetryAt is set
  if (stats.nextRetryAt !== null && stats.retryScheduledAt !== null) {
    const total = Math.max(1, stats.nextRetryAt - stats.retryScheduledAt);
    const remaining = Math.max(0, stats.nextRetryAt - now);
    return { phase: "reconnect", remaining, total };
  }

  return null;
}
