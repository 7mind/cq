/**
 * plan-workflow-scroll.spec.ts — PLAN-D02: the Goals tab content scrolls.
 *
 * The Goals `.wrapper` had `height:100%; overflow:auto` but, as a flex child of
 * a bounded flex-column panel with default `min-height:auto`, it grew to its
 * content height and `overflow:auto` never engaged — so with many questions the
 * user could not scroll to the rest. The fix makes `.wrapper` a bounded flex
 * item (`flex:1; min-height:0`).
 *
 * This proves the HEIGHT CHAIN, not just the CSS property: it seeds enough open
 * questions to overflow the viewport, then asserts the scroll container has
 * `scrollHeight > clientHeight` AND that programmatically scrolling actually
 * moves it (a non-scrolling container clamps scrollTop back to 0).
 *
 * Runs in the `prelude` project (WFL-D02 ordering) so the cq server is the sole
 * ledger writer at producer time.
 */

import { test, expect } from "../fixtures/base.ts";
import type { SSEEvent } from "../fixtures/adminMock.ts";

function toolUseSse(toolName: string, input: unknown, id: string): SSEEvent[] {
  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: `msg_${id}`,
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
      data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: toolName, input: {} } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

test("/plan: Goals tab scrolls when many questions overflow the viewport", async ({ cq, mock, page }) => {
  test.setTimeout(120_000);
  await cq.open();
  await expect(cq.textarea).toBeEnabled({ timeout: 10_000 });
  await cq.waitForIdle(15_000);

  // Producer returns MANY questions so the Goals tab content overflows.
  const questions = Array.from({ length: 25 }, (_, i) => ({
    question: `Open question number ${i + 1}: which approach do you prefer for sub-system ${i + 1}?`,
    context: `Context paragraph for question ${i + 1}, long enough to add vertical height to the question card so the list overflows the viewport.`,
    suggestions: ["option-a", "option-b"],
    recommendation: "option-a",
  }));
  await mock.scriptByKey(
    "submit_plan",
    toolUseSse(
      "mcp__wf__submit_plan",
      { goal: { title: "Many-questions goal", description: "A goal with many open questions." }, questions },
      "pp",
    ),
  );

  await cq.textarea.click();
  await cq.textarea.fill("/plan build something with many open decisions");
  await page.keyboard.press("Enter");

  const banner = page.locator("[data-testid='workflow-banner']");
  await expect(banner).toBeVisible({ timeout: 40_000 });
  await expect(banner).toHaveAttribute("data-status", "questions_ready", { timeout: 40_000 });

  await page.getByRole("tab", { name: "Goals" }).click();

  const goal = page.locator("[data-testid^='goal-G']").last();
  await expect(goal).toBeVisible({ timeout: 10_000 });

  // The scroll container is the Goals `.wrapper` (data-testid="goals-tab").
  const scroller = page.locator("[data-testid='goals-tab']");
  await expect(scroller).toBeVisible({ timeout: 10_000 });

  // (1) The height chain bounds the container below its content → it overflows.
  await expect
    .poll(
      async () =>
        scroller.evaluate((el) => el.scrollHeight - el.clientHeight),
      { timeout: 15_000, message: "goals-tab must overflow (scrollHeight > clientHeight)" },
    )
    .toBeGreaterThan(40);

  // (2) Prove it actually SCROLLS — a non-scrolling container clamps scrollTop
  // back to 0. Drive a real scroll and assert it stuck.
  const movedTo = await scroller.evaluate((el) => {
    el.scrollTop = 300;
    return el.scrollTop;
  });
  expect(movedTo, "goals-tab scrollTop must move off 0 (container is scrollable)").toBeGreaterThan(0);

  // Drain the workflow lane so no lingering child leaks into the next spec.
  const cqUrl = process.env["CQ_BASE_URL"] ?? "http://127.0.0.1:5173";
  const drainRes = await fetch(`${cqUrl}/__e2e/workflow-drain`, { method: "POST" });
  expect(drainRes.ok, "workflow-drain hook must report success").toBeTruthy();
  await cq.waitForIdle(15_000).catch(() => undefined);
});
