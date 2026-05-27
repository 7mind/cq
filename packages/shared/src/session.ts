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
  status: "running" | "completed" | "failed" | "stopped";
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  promptExcerpt: string; // truncated 500ch
  eventLogPath: string; // relative path to JSONL file
  /** D42: PID of the cq process that owns this row. NULL means unknown — never reaped. */
  ownerPid: number | null;
}
