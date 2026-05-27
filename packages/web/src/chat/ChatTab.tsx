/**
 * ChatTab.tsx — top-level chat shell component.
 *
 * Layout (F1, F2):
 *   header (fixed height, never scrolls)
 *   [search bar, when open]
 *   stream  (flex:1, scrolls internally — owns auto-scroll logic)
 *   footer  (sticky bottom — Input + Stop button + AttachmentList)
 *
 * Search (F4):
 *   Ctrl+F (Linux/Windows) or Cmd+F (macOS) opens the search bar and focuses it.
 *   Esc closes. ↑/↓ navigate matches. The match index is passed into Stream
 *   which highlights the active bubble and scrolls it into view.
 *
 * Jump-to-latest (F2):
 *   When Stream reports the user has scrolled up (onScrolledUp), we render a
 *   "↓ Jump to latest" button in the footer area. Clicking it sets
 *   scrollToBottom=true on Stream, which then calls onScrollToBottomDone to
 *   clear it.
 *
 * Subscribes to useConnection() for the Manager instance.
 * Subscribes to manager.onMessage() to accumulate chat.event frames.
 * On chat.start, clears the accumulated event list.
 */

import { useRef, useState, useEffect, useMemo, useCallback } from "react";
import { useConnection, useConnectionStats } from "../ws/useConnection";
import { Input } from "./Input";
import { Stream } from "./Stream";
import { Header } from "./Header";
import { SearchBar } from "./SearchBar";
import { PermissionPrompt } from "./PermissionPrompt";
import type { PermissionDecision } from "./PermissionPrompt";
import { ElicitationCard } from "./Cards/ElicitationCard";
import type { ElicitationReply } from "./Cards/ElicitationCard";
import type { PermissionMode } from "./Header";
import type { ChatInput, ChatInterrupt, ChatEvent, ChatStart, ChatStarted, ChatUsage, ChatPermissionRequest, ChatPermissionReply, ChatElicitationRequest, ChatElicitationReply, ChatQuestionReply, HistoryGet, HistoryReplayEvent, ChatError } from "@cq/shared";
import { ATTACHMENT_TOTAL_MAX_BYTES, base64DecodedByteLength } from "@cq/shared";
import type { QuestionReplyPayload } from "./Cards/AskCard";
import type { SlashCommand } from "./SlashPopover";
import type { Attachment } from "../lib/attachment";
import { showToast } from "../lib/toast";
import { computeTasks } from "./computeTasks";
import { TaskListSidebar } from "./TaskListSidebar";
import { isMacPlatform } from "../lib/platform";
import { computeMatchIndices, computeRenderedMessages } from "./Stream";
import tabStyles from "../styles/ChatTab.module.css";

export function ChatTab(): React.ReactElement {
  const manager = useConnection();
  const stats = useConnectionStats();
  const seqRef = useRef(0);
  const [chatEvents, setChatEvents] = useState<ChatEvent[]>([]);
  // activeSessionId is the persistent session handle. Set once on the first
  // chat.started (early stub) and cleared only on WS disconnect. Used as the
  // sessionId field on outbound chat.input / chat.interrupt frames.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // inProgress is true only between sending a chat.input and receiving the
  // corresponding chat.done. This gates the textarea (disabled while waiting)
  // and the Stop button (visible only while waiting). Decoupled from
  // activeSessionId so the textarea stays enabled when the session is idle.
  const [inProgress, setInProgress] = useState(false);
  // True between sending chat.start and receiving chat.started — prevents duplicate starts.
  const chatStartPendingRef = useRef(false);
  // True when the user explicitly triggered new/resume session — prevents auto-start racing.
  const userInitiatedStartRef = useRef(false);

  // --- Header state (PR-25) ---
  const [cwd, setCwd] = useState<string>("");
  const [model, setModel] = useState<string>("claude-sonnet-4-6");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("bypassPermissions");
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

  // ---- F4: Search state ----
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // 0-based index of the active match within the matchIndices array.
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);

  // Compute rendered messages and match indices for search (memoised).
  const renderedMessages = useMemo(() => computeRenderedMessages(chatEvents), [chatEvents]);
  const matchIndices = useMemo(
    () => computeMatchIndices(renderedMessages, searchQuery),
    [renderedMessages, searchQuery],
  );

  // Clamp activeMatchIndex whenever the match list changes.
  useEffect(() => {
    if (matchIndices.length === 0) {
      setActiveMatchIndex(0);
    } else if (activeMatchIndex >= matchIndices.length) {
      setActiveMatchIndex(matchIndices.length - 1);
    }
  }, [matchIndices.length]); // intentional: only clamp on count change

  function openSearch(): void {
    setSearchOpen(true);
  }

  function closeSearch(): void {
    setSearchOpen(false);
    setSearchQuery("");
    setActiveMatchIndex(0);
  }

  function goToNextMatch(): void {
    if (matchIndices.length === 0) return;
    setActiveMatchIndex((i) => (i + 1) % matchIndices.length);
  }

  function goToPrevMatch(): void {
    if (matchIndices.length === 0) return;
    setActiveMatchIndex((i) => (i - 1 + matchIndices.length) % matchIndices.length);
  }

  // Ctrl+F (Linux/Windows) or Cmd+F (macOS) opens the search bar.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      const isMac = isMacPlatform();
      const isSearchChord = e.key === "f" && (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
      if (isSearchChord) {
        e.preventDefault();
        openSearch();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // ---- F2: Jump-to-latest state ----
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const [triggerScrollToBottom, setTriggerScrollToBottom] = useState(false);

  const handleScrolledUp = useCallback((up: boolean) => {
    setUserScrolledUp(up);
  }, []);

  function handleJumpToLatest(): void {
    setTriggerScrollToBottom(true);
    setUserScrolledUp(false);
  }

  function handleScrollToBottomDone(): void {
    setTriggerScrollToBottom(false);
  }

  // Subscribe to incoming server frames and accumulate chat.event entries.
  // Track session lifecycle via chat.started / chat.done.
  useEffect(() => {
    const unsub = manager.onMessage((frame) => {
      if (frame.type === "chat.started") {
        const started = frame as ChatStarted;
        chatStartPendingRef.current = false;
        userInitiatedStartRef.current = false;
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
        // Turn finished — clear in-progress so the textarea re-enables.
        // Keep activeSessionId set: the session stays alive for multi-turn.
        setInProgress(false);
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
      } else if (frame.type === "chat.error") {
        const errFrame = frame as ChatError;
        showToast({ level: "error", text: errFrame.message });
      }
    });
    return unsub;
  }, [manager]);

  // Auto-start: fire chat.start when the connection first reaches ALIVE and no
  // session is active. Also re-fires on reconnect (ALIVE returned after being absent).
  // Guards: don't fire while a chat.start is already in-flight (chatStartPendingRef),
  // and don't fire when the user already triggered their own start (userInitiatedStartRef).
  const prevWasAliveRef = useRef(false);
  useEffect(() => {
    const isAlive = stats.connections.some((c) => c.state === "ALIVE");
    const wasAlive = prevWasAliveRef.current;
    prevWasAliveRef.current = isAlive;

    // ALIVE → not-ALIVE: WS dropped. The server-side bridge.active state is
    // tied to the connection lifecycle, so the prior session is no longer
    // valid. Drop client-side session state so the next ALIVE edge auto-starts
    // a fresh session.
    if (wasAlive && !isAlive) {
      setActiveSessionId(null);
      setInProgress(false);
      chatStartPendingRef.current = false;
      return;
    }

    // Only act on the ALIVE edge (false → true).
    if (!isAlive || wasAlive) return;
    // Already have an active session — nothing to do.
    if (activeSessionId !== null) return;
    // Another start is already in-flight.
    if (chatStartPendingRef.current) return;
    // User pressed New Session or Resume — they'll send their own chat.start.
    if (userInitiatedStartRef.current) return;

    chatStartPendingRef.current = true;
    const frame: ChatStart = {
      type: "chat.start",
      seq: seqRef.current++,
      ts: Date.now(),
      model,
      permissionMode,
    };
    manager.send(frame);
  }, [stats]); // intentional: only re-run when stats changes; model/permissionMode are captured at call time

  function handleSubmit(text: string, attachments: Attachment[] = []): void {
    if (activeSessionId === null) return;

    // Enforce the 5 MB total attachment cap client-side before sending.
    if (attachments.length > 0) {
      const totalBytes = attachments.reduce(
        (sum, a) => sum + base64DecodedByteLength(a.dataBase64),
        0,
      );
      if (totalBytes > ATTACHMENT_TOTAL_MAX_BYTES) {
        showToast({ level: "error", text: "Attachments exceed the 5 MB limit. Remove some files before sending." });
        return;
      }
    }

    setInProgress(true);
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
    userInitiatedStartRef.current = true;
    chatStartPendingRef.current = true;
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
    userInitiatedStartRef.current = true;
    chatStartPendingRef.current = true;
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

  // `inProgress` is the explicit state set/cleared in the chat.input → chat.done
  // window above; activeSessionId is the persistent session handle.

  // 1-based match counter for SearchBar display.
  const displayMatchCount = matchIndices.length;
  const displayCurrentMatch = displayMatchCount > 0 ? activeMatchIndex + 1 : 0;

  return (
    <div className={tabStyles.shell} data-testid="chat-tab-shell">
      {tasks.size > 0 && <TaskListSidebar tasks={tasks} />}
      {/* Fixed header — never scrolls */}
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
      {/* F4: Search bar — shown when open, sits between header and stream */}
      {searchOpen && (
        <SearchBar
          query={searchQuery}
          onChange={(q) => { setSearchQuery(q); setActiveMatchIndex(0); }}
          onClose={closeSearch}
          onPrev={goToPrevMatch}
          onNext={goToNextMatch}
          matchCount={displayMatchCount}
          currentMatch={displayCurrentMatch}
        />
      )}
      {/* F2: Scrollable stream — owns its own overflow */}
      <Stream
        chatEvents={chatEvents}
        onQuestionReply={handleQuestionReply}
        inProgress={inProgress}
        searchQuery={searchQuery}
        activeMatchIndex={activeMatchIndex}
        onScrolledUp={handleScrolledUp}
        scrollToBottom={triggerScrollToBottom}
        onScrollToBottomDone={handleScrollToBottomDone}
      />
      {/* F2: Jump-to-latest button — floats above footer when user scrolled up */}
      {userScrolledUp && (
        <button
          className={tabStyles.jumpButton}
          onClick={handleJumpToLatest}
          type="button"
          data-testid="jump-to-latest-btn"
          aria-label="Jump to latest message"
        >
          ↓ Jump to latest
        </button>
      )}
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
      {/* F1: Sticky footer — input + stop button, never scrolls */}
      <div className={tabStyles.footer} data-testid="chat-footer">
        <Input
          onSubmit={handleSubmit}
          onInterrupt={handleInterrupt}
          disabled={inProgress}
          slashCommands={slashCommands}
        />
      </div>
    </div>
  );
}
