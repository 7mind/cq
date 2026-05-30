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
import { useSession } from "./SessionContext";
import { Input } from "./Input";
import { Stream } from "./Stream";
import { Header } from "./Header";
import { SearchBar } from "./SearchBar";
import { PermissionPrompt } from "./PermissionPrompt";
import type { PermissionDecision } from "./PermissionPrompt";
import { ElicitationCard } from "./Cards/ElicitationCard";
import type { ElicitationReply } from "./Cards/ElicitationCard";
import { Detail } from "../history/Detail";
import type { PermissionMode } from "./Header";
import type { ChatInput, ChatInterrupt, ChatEvent, ChatStart, ChatRejoin, ChatStarted, ChatUsage, ChatPermissionRequest, ChatPermissionReply, ChatElicitationRequest, ChatElicitationReply, ChatQuestionReply, HistoryGet, HistoryReplayEvent, ChatError, SettingsGet, SettingsSet, SettingsGetResult, ApprovalPolicy, Effort, WorkflowStart, WorkflowEvent } from "@cq/shared";
import { DEFAULT_EFFORT, modelToPlatform } from "@cq/shared";
import { WorkflowBanner } from "./WorkflowBanner";
import { ATTACHMENT_TOTAL_MAX_BYTES, base64DecodedByteLength } from "@cq/shared";
import type { QuestionReplyPayload } from "./Cards/AskCard";
import type { SlashCommand } from "./SlashPopover";
import type { Attachment } from "../lib/attachment";
import { showToast } from "../lib/toast";
import { computeTasks } from "./computeTasks";
import { computeSubagentCount } from "./computeSubagentCount";
import { TaskListSidebar } from "./TaskListSidebar";
import { isMacPlatform } from "../lib/platform";
import { computeMatchIndices, computeRenderedMessages } from "./Stream";
import tabStyles from "../styles/ChatTab.module.css";

// gear-3 localStorage helpers — small and isolated so unit tests can pass
// a noop localStorage shim. Reads return the fallback when the key is
// missing or the API is unavailable (SSR, private browsing, etc.).
function lsReadString(key: string, fallback: string): string {
  try {
    const v = localStorage.getItem(key);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function lsReadEffort(key: string, fallback: Effort): Effort {
  const raw = lsReadString(key, fallback);
  const valid: readonly Effort[] = ["none", "low", "medium", "high", "max"];
  return valid.includes(raw as Effort) ? (raw as Effort) : fallback;
}

/**
 * gcn1-3: read the Codex approvalPolicy from localStorage. Defaults to
 * "on-request" — the codex-sdk default. Validates against the SDK's
 * 4-value union so a stale or corrupted entry falls back cleanly.
 */
function lsReadApprovalPolicy(key: string, fallback: ApprovalPolicy): ApprovalPolicy {
  const raw = lsReadString(key, fallback);
  const valid: readonly ApprovalPolicy[] = ["never", "on-request", "on-failure", "untrusted"];
  return valid.includes(raw as ApprovalPolicy) ? (raw as ApprovalPolicy) : fallback;
}

/**
 * gcn1-3: spread of the optional `approvalPolicy` field on ChatStart.
 * Codex sessions carry the popup-selected value; Claude sessions omit
 * the field (the facade rejects non-null approvalPolicy on Claude).
 */
function approvalPolicyFor(model: string, approvalPolicy: ApprovalPolicy): { approvalPolicy?: ApprovalPolicy } {
  return modelToPlatform(model) === "codex" ? { approvalPolicy } : {};
}

function lsWrite(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // best-effort
  }
}

export function ChatTab(): React.ReactElement {
  const manager = useConnection();
  const stats = useConnectionStats();
  // activeSessionId and inProgress are lifted into SessionContext so they
  // survive Chat ↔ History tab switches (E2E-D04).
  const { activeSessionId, setActiveSessionId, inProgress, setInProgress, resumeRequest, clearResumeRequest } = useSession();
  const seqRef = useRef(0);
  const [chatEvents, setChatEvents] = useState<ChatEvent[]>([]);
  // D49: count of user messages submitted while a turn was already in progress
  // (queued by the server's SDK queue). Cleared to 0 on each chat.done boundary.
  const [queuedUserMessageCount, setQueuedUserMessageCount] = useState(0);
  // True between sending chat.start/chat.rejoin and receiving chat.started — prevents duplicate starts.
  const chatStartPendingRef = useRef(false);
  // True when the user explicitly triggered new/resume session — prevents auto-start racing.
  const userInitiatedStartRef = useRef(false);
  // True while a chat.rejoin is in-flight on the first ALIVE edge (D47).
  const rejoinPendingRef = useRef(false);
  // Safety timer that self-clears rejoinPendingRef after 20 s if neither
  // chat.started nor chat.error arrives (e.g. silent WS partition with no
  // close frame). 20 s is chosen to be well beyond any realistic server RTT
  // while still bounding the stuck-true window.
  const rejoinTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True when ALIVE edge fired but chat.start is deferred until settings.get_result
  // arrives (D41/D6). Once settings.get_result lands this is cleared and chat.start
  // is sent. Safety: a fallback timer fires chat.start after 3 s if no result arrives.
  const chatStartDeferredRef = useRef(false);
  const settingsFallbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // D33: chat.started fires twice per new session (early stub + late real-init).
  // We must only clear chatEvents on the FIRST one — otherwise live events
  // received between the two (notably the server's echo of the user's
  // typed input) get wiped before the assistant reply lands.
  const clearedForSessionRef = useRef<string | null>(null);

  // --- Header state (PR-25 + gear-3) ---
  // gear-3: defaults hydrate from localStorage so a fresh tab remembers
  // the user's last choice. Server-side settings.get_result still merges
  // when it arrives (D41 kept intact per plan G2b finding #2).
  const [cwd, setCwd] = useState<string>("");
  const [model, setModel] = useState<string>(() => lsReadString("cq.model", "claude-opus-4-7[1m]"));
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    () => lsReadString("cq.permissionMode", "bypassPermissions") as PermissionMode,
  );
  const [effort, setEffort] = useState<Effort>(() => lsReadEffort("cq.effort", DEFAULT_EFFORT));
  // gcn1-3: Codex approvalPolicy, hydrated from localStorage. Only sent
  // on chat.start when the selected model resolves to platform=codex.
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>(
    () => lsReadApprovalPolicy("cq.codex.approvalPolicy", "on-request"),
  );
  // Refs that always hold the latest model/permissionMode/effort so closures
  // in effects (e.g. REJOIN_FAILED handler) read fresh values. Same
  // pattern as sortRef/filterRef/pageRef in HistoryTab.
  const modelRef = useRef(model);
  const permissionModeRef = useRef(permissionMode);
  const effortRef = useRef(effort);
  const approvalPolicyRef = useRef(approvalPolicy);
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
    { name: "/plan", description: "Start a planning workflow for a new goal" },
    { name: "/help" },
    { name: "/clear" },
    { name: "/cwd" },
    { name: "/model" },
    { name: "/cost" },
  ];
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>(DEFAULT_SLASH_COMMANDS);

  // Q7: latest /plan workflow lifecycle event, surfaced minimally as a banner
  // in the chat stream. Full Goals-tab rendering is cycle 4.
  const [workflowEvent, setWorkflowEvent] = useState<WorkflowEvent | null>(null);

  // ---- D26: Hide SDK events toggle (default hydrated from localStorage) ----
  const [hideSdkEvents, setHideSdkEvents] = useState<boolean>(
    () => lsReadString("cq.hideSdkEvents", "0") === "1",
  );

  // ---- D41: UI settings persistence ----
  // settingsLoadedRef guards against echoing defaults back to the server on
  // the very first render before settings.get_result has been received.
  const settingsLoadedRef = useRef(false);

  // Keep modelRef/permissionModeRef/effortRef in sync so closures (REJOIN_FAILED handler)
  // always read the latest values without stale-closure capture. Each change
  // also writes the new value into localStorage so it survives a page reload.
  useEffect(() => { modelRef.current = model; lsWrite("cq.model", model); }, [model]);
  useEffect(() => { permissionModeRef.current = permissionMode; lsWrite("cq.permissionMode", permissionMode); }, [permissionMode]);
  useEffect(() => { effortRef.current = effort; lsWrite("cq.effort", effort); }, [effort]);
  useEffect(() => {
    approvalPolicyRef.current = approvalPolicy;
    lsWrite("cq.codex.approvalPolicy", approvalPolicy);
  }, [approvalPolicy]);
  useEffect(() => { lsWrite("cq.hideSdkEvents", hideSdkEvents ? "1" : "0"); }, [hideSdkEvents]);

  // ---- D30: Subagent transcript overlay ----
  // When set, renders the Detail component as a modal over the chat stream.
  const [subagentDetailId, setSubagentDetailId] = useState<string | null>(null);

  const handleSubagentClicked = useCallback((childInvocationId: string) => {
    setSubagentDetailId(childInvocationId);
  }, []);

  function handleSubagentDetailClose(): void {
    setSubagentDetailId(null);
  }

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
        rejoinPendingRef.current = false;
        if (rejoinTimeoutRef.current !== null) {
          clearTimeout(rejoinTimeoutRef.current);
          rejoinTimeoutRef.current = null;
        }
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
        // D33: only reset/wipe on the FIRST chat.started per session.
        // The SDK init triggers a second chat.started carrying full initInfo,
        // and that one would otherwise wipe events received in between
        // (notably the server's echo of the user's just-typed input).
        if (clearedForSessionRef.current !== started.sessionId) {
          clearedForSessionRef.current = started.sessionId;
          // Reset usage counters for new session.
          setInputTokens(0);
          setOutputTokens(0);
          setCostUsd(0);
          // Clear previous conversation.
          setChatEvents([]);
        }
        // Fire replay whenever the user clicked Resume, regardless of whether
        // the chat.started was the first or second for this session. The
        // pendingReplayInvocationIdRef self-consumes (null after first read).
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
        // D33: append replay events in arrival order. The server streams
        // them in chronological order (ordinal 0, 1, 2, ...), so plain
        // append preserves order. The prior implementation prepended,
        // which reversed the transcript after resume.
        const replayEvt = frame as unknown as HistoryReplayEvent;
        const synthetic: ChatEvent = {
          type: "chat.event",
          seq: replayEvt.ordinal,
          ts: replayEvt.ts,
          sessionId: replayEvt.invocationId, // placeholder; not used by renderer
          invocationId: replayEvt.invocationId,
          parentInvocationId: null,
          sdkEvent: replayEvt.sdkEvent,
        };
        setChatEvents((prev) => {
          if (prev.some((e) => e.seq === replayEvt.ordinal && e.invocationId === replayEvt.invocationId)) {
            return prev;
          }
          return [...prev, synthetic];
        });
      } else if (frame.type === "chat.done") {
        // Turn finished — clear in-progress so the textarea re-enables.
        // Keep activeSessionId set: the session stays alive for multi-turn.
        setInProgress(false);
        // D49: clear the queued-message counter at each turn boundary.
        setQueuedUserMessageCount(0);
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
      } else if (frame.type === "workflow.event") {
        // Q7: surface the latest lifecycle event as a banner. An errored
        // event also raises a toast so the user notices a failure even if the
        // banner is scrolled off.
        const wf = frame as WorkflowEvent;
        setWorkflowEvent(wf);
        if (wf.status === "errored") {
          showToast({ level: "error", text: wf.detail ?? "Planning workflow failed" });
        }
      } else if (frame.type === "chat.error") {
        const errFrame = frame as ChatError;
        // Clear the self-clearing timeout whenever chat.error arrives
        // (REJOIN_FAILED or otherwise) — the response has landed.
        if (rejoinTimeoutRef.current !== null) {
          clearTimeout(rejoinTimeoutRef.current);
          rejoinTimeoutRef.current = null;
        }
        // D47: if rejoin failed, clear the stale session from localStorage and
        // fall back to a fresh chat.start so the user is not left stranded.
        if (rejoinPendingRef.current && errFrame.code === "REJOIN_FAILED") {
          rejoinPendingRef.current = false;
          chatStartPendingRef.current = false;
          setActiveSessionId(null);
          // Fire a fresh start. Read model/permissionMode from refs so the
          // fallback carries the values current at the time of the error,
          // not the stale closure values from when the effect first ran.
          chatStartPendingRef.current = true;
          const fallbackFrame: ChatStart = {
            type: "chat.start",
            seq: seqRef.current++,
            ts: Date.now(),
            model: modelRef.current,
            permissionMode: permissionModeRef.current,
            effort: effortRef.current,
            platform: modelToPlatform(modelRef.current),
            ...approvalPolicyFor(modelRef.current, approvalPolicyRef.current),
          };
          manager.send(fallbackFrame);
          return;
        }
        setInProgress(false);
        showToast({ level: "error", text: errFrame.message });
      } else if (frame.type === "settings.get_result") {
        const r = frame as SettingsGetResult;
        // Apply persisted settings. Use functional-update form for model and
        // permissionMode so modelRef/permissionModeRef are updated synchronously
        // via their own useEffects before we fire chat.start below.
        const newModel = r.model !== null ? r.model : modelRef.current;
        const newPermMode = r.permissionMode !== null ? (r.permissionMode as PermissionMode) : permissionModeRef.current;
        if (r.model !== null) setModel(r.model);
        if (r.permissionMode !== null) setPermissionMode(r.permissionMode as PermissionMode);
        setHideSdkEvents(r.hideSdkEvents);
        settingsLoadedRef.current = true;
        // D6: fire the deferred chat.start now that we have persisted settings.
        if (chatStartDeferredRef.current) {
          chatStartDeferredRef.current = false;
          if (settingsFallbackTimeoutRef.current !== null) {
            clearTimeout(settingsFallbackTimeoutRef.current);
            settingsFallbackTimeoutRef.current = null;
          }
          const startFrame: ChatStart = {
            type: "chat.start",
            seq: seqRef.current++,
            ts: Date.now(),
            model: newModel,
            permissionMode: newPermMode,
            effort: effortRef.current,
            platform: modelToPlatform(newModel),
            ...approvalPolicyFor(newModel, approvalPolicyRef.current),
          };
          manager.send(startFrame);
        }
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

    // ALIVE → not-ALIVE: WS dropped. Clear in-flight guards so the next ALIVE
    // edge can attempt rejoin (if activeSessionId is still in localStorage).
    if (wasAlive && !isAlive) {
      setInProgress(false);
      chatStartPendingRef.current = false;
      chatStartDeferredRef.current = false;
      if (settingsFallbackTimeoutRef.current !== null) {
        clearTimeout(settingsFallbackTimeoutRef.current);
        settingsFallbackTimeoutRef.current = null;
      }
      rejoinPendingRef.current = false;
      return;
    }

    // Only act on the ALIVE edge (false → true).
    if (!isAlive || wasAlive) return;
    // Another start/rejoin is already in-flight.
    if (chatStartPendingRef.current) return;
    // User pressed New Session or Resume — they'll send their own chat.start.
    if (userInitiatedStartRef.current) return;

    // D41: fetch persisted UI settings on each ALIVE edge so settings are
    // restored after reconnect. Sent before chat.start so the settings.get_result
    // can arrive and update model/permissionMode before the start fires.
    const settingsGetFrame: SettingsGet = {
      type: "settings.get",
      seq: seqRef.current++,
      ts: Date.now(),
    };
    manager.send(settingsGetFrame);

    // D47: if we have a stored sessionId from a previous page load, attempt
    // to rejoin it before falling back to a fresh start.
    if (activeSessionId !== null) {
      rejoinPendingRef.current = true;
      // Safety: self-clear rejoinPendingRef after 20 s in case the WS
      // partitions silently (no close frame, no chat.error response).
      if (rejoinTimeoutRef.current !== null) clearTimeout(rejoinTimeoutRef.current);
      rejoinTimeoutRef.current = setTimeout(() => {
        rejoinPendingRef.current = false;
        rejoinTimeoutRef.current = null;
      }, 20_000);
      chatStartPendingRef.current = true;
      const rejoinFrame: ChatRejoin = {
        type: "chat.rejoin",
        seq: seqRef.current++,
        ts: Date.now(),
        sessionId: activeSessionId,
      };
      manager.send(rejoinFrame);
      return;
    }

    // D6: defer chat.start until settings.get_result arrives so the first
    // auto-start carries persisted values (model, permissionMode, hideSdkEvents)
    // rather than React defaults. chatStartPendingRef is set now to prevent
    // duplicate sends from further stats updates while we wait.
    chatStartPendingRef.current = true;
    chatStartDeferredRef.current = true;
    // Safety fallback: if settings.get_result does not arrive within 3 s
    // (e.g. the server rejects settings.get), fire chat.start with whatever
    // model/permissionMode are in state at that point.
    if (settingsFallbackTimeoutRef.current !== null) clearTimeout(settingsFallbackTimeoutRef.current);
    settingsFallbackTimeoutRef.current = setTimeout(() => {
      settingsFallbackTimeoutRef.current = null;
      if (!chatStartDeferredRef.current) return; // already fired via settings.get_result
      chatStartDeferredRef.current = false;
      const fallback: ChatStart = {
        type: "chat.start",
        seq: seqRef.current++,
        ts: Date.now(),
        model: modelRef.current,
        permissionMode: permissionModeRef.current,
        effort: effortRef.current,
        platform: modelToPlatform(modelRef.current),
        ...approvalPolicyFor(modelRef.current, approvalPolicyRef.current),
      };
      manager.send(fallback);
    }, 3_000);
  }, [stats]); // intentional: only re-run when stats changes; model/permissionMode read from refs

  // D41: persist model/permissionMode/hideSdkEvents on every change.
  // Skip sending until settings have been loaded (settingsLoadedRef.current === true)
  // so the initial render with default values does not clobber persisted settings.
  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    const frame: SettingsSet = {
      type: "settings.set",
      seq: seqRef.current++,
      ts: Date.now(),
      model,
    };
    manager.send(frame);
  }, [model]); // intentional: only watch model

  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    const frame: SettingsSet = {
      type: "settings.set",
      seq: seqRef.current++,
      ts: Date.now(),
      permissionMode,
    };
    manager.send(frame);
  }, [permissionMode]); // intentional: only watch permissionMode

  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    const frame: SettingsSet = {
      type: "settings.set",
      seq: seqRef.current++,
      ts: Date.now(),
      hideSdkEvents,
    };
    manager.send(frame);
  }, [hideSdkEvents]); // intentional: only watch hideSdkEvents

  function handleSubmit(text: string, attachments: Attachment[] = []): void {
    // Q9: a leading `/plan` routes to the workflow lane (workflow.start)
    // instead of chat.input. This runs BEFORE the activeSessionId guard
    // because a planning command lives in its own dispatch lane and does not
    // depend on the interactive chat session being started — the workflow.start
    // frame carries no sessionId. `/plan <text>` = new goal; `/plan G<id>
    // <text>` = continuation (continuation-not-implemented this cycle). The
    // leading `/plan` token is stripped here; the server registry classifies
    // the rest.
    const planMatch = /^\/plan(?:\s+([\s\S]*))?$/.exec(text);
    if (planMatch !== null) {
      const rest = (planMatch[1] ?? "").trim();
      const goalRefMatch = /^(G\d+)\s+([\s\S]*)$/.exec(rest);
      // PLAN-D04: the server's workflow.start handler emits only
      // workflow.event lifecycle frames, never a chat.event, so the user's
      // typed `/plan …` line would vanish from the transcript. Echo it
      // locally as a synthetic user message (same SDKUserMessage shape the
      // server echoes for chat.input) so the existing Stream user-bubble
      // renderer preserves a record that the command was issued.
      const now = Date.now();
      const echo: ChatEvent = {
        type: "chat.event",
        seq: seqRef.current++,
        ts: now,
        sessionId: activeSessionId ?? "workflow",
        invocationId: "workflow",
        parentInvocationId: null,
        sdkEvent: {
          type: "user",
          message: { role: "user", content: [{ type: "text", text }] },
        },
      };
      setChatEvents((prev) => [...prev, echo]);
      const frame: WorkflowStart = {
        type: "workflow.start",
        seq: seqRef.current++,
        ts: now,
        kind: "plan",
        text: goalRefMatch !== null ? goalRefMatch[2]!.trim() : rest,
        platform: modelToPlatform(model),
        ...(goalRefMatch !== null ? { goalRef: goalRefMatch[1]! } : {}),
      };
      manager.send(frame);
      return;
    }

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

    // D49: if a turn is already in progress, the message will be queued by the
    // SDK on the server side. Increment the counter to show a "queued" badge.
    if (inProgress) {
      setQueuedUserMessageCount((n) => n + 1);
    } else {
      setInProgress(true);
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
    // The server echoes the user's input as a chat.event (synthesized SDK
    // user message) on handleChatInput so the bubble appears in the live
    // stream AND in the JSONL log → preserved for resume/history replay.
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
    clearedForSessionRef.current = null;
    userInitiatedStartRef.current = true;
    chatStartPendingRef.current = true;
    const frame: ChatStart = {
      type: "chat.start",
      seq: seqRef.current++,
      ts: Date.now(),
      model,
      permissionMode,
      effort,
      platform: modelToPlatform(model),
      ...approvalPolicyFor(model, approvalPolicy),
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
    clearedForSessionRef.current = null;
    userInitiatedStartRef.current = true;
    chatStartPendingRef.current = true;
    const frame: ChatStart = {
      type: "chat.start",
      seq: seqRef.current++,
      ts: Date.now(),
      model,
      permissionMode,
      effort,
      platform: modelToPlatform(model),
      ...approvalPolicyFor(model, approvalPolicy),
      resumeFromInvocationId: invocationId,
    };
    manager.send(frame);
  }

  // PR-04 (resume-rework) removed handleRejoinSession: its only caller was
  // the legacy header dialog "click a running session" branch, deleted in
  // PR-04. The auto-refresh ChatRejoin send path (D47, near the ALIVE-edge
  // effect above) is inline and unaffected.

  // PR-03: consume cross-tab resume requests posted by HistoryTab. The
  // SessionContext.requestResume(invocationId) call sets a pending request;
  // this effect fires once, drives the resume flow, and clears the request.
  // handleResumeSession is defined inside the component so it is a fresh
  // closure on every render; keeping the dep array narrow to `resumeRequest`
  // is intentional — re-firing on other state changes would duplicate sends.
  useEffect(() => {
    if (resumeRequest === null) return;
    handleResumeSession(resumeRequest.invocationId);
    clearResumeRequest();
  }, [resumeRequest, clearResumeRequest]);

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
  const subagentCounts = useMemo(() => computeSubagentCount(chatEvents), [chatEvents]);

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
        effort={effort}
        onEffortChange={setEffort}
        inputTokens={inputTokens}
        outputTokens={outputTokens}
        costUsd={costUsd}
        sessionId={sessionId}
        startedAt={startedAt}
        inProgress={inProgress}
        runningSubagents={subagentCounts.running}
        onNewSession={handleNewSession}
        hideSdkEvents={hideSdkEvents}
        onHideSdkEventsChange={setHideSdkEvents}
        approvalPolicy={approvalPolicy}
        onApprovalPolicyChange={setApprovalPolicy}
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
      {/* F2: Scrollable stream — owns its own overflow.
          Wrapped in a position:relative box so the Jump-to-latest button
          (positioned absolute, bottom-right) anchors inside the messages
          viewport instead of the whole ChatTab (where it overlapped the
          Input row). */}
      {workflowEvent !== null && (
        <WorkflowBanner event={workflowEvent} onDismiss={() => setWorkflowEvent(null)} />
      )}
      <div className={tabStyles.streamWrap}>
        <Stream
          chatEvents={chatEvents}
          onQuestionReply={handleQuestionReply}
          inProgress={inProgress}
          searchQuery={searchQuery}
          activeMatchIndex={activeMatchIndex}
          onScrolledUp={handleScrolledUp}
          scrollToBottom={triggerScrollToBottom}
          onScrollToBottomDone={handleScrollToBottomDone}
          hideSdkEvents={hideSdkEvents}
          onSubagentClicked={handleSubagentClicked}
        />
        {/* D30: Subagent transcript overlay — mounts Detail for the selected child invocation. */}
        {subagentDetailId !== null && (
          <Detail
            invocationId={subagentDetailId}
            onClose={handleSubagentDetailClose}
          />
        )}
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
      </div>
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
          queueCount={queuedUserMessageCount}
        />
      </div>
    </div>
  );
}
