/**
 * askcard-other.spec.ts — ASKCARD-2: free-form "Other…" answer path, e2e.
 *
 * Deferred follow-up from ASKCARD-D01 (0b68375): render + broker tests cover
 * submit and model-delivery, but no browser e2e drives the "Other…" path end
 * to end. This spec does.
 *
 * Flow under test:
 *   1. Open cq; wait for ALIVE + idle.
 *   2. Script the mock to stream an assistant `tool_use` named
 *      `AskUserQuestion` (the bundled CLI aliases this to the in-process
 *      mcp__cq__ask_user_question tool — claudeBridge.ts:479 — which blocks
 *      the turn on the AskBroker until the WS client replies).
 *   3. Send a prompt that triggers it; the AskCard renders from the streamed
 *      block (Stream.tsx:539 keys on the literal name "AskUserQuestion").
 *   4. Select "Other…", assert the text field appears and Submit is DISABLED
 *      while empty (AskCard isComplete() rule: active-but-empty Other ⇒ the
 *      question counts as unanswered).
 *   5. Type a custom answer; assert Submit ENABLES; click it.
 *   6. Assert the custom string round-trips: the browser sends a
 *      `chat.question_reply` WS frame whose `answers` carry the typed text
 *      (ChatTab.tsx:707). We capture it via page.on("websocket") + framesent —
 *      a robust observable independent of whether the follow-up model turn
 *      fires. As a secondary signal we also script a tool-result confirmation
 *      and assert it appears, proving the broker resolved and the SDK sent the
 *      tool_result back upstream.
 */

import { test, expect } from "../fixtures/base.ts";
import type { SSEEvent } from "../fixtures/adminMock.ts";

const ASK_TOOL_USE_ID = "toolu_ask_other_e2e";
const CUSTOM_ANSWER = "mTLS with pinned client certs";
const CONFIRM_TEXT = "Got it — using your custom answer.";

/** Stream an assistant message containing one AskUserQuestion tool_use. */
function askUserQuestionSseEvents(): SSEEvent[] {
  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_ask_other",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-5-sonnet-stub",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: ASK_TOOL_USE_ID,
          name: "AskUserQuestion",
          input: {},
        },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({
            questions: [
              {
                header: "Auth",
                question: "How to auth?",
                multiSelect: false,
                options: [
                  { label: "Cookies", description: "Session cookies" },
                  { label: "JWT", description: "Bearer tokens" },
                ],
              },
            ],
          }),
        },
      },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 12 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

/** Confirmation text streamed on the follow-up turn (tool_result present). */
function confirmSseEvents(): SSEEvent[] {
  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_ask_done",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-5-sonnet-stub",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: CONFIRM_TEXT },
      },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

/**
 * Install a page.on("websocket") capture for outbound `chat.question_reply`
 * frames. Returns a getter for the latest captured reply payload.
 */
function captureQuestionReply(cq: import("../fixtures/cqPage.ts").CqPage): {
  latest: () => { toolUseId?: string; answers?: Record<string, unknown> } | null;
} {
  let latest: { toolUseId?: string; answers?: Record<string, unknown> } | null = null;
  cq.page.on("websocket", (ws) => {
    ws.on("framesent", (frame) => {
      const payload = frame.payload;
      if (typeof payload !== "string") return;
      if (!payload.includes("chat.question_reply")) return;
      try {
        const parsed = JSON.parse(payload) as { type?: string; toolUseId?: string; answers?: Record<string, unknown> };
        if (parsed.type === "chat.question_reply") latest = parsed;
      } catch {
        /* not JSON — ignore */
      }
    });
  });
  return { latest: () => latest };
}

test("askcard-other: free-form Other answer round-trips via chat.question_reply", async ({ cq, mock }) => {
  // Attach the WS frame capture BEFORE open() — page.on("websocket") only
  // observes sockets opened after the listener is registered, and the cq WS
  // connects during open().
  const reply = captureQuestionReply(cq);

  await cq.open();
  await expect(cq.textarea).toBeEnabled({ timeout: 10_000 });

  // Sticky response: emit the AskUserQuestion tool_use. After the broker
  // resolves and the SDK sends a tool_result, the mock returns the
  // confirmation text.
  await mock.script(askUserQuestionSseEvents());
  await mock.scriptOnToolResult(confirmSseEvents());

  await cq.sendMessage("Ask me how to authenticate using the AskUserQuestion tool.");

  // The AskCard renders from the streamed tool_use block.
  const card = cq.page.locator("[data-testid='ask-card']");
  await expect(card).toBeVisible({ timeout: 25_000 });
  await expect(card).toContainText("How to auth?");

  // The "Other…" control exists; its text field is not yet shown.
  const otherInput = cq.page.locator("[data-testid='ask-other-input-0']");
  await expect(otherInput).toBeVisible();
  const otherText = cq.page.locator("[data-testid='ask-other-text-0']");
  await expect(otherText).toHaveCount(0);

  const submit = cq.page.locator("[data-testid='ask-submit']");
  await expect(submit).toBeDisabled();

  // Select "Other…": the text field appears; Submit stays DISABLED while empty.
  await otherInput.check();
  await expect(otherText).toBeVisible();
  await expect(submit).toBeDisabled();

  // Type a custom answer → Submit ENABLES.
  await otherText.fill(CUSTOM_ANSWER);
  await expect(submit).toBeEnabled();

  await submit.click();

  // Primary observable: the browser sent a chat.question_reply WS frame whose
  // answers carry the custom string.
  await expect
    .poll(() => reply.latest()?.answers, { timeout: 10_000 })
    .toBeTruthy();
  const captured = reply.latest();
  expect(captured?.toolUseId).toBe(ASK_TOOL_USE_ID);
  expect(JSON.stringify(captured?.answers)).toContain(CUSTOM_ANSWER);

  // Secondary signal: the broker resolved and the SDK sent the tool_result
  // upstream, so the follow-up confirmation text streams back into the UI.
  await cq.waitForTextInStream(CONFIRM_TEXT, 25_000);
  await expect(cq.textarea).toBeEnabled({ timeout: 25_000 });
});
