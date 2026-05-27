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
 *
 * ## Pagination (F3)
 *
 * Design choice: "Load older" button at the top (option a from the brief).
 * We render only the most recent VISIBLE_PAGE_SIZE messages by default.
 * Clicking "Load older (N more)" doubles the visible count (up to the total).
 * This avoids virtualisation while keeping long histories performant.
 * DEFAULT_VISIBLE = 200 messages shown initially; load in chunks of 100.
 *
 * ## Auto-scroll (F2)
 *
 * The scroll container is .root itself (overflow-y: auto, flex: 1).
 * We track whether the user is "at bottom" (within SCROLL_NEAR_BOTTOM_PX of
 * the scrollable end). If yes, new messages trigger a scroll to bottom.
 * If the user has scrolled up, auto-scroll is suppressed; the parent
 * renders a "↓ Jump to latest" button (via the onScrolledUp callback).
 *
 * ## Search (F4)
 *
 * When searchQuery is non-empty we wrap matching text runs inside <mark>
 * elements. The activeMatchKey identifies which message bubble gets the
 * highlight ring (via MessageBubble.isActiveMatch).
 */

import { useMemo, useRef, useEffect, useCallback, createElement, useState } from "react";
import { Markdown } from "./Markdown";
import { UnknownCard } from "./Cards/UnknownCard";
import { SubagentCard } from "./Cards/SubagentCard";
import type { SubagentTask } from "./Cards/SubagentCard";
import { ToolCard } from "./Cards/index";
import type { ToolUseBlock, ToolResultBlock } from "./Cards/index";
import { AskCard } from "./Cards/AskCard";
import type { AskUserQuestionInput, QuestionReplyPayload } from "./Cards/AskCard";
import { Thinking } from "./Cards/Thinking";
import type { ThinkingBlock } from "./Cards/Thinking";
import { MessageBubble } from "./MessageBubble";
import type { MessageRole } from "./MessageBubble";
import styles from "../styles/Stream.module.css";
import type { ChatEvent } from "@cq/shared";

// ---------------------------------------------------------------------------
// Pagination constants (F3)
// ---------------------------------------------------------------------------

/** Default number of messages shown without clicking "Load older". */
const DEFAULT_VISIBLE = 200;
/** Number of additional messages revealed per "Load older" click. */
const LOAD_OLDER_CHUNK = 100;
/** Distance from bottom (px) within which auto-scroll fires. */
const SCROLL_NEAR_BOTTOM_PX = 80;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A fully-resolved message ready to render. */
type RenderedMessage =
  | { kind: "assistant"; messageId: string; text: string; thinkingBlocks: ThinkingBlock[]; ts: number }
  | { kind: "user"; messageId: string; text: string; ts: number }
  | { kind: "tool_use"; key: string; toolUse: ToolUseBlock; toolResult?: ToolResultBlock; ts: number }
  | { kind: "ask"; key: string; toolUseId: string; input: AskUserQuestionInput; ts: number }
  | { kind: "unknown"; key: string; sdkEvent: Record<string, unknown>; ts: number }
  | { kind: "subagent"; key: string; task: SubagentTask; children: RenderedMessage[]; ts: number };

// ---------------------------------------------------------------------------
// Sub-agent entry accumulator
// ---------------------------------------------------------------------------

/** Mutable state accumulated for one sub-agent task. */
interface SubagentEntry {
  task: SubagentTask;
  ts: number;
  /** Ordered child keys (same semantics as the top-level `order` array). */
  childOrder: string[];
  childTextByMessageId: Map<string, string>;
  childTsByMessageId: Map<string, number>;
  childFinalised: Set<string>;
  childToolUseByKey: Map<string, { toolUse: ToolUseBlock; toolResult?: ToolResultBlock }>;
  childToolUseIdToKey: Map<string, string>;
  childUnknownByKey: Map<string, Record<string, unknown>>;
  currentStreamMessageId: string | null;
}

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
 * Extract thinking blocks from a final SDKAssistantMessage's content array.
 * Returns an array of ThinkingBlock values in document order.
 */
function extractThinkingBlocks(content: unknown): ThinkingBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: ThinkingBlock[] = [];
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as Record<string, unknown>)["type"] === "thinking" &&
      typeof (block as Record<string, unknown>)["thinking"] === "string"
    ) {
      const b = block as Record<string, unknown>;
      const thinkingBlock: ThinkingBlock = {
        type: "thinking",
        thinking: b["thinking"] as string,
      };
      if (typeof b["signature"] === "string") {
        thinkingBlock.signature = b["signature"] as string;
      }
      blocks.push(thinkingBlock);
    }
  }
  return blocks;
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
/**
 * Try to cast a raw object as a ToolUseBlock. Returns null if the shape
 * doesn't match.
 */
function asToolUseBlock(block: unknown): ToolUseBlock | null {
  if (block === null || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;
  if (b["type"] !== "tool_use") return null;
  if (typeof b["id"] !== "string") return null;
  if (typeof b["name"] !== "string") return null;
  if (b["input"] === null || typeof b["input"] !== "object") return null;
  return {
    type: "tool_use",
    id: b["id"] as string,
    name: b["name"] as string,
    input: b["input"] as Record<string, unknown>,
  };
}

/**
 * Try to cast a raw object as a ToolResultBlock. Returns null if the shape
 * doesn't match.
 */
function asToolResultBlock(block: unknown): ToolResultBlock | null {
  if (block === null || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;
  if (b["type"] !== "tool_result") return null;
  if (typeof b["tool_use_id"] !== "string") return null;
  return {
    type: "tool_result",
    tool_use_id: b["tool_use_id"] as string,
    content: b["content"],
  };
}

// ---------------------------------------------------------------------------
// Sub-agent entry helpers
// ---------------------------------------------------------------------------

function makeSubagentEntry(sdkEvent: Record<string, unknown>, ts: number): SubagentEntry {
  const task_id = typeof sdkEvent["task_id"] === "string" ? sdkEvent["task_id"] : "";
  const rawToolUseId = sdkEvent["tool_use_id"];
  const description = typeof sdkEvent["description"] === "string" ? sdkEvent["description"] : "";
  const subagent_type = typeof sdkEvent["subagent_type"] === "string" ? sdkEvent["subagent_type"] : "Task";
  const agent_name = subagent_type.charAt(0).toUpperCase() + subagent_type.slice(1);
  // D30: child_invocation_id is injected by the bridge (not present on the raw SDK message).
  const childInvocationId = typeof sdkEvent["child_invocation_id"] === "string"
    ? sdkEvent["child_invocation_id"]
    : undefined;
  const baseTask = {
    task_id,
    agent_name,
    task_description: description,
    status: "running" as const,
    ...(childInvocationId !== undefined ? { childInvocationId } : {}),
  };
  const task: SubagentTask =
    typeof rawToolUseId === "string"
      ? { ...baseTask, tool_use_id: rawToolUseId }
      : baseTask;
  return {
    task,
    ts,
    childOrder: [],
    childTextByMessageId: new Map(),
    childTsByMessageId: new Map(),
    childFinalised: new Set(),
    childToolUseByKey: new Map(),
    childToolUseIdToKey: new Map(),
    childUnknownByKey: new Map(),
    currentStreamMessageId: null,
  };
}

/** Accumulate an assistant-type sdkEvent into a SubagentEntry's child collections. */
function accumulateChildAssistant(
  entry: SubagentEntry,
  sdkEvent: Record<string, unknown>,
  index: number,
  ts: number,
): void {
  const message = sdkEvent["message"] as Record<string, unknown> | undefined;
  const messageId = typeof message?.["id"] === "string" ? (message["id"] as string) : null;
  const content = Array.isArray(message?.["content"]) ? (message!["content"] as unknown[]) : [];

  if (messageId !== null) {
    const canonical = extractFinalText(message?.["content"]);
    if (!entry.childTextByMessageId.has(messageId)) {
      entry.childOrder.push(messageId);
    }
    entry.childTextByMessageId.set(messageId, canonical);
    entry.childTsByMessageId.set(messageId, ts);
    entry.childFinalised.add(messageId);
    entry.currentStreamMessageId = null;
  } else {
    const key = `child-unknown-${index}`;
    entry.childOrder.push(key);
    entry.childUnknownByKey.set(key, sdkEvent);
  }

  for (let bi = 0; bi < content.length; bi++) {
    const block = content[bi];
    const toolUse = asToolUseBlock(block);
    if (toolUse !== null) {
      const key = `child-tool-${index}-${bi}`;
      entry.childOrder.push(key);
      entry.childToolUseByKey.set(key, { toolUse });
      entry.childToolUseIdToKey.set(toolUse.id, key);
      continue;
    }
    const toolResult = asToolResultBlock(block);
    if (toolResult !== null) {
      const partnerKey = entry.childToolUseIdToKey.get(toolResult.tool_use_id);
      if (partnerKey !== undefined) {
        const existing = entry.childToolUseByKey.get(partnerKey);
        if (existing !== undefined) {
          entry.childToolUseByKey.set(partnerKey, { ...existing, toolResult });
        }
      } else {
        const key = `child-unknown-${index}-${bi}`;
        entry.childOrder.push(key);
        entry.childUnknownByKey.set(key, block as Record<string, unknown>);
      }
    }
  }
}

/** Accumulate a stream_event (partial) sdkEvent into a SubagentEntry's child collections. */
function accumulateChildStreamEvent(
  entry: SubagentEntry,
  sdkEvent: Record<string, unknown>,
): void {
  const parsed = parseStreamEvent(sdkEvent);
  if (parsed.kind === "message_start") {
    entry.currentStreamMessageId = parsed.messageId;
    if (parsed.messageId !== "" && !entry.childTextByMessageId.has(parsed.messageId)) {
      entry.childOrder.push(parsed.messageId);
      entry.childTextByMessageId.set(parsed.messageId, "");
    }
  } else if (parsed.kind === "text_delta" && entry.currentStreamMessageId !== null) {
    const existing = entry.childTextByMessageId.get(entry.currentStreamMessageId) ?? "";
    entry.childTextByMessageId.set(entry.currentStreamMessageId, existing + parsed.text);
  }
}

/** Materialise the accumulated children of a SubagentEntry into RenderedMessage[]. */
function buildSubagentChildren(entry: SubagentEntry): RenderedMessage[] {
  const children: RenderedMessage[] = [];
  for (const id of entry.childOrder) {
    if (entry.childUnknownByKey.has(id)) {
      children.push({ kind: "unknown", key: id, sdkEvent: entry.childUnknownByKey.get(id)!, ts: 0 });
    } else if (entry.childToolUseByKey.has(id)) {
      const e = entry.childToolUseByKey.get(id)!;
      if (e.toolResult !== undefined) {
        children.push({ kind: "tool_use", key: id, toolUse: e.toolUse, toolResult: e.toolResult, ts: 0 });
      } else {
        children.push({ kind: "tool_use", key: id, toolUse: e.toolUse, ts: 0 });
      }
    } else {
      const text = entry.childTextByMessageId.get(id) ?? "";
      const ts = entry.childTsByMessageId.get(id) ?? 0;
      // Subagent child messages don't carry separate thinking-block tracking;
      // thinking blocks are dropped for child messages (they render as tool cards
      // in the subagent panel where vertical space is constrained).
      children.push({ kind: "assistant", messageId: id, text, thinkingBlocks: [], ts });
    }
  }
  return children;
}

export function computeRenderedMessages(events: ChatEvent[]): RenderedMessage[] {
  // Ordered list of message IDs (determines display order).
  const order: string[] = [];
  // Accumulated text per Anthropic message ID.
  const textByMessageId = new Map<string, string>();
  // Timestamps per message ID.
  const tsByMessageId = new Map<string, number>();
  // Thinking blocks per Anthropic message ID (populated from final messages only).
  const thinkingByMessageId = new Map<string, ThinkingBlock[]>();
  // Whether the final canonical text has been applied for a given ID.
  const finalised = new Set<string>();
  // The Anthropic message ID currently being streamed (set by message_start).
  let currentStreamMessageId: string | null = null;
  // Messages that are unknown/tool events, mapped by their insertion key.
  const unknownByKey = new Map<string, Record<string, unknown>>();
  const tsByKey = new Map<string, number>();
  // Tool-use blocks, keyed by their insertion key (for ordering).
  const toolUseByKey = new Map<string, { toolUse: ToolUseBlock; toolResult?: ToolResultBlock }>();
  // Index from tool_use_id → insertion key so tool_result can find its partner.
  const toolUseIdToKey = new Map<string, string>();
  // Sub-agent entries keyed by task_id (insertion order preserved via Map).
  const subagentByTaskId = new Map<string, SubagentEntry>();
  // Map tool_use_id → task_id so nested events route into the right entry.
  const toolUseIdToTaskId = new Map<string, string>();
  // AskUserQuestion tool_use blocks, keyed by insertion key.
  const askByKey = new Map<string, { toolUseId: string; input: AskUserQuestionInput }>();
  // User-typed messages (SDKUserMessage with text content), keyed by message id or user-<i>.
  const userTextByKey = new Map<string, string>();

  for (let i = 0; i < events.length; i++) {
    const evt = events[i]!;
    const sdkEvent = evt.sdkEvent as Record<string, unknown>;
    const sdkType = sdkEvent["type"] as string | undefined;
    const sdkSubtype = sdkEvent["subtype"] as string | undefined;
    const evtTs = evt.ts;

    // ------------------------------------------------------------------
    // Sub-agent lifecycle events
    // ------------------------------------------------------------------
    if (sdkType === "system" && sdkSubtype === "task_started") {
      const task_id = typeof sdkEvent["task_id"] === "string" ? sdkEvent["task_id"] : `task-${i}`;
      if (!subagentByTaskId.has(task_id)) {
        const entry = makeSubagentEntry(sdkEvent, evtTs);
        subagentByTaskId.set(task_id, entry);
        // Register the tool_use_id → task_id mapping for routing nested events.
        if (entry.task.tool_use_id !== undefined) {
          toolUseIdToTaskId.set(entry.task.tool_use_id, task_id);
        }
        const key = `subagent-${task_id}`;
        order.push(key);
      }
      continue;
    }

    if (sdkType === "system" && sdkSubtype === "task_progress") {
      const task_id = typeof sdkEvent["task_id"] === "string" ? sdkEvent["task_id"] : "";
      const entry = subagentByTaskId.get(task_id);
      if (entry !== undefined) {
        const summary = typeof sdkEvent["summary"] === "string" ? sdkEvent["summary"] : undefined;
        if (summary !== undefined) {
          entry.task = { ...entry.task, summary };
        }
      }
      continue;
    }

    if (sdkType === "system" && sdkSubtype === "task_notification") {
      const task_id = typeof sdkEvent["task_id"] === "string" ? sdkEvent["task_id"] : "";
      const entry = subagentByTaskId.get(task_id);
      if (entry !== undefined) {
        const rawStatus = sdkEvent["status"];
        const status =
          rawStatus === "completed" ? "completed"
          : rawStatus === "failed" ? "failed"
          : rawStatus === "stopped" ? "stopped"
          : entry.task.status;
        entry.task = { ...entry.task, status };
      }
      continue;
    }

    // ------------------------------------------------------------------
    // Nested events (parent_tool_use_id set → route into sub-agent entry)
    // ------------------------------------------------------------------
    const parentToolUseId = sdkEvent["parent_tool_use_id"];
    if (typeof parentToolUseId === "string" && parentToolUseId !== "") {
      // Walk up the chain: direct match or via toolUseIdToTaskId.
      const task_id = toolUseIdToTaskId.get(parentToolUseId);
      if (task_id !== undefined) {
        const entry = subagentByTaskId.get(task_id)!;
        if (sdkType === "assistant") {
          accumulateChildAssistant(entry, sdkEvent, i, evtTs);
        } else if (sdkType === "stream_event") {
          accumulateChildStreamEvent(entry, sdkEvent);
        } else {
          const key = `child-unknown-${i}`;
          entry.childOrder.push(key);
          entry.childUnknownByKey.set(key, sdkEvent);
        }
        continue;
      }
      // Unknown parent — fall through to top-level unknown rendering.
    }

    // ------------------------------------------------------------------
    // Top-level events (no parent or unresolved parent)
    // ------------------------------------------------------------------
    if (sdkType === "stream_event") {
      // SDKPartialAssistantMessage — streaming text.
      const parsed = parseStreamEvent(sdkEvent);
      if (parsed.kind === "message_start") {
        currentStreamMessageId = parsed.messageId;
        if (parsed.messageId !== "" && !textByMessageId.has(parsed.messageId)) {
          order.push(parsed.messageId);
          textByMessageId.set(parsed.messageId, "");
          tsByMessageId.set(parsed.messageId, evtTs);
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
      const content = Array.isArray(message?.["content"]) ? (message!["content"] as unknown[]) : [];

      if (messageId !== null) {
        const canonical = extractFinalText(message?.["content"]);
        const thinkingBlocks = extractThinkingBlocks(message?.["content"]);
        if (!textByMessageId.has(messageId)) {
          order.push(messageId);
        }
        textByMessageId.set(messageId, canonical);
        if (!tsByMessageId.has(messageId)) tsByMessageId.set(messageId, evtTs);
        thinkingByMessageId.set(messageId, thinkingBlocks);
        finalised.add(messageId);
        // Reset current stream ID — the final message closes the stream group.
        currentStreamMessageId = null;
      } else {
        // Final message without a recognisable ID — fall through to unknown
        // (but still process tool blocks from content below).
        const key = `unknown-${i}`;
        order.push(key);
        unknownByKey.set(key, sdkEvent);
        tsByKey.set(key, evtTs);
      }

      // Extract tool_use and tool_result blocks from message.content regardless
      // of whether we recognised the messageId.
      for (let bi = 0; bi < content.length; bi++) {
        const block = content[bi];
        const toolUse = asToolUseBlock(block);
        if (toolUse !== null) {
          const key = `tool-${i}-${bi}`;
          if (toolUse.name === "AskUserQuestion") {
            // Render as an interactive AskCard instead of a generic tool card.
            order.push(key);
            askByKey.set(key, { toolUseId: toolUse.id, input: toolUse.input as unknown as AskUserQuestionInput });
            tsByKey.set(key, evtTs);
          } else {
            order.push(key);
            toolUseByKey.set(key, { toolUse });
            toolUseIdToKey.set(toolUse.id, key);
            tsByKey.set(key, evtTs);
          }
          continue;
        }
        const toolResult = asToolResultBlock(block);
        if (toolResult !== null) {
          // Pair with matching tool_use by tool_use_id.
          const partnerKey = toolUseIdToKey.get(toolResult.tool_use_id);
          if (partnerKey !== undefined) {
            const entry = toolUseByKey.get(partnerKey);
            if (entry !== undefined) {
              toolUseByKey.set(partnerKey, { ...entry, toolResult });
            }
          } else {
            // Orphaned tool_result — render as unknown.
            const key = `unknown-${i}-${bi}`;
            order.push(key);
            unknownByKey.set(key, block as Record<string, unknown>);
            tsByKey.set(key, evtTs);
          }
        }
      }
    } else if (sdkType === "user") {
      // SDKUserMessage — the user's typed input echoed back by the SDK.
      // Extract text blocks; skip if the message contains only tool_result blocks
      // (those are paired with tool_use cards rendered elsewhere).
      const message = sdkEvent["message"] as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.["content"]) ? (message!["content"] as unknown[]) : [];
      const hasTextBlock = content.some(
        (b) =>
          b !== null &&
          typeof b === "object" &&
          (b as Record<string, unknown>)["type"] === "text",
      );
      if (hasTextBlock) {
        let text = "";
        for (const block of content) {
          if (
            block !== null &&
            typeof block === "object" &&
            (block as Record<string, unknown>)["type"] === "text" &&
            typeof (block as Record<string, unknown>)["text"] === "string"
          ) {
            text += (block as Record<string, unknown>)["text"] as string;
          }
        }
        if (text.length > 0) {
          const rawId = message?.["id"];
          const msgId = typeof rawId === "string" ? rawId : `user-${i}`;
          order.push(msgId);
          // Store in unknownByKey-style maps but with a user-typed key prefix
          // so the build step can identify them. We reuse a dedicated Map.
          userTextByKey.set(msgId, text);
          tsByKey.set(msgId, evtTs);
        }
      }
      // If message contains only tool_result blocks (no text), fall through to unknown.
      if (!hasTextBlock) {
        const key = `unknown-${i}`;
        order.push(key);
        unknownByKey.set(key, sdkEvent);
        tsByKey.set(key, evtTs);
      }
    } else {
      // All other SDK event types (tool_use, tool_result, system, etc.).
      const key = `unknown-${i}`;
      order.push(key);
      unknownByKey.set(key, sdkEvent);
      tsByKey.set(key, evtTs);
    }
  }

  // Build the output list preserving insertion order.
  const result: RenderedMessage[] = [];
  for (const id of order) {
    if (id.startsWith("subagent-")) {
      const task_id = id.slice("subagent-".length);
      const entry = subagentByTaskId.get(task_id)!;
      const children = buildSubagentChildren(entry);
      result.push({ kind: "subagent", key: id, task: entry.task, children, ts: entry.ts });
    } else if (unknownByKey.has(id)) {
      result.push({ kind: "unknown", key: id, sdkEvent: unknownByKey.get(id)!, ts: tsByKey.get(id) ?? 0 });
    } else if (askByKey.has(id)) {
      const entry = askByKey.get(id)!;
      result.push({ kind: "ask", key: id, toolUseId: entry.toolUseId, input: entry.input, ts: tsByKey.get(id) ?? 0 });
    } else if (toolUseByKey.has(id)) {
      const entry = toolUseByKey.get(id)!;
      const toolMsg: RenderedMessage =
        entry.toolResult !== undefined
          ? { kind: "tool_use", key: id, toolUse: entry.toolUse, toolResult: entry.toolResult, ts: tsByKey.get(id) ?? 0 }
          : { kind: "tool_use", key: id, toolUse: entry.toolUse, ts: tsByKey.get(id) ?? 0 };
      result.push(toolMsg);
    } else if (userTextByKey.has(id)) {
      const text = userTextByKey.get(id)!;
      const ts = tsByKey.get(id) ?? 0;
      result.push({ kind: "user", messageId: id, text, ts });
    } else {
      const text = textByMessageId.get(id) ?? "";
      const thinkingBlocks = thinkingByMessageId.get(id) ?? [];
      const ts = tsByMessageId.get(id) ?? 0;
      result.push({ kind: "assistant", messageId: id, text, thinkingBlocks, ts });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Search helpers (F4)
// ---------------------------------------------------------------------------

/**
 * Extract plain text content from a RenderedMessage for the Copy button and
 * for search matching. Per-kind rules:
 *   - assistant: raw markdown text
 *   - user:      raw text
 *   - tool_use:  for Bash tools, the literal command; for other tools,
 *                pretty-printed JSON of the input object
 *   - subagent:  the task description / prompt
 *   - unknown:   pretty-printed JSON of the underlying SDK event
 *   - ask:       empty (the bubble holds an interactive card)
 */
function messagePlainText(msg: RenderedMessage): string {
  if (msg.kind === "assistant") return msg.text;
  if (msg.kind === "user") return msg.text;
  if (msg.kind === "tool_use") {
    const name = msg.toolUse.name;
    const input = msg.toolUse.input;
    // Bash tool: copy the literal command for paste-into-shell convenience.
    if (name === "Bash" && input !== null && typeof input === "object") {
      const cmd = (input as Record<string, unknown>)["command"];
      if (typeof cmd === "string") return cmd;
    }
    // Default: name + pretty-printed JSON of input.
    try {
      return `${name}\n${JSON.stringify(input, null, 2)}`;
    } catch {
      return name;
    }
  }
  if (msg.kind === "subagent") {
    return msg.task.task_description ?? "";
  }
  if (msg.kind === "unknown") {
    try {
      return JSON.stringify(msg.sdkEvent, null, 2);
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * Given a search query and an ordered list of messages, return the indices
 * (into messages[]) that contain a case-insensitive substring match.
 */
export function computeMatchIndices(messages: RenderedMessage[], query: string): number[] {
  if (query.length === 0) return [];
  const lower = query.toLowerCase();
  const indices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const text = messagePlainText(messages[i]!);
    if (text.toLowerCase().includes(lower)) {
      indices.push(i);
    }
  }
  return indices;
}

// ---------------------------------------------------------------------------
// Helper: render a list of RenderedMessage values (used recursively by SubagentCard)
// ---------------------------------------------------------------------------

function renderMessages(
  messages: RenderedMessage[],
  onQuestionReply?: (payload: QuestionReplyPayload) => void,
  searchQuery = "",
  activeMatchKey = "",
  hideSdkEvents = false,
  onSubagentClicked?: (childInvocationId: string) => void,
): React.ReactNode[] {
  return messages.map((msg) => {
    // D26: when hideSdkEvents is true, suppress unknown (raw SDK event) cards.
    // Assistant, user, tool, ask, and subagent messages are never hidden.
    if (hideSdkEvents && msg.kind === "unknown") {
      return null;
    }

    if (msg.kind === "assistant") {
      // D25: skip assistant bubbles with no text and no thinking blocks — they
      // arise when a message contains only tool_use content blocks (no prose).
      // The tool_use itself is rendered as a ToolCard further down in the list.
      if (msg.text.trim() === "" && msg.thinkingBlocks.length === 0) {
        return null;
      }
      const thinkingNodes = msg.thinkingBlocks.map((block, i) =>
        createElement(Thinking, { key: `thinking-${i}`, block }),
      );
      const isActive = msg.messageId === activeMatchKey;
      const plainText = msg.text;
      return createElement(
        MessageBubble,
        {
          key: msg.messageId,
          role: "assistant" as MessageRole,
          timestamp: msg.ts,
          plainText,
          isActiveMatch: isActive,
          testId: `stream-message-${msg.messageId}`,
        },
        ...thinkingNodes,
        createElement(Markdown, { searchQuery, children: msg.text }),
      );
    }
    if (msg.kind === "user") {
      return createElement(
        MessageBubble,
        {
          key: msg.messageId,
          role: "user" as MessageRole,
          timestamp: msg.ts,
          plainText: msg.text,
          isActiveMatch: false,
          testId: `stream-user-${msg.messageId}`,
        },
        createElement(Markdown, { searchQuery, children: msg.text }),
      );
    }
    if (msg.kind === "ask") {
      return createElement(
        MessageBubble,
        {
          key: msg.key,
          role: "assistant" as MessageRole,
          timestamp: msg.ts,
          plainText: "",
          isActiveMatch: false,
        },
        createElement(AskCard, {
          toolUseId: msg.toolUseId,
          input: msg.input,
          onReply: onQuestionReply ?? (() => {}),
        }),
      );
    }
    if (msg.kind === "tool_use") {
      const isActive = msg.key === activeMatchKey;
      const plainText = messagePlainText(msg);
      return createElement(
        MessageBubble,
        {
          key: msg.key,
          role: "tool" as MessageRole,
          timestamp: msg.ts,
          plainText,
          isActiveMatch: isActive,
          testId: `tool-use-${msg.toolUse.id}`,
        },
        ToolCard(msg.toolUse, msg.toolResult),
      );
    }
    if (msg.kind === "subagent") {
      // D30: when a childInvocationId is available and a click handler is wired,
      // SubagentCard renders a compact "View transcript →" link instead of
      // inlining the full transcript.
      const nestedChildren = renderMessages(msg.children, onQuestionReply, searchQuery, activeMatchKey, hideSdkEvents, onSubagentClicked);
      return createElement(
        MessageBubble,
        {
          key: msg.key,
          role: "assistant" as MessageRole,
          timestamp: msg.ts,
          plainText: msg.task.task_description,
          isActiveMatch: false,
        },
        createElement(
          SubagentCard,
          {
            task: msg.task,
            ...(onSubagentClicked !== undefined ? { onViewTranscript: onSubagentClicked } : {}),
          },
          ...nestedChildren,
        ),
      );
    }
    // unknown
    return createElement(
      MessageBubble,
      {
        key: msg.key,
        role: "unknown" as MessageRole,
        timestamp: msg.ts,
        plainText: messagePlainText(msg),
        isActiveMatch: false,
      },
      createElement(UnknownCard, { sdkEvent: msg.sdkEvent }),
    );
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface StreamProps {
  chatEvents: ChatEvent[];
  onQuestionReply?: (payload: QuestionReplyPayload) => void;
  /**
   * Rendering mode.
   *
   * - `'live'` (default): interactive — AskCard, PermissionPrompt, and other
   *   interactive cards accept user input and fire callbacks.
   * - `'replay'`: read-only — interactive callbacks are suppressed; AskCard
   *   renders without a submit button because `onQuestionReply` is omitted.
   *   This mode is used by `Detail.tsx` to replay history events through the
   *   same renderer without allowing user interaction.
   */
  mode?: "live" | "replay";
  /**
   * When true, the model is processing (chat.started received, chat.done not
   * yet received). If no chat.events have arrived yet for this invocation,
   * Stream renders a "Thinking…" indicator.
   */
  inProgress?: boolean;
  /**
   * Search query for F4 highlighting. Empty string = no search active.
   */
  searchQuery?: string;
  /**
   * 0-based index of the active match within matchIndices.
   * Passed in from the parent which owns search state.
   */
  activeMatchIndex?: number;
  /**
   * Callback fired when the user scrolls up (away from the bottom).
   * The parent uses this to show the "Jump to latest" button.
   */
  onScrolledUp?: (scrolledUp: boolean) => void;
  /**
   * When true, the parent wants Stream to imperatively scroll to the bottom.
   * The parent sets this after the user clicks "Jump to latest".
   */
  scrollToBottom?: boolean;
  /** Called after Stream has processed a scrollToBottom request. */
  onScrollToBottomDone?: () => void;
  /**
   * When true, raw SDK event cards (UnknownCard) are hidden from the stream.
   * Assistant, user, tool, ask, and subagent messages are never affected.
   * Default: false.
   */
  hideSdkEvents?: boolean;
  /**
   * D30: called when the user clicks "View transcript →" on a SubagentCard.
   * Receives the child invocation id. When undefined, the compact link is not
   * rendered (full transcript inlined as before).
   */
  onSubagentClicked?: (childInvocationId: string) => void;
}

export function Stream({
  chatEvents,
  onQuestionReply,
  mode = "live",
  inProgress = false,
  searchQuery = "",
  activeMatchIndex = 0,
  onScrolledUp,
  scrollToBottom = false,
  onScrollToBottomDone,
  hideSdkEvents = false,
  onSubagentClicked,
}: StreamProps): React.ReactElement {
  const messages = useMemo(() => computeRenderedMessages(chatEvents), [chatEvents]);

  // ---- Pagination state (F3) ----
  // We show only the most recent `visibleCount` messages. "Load older" increases this.
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE);

  // Reset pagination when a new session starts (chatEvents cleared to []).
  const prevEventLengthRef = useRef(chatEvents.length);
  useEffect(() => {
    if (chatEvents.length < prevEventLengthRef.current) {
      // Events array shrank — new session started, reset pagination.
      setVisibleCount(DEFAULT_VISIBLE);
    }
    prevEventLengthRef.current = chatEvents.length;
  }, [chatEvents.length]);

  const totalMessages = messages.length;
  const hiddenCount = Math.max(0, totalMessages - visibleCount);
  // The slice we actually render: most recent `visibleCount` messages.
  const visibleMessages = hiddenCount > 0 ? messages.slice(hiddenCount) : messages;

  function handleLoadOlder(): void {
    setVisibleCount((c) => c + LOAD_OLDER_CHUNK);
  }

  // ---- Search state (F4) ----
  const matchIndices = useMemo(
    () => computeMatchIndices(visibleMessages, searchQuery),
    [visibleMessages, searchQuery],
  );
  // The activeMatchIndex is 0-based over matchIndices[].
  const activeMatchArrayIndex = matchIndices[activeMatchIndex] ?? -1;
  // Convert to a message key for bubble highlighting.
  const activeMatchMsg = activeMatchArrayIndex >= 0 ? visibleMessages[activeMatchArrayIndex] : undefined;
  const activeMatchKey: string =
    activeMatchMsg !== undefined
      ? activeMatchMsg.kind === "assistant" || activeMatchMsg.kind === "user"
        ? activeMatchMsg.messageId
        : activeMatchMsg.key
      : "";

  // ---- Auto-scroll state (F2) ----
  const rootRef = useRef<HTMLDivElement>(null);
  // True while the user is scrolled up (not near the bottom).
  const isScrolledUpRef = useRef(false);

  function isAtBottom(): boolean {
    const el = rootRef.current;
    if (el === null) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_NEAR_BOTTOM_PX;
  }

  // Scroll to bottom on new messages if the user is at (or near) the bottom.
  const prevMessageCountRef = useRef(visibleMessages.length);
  useEffect(() => {
    const grew = visibleMessages.length > prevMessageCountRef.current;
    prevMessageCountRef.current = visibleMessages.length;
    if (grew && !isScrolledUpRef.current) {
      rootRef.current?.scrollTo({ top: rootRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [visibleMessages.length]);

  // Handle the imperative scrollToBottom request from parent.
  useEffect(() => {
    if (scrollToBottom) {
      rootRef.current?.scrollTo({ top: rootRef.current.scrollHeight, behavior: "smooth" });
      isScrolledUpRef.current = false;
      onScrolledUp?.(false);
      onScrollToBottomDone?.();
    }
  }, [scrollToBottom]); // intentional: only react to the flag change

  // Track scroll position to determine if user has scrolled up.
  const handleScroll = useCallback(() => {
    const atBottom = isAtBottom();
    const wasScrolledUp = isScrolledUpRef.current;
    isScrolledUpRef.current = !atBottom;
    if (!atBottom !== wasScrolledUp) {
      onScrolledUp?.(!atBottom);
    }
  }, [onScrolledUp]);

  // Scroll to active search match when it changes.
  useEffect(() => {
    if (activeMatchKey.length === 0) return;
    const el = rootRef.current;
    if (el === null) return;
    const target = el.querySelector(`[data-testid="stream-message-${activeMatchKey}"], [data-testid="tool-use-${activeMatchKey}"]`);
    if (target !== null) {
      target.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [activeMatchKey]);

  // In replay mode, omit the onQuestionReply callback so AskCard renders
  // without a submit button and other interactive cards are effectively
  // disabled (they receive no reply handler).
  const effectiveReply = mode === "replay" ? undefined : onQuestionReply;

  const isEmpty = chatEvents.length === 0 && !inProgress;
  const showThinking = inProgress && chatEvents.length === 0;

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-testid="stream-root"
      aria-live="polite"
      aria-label="Chat messages"
      onScroll={handleScroll}
    >
      {/* F3: Load older button — shown when there are hidden older messages */}
      {hiddenCount > 0 && (
        <button
          className={styles.loadOlderBtn}
          onClick={handleLoadOlder}
          type="button"
          data-testid="load-older-btn"
        >
          Load older ({hiddenCount} more)
        </button>
      )}
      {isEmpty && (
        <div className={styles.emptyState} data-testid="stream-empty-state">
          Type below to start
        </div>
      )}
      <div className={styles.messageList}>
        {renderMessages(visibleMessages, effectiveReply, searchQuery, activeMatchKey, hideSdkEvents, onSubagentClicked)}
      </div>
      {showThinking && (
        <div className={styles.thinkingIndicator} data-testid="stream-thinking">
          Thinking…
        </div>
      )}
    </div>
  );
}
