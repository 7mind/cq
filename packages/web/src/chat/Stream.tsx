/**
 * Stream.tsx — streaming assistant message renderer.
 *
 * Accepts an array of ChatEvent frames (as received from the server via the
 * WebSocket bridge) and renders the accumulated conversation into a vertical
 * list of message blocks. Each assistant message is rendered via <Markdown>.
 *
 * ## Partial message stitching (SDKPartialAssistantMessage)
 *
 * The SDK bridge emits SDKPartialAssistantMessage frames with
 * `type: 'stream_event'`. Within that stream a `message_start` event carries
 * the Anthropic `message.id` (the stable identifier for a logical message);
 * subsequent `content_block_delta` events with `delta.type === 'text_delta'`
 * carry incremental text. We accumulate text per Anthropic message ID.
 *
 * When the final SDKAssistantMessage (`type: 'assistant'`) arrives for the
 * same message ID, we replace the stitched text with the canonical content
 * from `message.content` (concatenation of all text blocks).
 *
 * ## Stable code-block identity (G2c F-07)
 *
 * Each rendered message is wrapped in a React element with `key={messageId}`.
 * As long as the messageId doesn't change between renders (which it does not
 * for append-only partials), React's positional reconciliation keeps the same
 * <Markdown> fiber and its descendant <CodeBlock> fibers stable across
 * re-renders. Code blocks do NOT remount during streaming. This is the
 * approach (B) described in the PR-22b brief.
 *
 * ## Unknown SDK event types
 *
 * Any ChatEvent whose sdkEvent doesn't map to a known rendering path (e.g.
 * tool_use, tool_result, system events) is rendered by <UnknownCard>. PR-23
 * will replace these with proper tool cards.
 */

import { useMemo } from "react";
import { Markdown } from "./Markdown";
import { UnknownCard } from "./Cards/UnknownCard";
import styles from "../styles/Stream.module.css";
import type { ChatEvent } from "@cq/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A fully-resolved message ready to render. */
type RenderedMessage =
  | { kind: "assistant"; messageId: string; text: string }
  | { kind: "unknown"; key: string; sdkEvent: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract plain text from a final SDKAssistantMessage's content array.
 * content is an array of BetaContentBlock; we collect all text blocks.
 */
function extractFinalText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as Record<string, unknown>)["type"] === "text" &&
      typeof (block as Record<string, unknown>)["text"] === "string"
    ) {
      out += (block as Record<string, unknown>)["text"] as string;
    }
  }
  return out;
}

/**
 * Try to extract text from a stream_event sdkEvent frame (SDKPartialAssistantMessage).
 *
 * Returns:
 *   { kind: 'message_start', messageId: string } — start of a new message
 *   { kind: 'text_delta', text: string }         — incremental text for current message
 *   { kind: 'other' }                             — all other stream events
 */
type StreamEventParsed =
  | { kind: "message_start"; messageId: string }
  | { kind: "text_delta"; text: string }
  | { kind: "other" };

function parseStreamEvent(rawEvent: Record<string, unknown>): StreamEventParsed {
  const event = rawEvent["event"] as Record<string, unknown> | undefined;
  if (event === undefined || event === null) return { kind: "other" };

  const eventType = event["type"];
  if (eventType === "message_start") {
    const message = event["message"] as Record<string, unknown> | undefined;
    const messageId = typeof message?.["id"] === "string" ? message["id"] : "";
    return { kind: "message_start", messageId };
  }

  if (eventType === "content_block_delta") {
    const delta = event["delta"] as Record<string, unknown> | undefined;
    if (delta?.["type"] === "text_delta" && typeof delta["text"] === "string") {
      return { kind: "text_delta", text: delta["text"] as string };
    }
  }

  return { kind: "other" };
}

// ---------------------------------------------------------------------------
// Core computation: events → rendered messages
// ---------------------------------------------------------------------------

/**
 * Reduce a sequence of ChatEvent frames into an ordered list of RenderedMessage
 * values ready to display.
 *
 * This is a pure function so it can safely run inside useMemo.
 */
export function computeRenderedMessages(events: ChatEvent[]): RenderedMessage[] {
  // Ordered list of message IDs (determines display order).
  const order: string[] = [];
  // Accumulated text per Anthropic message ID.
  const textByMessageId = new Map<string, string>();
  // Whether the final canonical text has been applied for a given ID.
  const finalised = new Set<string>();
  // The Anthropic message ID currently being streamed (set by message_start).
  let currentStreamMessageId: string | null = null;
  // Messages that are unknown/tool events, mapped by their insertion key.
  const unknownByKey = new Map<string, Record<string, unknown>>();

  for (let i = 0; i < events.length; i++) {
    const evt = events[i]!;
    const sdkEvent = evt.sdkEvent as Record<string, unknown>;
    const sdkType = sdkEvent["type"] as string | undefined;

    if (sdkType === "stream_event") {
      // SDKPartialAssistantMessage — streaming text.
      const parsed = parseStreamEvent(sdkEvent);
      if (parsed.kind === "message_start") {
        currentStreamMessageId = parsed.messageId;
        if (parsed.messageId !== "" && !textByMessageId.has(parsed.messageId)) {
          order.push(parsed.messageId);
          textByMessageId.set(parsed.messageId, "");
        }
      } else if (parsed.kind === "text_delta" && currentStreamMessageId !== null) {
        const existing = textByMessageId.get(currentStreamMessageId) ?? "";
        textByMessageId.set(currentStreamMessageId, existing + parsed.text);
      }
      // other stream_event subtypes (content_block_start, message_stop, etc.) — skip.
    } else if (sdkType === "assistant") {
      // SDKAssistantMessage — final canonical message.
      const message = sdkEvent["message"] as Record<string, unknown> | undefined;
      const messageId = typeof message?.["id"] === "string" ? (message["id"] as string) : null;

      if (messageId !== null) {
        const canonical = extractFinalText(message?.["content"]);
        if (!textByMessageId.has(messageId)) {
          order.push(messageId);
        }
        textByMessageId.set(messageId, canonical);
        finalised.add(messageId);
        // Reset current stream ID — the final message closes the stream group.
        currentStreamMessageId = null;
      } else {
        // Final message without a recognisable ID — fall through to unknown.
        const key = `unknown-${i}`;
        order.push(key);
        unknownByKey.set(key, sdkEvent);
      }
    } else {
      // All other SDK event types (tool_use, tool_result, system, etc.).
      const key = `unknown-${i}`;
      order.push(key);
      unknownByKey.set(key, sdkEvent);
    }
  }

  // Build the output list preserving insertion order.
  const result: RenderedMessage[] = [];
  for (const id of order) {
    if (unknownByKey.has(id)) {
      result.push({ kind: "unknown", key: id, sdkEvent: unknownByKey.get(id)! });
    } else {
      const text = textByMessageId.get(id) ?? "";
      result.push({ kind: "assistant", messageId: id, text });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface StreamProps {
  chatEvents: ChatEvent[];
}

export function Stream({ chatEvents }: StreamProps): React.ReactElement {
  const messages = useMemo(() => computeRenderedMessages(chatEvents), [chatEvents]);

  return (
    <div className={styles.root} data-testid="stream-root">
      {messages.map((msg) => {
        if (msg.kind === "assistant") {
          return (
            <div key={msg.messageId} className={styles.message} data-testid={`stream-message-${msg.messageId}`}>
              <Markdown>{msg.text}</Markdown>
            </div>
          );
        }
        // unknown / tool events — placeholder until PR-23.
        return (
          <div key={msg.key} className={styles.message}>
            <UnknownCard sdkEvent={msg.sdkEvent} />
          </div>
        );
      })}
    </div>
  );
}
