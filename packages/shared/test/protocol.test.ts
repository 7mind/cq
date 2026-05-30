import { test, expect, describe } from "bun:test";
import {
  ClientHbPing,
  ServerHbPong,
  ServerHbPing,
  ClientHbPong,
  ChatStart,
  ChatInput,
  ChatInterrupt,
  ChatPermissionReply,
  ChatQuestionReply,
  ChatElicitationReply,
  ChatReadFileRequest,
  ChatReadFileResult,
  HistoryList,
  HistoryGet,
  HistoryDelete,
  SessionRequestState,
  ChatStarted,
  ChatEvent,
  ChatUsage,
  ChatPermissionRequest,
  ChatElicitationRequest,
  ChatDone,
  ChatError,
  HistoryListResult,
  HistoryGetResult,
  HistoryReplayEvent,
  HistoryReplayDone,
  HistoryUpdate,
  SessionState,
  ClientFrame,
  ServerFrame,
  GoalsList,
  GoalsSnapshot,
  WorkflowEscalationReply,
  ActivityStatus,
  SDKMessageEnvelope,
  base64DecodedByteLength,
  ATTACHMENT_TOTAL_MAX_BYTES,
} from "../src/protocol.js";
import { isRetriable } from "../src/close-codes.js";

const NOW = Date.now();
const UUID = "00000000-0000-4000-8000-000000000001";
const NONCE16 = "a1b2c3d4e5f60001"; // exactly 16 chars

// ---------------------------------------------------------------------------
// § 3.2 Heartbeat frames
// ---------------------------------------------------------------------------

describe("Heartbeats", () => {
  test("ClientHbPing round-trips", () => {
    const frame = { type: "hb.ping" as const, seq: 0, ts: NOW, nonce: NONCE16, ackSeq: null };
    expect(ClientHbPing.parse(frame)).toEqual(frame);
  });

  test("ServerHbPong round-trips", () => {
    const frame = {
      type: "hb.pong" as const,
      seq: 1,
      ts: NOW,
      echoNonce: NONCE16,
      clientTs: NOW - 10,
      serverTs: NOW,
    };
    expect(ServerHbPong.parse(frame)).toEqual(frame);
  });

  test("ServerHbPing round-trips", () => {
    const frame = { type: "hb.sping" as const, seq: 2, ts: NOW, nonce: NONCE16 };
    expect(ServerHbPing.parse(frame)).toEqual(frame);
  });

  test("ClientHbPong round-trips", () => {
    const frame = {
      type: "hb.spong" as const,
      seq: 3,
      ts: NOW,
      echoNonce: NONCE16,
      serverTs: NOW,
    };
    expect(ClientHbPong.parse(frame)).toEqual(frame);
  });

  test("ClientHbPing rejects nonce of wrong length", () => {
    const result = ClientHbPing.safeParse({
      type: "hb.ping",
      seq: 0,
      ts: NOW,
      nonce: "tooshort",
      ackSeq: 0,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path[0]);
      expect(paths).toContain("nonce");
    }
  });
});

// ---------------------------------------------------------------------------
// § 3.3 Client → server
// ---------------------------------------------------------------------------

describe("ChatStart", () => {
  test("ChatStart round-trips", () => {
    const frame = {
      type: "chat.start" as const,
      seq: 0,
      ts: NOW,
      model: "claude-opus-4",
      permissionMode: "default" as const,
      resumeFromInvocationId: UUID,
    };
    expect(ChatStart.parse(frame)).toEqual(frame);
  });

  test("ChatStart rejects invalid permissionMode", () => {
    const result = ChatStart.safeParse({
      type: "chat.start",
      seq: 0,
      ts: NOW,
      permissionMode: "invalid_mode",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path[0]);
      expect(paths).toContain("permissionMode");
    }
  });
});

describe("ChatInput", () => {
  test("ChatInput round-trips with no attachments", () => {
    const frame = {
      type: "chat.input" as const,
      seq: 1,
      ts: NOW,
      sessionId: UUID,
      text: "Hello",
    };
    expect(ChatInput.parse(frame)).toEqual(frame);
  });

  test("ChatInput round-trips with small attachments", () => {
    // 4_000_000 base64 chars → floor(4_000_000 * 3/4) = 3_000_000 bytes < 5MB
    const smallB64 = "A".repeat(4_000_000);
    const frame = {
      type: "chat.input" as const,
      seq: 2,
      ts: NOW,
      sessionId: UUID,
      text: "with attachment",
      attachments: [{ kind: "image" as const, mimeType: "image/png", name: "img.png", dataBase64: smallB64 }],
    };
    const result = ChatInput.safeParse(frame);
    expect(result.success).toBe(true);
  });

  test("ChatInput rejects oversize attachments", () => {
    // 7_000_000 base64 chars → floor(7_000_000 * 3/4) = 5_250_000 bytes > 5MB
    const bigB64 = "A".repeat(7_000_000);
    const result = ChatInput.safeParse({
      type: "chat.input",
      seq: 3,
      ts: NOW,
      sessionId: UUID,
      text: "big attachment",
      attachments: [{ kind: "image", mimeType: "image/png", name: "big.png", dataBase64: bigB64 }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.flatMap((i) => i.path);
      expect(paths).toContain("attachments");
    }
  });
});

test("ChatInterrupt round-trips", () => {
  const frame = { type: "chat.interrupt" as const, seq: 4, ts: NOW, sessionId: UUID };
  expect(ChatInterrupt.parse(frame)).toEqual(frame);
});

test("ChatPermissionReply round-trips", () => {
  const frame = {
    type: "chat.permission_reply" as const,
    seq: 5,
    ts: NOW,
    sessionId: UUID,
    permissionRequestId: UUID,
    decision: "allow" as const,
  };
  expect(ChatPermissionReply.parse(frame)).toEqual(frame);
});

test("ChatQuestionReply round-trips", () => {
  const frame = {
    type: "chat.question_reply" as const,
    seq: 6,
    ts: NOW,
    sessionId: UUID,
    invocationId: UUID,
    toolUseId: "toolu_abc",
    answers: { field: "value" },
  };
  expect(ChatQuestionReply.parse(frame)).toEqual(frame);
});

test("ChatElicitationReply round-trips", () => {
  const frame = {
    type: "chat.elicitation_reply" as const,
    seq: 7,
    ts: NOW,
    sessionId: UUID,
    elicitationId: "elic_1",
    action: "accept" as const,
    content: { key: "val" },
  };
  expect(ChatElicitationReply.parse(frame)).toEqual(frame);
});

test("HistoryList round-trips", () => {
  const frame = {
    type: "history.list" as const,
    seq: 8,
    ts: NOW,
    page: 0,
    pageSize: 50,
    filter: { status: "completed" as const },
    sort: { key: "startedAt", dir: "desc" as const },
  };
  expect(HistoryList.parse(frame)).toEqual(frame);
});

test("HistoryGet round-trips", () => {
  const frame = {
    type: "history.get" as const,
    seq: 9,
    ts: NOW,
    invocationId: UUID,
    replay: true,
  };
  expect(HistoryGet.parse(frame)).toEqual(frame);
});

test("HistoryDelete round-trips", () => {
  const frame = {
    type: "history.delete" as const,
    seq: 10,
    ts: NOW,
    what: "invocation" as const,
    id: UUID,
  };
  expect(HistoryDelete.parse(frame)).toEqual(frame);
});

test("SessionRequestState round-trips", () => {
  const frame = {
    type: "session.request_state" as const,
    seq: 11,
    ts: NOW,
    lastSeenServerSeq: null,
  };
  expect(SessionRequestState.parse(frame)).toEqual(frame);
});

// ---------------------------------------------------------------------------
// § 3.4 Server → client
// ---------------------------------------------------------------------------

test("ChatStarted round-trips", () => {
  const frame = {
    type: "chat.started" as const,
    seq: 12,
    ts: NOW,
    sessionId: UUID,
    invocationId: UUID,
    initInfo: { model: "claude-opus-4", toolCount: 3 },
  };
  expect(ChatStarted.parse(frame)).toEqual(frame);
});

test("SDKMessageEnvelope passthrough preserves unknown subtypes", () => {
  const envelope = {
    type: "assistant",
    subtype: "future_unknown_subtype",
    content: [{ type: "text", text: "hello" }],
    extra_field: 42,
  };
  const result = SDKMessageEnvelope.parse(envelope);
  // passthrough: unknown fields must survive
  expect(result).toEqual(envelope);
  expect((result as Record<string, unknown>)["subtype"]).toBe("future_unknown_subtype");
  expect((result as Record<string, unknown>)["extra_field"]).toBe(42);
});

test("ChatEvent round-trips", () => {
  const frame = {
    type: "chat.event" as const,
    seq: 13,
    ts: NOW,
    sessionId: UUID,
    invocationId: UUID,
    parentInvocationId: null,
    sdkEvent: { type: "assistant", content: [] },
  };
  expect(ChatEvent.parse(frame)).toEqual(frame);
});

test("ChatUsage round-trips", () => {
  const frame = {
    type: "chat.usage" as const,
    seq: 14,
    ts: NOW,
    sessionId: UUID,
    inputTokens: 100,
    outputTokens: 200,
    costUsd: 0.01,
  };
  expect(ChatUsage.parse(frame)).toEqual(frame);
});

test("ChatPermissionRequest round-trips", () => {
  const frame = {
    type: "chat.permission_request" as const,
    seq: 15,
    ts: NOW,
    sessionId: UUID,
    invocationId: UUID,
    permissionRequestId: UUID,
    toolName: "bash",
    toolUseId: "toolu_xyz",
    input: { command: "ls" },
  };
  expect(ChatPermissionRequest.parse(frame)).toEqual(frame);
});

test("ChatElicitationRequest round-trips", () => {
  const frame = {
    type: "chat.elicitation_request" as const,
    seq: 16,
    ts: NOW,
    sessionId: UUID,
    elicitationId: "elic_2",
    mcpServerName: "my-mcp",
    message: "Please provide your API key",
  };
  expect(ChatElicitationRequest.parse(frame)).toEqual(frame);
});

test("ChatDone round-trips", () => {
  const frame = {
    type: "chat.done" as const,
    seq: 17,
    ts: NOW,
    sessionId: UUID,
    reason: "completed" as const,
  };
  expect(ChatDone.parse(frame)).toEqual(frame);
});

test("ChatError round-trips (no sessionId)", () => {
  const frame = {
    type: "chat.error" as const,
    seq: 18,
    ts: NOW,
    code: "INTERNAL_ERROR",
    message: "Something went wrong",
  };
  expect(ChatError.parse(frame)).toEqual(frame);
});

test("HistoryListResult round-trips", () => {
  const row = {
    invocationId: UUID,
    sessionId: UUID,
    agentName: "main",
    model: "claude-opus-4",
    startedAt: NOW,
    endedAt: null,
    durationMs: null,
    status: "running" as const,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    promptExcerpt: "Hello",
    title: "My Chat",
    resumedFromInvocationId: null,
    platform: "claude" as const,
    effort: "none" as const,
  };
  const frame = {
    type: "history.list_result" as const,
    seq: 19,
    ts: NOW,
    requestSeq: 8,
    total: 1,
    rows: [row],
  };
  expect(HistoryListResult.parse(frame)).toEqual(frame);
});

test("HistoryGetResult round-trips", () => {
  const row = {
    invocationId: UUID,
    sessionId: UUID,
    agentName: "main",
    model: "claude-opus-4",
    startedAt: NOW,
    endedAt: NOW + 5000,
    durationMs: 5000,
    status: "completed" as const,
    toolCallCount: 2,
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.001,
    promptExcerpt: "Hello",
    title: "My Chat",
    cwd: "/home/user",
    permissionMode: "default",
    endedReason: "completed",
    sdkSessionId: null,
    eventLogPath: "var/db/events/abc.jsonl",
    parentInvocationId: null,
    resumedFromInvocationId: null,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCostUsd: 0.001,
    platform: "claude" as const,
    effort: "none" as const,
  };
  const frame = {
    type: "history.get_result" as const,
    seq: 20,
    ts: NOW,
    requestSeq: 9,
    row,
  };
  expect(HistoryGetResult.parse(frame)).toEqual(frame);
});

test("HistoryReplayEvent round-trips", () => {
  const frame = {
    type: "history.replay_event" as const,
    seq: 21,
    ts: NOW,
    requestSeq: 9,
    invocationId: UUID,
    ordinal: 0,
    sdkEvent: { type: "user", content: "hi" },
  };
  expect(HistoryReplayEvent.parse(frame)).toEqual(frame);
});

test("HistoryReplayDone round-trips", () => {
  const frame = { type: "history.replay_done" as const, seq: 22, ts: NOW, requestSeq: 9 };
  expect(HistoryReplayDone.parse(frame)).toEqual(frame);
});

test("HistoryUpdate round-trips", () => {
  const frame = {
    type: "history.update" as const,
    seq: 23,
    ts: NOW,
    invocationId: UUID,
    patch: { status: "completed", durationMs: 1234 },
  };
  expect(HistoryUpdate.parse(frame)).toEqual(frame);
});

test("SessionState round-trips", () => {
  const frame = {
    type: "session.state" as const,
    seq: 24,
    ts: NOW,
    sessionId: null,
    serverSeq: 0,
    gapDetected: false,
  };
  expect(SessionState.parse(frame)).toEqual(frame);
});

// ---------------------------------------------------------------------------
// Discriminated unions
// ---------------------------------------------------------------------------

test("ClientFrame discriminator routes hb.ping vs chat.start", () => {
  const ping = { type: "hb.ping" as const, seq: 0, ts: NOW, nonce: NONCE16, ackSeq: null };
  const start = { type: "chat.start" as const, seq: 1, ts: NOW };

  const pingParsed = ClientFrame.parse(ping);
  const startParsed = ClientFrame.parse(start);

  expect(pingParsed.type).toBe("hb.ping");
  expect(startParsed.type).toBe("chat.start");
});

test("ServerFrame discriminator routes chat.event vs hb.pong", () => {
  const pong = {
    type: "hb.pong" as const,
    seq: 0,
    ts: NOW,
    echoNonce: NONCE16,
    clientTs: NOW,
    serverTs: NOW,
  };
  const event = {
    type: "chat.event" as const,
    seq: 1,
    ts: NOW,
    sessionId: UUID,
    invocationId: UUID,
    parentInvocationId: null,
    sdkEvent: { type: "assistant" },
  };

  const pongParsed = ServerFrame.parse(pong);
  const eventParsed = ServerFrame.parse(event);

  expect(pongParsed.type).toBe("hb.pong");
  expect(eventParsed.type).toBe("chat.event");
});

test("ClientFrame rejects unknown type", () => {
  const result = ClientFrame.safeParse({ type: "unknown.frame", seq: 0, ts: NOW });
  expect(result.success).toBe(false);
});

// ---------------------------------------------------------------------------
// PR-36: chat.read_file_request / chat.read_file_result
// ---------------------------------------------------------------------------

describe("ChatReadFileRequest", () => {
  test("round-trips with contextBefore and contextAfter", () => {
    const frame = {
      type: "chat.read_file_request" as const,
      seq: 25,
      ts: NOW,
      requestId: UUID,
      sessionId: UUID,
      path: "/etc/hosts",
      around: { line: 12, contextBefore: 5, contextAfter: 5 },
    };
    expect(ChatReadFileRequest.parse(frame)).toEqual(frame);
  });

  test("round-trips without optional context fields", () => {
    const frame = {
      type: "chat.read_file_request" as const,
      seq: 26,
      ts: NOW,
      requestId: UUID,
      sessionId: UUID,
      path: "src/index.ts",
      around: { line: 1 },
    };
    expect(ChatReadFileRequest.parse(frame)).toEqual(frame);
  });

  test("rejects when line is 0 (must be positive)", () => {
    const result = ChatReadFileRequest.safeParse({
      type: "chat.read_file_request",
      seq: 0,
      ts: NOW,
      requestId: UUID,
      sessionId: UUID,
      path: "/etc/hosts",
      around: { line: 0 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.flatMap((i) => i.path);
      expect(paths).toContain("line");
    }
  });

  test("is accepted by ClientFrame discriminated union", () => {
    const frame = {
      type: "chat.read_file_request" as const,
      seq: 27,
      ts: NOW,
      requestId: UUID,
      sessionId: UUID,
      path: "/etc/hosts",
      around: { line: 12 },
    };
    const parsed = ClientFrame.parse(frame);
    expect(parsed.type).toBe("chat.read_file_request");
  });
});

describe("ChatReadFileResult", () => {
  test("round-trips with content", () => {
    const frame = {
      type: "chat.read_file_result" as const,
      seq: 28,
      ts: NOW,
      requestId: UUID,
      content: "line7\nline8\nline9",
      startLine: 7,
    };
    expect(ChatReadFileResult.parse(frame)).toEqual(frame);
  });

  test("round-trips with error field", () => {
    const frame = {
      type: "chat.read_file_result" as const,
      seq: 29,
      ts: NOW,
      requestId: UUID,
      content: "",
      startLine: 0,
      error: "file not found",
    };
    expect(ChatReadFileResult.parse(frame)).toEqual(frame);
  });

  test("rejects missing requestId", () => {
    const result = ChatReadFileResult.safeParse({
      type: "chat.read_file_result",
      seq: 0,
      ts: NOW,
      content: "x",
      startLine: 1,
    });
    expect(result.success).toBe(false);
  });

  test("is accepted by ServerFrame discriminated union", () => {
    const frame = {
      type: "chat.read_file_result" as const,
      seq: 30,
      ts: NOW,
      requestId: UUID,
      content: "line1",
      startLine: 1,
    };
    const parsed = ServerFrame.parse(frame);
    expect(parsed.type).toBe("chat.read_file_result");
  });
});

// ---------------------------------------------------------------------------
// Goals tab frames (cycle 4)
// ---------------------------------------------------------------------------

describe("Goals frames", () => {
  test("GoalsList round-trips and is accepted by ClientFrame", () => {
    const frame = { type: "goals.list" as const, seq: 5, ts: NOW };
    expect(GoalsList.parse(frame)).toEqual(frame);
    expect(ClientFrame.parse(frame).type).toBe("goals.list");
  });

  test("GoalsSnapshot round-trips and is accepted by ServerFrame", () => {
    const frame = {
      type: "goals.snapshot" as const,
      seq: 6,
      ts: NOW,
      requestSeq: 5,
      totalOpenQuestions: 1,
      goals: [
        {
          id: "G1",
          title: "Notes app",
          description: "A notes app.",
          status: "clarifying",
          openQuestionCount: 1,
          milestones: [
            {
              id: "M1",
              title: "produce an actionable specification",
              status: "open",
              questions: [
                {
                  id: "Q1",
                  question: "Which platforms?",
                  context: "scope",
                  suggestions: ["web", "desktop"],
                  recommendation: "web",
                  status: "open",
                },
              ],
              tasks: [],
            },
            {
              id: "M2",
              title: "Core build",
              status: "open",
              questions: [],
              tasks: [{ id: "T1", headline: "Editor", status: "planned" }],
            },
          ],
        },
      ],
    };
    expect(GoalsSnapshot.parse(frame)).toEqual(frame);
    expect(ServerFrame.parse(frame).type).toBe("goals.snapshot");
  });

  test("WorkflowEscalationReply: proceed/abandon need no guidance", () => {
    for (const choice of ["proceed", "abandon"] as const) {
      const frame = { type: "workflow.escalation_reply" as const, seq: 7, ts: NOW, goalId: "G1", choice };
      expect(WorkflowEscalationReply.parse(frame)).toEqual(frame);
      expect(ClientFrame.parse(frame).type).toBe("workflow.escalation_reply");
    }
  });

  test("WorkflowEscalationReply: guidance requires non-empty guidance text", () => {
    const ok = {
      type: "workflow.escalation_reply" as const,
      seq: 8,
      ts: NOW,
      goalId: "G1",
      choice: "guidance" as const,
      guidance: "prefer SQLite",
    };
    expect(WorkflowEscalationReply.parse(ok)).toEqual(ok);

    const blankGuidance = { ...ok, guidance: "   " };
    expect(WorkflowEscalationReply.safeParse(blankGuidance).success).toBe(false);
    const missingGuidance = { type: "workflow.escalation_reply", seq: 8, ts: NOW, goalId: "G1", choice: "guidance" };
    expect(WorkflowEscalationReply.safeParse(missingGuidance).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Close-code isRetriable
// ---------------------------------------------------------------------------

test("close-codes isRetriable: 1012 yes, 4000 no, 1008 no, 4001 yes", () => {
  expect(isRetriable(1012)).toBe(true);
  expect(isRetriable(4000)).toBe(false);
  expect(isRetriable(1008)).toBe(false);
  expect(isRetriable(4001)).toBe(true);
  // additional checks per § 3.6 table
  expect(isRetriable(1000)).toBe(false);
  expect(isRetriable(4002)).toBe(false);
  expect(isRetriable(1001)).toBe(true);
  expect(isRetriable(1011)).toBe(true);
  // 1006 = abnormal closure (synthesized locally, never sent as a real frame)
  // — NAT drop, TCP reset, freeze → always retriable
  expect(isRetriable(1006)).toBe(true);
});

// ---------------------------------------------------------------------------
// base64DecodedByteLength helper
// ---------------------------------------------------------------------------

test("base64DecodedByteLength computes correct sizes", () => {
  // "Man" → 3 bytes, base64 "TWFu" (no padding)
  expect(base64DecodedByteLength("TWFu")).toBe(3);
  // "Ma" → 2 bytes, base64 "TWE=" (1 padding)
  expect(base64DecodedByteLength("TWE=")).toBe(2);
  // "M" → 1 byte, base64 "TQ==" (2 padding)
  expect(base64DecodedByteLength("TQ==")).toBe(1);
});

test("ATTACHMENT_TOTAL_MAX_BYTES equals 5 MiB", () => {
  expect(ATTACHMENT_TOTAL_MAX_BYTES).toBe(5 * 1024 * 1024);
});

// ---------------------------------------------------------------------------
// activity.status (ACTIVITY-01) — aggregate compute-activity frame
// ---------------------------------------------------------------------------

describe("ActivityStatus", () => {
  test("round-trips and is accepted by ServerFrame", () => {
    const frame = { type: "activity.status" as const, seq: 11, ts: NOW, running: 2 };
    expect(ActivityStatus.parse(frame)).toEqual(frame);
    expect(ServerFrame.parse(frame).type).toBe("activity.status");
  });

  test("accepts running = 0 (idle)", () => {
    const frame = { type: "activity.status" as const, seq: 0, ts: NOW, running: 0 };
    expect(ActivityStatus.parse(frame)).toEqual(frame);
  });

  test("rejects negative running", () => {
    const result = ActivityStatus.safeParse({ type: "activity.status", seq: 0, ts: NOW, running: -1 });
    expect(result.success).toBe(false);
  });

  test("rejects non-integer running", () => {
    const result = ActivityStatus.safeParse({ type: "activity.status", seq: 0, ts: NOW, running: 1.5 });
    expect(result.success).toBe(false);
  });

  test("rejects missing running", () => {
    const result = ActivityStatus.safeParse({ type: "activity.status", seq: 0, ts: NOW });
    expect(result.success).toBe(false);
  });
});
