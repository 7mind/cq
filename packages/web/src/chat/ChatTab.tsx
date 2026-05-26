/**
 * ChatTab.tsx — top-level chat shell component.
 *
 * Renders:
 *   - <Header> at the top: cwd, model picker, permission-mode, live usage,
 *     session id, started-at, duration, new-session button.
 *   - <Stream> for assistant output, fed by accumulated chat.event frames.
 *   - <Input> for user text entry.
 *
 * On submit, builds a ChatInput frame and calls manager.send(). The session id
 * is read from the chat.started server frame (PR-25).
 *
 * Tracks in-progress state: set on chat.started, cleared on chat.done. While
 * in-progress the Input is disabled and a Stop button is shown; clicking Stop
 * sends chat.interrupt to the server.
 *
 * Subscribes to useConnection() for the Manager instance.
 * Subscribes to manager.onMessage() to accumulate chat.event frames.
 * On chat.start, clears the accumulated event list.
 */

import { useRef, useState, useEffect, useMemo } from "react";
import { useConnection } from "../ws/useConnection";
import { Input } from "./Input";
import { Stream } from "./Stream";
import { Header } from "./Header";
import { PermissionPrompt } from "./PermissionPrompt";
import type { PermissionDecision } from "./PermissionPrompt";
import { ElicitationCard } from "./Cards/ElicitationCard";
import type { ElicitationReply } from "./Cards/ElicitationCard";
import type { PermissionMode } from "./Header";
import type { ChatInput, ChatInterrupt, ChatEvent, ChatStart, ChatStarted, ChatUsage, ChatPermissionRequest, ChatPermissionReply, ChatElicitationRequest, ChatElicitationReply, ChatQuestionReply, HistoryGet, HistoryReplayEvent } from "@cq/shared";
import { ATTACHMENT_TOTAL_MAX_BYTES, base64DecodedByteLength } from "@cq/shared";
import type { QuestionReplyPayload } from "./Cards/AskCard";
import type { SlashCommand } from "./SlashPopover";
import type { Attachment } from "../lib/attachment";
import { showToast } from "../lib/toast";
import { computeTasks } from "./computeTasks";
import { TaskListSidebar } from "./TaskListSidebar";

export function ChatTab(): React.ReactElement {
  const manager = useConnection();
  const seqRef = useRef(0);
  const [chatEvents, setChatEvents] = useState<ChatEvent[]>([]);
  // activeSessionId is non-null while a query is in progress (chat.started received,
  // chat.done not yet received). Used to gate the Stop button and send interrupt.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // --- Header state (PR-25) ---
  const [cwd, setCwd] = useState<string>("");
  const [model, setModel] = useState<string>("claude-sonnet-4-6");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  const [inputTokens, setInputTokens] = useState(0);
  const [outputTokens, setOutputTokens] = useState(0);
  const [costUsd, setCostUsd] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [invocationId, setInvocationId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // Invocation id from which to replay history after chat.started (set when resuming).
  const pendingReplayInvocationIdRef = useRef<string | null>(null);
  // PR-28: pending permission requests, ordered by arrival.
  const [permissionRequests, setPermissionRequests] = useState<ChatPermissionRequest[]>([]);
  // PR-30: pending elicitation requests, ordered by arrival.
  const [elicitationRequests, setElicitationRequests] = useState<ChatElicitationRequest[]>([]);
  // PR-34: slash commands from initInfo (or sensible defaults).
  const DEFAULT_SLASH_COMMANDS: SlashCommand[] = [
    { name: "/help" },
    { name: "/clear" },
    { name: "/cwd" },
    { name: "/model" },
    { name: "/cost" },
  ];
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>(DEFAULT_SLASH_COMMANDS);

  // Subscribe to incoming server frames and accumulate chat.event entries.
  // Track session lifecycle via chat.started / chat.done.
  useEffect(() => {
    const unsub = manager.onMessage((frame) => {
      if (frame.type === "chat.started") {
        const started = frame as ChatStarted;
        setActiveSessionId(started.sessionId);
        setSessionId(started.sessionId);
        setInvocationId(started.invocationId);
        setStartedAt(Date.now());
        // Extract cwd from initInfo if present.
        const info = started.initInfo as Record<string, unknown>;
        if (typeof info["cwd"] === "string") {
          setCwd(info["cwd"] as string);
        }
        // Extract slash_commands from initInfo (PR-34).
        const rawCmds = info["slash_commands"];
        if (Array.isArray(rawCmds)) {
          const parsed: SlashCommand[] = [];
          for (const c of rawCmds) {
            if (c !== null && typeof c === "object" && typeof (c as Record<string, unknown>)["name"] === "string") {
              const entry: SlashCommand = { name: (c as Record<string, unknown>)["name"] as string };
              const desc = (c as Record<string, unknown>)["description"];
              if (typeof desc === "string") entry.description = desc;
              parsed.push(entry);
            }
          }
          if (parsed.length > 0) setSlashCommands(parsed);
        }
        // Reset usage counters for new session.
        setInputTokens(0);
        setOutputTokens(0);
        setCostUsd(0);
        // Clear previous conversation.
        setChatEvents([]);
        // If a resume replay was requested, fire history.get now.
        const replayId = pendingReplayInvocationIdRef.current;
        if (replayId !== null) {
          pendingReplayInvocationIdRef.current = null;
          const histGetFrame: HistoryGet = {
            type: "history.get",
            seq: Date.now(),
            ts: Date.now(),
            invocationId: replayId,
            replay: true,
          };
          manager.send(histGetFrame);
        }
      } else if (frame.type === "history.replay_event") {
        // Prepend replay events before live events (ordinal ordering guaranteed by server).
        const replayEvt = frame as unknown as HistoryReplayEvent;
        // Convert replay event to a synthetic ChatEvent so Stream can render it.
        const synthetic: ChatEvent = {
          type: "chat.event",
          seq: replayEvt.ordinal,
          ts: replayEvt.ts,
          sessionId: replayEvt.invocationId, // use invocationId as placeholder sessionId
          invocationId: replayEvt.invocationId,
          parentInvocationId: null,
          sdkEvent: replayEvt.sdkEvent,
        };
        setChatEvents((prev) => {
          // Only prepend if this ordinal hasn't been added yet.
          if (prev.some((e) => e.seq === replayEvt.ordinal && e.invocationId === replayEvt.invocationId)) {
            return prev;
          }
          return [synthetic, ...prev];
        });
      } else if (frame.type === "chat.done") {
        setActiveSessionId(null);
      } else if (frame.type === "chat.event") {
        setChatEvents((prev) => [...prev, frame as ChatEvent]);
      } else if (frame.type === "chat.usage") {
        const usage = frame as ChatUsage;
        setInputTokens(usage.inputTokens);
        setOutputTokens(usage.outputTokens);
        setCostUsd(usage.costUsd);
      } else if (frame.type === "chat.permission_request") {
        setPermissionRequests((prev) => [...prev, frame as ChatPermissionRequest]);
      } else if (frame.type === "chat.elicitation_request") {
        setElicitationRequests((prev) => [...prev, frame as ChatElicitationRequest]);
      }
    });
    return unsub;
  }, [manager]);

  function handleSubmit(text: string, attachments: Attachment[] = []): void {
    if (activeSessionId === null) return;

    // Enforce the 5 MB total attachment cap client-side before sending.
    if (attachments.length > 0) {
      const totalBytes = attachments.reduce(
        (sum, a) => sum + base64DecodedByteLength(a.dataBase64),
        0,
      );
      if (totalBytes > ATTACHMENT_TOTAL_MAX_BYTES) {
        showToast("Attachments exceed the 5 MB limit. Remove some files before sending.");
        return;
      }
    }

    const seq = seqRef.current++;
    const frame: ChatInput = {
      type: "chat.input",
      seq,
      ts: Date.now(),
      sessionId: activeSessionId,
      text,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
    manager.send(frame);
  }

  function handleInterrupt(): void {
    if (activeSessionId === null) return;
    const frame: ChatInterrupt = {
      type: "chat.interrupt",
      seq: seqRef.current++,
      ts: Date.now(),
      sessionId: activeSessionId,
    };
    manager.send(frame);
  }

  function handleNewSession(): void {
    // Interrupt any in-progress session before starting fresh.
    if (activeSessionId !== null) {
      handleInterrupt();
    }
    const frame: ChatStart = {
      type: "chat.start",
      seq: seqRef.current++,
      ts: Date.now(),
      model,
      permissionMode,
    };
    manager.send(frame);
  }

  function handleResumeSession(invocationId: string): void {
    // Store the invocationId to replay after chat.started arrives.
    pendingReplayInvocationIdRef.current = invocationId;
    // Interrupt any in-progress session before resuming.
    if (activeSessionId !== null) {
      handleInterrupt();
    }
    const frame: ChatStart = {
      type: "chat.start",
      seq: seqRef.current++,
      ts: Date.now(),
      model,
      permissionMode,
      resumeFromInvocationId: invocationId,
    };
    manager.send(frame);
  }

  function handlePermissionReply(req: ChatPermissionRequest, decision: PermissionDecision): void {
    // Remove the request from the pending list.
    setPermissionRequests((prev) =>
      prev.filter((r) => r.permissionRequestId !== req.permissionRequestId),
    );
    if (activeSessionId === null) return;
    const frame: ChatPermissionReply = {
      type: "chat.permission_reply",
      seq: seqRef.current++,
      ts: Date.now(),
      sessionId: activeSessionId,
      permissionRequestId: req.permissionRequestId,
      decision,
    };
    manager.send(frame);
  }

  function handleQuestionReply(payload: QuestionReplyPayload): void {
    if (activeSessionId === null || invocationId === null) return;
    const frame: ChatQuestionReply = {
      type: "chat.question_reply",
      seq: seqRef.current++,
      ts: Date.now(),
      sessionId: activeSessionId,
      invocationId,
      toolUseId: payload.toolUseId,
      answers: payload.answers,
    };
    manager.send(frame);
  }

  function handleElicitationReply(req: ChatElicitationRequest, reply: ElicitationReply): void {
    // Remove the request from the pending list.
    setElicitationRequests((prev) =>
      prev.filter((r) => r.elicitationId !== req.elicitationId),
    );
    if (activeSessionId === null) return;
    const frame: ChatElicitationReply = {
      type: "chat.elicitation_reply",
      seq: seqRef.current++,
      ts: Date.now(),
      sessionId: activeSessionId,
      elicitationId: req.elicitationId,
      action: reply.action,
      ...(reply.content !== undefined ? { content: reply.content } : {}),
    };
    manager.send(frame);
  }

  // Derive the task list from accumulated events (pure, memoised).
  // The sidebar is always rendered when tasks are present; it is hidden (empty)
  // when the Map is empty — callers do not need to toggle it manually.
  const tasks = useMemo(() => computeTasks(chatEvents), [chatEvents]);

  const inProgress = activeSessionId !== null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {tasks.size > 0 && <TaskListSidebar tasks={tasks} />}
      <Header
        cwd={cwd}
        model={model}
        onModelChange={setModel}
        permissionMode={permissionMode}
        onPermissionModeChange={setPermissionMode}
        inputTokens={inputTokens}
        outputTokens={outputTokens}
        costUsd={costUsd}
        sessionId={sessionId}
        startedAt={startedAt}
        inProgress={inProgress}
        onNewSession={handleNewSession}
        onResumeSession={handleResumeSession}
      />
      <Stream chatEvents={chatEvents} onQuestionReply={handleQuestionReply} />
      {permissionRequests.map((req) => (
        <PermissionPrompt
          key={req.permissionRequestId}
          frame={req}
          onReply={(decision) => handlePermissionReply(req, decision)}
        />
      ))}
      {elicitationRequests.map((req) => (
        <ElicitationCard
          key={req.elicitationId}
          frame={req}
          onReply={(reply) => handleElicitationReply(req, reply)}
        />
      ))}
      <Input
        onSubmit={handleSubmit}
        onInterrupt={handleInterrupt}
        disabled={inProgress}
        slashCommands={slashCommands}
      />
    </div>
  );
}
