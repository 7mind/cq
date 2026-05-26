// WebSocket close codes per plan § 3.6.

export const NORMAL_CLOSURE = 1000 as const;
export const GOING_AWAY = 1001 as const;
export const ABNORMAL_CLOSURE = 1006 as const;
export const POLICY_VIOLATION = 1008 as const;
export const INTERNAL_ERROR = 1011 as const;
export const SERVICE_RESTART = 1012 as const;
export const FRAME_VALIDATION_FAILED = 4000 as const;
export const SEQ_REPLAY_REJECTED = 4001 as const;
export const SESSION_SUPERSEDED = 4002 as const;

/**
 * Returns true if the WS close code indicates the client should reconnect.
 * Per plan § 3.6 [ws R7]: 4000 / 4002 / 1008 → not retriable;
 * 1001 / 1006 / 1011 / 1012 / 4001 → retriable; 1000 → normal, no retry.
 *
 * 1006 (ABNORMAL_CLOSURE) is never sent as a real close frame — the browser
 * synthesizes it when the connection terminates without a close handshake
 * (NAT drop, OS-level TCP reset, freeze). Reconnecting is always correct.
 */
export function isRetriable(code: number): boolean {
  switch (code) {
    case GOING_AWAY:
    case ABNORMAL_CLOSURE:
    case INTERNAL_ERROR:
    case SERVICE_RESTART:
    case SEQ_REPLAY_REJECTED:
      return true;
    default:
      return false;
  }
}
