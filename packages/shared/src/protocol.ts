import { z } from "zod";
import { EffortSchema } from "./effort.js";

// ---------------------------------------------------------------------------
// Common fields (reused inline per plan § 3.1)
// ---------------------------------------------------------------------------

const seq = z.number().int().nonnegative();
const ts = z.number();
const uuidStr = () => z.string().uuid();

// ---------------------------------------------------------------------------
// Attachment size cap (plan § 3.3 / F-08)
// ---------------------------------------------------------------------------

/** Maximum allowed total decoded byte size of all attachments in a single chat.input frame. */
export const ATTACHMENT_TOTAL_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Computes the decoded byte length of a base64 string without actually decoding it.
 * Formula per plan F-08 brief.
 */
export function base64DecodedByteLength(b64: string): number {
  const len = b64.length;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor(len * 3 / 4) - padding;
}

// ---------------------------------------------------------------------------
// SDK passthrough envelope (plan § 3.4)
// ---------------------------------------------------------------------------

/**
 * A passthrough envelope around any SDK message.
 * We validate only that `type` is present as a string; all other fields
 * are forwarded untouched (looseObject = catchall: unknown).
 * Per plan § 3.4: "We do NOT re-shape the SDK types — we forward them
 * tagged by their type/subtype."
 */
export const SDKMessageEnvelope = z.looseObject({
  type: z.string(),
});
export type SDKMessageEnvelope = z.infer<typeof SDKMessageEnvelope>;

/** Minimal SDK init-info passthrough (skills, slash_commands, mcp, model, cwd). */
export const SDKInitInfo = z.looseObject({
  model: z.string().optional(),
});
export type SDKInitInfo = z.infer<typeof SDKInitInfo>;

// ---------------------------------------------------------------------------
// History row shapes (plan § 4 — Zod schemas for wire use)
// ---------------------------------------------------------------------------

/** Summary row returned in history.list_result (plan § 4 invocation + session columns). */
export const HistoryRow = z.object({
  invocationId: uuidStr(),
  sessionId: uuidStr(),
  agentName: z.string(),
  model: z.string(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  status: z.enum(["running", "completed", "failed", "stopped", "wiped"]),
  toolCallCount: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
  promptExcerpt: z.string(),
  title: z.string(),
  /** Non-null when this invocation was created via "resume from history". */
  resumedFromInvocationId: uuidStr().nullable(),
  /** Platform the session ran on. Defaults to "claude" for pre-migration rows. */
  platform: z.enum(["claude", "codex"]),
  /** Reasoning-effort tier the session was started with. Defaults to "none". */
  effort: EffortSchema,
  /**
   * Codex `approvalPolicy` the session was started with (one of
   * `"never" | "on-request" | "on-failure" | "untrusted"`). Null on Claude
   * rows and on Codex rows that pre-date migration #7.
   */
  approvalPolicy: z.string().nullable().optional(),
});
export type HistoryRow = z.infer<typeof HistoryRow>;

/** Full row for history.get_result — adds session join fields. */
export const HistoryRowFull = HistoryRow.extend({
  cwd: z.string(),
  permissionMode: z.string(),
  endedReason: z.string().nullable(),
  sdkSessionId: z.string().nullable(),
  eventLogPath: z.string(),
  parentInvocationId: uuidStr().nullable(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  totalCostUsd: z.number(),
});
export type HistoryRowFull = z.infer<typeof HistoryRowFull>;

// ---------------------------------------------------------------------------
// § 3.2 Heartbeat frames
// ---------------------------------------------------------------------------

export const ClientHbPing = z.object({
  type: z.literal("hb.ping"),
  seq,
  ts,
  nonce: z.string().length(16),
  ackSeq: z.number().int().nonnegative().nullable(),
});
export type ClientHbPing = z.infer<typeof ClientHbPing>;

export const ServerHbPong = z.object({
  type: z.literal("hb.pong"),
  seq,
  ts,
  echoNonce: z.string().length(16),
  clientTs: z.number(),
  serverTs: z.number(),
});
export type ServerHbPong = z.infer<typeof ServerHbPong>;

export const ServerHbPing = z.object({
  type: z.literal("hb.sping"),
  seq,
  ts,
  nonce: z.string().length(16),
});
export type ServerHbPing = z.infer<typeof ServerHbPing>;

export const ClientHbPong = z.object({
  type: z.literal("hb.spong"),
  seq,
  ts,
  echoNonce: z.string().length(16),
  serverTs: z.number(),
});
export type ClientHbPong = z.infer<typeof ClientHbPong>;

// ---------------------------------------------------------------------------
// § 3.3 Client → server application frames
// ---------------------------------------------------------------------------

/**
 * Permission-mode union spans both platforms' valid values. Claude uses the
 * first seven; Codex uses `codex-read-only | codex-workspace-write |
 * codex-danger-full-access` (prefixed so the union is unambiguous). The
 * per-backend bridge rejects values that don't match its platform.
 */
export const PermissionModeSchema = z.enum([
  // Claude / cq-internal
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
  "read-only",
  // Codex sandbox modes (mapped 1:1 to codex-sdk's SandboxMode)
  "codex-read-only",
  "codex-workspace-write",
  "codex-danger-full-access",
]);
export type PermissionModeValue = z.infer<typeof PermissionModeSchema>;

/** Backend platform the session should run on. */
export const PlatformSchema = z.enum(["claude", "codex"]);

/**
 * Codex `approvalPolicy` knob. Mirrors `@openai/codex-sdk@0.134.0`'s
 * `ApprovalMode` union exactly (see dist/index.d.ts line 235). Only
 * meaningful for `platform === "codex"` sessions; the facade rejects
 * non-null values on Claude sessions with `chat.error{code:
 * 'approval-policy-on-claude'}`.
 */
export const ApprovalPolicySchema = z.enum([
  "never",
  "on-request",
  "on-failure",
  "untrusted",
]);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

export const ChatStart = z.object({
  type: z.literal("chat.start"),
  seq,
  ts,
  model: z.string().optional(),
  permissionMode: PermissionModeSchema.optional(),
  /** Reasoning-effort knob; defaults to "none" (thinking disabled). */
  effort: EffortSchema.optional(),
  /**
   * Backend the session runs on. Server cross-checks against the resumed
   * session's prior platform and refuses on mismatch with `chat.error
   * {code:'platform-mismatch'}`. Optional for backward compatibility; the
   * facade defaults to "claude" when absent so legacy clients continue to
   * work.
   */
  platform: PlatformSchema.optional(),
  /**
   * Codex `approvalPolicy` to apply to this session (only meaningful for
   * `platform === "codex"`). The facade rejects non-null values for
   * `platform === "claude"` with `chat.error{code:'approval-policy-on-claude'}`.
   */
  approvalPolicy: ApprovalPolicySchema.optional(),
  resumeFromInvocationId: uuidStr().optional(),
});
export type ChatStart = z.infer<typeof ChatStart>;

export const ChatRejoin = z.object({
  type: z.literal("chat.rejoin"),
  seq,
  ts,
  sessionId: uuidStr(),
});
export type ChatRejoin = z.infer<typeof ChatRejoin>;

const AttachmentSchema = z.object({
  kind: z.enum(["image", "file"]),
  mimeType: z.string(),
  name: z.string(),
  dataBase64: z.string(),
});

export const ChatInput = z
  .object({
    type: z.literal("chat.input"),
    seq,
    ts,
    sessionId: uuidStr(),
    text: z.string(),
    attachments: z.array(AttachmentSchema).optional(),
  })
  .refine(
    (frame) => {
      if (!frame.attachments || frame.attachments.length === 0) return true;
      const total = frame.attachments.reduce(
        (sum, a) => sum + base64DecodedByteLength(a.dataBase64),
        0,
      );
      return total <= ATTACHMENT_TOTAL_MAX_BYTES;
    },
    {
      message: "attachments total exceeds 5 MB cap",
      path: ["attachments"],
    },
  );
export type ChatInput = z.infer<typeof ChatInput>;

export const ChatInterrupt = z.object({
  type: z.literal("chat.interrupt"),
  seq,
  ts,
  sessionId: uuidStr(),
});
export type ChatInterrupt = z.infer<typeof ChatInterrupt>;

export const ChatPermissionReply = z.object({
  type: z.literal("chat.permission_reply"),
  seq,
  ts,
  sessionId: uuidStr(),
  permissionRequestId: uuidStr(),
  decision: z.enum(["allow", "deny", "allow_once"]),
});
export type ChatPermissionReply = z.infer<typeof ChatPermissionReply>;

export const ChatQuestionReply = z.object({
  type: z.literal("chat.question_reply"),
  seq,
  ts,
  sessionId: uuidStr(),
  invocationId: uuidStr(),
  toolUseId: z.string(),
  answers: z.record(z.string(), z.unknown()),
});
export type ChatQuestionReply = z.infer<typeof ChatQuestionReply>;

export const ChatElicitationReply = z.object({
  type: z.literal("chat.elicitation_reply"),
  seq,
  ts,
  sessionId: uuidStr(),
  elicitationId: z.string(),
  action: z.enum(["accept", "decline", "cancel"]),
  content: z.record(z.string(), z.unknown()).optional(),
});
export type ChatElicitationReply = z.infer<typeof ChatElicitationReply>;

export const ChatReadFileRequest = z.object({
  type: z.literal("chat.read_file_request"),
  seq,
  ts,
  requestId: uuidStr(),
  sessionId: uuidStr(),
  path: z.string(),
  around: z.object({
    line: z.number().int().positive(),
    contextBefore: z.number().int().nonnegative().optional(),
    contextAfter: z.number().int().nonnegative().optional(),
  }),
});
export type ChatReadFileRequest = z.infer<typeof ChatReadFileRequest>;

export const ChatReadFileResult = z.object({
  type: z.literal("chat.read_file_result"),
  seq,
  ts,
  requestId: uuidStr(),
  content: z.string(),
  startLine: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type ChatReadFileResult = z.infer<typeof ChatReadFileResult>;

export const HistoryList = z.object({
  type: z.literal("history.list"),
  seq,
  ts,
  filter: z
    .object({
      agentName: z.string().optional(),
      model: z.string().optional(),
      status: z.enum(["completed", "failed", "stopped", "running", "wiped"]).optional(),
      dateFrom: z.number().optional(),
      dateTo: z.number().optional(),
      search: z.string().optional(),
    })
    .optional(),
  sort: z
    .object({ key: z.string(), dir: z.enum(["asc", "desc"]) })
    .optional(),
  page: z.number().int().nonnegative(),
  pageSize: z.number().int().positive().max(500),
});
export type HistoryList = z.infer<typeof HistoryList>;

export const HistoryGet = z.object({
  type: z.literal("history.get"),
  seq,
  ts,
  invocationId: uuidStr(),
  replay: z.boolean().optional(),
});
export type HistoryGet = z.infer<typeof HistoryGet>;

export const HistoryDelete = z.object({
  type: z.literal("history.delete"),
  seq,
  ts,
  what: z.enum(["session", "invocation"]),
  id: uuidStr(),
});
export type HistoryDelete = z.infer<typeof HistoryDelete>;

export const SessionRequestState = z.object({
  type: z.literal("session.request_state"),
  seq,
  ts,
  lastSeenServerSeq: z.number().int().nonnegative().nullable(),
});
export type SessionRequestState = z.infer<typeof SessionRequestState>;

export const SettingsGet = z.object({
  type: z.literal("settings.get"),
  seq,
  ts,
});
export type SettingsGet = z.infer<typeof SettingsGet>;

export const SettingsSet = z.object({
  type: z.literal("settings.set"),
  seq,
  ts,
  model: z.string().nullable().optional(),
  permissionMode: z.string().nullable().optional(),
  hideSdkEvents: z.boolean().optional(),
});
export type SettingsSet = z.infer<typeof SettingsSet>;

// ---------------------------------------------------------------------------
// § 3.4 Server → client application frames
// ---------------------------------------------------------------------------

export const ChatStarted = z.object({
  type: z.literal("chat.started"),
  seq,
  ts,
  sessionId: uuidStr(),
  invocationId: uuidStr(),
  initInfo: SDKInitInfo,
});
export type ChatStarted = z.infer<typeof ChatStarted>;

export const ChatEvent = z.object({
  type: z.literal("chat.event"),
  seq,
  ts,
  sessionId: uuidStr(),
  invocationId: uuidStr(),
  parentInvocationId: uuidStr().nullable(),
  sdkEvent: SDKMessageEnvelope,
});
export type ChatEvent = z.infer<typeof ChatEvent>;

export const ChatUsage = z.object({
  type: z.literal("chat.usage"),
  seq,
  ts,
  sessionId: uuidStr(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheCreateTokens: z.number().optional(),
  costUsd: z.number(),
});
export type ChatUsage = z.infer<typeof ChatUsage>;

export const ChatPermissionRequest = z.object({
  type: z.literal("chat.permission_request"),
  seq,
  ts,
  sessionId: uuidStr(),
  invocationId: uuidStr(),
  permissionRequestId: uuidStr(),
  toolName: z.string(),
  toolUseId: z.string(),
  input: z.record(z.string(), z.unknown()),
  title: z.string().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  suggestions: z.array(z.unknown()).optional(),
});
export type ChatPermissionRequest = z.infer<typeof ChatPermissionRequest>;

export const ChatElicitationRequest = z.object({
  type: z.literal("chat.elicitation_request"),
  seq,
  ts,
  sessionId: uuidStr(),
  elicitationId: z.string(),
  mcpServerName: z.string(),
  message: z.string(),
  mode: z.enum(["form", "url"]).optional(),
  url: z.string().optional(),
  requestedSchema: z.record(z.string(), z.unknown()).optional(),
  title: z.string().optional(),
});
export type ChatElicitationRequest = z.infer<typeof ChatElicitationRequest>;

export const ChatDone = z.object({
  type: z.literal("chat.done"),
  seq,
  ts,
  sessionId: uuidStr(),
  reason: z.enum(["completed", "interrupted", "errored", "max_turns", "max_budget"]),
});
export type ChatDone = z.infer<typeof ChatDone>;

export const ChatError = z.object({
  type: z.literal("chat.error"),
  seq,
  ts,
  sessionId: uuidStr().optional(),
  code: z.string(),
  message: z.string(),
});
export type ChatError = z.infer<typeof ChatError>;

export const HistoryListResult = z.object({
  type: z.literal("history.list_result"),
  seq,
  ts,
  requestSeq: z.number(),
  total: z.number(),
  rows: z.array(HistoryRow),
});
export type HistoryListResult = z.infer<typeof HistoryListResult>;

export const HistoryGetResult = z.object({
  type: z.literal("history.get_result"),
  seq,
  ts,
  requestSeq: z.number(),
  row: HistoryRowFull,
});
export type HistoryGetResult = z.infer<typeof HistoryGetResult>;

export const HistoryReplayEvent = z.object({
  type: z.literal("history.replay_event"),
  seq,
  ts,
  requestSeq: z.number(),
  invocationId: uuidStr(),
  ordinal: z.number().int().nonnegative(),
  sdkEvent: SDKMessageEnvelope,
});
export type HistoryReplayEvent = z.infer<typeof HistoryReplayEvent>;

export const HistoryReplayDone = z.object({
  type: z.literal("history.replay_done"),
  seq,
  ts,
  requestSeq: z.number(),
});
export type HistoryReplayDone = z.infer<typeof HistoryReplayDone>;

export const HistoryUpdate = z.object({
  type: z.literal("history.update"),
  seq,
  ts,
  invocationId: uuidStr(),
  patch: z.record(z.string(), z.unknown()),
});
export type HistoryUpdate = z.infer<typeof HistoryUpdate>;

export const SessionState = z.object({
  type: z.literal("session.state"),
  seq,
  ts,
  sessionId: uuidStr().nullable(),
  serverSeq: z.number(),
  gapDetected: z.boolean(),
});
export type SessionState = z.infer<typeof SessionState>;

export const SettingsGetResult = z.object({
  type: z.literal("settings.get_result"),
  seq,
  ts,
  requestSeq: z.number(),
  model: z.string().nullable(),
  permissionMode: z.string().nullable(),
  hideSdkEvents: z.boolean(),
});
export type SettingsGetResult = z.infer<typeof SettingsGetResult>;

// ---------------------------------------------------------------------------
// Discriminated unions for inbound validation (plan § 3)
// ---------------------------------------------------------------------------

/**
 * All frames the client sends to the server.
 * Used by the server WS session handler for inbound validation (PR-06).
 */
export const ClientFrame = z.discriminatedUnion("type", [
  ClientHbPing,
  ClientHbPong,
  ChatStart,
  ChatRejoin,
  ChatInput,
  ChatInterrupt,
  ChatPermissionReply,
  ChatQuestionReply,
  ChatElicitationReply,
  ChatReadFileRequest,
  HistoryList,
  HistoryGet,
  HistoryDelete,
  SessionRequestState,
  SettingsGet,
  SettingsSet,
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

/**
 * All frames the server sends to the client.
 * Used by the client WS hook for inbound validation (PR-08).
 */
export const ServerFrame = z.discriminatedUnion("type", [
  ServerHbPong,
  ServerHbPing,
  ChatStarted,
  ChatEvent,
  ChatUsage,
  ChatPermissionRequest,
  ChatElicitationRequest,
  ChatDone,
  ChatError,
  ChatReadFileResult,
  HistoryListResult,
  HistoryGetResult,
  HistoryReplayEvent,
  HistoryReplayDone,
  HistoryUpdate,
  SessionState,
  SettingsGetResult,
]);
export type ServerFrame = z.infer<typeof ServerFrame>;
