/**
 * ChatTab.tsx — top-level chat shell component.
 *
 * Renders:
 *   - <Stream> for assistant output, fed by accumulated chat.event frames.
 *   - The <Input> component for user text entry.
 *
 * On submit, builds a ChatInput frame and calls manager.send(). The sessionId
 * is a placeholder UUID for PR-21; PR-25 will wire the real session id from
 * the chat.started server frame.
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
import type { ChatInput, ChatInterrupt, ChatEvent } from "@cq/shared";

/** Placeholder session id for PR-21. PR-25 will replace with a real value. */
const PLACEHOLDER_SESSION_ID = "00000000-0000-0000-0000-000000000000";

export function ChatTab(): React.ReactElement {
  const manager = useConnection();
  const seqRef = useRef(0);
  const [chatEvents, setChatEvents] = useState<ChatEvent[]>([]);
  // activeSessionId is non-null while a query is in progress (chat.started received,
  // chat.done not yet received). Used to gate the Stop button and send interrupt.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // Subscribe to incoming server frames and accumulate chat.event entries.
  // Track session lifecycle via chat.started / chat.done.
  useEffect(() => {
    const unsub = manager.onMessage((frame) => {
      if (frame.type === "chat.started") {
        setActiveSessionId((frame as { sessionId: string }).sessionId);
      } else if (frame.type === "chat.done") {
        setActiveSessionId(null);
      } else if (frame.type === "chat.event") {
        setChatEvents((prev) => [...prev, frame as ChatEvent]);
      }
    });
    return unsub;
  }, [manager]);

  function handleSubmit(text: string): void {
    const seq = seqRef.current++;
    // Clear previous conversation on each new submission.
    setChatEvents([]);
    const frame: ChatInput = {
      type: "chat.input",
      seq,
      ts: Date.now(),
      sessionId: PLACEHOLDER_SESSION_ID,
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

  const inProgress = activeSessionId !== null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <Stream chatEvents={chatEvents} />
      <Input
        onSubmit={handleSubmit}
        onInterrupt={handleInterrupt}
        disabled={inProgress}
      />
    </div>
  );
}
