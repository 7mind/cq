import { ClientFrame, type ServerHbPong, type SessionState, type ChatError, type HistoryListResult, type HistoryGetResult, type HistoryReplayEvent, type HistoryReplayDone, type HistoryUpdate, type SettingsGetResult, type WorkflowEvent, type GoalsSnapshot, type ActivityStatus } from "@cq/shared";
import { FRAME_VALIDATION_FAILED } from "@cq/shared";
import type { Logger } from "../log/logger";
import { createHeartbeat, type HeartbeatHandle } from "./heartbeat";
import type { SessionRegistry } from "../seq/sessionRegistry";
import type { Bridge, WsSocket as BridgeWsSocket } from "../agent/bridge";
import type { Persistence } from "../persist/Persistence.js";
import type { WorkflowRuntime } from "../workflow/index.js";
import { parsePlanCommand } from "../workflow/index.js";
import type { ActivityTracker } from "./activityTracker";

// ---------------------------------------------------------------------------
// Data attached to each WebSocket connection via ws.data
// ---------------------------------------------------------------------------

export type WsSessionData = {
  sessionId: string;
  session: WsSession;
};

// ---------------------------------------------------------------------------
// Outbound frame helper type — server-to-client frames without seq/ts (injected)
// ---------------------------------------------------------------------------

type PongPayload = Omit<ServerHbPong, "seq" | "ts">;
type SessionStatePayload = Omit<SessionState, "seq" | "ts">;
type HistoryListResultPayload = Omit<HistoryListResult, "seq" | "ts">;
type HistoryGetResultPayload = Omit<HistoryGetResult, "seq" | "ts">;
type HistoryReplayEventPayload = Omit<HistoryReplayEvent, "seq" | "ts">;
type HistoryReplayDonePayload = Omit<HistoryReplayDone, "seq" | "ts">;
type HistoryUpdatePayload = Omit<HistoryUpdate, "seq" | "ts">;
type SettingsGetResultPayload = Omit<SettingsGetResult, "seq" | "ts">;
type WorkflowEventPayload = Omit<WorkflowEvent, "seq" | "ts">;
type GoalsSnapshotPayload = Omit<GoalsSnapshot, "seq" | "ts">;
type ActivityStatusPayload = Omit<ActivityStatus, "seq" | "ts">;

// ---------------------------------------------------------------------------
// WsSession — per-connection state and message dispatch
// ---------------------------------------------------------------------------

export class WsSession {
  private outboundSeq = 0;
  /** WS connection-level id (assigned at upgrade time). */
  readonly sessionId: string;
  /**
   * Chat session id — null until PR-19 sets it on `chat.start`.
   * The session.request_state handler returns sessionId:null when this is null.
   */
  chatSessionId: string | null = null;
  private readonly logger: Logger;
  private readonly heartbeat: HeartbeatHandle;
  private readonly registry: SessionRegistry | null;
  /**
   * Bridge instance — null in development/test mode where no SDK is wired.
   * When null, chat.start/input/interrupt return chat.error{code:BRIDGE_UNAVAILABLE}.
   */
  private readonly bridge: Bridge | null;
  /** Persistence — null when not wired (tests that don't need history). */
  private readonly persistence: Persistence | null;
  /**
   * WorkflowRuntime — null when not wired (tests / dev mode without a ledger
   * store). When null, `workflow.start` returns a `workflow.event` errored
   * frame so the client is not left waiting.
   */
  private readonly workflow: WorkflowRuntime | null;
  /**
   * Stable per-connection workflow lifecycle sink. Registered with the runtime
   * fan-out on `open` and removed on `close`, so async loop phases and
   * `question.answer`-triggered advances reach this connection even when they
   * fire outside the original `/plan` request. Bound to `ws` lazily in `open`.
   */
  private workflowSink: ((event: WorkflowEventPayload) => void) | null = null;
  /**
   * Aggregate activity tracker (ACTIVITY-01) — null when not wired (tests / a
   * server without it). When non-null this connection subscribes on `open` to
   * receive the initial `activity.status{running}` immediately and a fresh frame
   * on every transition of either compute lane.
   */
  private readonly activityTracker: ActivityTracker | null;
  /** Unsubscribe handle for the activity-tracker sink (set on open, called on close). */
  private activityUnsubscribe: (() => void) | null = null;
  /** The socket this session is bound to (set on open) for the fan-out sink. */
  private boundWs: WsSocket | null = null;

  constructor(sessionId: string, logger: Logger, registry?: SessionRegistry, bridge?: Bridge | null, persistence?: Persistence | null, workflow?: WorkflowRuntime | null, activityTracker?: ActivityTracker | null) {
    this.sessionId = sessionId;
    this.logger = logger;
    this.registry = registry ?? null;
    this.bridge = bridge ?? null;
    this.persistence = persistence ?? null;
    this.workflow = workflow ?? null;
    this.activityTracker = activityTracker ?? null;
    this.heartbeat = createHeartbeat({
      buildFrame: (payload) => {
        const seq = this.outboundSeq++;
        const ts = Date.now();
        return JSON.stringify({ ...payload, seq, ts });
      },
    });
  }

  /** Called by the Bun WS `open` handler. */
  open(ws: WsSocket): void {
    this.logger.info("ws.open", { sessionId: this.sessionId });
    this.heartbeat.start(ws);
    // Bind the socket before any subscribe so a synchronous initial push
    // (activity.status on connect) has a socket to write to.
    this.boundWs = ws;
    // Subscribe to workflow lifecycle frames so async loop phases (clarify /
    // plan / review) and question.answer-triggered advances reach this client.
    if (this.workflow !== null) {
      const sink = (event: WorkflowEventPayload): void => {
        if (this.boundWs !== null) this.sendFrame(this.boundWs, event);
      };
      this.workflowSink = sink;
      this.workflow.subscribe(sink);
    }
    // Subscribe to the aggregate activity tracker (ACTIVITY-01). `subscribe`
    // pushes the CURRENT running count synchronously (initial state on connect),
    // then a fresh value on every transition of either compute lane.
    if (this.activityTracker !== null) {
      const sink = (running: number): void => {
        if (this.boundWs !== null) {
          const payload: ActivityStatusPayload = { type: "activity.status", running };
          this.sendFrame(this.boundWs, payload);
        }
      };
      this.activityUnsubscribe = this.activityTracker.subscribe(sink);
    }
  }

  /** Called by the Bun WS `message` handler. */
  message(ws: WsSocket, raw: string | Buffer): void {
    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      this.logger.info("ws.validation_failed", {
        sessionId: this.sessionId,
        reason: "invalid JSON",
      });
      ws.close(FRAME_VALIDATION_FAILED, "invalid frame");
      return;
    }

    // Zod-validate against ClientFrame discriminated union
    const result = ClientFrame.safeParse(parsed);
    if (!result.success) {
      this.logger.info("ws.validation_failed", {
        sessionId: this.sessionId,
        reason: result.error.message,
      });
      ws.close(FRAME_VALIDATION_FAILED, "invalid frame");
      return;
    }

    const frame = result.data;

    switch (frame.type) {
      case "hb.ping": {
        const pong: PongPayload = {
          type: "hb.pong",
          echoNonce: frame.nonce,
          clientTs: frame.ts,
          serverTs: Date.now(),
        };
        this.sendFrame(ws, pong);
        break;
      }
      case "hb.spong": {
        this.heartbeat.onPong(ws, frame);
        break;
      }
      case "session.request_state": {
        this.handleRequestState(ws, frame.lastSeenServerSeq);
        break;
      }
      case "chat.start": {
        if (this.bridge === null) {
          this.sendBridgeUnavailable(ws);
        } else {
          this.bridge.handleChatStart(ws as BridgeWsSocket, frame).catch((err: unknown) => {
            this.logger.error("ws.bridge_error", { sessionId: this.sessionId, err: String(err) });
          });
        }
        break;
      }
      case "chat.rejoin": {
        if (this.bridge === null) {
          this.sendBridgeUnavailable(ws);
        } else {
          this.bridge.handleChatRejoin(ws as BridgeWsSocket, frame).catch((err: unknown) => {
            this.logger.error("ws.bridge_error", { sessionId: this.sessionId, err: String(err) });
          });
        }
        break;
      }
      case "chat.input": {
        if (this.bridge === null) {
          this.sendBridgeUnavailable(ws);
        } else {
          this.bridge.handleChatInput(ws as BridgeWsSocket, frame).catch((err: unknown) => {
            this.logger.error("ws.bridge_error", { sessionId: this.sessionId, err: String(err) });
          });
        }
        break;
      }
      case "chat.interrupt": {
        if (this.bridge === null) {
          this.sendBridgeUnavailable(ws);
        } else {
          this.bridge.handleChatInterrupt(ws as BridgeWsSocket, frame).catch((err: unknown) => {
            this.logger.error("ws.bridge_error", { sessionId: this.sessionId, err: String(err) });
          });
        }
        break;
      }
      case "workflow.start": {
        this.handleWorkflowStart(ws, frame.kind, frame.text, frame.goalRef, frame.platform);
        break;
      }
      case "question.answer": {
        this.handleQuestionAnswer(frame.questionId, frame.answer);
        break;
      }
      case "goals.list": {
        this.handleGoalsList(ws, frame.seq);
        break;
      }
      case "workflow.escalation_reply": {
        this.handleEscalationReply(frame.goalId, frame.choice, frame.guidance);
        break;
      }
      case "chat.permission_reply": {
        if (this.bridge !== null) {
          this.bridge.handleChatPermissionReply(ws as BridgeWsSocket, frame);
        }
        break;
      }
      case "chat.elicitation_reply": {
        if (this.bridge !== null) {
          this.bridge.handleChatElicitationReply(ws as BridgeWsSocket, frame);
        }
        break;
      }
      case "chat.question_reply": {
        if (this.bridge !== null) {
          this.bridge.handleChatQuestionReply(ws as BridgeWsSocket, frame);
        }
        break;
      }
      case "chat.read_file_request": {
        if (this.bridge !== null) {
          this.bridge.handleChatReadFileRequest(ws as BridgeWsSocket, frame).catch((err: unknown) => {
            this.logger.error("ws.bridge_error", { sessionId: this.sessionId, err: String(err) });
          });
        }
        break;
      }
      case "history.list": {
        if (this.persistence === null) break;
        this.logger.info("ws.history_list", {
          sessionId: this.sessionId,
          seq: frame.seq,
          filter: frame.filter,
        });
        const f = frame.filter ?? {};
        const sortKey = frame.sort?.key ?? "startedAt";
        const sortDir = (frame.sort?.dir ?? "desc") as "asc" | "desc";
        // Map protocol sort key names to InvocationSortField names
        const sortFieldMap: Record<string, string> = {
          started_at: "startedAt",
          ended_at: "endedAt",
          duration_ms: "durationMs",
          cost_usd: "costUsd",
          tool_call_count: "toolCallCount",
          startedAt: "startedAt",
          endedAt: "endedAt",
          durationMs: "durationMs",
          costUsd: "costUsd",
          toolCallCount: "toolCallCount",
        };
        const mappedSort = (sortFieldMap[sortKey] ?? "startedAt") as import("../persist/Persistence.js").InvocationSortField;
        const invFilter: import("../persist/Persistence.js").InvocationFilter = {};
        if (f.agentName !== undefined) invFilter.agentName = f.agentName;
        if (f.model !== undefined) invFilter.model = f.model;
        if (f.status !== undefined) invFilter.status = f.status;
        if (f.dateFrom !== undefined) invFilter.dateFrom = f.dateFrom;
        if (f.dateTo !== undefined) invFilter.dateTo = f.dateTo;
        if (f.search !== undefined) invFilter.search = f.search;
        const result = this.persistence.invocations.list(
          invFilter,
          { field: mappedSort, dir: sortDir },
          { limit: frame.pageSize, offset: frame.page * frame.pageSize },
        );
        const payload: HistoryListResultPayload = {
          type: "history.list_result",
          requestSeq: frame.seq,
          total: result.total,
          rows: result.rows,
        };
        this.sendFrame(ws, payload);
        break;
      }
      case "history.get": {
        if (this.persistence === null) break;
        const full = this.persistence.invocations.getFull(frame.invocationId);
        if (full === undefined) break;
        const payload: HistoryGetResultPayload = {
          type: "history.get_result",
          requestSeq: frame.seq,
          row: full,
        };
        this.sendFrame(ws, payload);
        // replay:true — stream all persisted events for this invocation.
        if (frame.replay === true) {
          this.handleHistoryReplay(ws, frame.seq, frame.invocationId).catch((err: unknown) => {
            this.logger.error("ws.replay_error", { invocationId: frame.invocationId, err: String(err) });
          });
        }
        break;
      }
      case "history.delete": {
        if (this.persistence === null) break;
        if (frame.what === "session") {
          this.persistence.sessions.delete(frame.id);
        } else {
          this.persistence.invocations.delete(frame.id);
        }
        // Emit confirmation: history.update{patch:{deleted:true}} keyed by the id.
        const confirmPayload: HistoryUpdatePayload = {
          type: "history.update",
          invocationId: frame.id,
          patch: { deleted: true },
        };
        this.sendFrame(ws, confirmPayload);
        break;
      }
      case "settings.get": {
        if (this.persistence === null) break;
        const s = this.persistence.settings.get();
        const settingsPayload: SettingsGetResultPayload = {
          type: "settings.get_result",
          requestSeq: frame.seq,
          model: s.model,
          permissionMode: s.permissionMode,
          hideSdkEvents: s.hideSdkEvents,
        };
        this.sendFrame(ws, settingsPayload);
        break;
      }
      case "settings.set": {
        if (this.persistence === null) break;
        const patch: Partial<{ model: string | null; permissionMode: string | null; hideSdkEvents: boolean }> = {};
        if (frame.model !== undefined) patch.model = frame.model;
        if (frame.permissionMode !== undefined) patch.permissionMode = frame.permissionMode;
        if (frame.hideSdkEvents !== undefined) patch.hideSdkEvents = frame.hideSdkEvents;
        this.persistence.settings.set(patch);
        break;
      }
      // All other client frames are accepted but not yet dispatched (PR-07+)
      default:
        // Accepted; no-op until later PRs wire the handlers.
        break;
    }
  }

  /** Called by the Bun WS `close` handler. */
  close(ws: WsSocket, code: number, reason: string): void {
    this.logger.info("ws.close", { sessionId: this.sessionId, code, reason });
    this.heartbeat.stop(ws);
    if (this.workflow !== null && this.workflowSink !== null) {
      this.workflow.unsubscribe(this.workflowSink);
      this.workflowSink = null;
    }
    if (this.activityUnsubscribe !== null) {
      this.activityUnsubscribe();
      this.activityUnsubscribe = null;
    }
    this.boundWs = null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Handles `session.request_state` from the client (post-reconnect catchup).
   *
   * Decision tree per plan § 3.5:
   *  - No chat session (chatSessionId === null) → session.state{sessionId:null, gapDetected:false, serverSeq:0}
   *  - lastSeenServerSeq >= buffer.serverSeq → no gap; session.state{gapDetected:false}
   *  - gap within buffer → replay missing entries, then session.state{gapDetected:false}
   *  - gap exceeds buffer → session.state{gapDetected:true} (client recovers via history.get in M4)
   */
  private handleRequestState(ws: WsSocket, lastSeenServerSeq: number | null): void {
    if (this.chatSessionId === null || this.registry === null) {
      // No active chat session on this WS connection.
      const payload: SessionStatePayload = {
        type: "session.state",
        sessionId: null,
        serverSeq: 0,
        gapDetected: false,
      };
      this.sendFrame(ws, payload);
      return;
    }

    const sessionState = this.registry.get(this.chatSessionId);
    if (sessionState === undefined) {
      // Session id set but not found in registry — treat as no session.
      const payload: SessionStatePayload = {
        type: "session.state",
        sessionId: null,
        serverSeq: 0,
        gapDetected: false,
      };
      this.sendFrame(ws, payload);
      return;
    }

    const { buffer } = sessionState;
    const result = buffer.getSince(lastSeenServerSeq);

    if (result === "GAP_EXCEEDS") {
      const payload: SessionStatePayload = {
        type: "session.state",
        sessionId: this.chatSessionId,
        serverSeq: buffer.serverSeq,
        gapDetected: true,
      };
      this.sendFrame(ws, payload);
      return;
    }

    // Replay missing entries (idempotent — keep original seq values).
    for (const entry of result) {
      ws.send(JSON.stringify(entry.frame));
    }

    // Then confirm state to client.
    const payload: SessionStatePayload = {
      type: "session.state",
      sessionId: this.chatSessionId,
      serverSeq: buffer.serverSeq,
      gapDetected: false,
    };
    this.sendFrame(ws, payload);
  }

  /**
   * Routes a `/plan …` workflow command (Q7/Q9). The leading `/plan` token is
   * already stripped client-side; the registry classifies the remainder.
   * Lifecycle frames fan out via the runtime to every subscribed connection
   * (this session's `workflowSink` registered on open), so async loop phases
   * reach the client even when they fire outside this request. The workflow
   * runs in its own dispatch lane — it does NOT occupy the pool=1 interactive
   * Bridge session.
   */
  private handleWorkflowStart(
    ws: WsSocket,
    kind: "plan",
    text: string,
    goalRef: string | undefined,
    platform: "claude" | "codex" | undefined,
  ): void {
    if (this.workflow === null || this.workflowSink === null) {
      // No runtime wired — emit an errored lifecycle frame so the client is
      // not left waiting. Mirrors BRIDGE_UNAVAILABLE for the chat path.
      const payload: WorkflowEventPayload = {
        type: "workflow.event",
        workflowId: crypto.randomUUID(),
        phase: "produce",
        status: "errored",
        detail: "No workflow runtime is configured on this server",
      };
      this.sendFrame(ws, payload);
      return;
    }
    const emit = this.workflowSink;

    const parsed = parsePlanCommand(text, goalRef);
    switch (parsed.kind) {
      case "malformed": {
        emit({
          type: "workflow.event",
          workflowId: crypto.randomUUID(),
          phase: "produce",
          status: "errored",
          detail: parsed.reason,
        });
        return;
      }
      case "plan_continue": {
        // Append an increment to an existing goal (Q9/Q10). Fire-and-forget:
        // lifecycle frames stream as the continuation progresses, exactly like
        // plan_new. The runtime gates on goal state (stable goals only).
        void this.workflow
          .continueGoal(parsed.goalRef, parsed.text, platform ?? "claude", emit)
          .catch((err: unknown) => {
            this.logger.error("ws.workflow_error", {
              sessionId: this.sessionId,
              kind,
              err: String(err),
            });
          });
        return;
      }
      case "plan_new": {
        // Fire-and-forget: lifecycle frames stream as the run progresses.
        void this.workflow
          .startPlan({ text: parsed.text, platform: platform ?? "claude" }, emit)
          .catch((err: unknown) => {
            this.logger.error("ws.workflow_error", {
              sessionId: this.sessionId,
              kind,
              err: String(err),
            });
          });
        return;
      }
    }
  }

  /**
   * Handle a `question.answer` frame: the HARNESS writes the answer into the
   * questions ledger (status open→answered) and the runtime auto-advances the
   * relevant loop when this answer takes the goal's open-question count to zero.
   * No-op when no runtime is wired.
   */
  private handleQuestionAnswer(questionId: string, answer: string): void {
    if (this.workflow === null) return;
    void this.workflow.submitAnswer(questionId, answer).catch((err: unknown) => {
      this.logger.error("ws.question_answer_error", {
        sessionId: this.sessionId,
        questionId,
        err: String(err),
      });
    });
  }

  /**
   * Handle a `goals.list` request: build the Goals-tab snapshot from the
   * ledgers via the WorkflowRuntime and reply with a single `goals.snapshot`
   * keyed by the request seq (mirrors history.list → history.list_result). The
   * snapshot read is a pure in-memory store read (no lock), so it cannot raise
   * LedgerBusyError even during a concurrent workflow write. No-op when no
   * runtime is wired.
   */
  private handleGoalsList(ws: WsSocket, requestSeq: number): void {
    if (this.workflow === null) return;
    const { goals, totalOpenQuestions } = this.workflow.buildGoalsSnapshot();
    const payload: GoalsSnapshotPayload = {
      type: "goals.snapshot",
      requestSeq,
      goals,
      totalOpenQuestions,
    };
    this.sendFrame(ws, payload);
  }

  /**
   * Handle a `workflow.escalation_reply` frame: resolve the WFL-D01 no-progress
   * escalation. proceed → planned+done; guidance → re-dispatch planner +
   * resume the review loop; abandon → abandoned. Lifecycle frames fan out via
   * the runtime to every subscribed connection. No-op when no runtime is wired.
   */
  private handleEscalationReply(
    goalId: string,
    choice: "proceed" | "guidance" | "abandon",
    guidance: string | undefined,
  ): void {
    if (this.workflow === null) return;
    void this.workflow.submitEscalationReply(goalId, choice, guidance).catch((err: unknown) => {
      this.logger.error("ws.escalation_reply_error", {
        sessionId: this.sessionId,
        goalId,
        choice,
        err: String(err),
      });
    });
  }

  /**
   * Sends a frame to the client, injecting `seq` and `ts` automatically.
   * `payload` must contain all fields except `seq` and `ts`.
   */
  private sendFrame(ws: WsSocket, payload: PongPayload | SessionStatePayload | HistoryListResultPayload | HistoryGetResultPayload | HistoryReplayEventPayload | HistoryReplayDonePayload | HistoryUpdatePayload | SettingsGetResultPayload | WorkflowEventPayload | GoalsSnapshotPayload | ActivityStatusPayload): void {
    const seq = this.outboundSeq++;
    const ts = Date.now();
    ws.send(JSON.stringify({ ...payload, seq, ts }));
  }

  /**
   * Streams all persisted events for an invocation as `history.replay_event` frames,
   * then emits a final `history.replay_done` frame.
   */
  private async handleHistoryReplay(ws: WsSocket, requestSeq: number, invocationId: string): Promise<void> {
    let ordinal = 0;
    for await (const event of this.persistence!.events.readAll(invocationId)) {
      const evtPayload: HistoryReplayEventPayload = {
        type: "history.replay_event",
        requestSeq,
        invocationId,
        ordinal: ordinal++,
        sdkEvent: event as import("@cq/shared").SDKMessageEnvelope,
      };
      this.sendFrame(ws, evtPayload);
    }
    const donePayload: HistoryReplayDonePayload = {
      type: "history.replay_done",
      requestSeq,
    };
    this.sendFrame(ws, donePayload);
  }

  /**
   * Emits chat.error{code:'BRIDGE_UNAVAILABLE'} when no bridge is configured.
   * Used in development/test mode.
   */
  private sendBridgeUnavailable(ws: WsSocket): void {
    const frame: Omit<ChatError, "seq" | "ts"> = {
      type: "chat.error",
      code: "BRIDGE_UNAVAILABLE",
      message: "No SDK bridge is configured on this server",
    };
    const seq = this.outboundSeq++;
    const ts = Date.now();
    ws.send(JSON.stringify({ ...frame, seq, ts }));
  }
}

// ---------------------------------------------------------------------------
// Minimal ServerWebSocket shape Bun exposes — typed locally to avoid coupling
// to Bun global types that may not be in scope everywhere.
// ---------------------------------------------------------------------------

type WsSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  data: WsSessionData;
};
