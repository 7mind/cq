/**
 * ChatTab.tsx — top-level chat shell component.
 *
 * Renders:
 *   - A placeholder stream area for the assistant output (PR-22a/b will fill
 *     this in with Markdown / Stream renderers).
 *   - The <Input> component for user text entry.
 *
 * On submit, builds a ChatInput frame and calls manager.send(). The sessionId
 * is a placeholder UUID for PR-21; PR-25 will wire the real session id from
 * the chat.started server frame.
 *
 * Subscribes to useConnection() for the Manager instance.
 */

import { useRef } from "react";
import { useConnection } from "../ws/useConnection";
import { Input } from "./Input";
import type { ChatInput } from "@cq/shared";

/** Placeholder session id for PR-21. PR-25 will replace with a real value. */
const PLACEHOLDER_SESSION_ID = "00000000-0000-0000-0000-000000000000";

export function ChatTab(): React.ReactElement {
  const manager = useConnection();
  const seqRef = useRef(0);

  function handleSubmit(text: string): void {
    const seq = seqRef.current++;
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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* Stream area: PR-22a/b will replace this placeholder */}
      <div
        style={{ flex: 1, overflowY: "auto", padding: "16px" }}
        aria-label="assistant output"
      />
      <Input onSubmit={handleSubmit} />
    </div>
  );
}
