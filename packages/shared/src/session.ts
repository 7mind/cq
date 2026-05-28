// TypeScript types mirroring the persistence schema from plan § 4.
// These are plain TS types (not Zod schemas) used for in-process data exchange.
// The Zod counterparts for wire frames are in protocol.ts.

/** A row from the `session` table (§ 4 DDL). */
export interface SessionRow {
  id: string; // UUID v4
  startedAt: number; // epoch ms
  endedAt: number | null;
  cwd: string;
  model: string;
  permissionMode: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheCreate: number;
  totalCostUsd: number;
  endedReason: string | null; // completed | interrupted | errored | max_turns | max_budget
  title: string;
  lastServerSeq: number;
  sdkSessionId: string | null;
  /**
   * Backend platform this session ran on. New in migration #6.
   * Pre-migration rows default-fill to "claude".
   */
  platform: "claude" | "codex";
  /**
   * Reasoning-effort tier sent in ChatStart. New in migration #6.
   * Pre-migration rows default-fill to "none".
   * Persisted as a string; the bridge maps it to the platform-native form.
   */
  effort: string; // shape-equivalent to Effort from @cq/shared/effort
  /**
   * Codex `approvalPolicy` (one of `"never" | "on-request" | "on-failure" | "untrusted"`).
   * New in migration #7. Nullable: NULL for Claude sessions and for Codex
   * sessions started before this migration (those fall back to the codex-sdk
   * default at session-start time). Optional on the TS shape because the
   * in-memory persistence's seed helpers may omit it.
   */
  approvalPolicy?: string | null;
}

/** A row from the `invocation` table (§ 4 DDL). */
export interface InvocationRow {
  id: string; // UUID v4
  sessionId: string;
  parentInvocationId: string | null;
  /** Non-null when this invocation was started via "resume from history". References the prior invocation. */
  resumedFromInvocationId: string | null;
  agentName: string; // 'main' for top-level
  agentId: string | null;
  taskId: string | null;
  toolUseId: string | null;
  model: string;
  startedAt: number; // epoch ms
  endedAt: number | null;
  durationMs: number | null;
  status: "running" | "completed" | "failed" | "stopped" | "wiped";
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  promptExcerpt: string; // truncated 500ch
  eventLogPath: string; // relative path to JSONL file
  /** D42: PID of the cq process that owns this row. NULL means unknown — never reaped. */
  ownerPid: number | null;
}
