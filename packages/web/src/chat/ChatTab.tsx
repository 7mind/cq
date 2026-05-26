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

import { useRef, useState, useEffect } from "react";
import { useConnection } from "../ws/useConnection";
import { Input } from "./Input";
import { Stream } from "./Stream";
import { Header } from "./Header";
import { PermissionPrompt } from "./PermissionPrompt";
import type { PermissionDecision } from "./PermissionPrompt";
import { ElicitationCard } from "./Cards/ElicitationCard";
import type { ElicitationReply } from "./Cards/ElicitationCard";
import type { PermissionMode } from "./Header";
import type { ChatInput, ChatInterrupt, ChatEvent, ChatStart, ChatStarted, ChatUsage, ChatPermissionRequest, ChatPermissionReply, ChatElicitationRequest, ChatElicitationReply } from "@cq/shared";

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
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // PR-28: pending permission requests, ordered by arrival.
  const [permissionRequests, setPermissionRequests] = useState<ChatPermissionRequest[]>([]);
  // PR-30: pending elicitation requests, ordered by arrival.
  const [elicitationRequests, setElicitationRequests] = useState<ChatElicitationRequest[]>([]);

  // Subscribe to incoming server frames and accumulate chat.event entries.
  // Track session lifecycle via chat.started / chat.done.
  useEffect(() => {
    const unsub = manager.onMessage((frame) => {
      if (frame.type === "chat.started") {
        const started = frame as ChatStarted;
        setActiveSessionId(started.sessionId);
        setSessionId(started.sessionId);
        setStartedAt(Date.now());
        // Extract cwd from initInfo if present.
        const info = started.initInfo as Record<string, unknown>;
        if (typeof info["cwd"] === "string") {
          setCwd(info["cwd"] as string);
        }
        // Reset usage counters for new session.
        setInputTokens(0);
        setOutputTokens(0);
        setCostUsd(0);
        // Clear previous conversation.
        setChatEvents([]);
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

  function handleSubmit(text: string): void {
    if (activeSessionId === null) return;
    const seq = seqRef.current++;
    const frame: ChatInput = {
      type: "chat.input",
      seq,
      ts: Date.now(),
      sessionId: activeSessionId,
      text,
      attachments: undefined,
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

  const inProgress = activeSessionId !== null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
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
      />
      <Stream chatEvents={chatEvents} />
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
      />
    </div>
  );
}
