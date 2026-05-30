/**
 * plan-workflow-history.spec.ts — wfhist E2E.
 *
 * Scenario:
 *   1. Open the cq page; wait for ALIVE + idle.
 *   2. Script the mock so the producer submits a structured {goal,questions}.
 *   3. Type `/plan …`; wait for the questions_ready banner.
 *   4. Switch to the History tab.
 *   5. Assert a DISTINCT workflow entry exists: a top-level row carrying the
 *      "Plan" badge AND a `producer` phase child row nested under it.
 *
 * Lives in the `prelude` Playwright project (WFL-D02 ordering): a `/plan` spec
 * must run before any Codex spec so the cq server is the sole ledger writer at
 * producer time. The config's prelude testMatch includes `-history`.
 */

import { test, expect } from "../fixtures/base.ts";
import type { SSEEvent } from "../fixtures/adminMock.ts";

const SUBMIT_TOOL_USE_ID = "toolu_wf_hist_e2e";

const SUBMIT_INPUT = {
  goal: { title: "History probe app", description: "A probe goal to verify /plan shows in History." },
  questions: [
    { question: "Which platforms should it target?", suggestions: ["web", "desktop"], recommendation: "web" },
  ],
  grounding: "cq is a local-first ledger app; ledgers under docs/; the workflow runtime drives /plan.",
};

function submitPlanSse(): SSEEvent[] {
  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: { id: "msg_h_1", type: "message", role: "assistant", content: [], model: "claude-3-5-sonnet-stub", stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
      },
    },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: SUBMIT_TOOL_USE_ID, name: "mcp__wf__submit_plan", input: {} } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(SUBMIT_INPUT) } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

function confirmSse(): SSEEvent[] {
  return [
    {
      event: "message_start",
      data: { type: "message_start", message: { id: "msg_h_2", type: "message", role: "assistant", content: [], model: "claude-3-5-sonnet-stub", stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
    },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "submitted" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

test("/plan run appears as a distinct History entry with its producer phase nested", async ({ cq, mock, page }) => {
  test.setTimeout(150_000);
  await cq.open();
  await expect(cq.textarea).toBeEnabled({ timeout: 45_000 });
  await cq.waitForIdle(45_000);

  await mock.script(submitPlanSse());
  await mock.scriptOnToolResult(confirmSse());

  await cq.textarea.click();
  await cq.textarea.fill("/plan build a history probe app");
  await page.keyboard.press("Enter");

  const banner = page.locator("[data-testid='workflow-banner']");
  await expect(banner).toBeVisible({ timeout: 90_000 });
  await expect(banner).toHaveAttribute("data-status", "questions_ready", { timeout: 90_000 });

  // Switch to the History tab and refresh the list.
  const historyTab = page.locator("[role='tab']", { hasText: "History" });
  await historyTab.click();

  // A top-level workflow row carries the "Plan" badge.
  const planBadge = page.locator("[data-testid^='workflow-badge-']");
  await expect(planBadge.first()).toBeVisible({ timeout: 45_000 });
  await expect(planBadge.first()).toHaveText("Plan");

  // The workflow run's title row is present.
  const titleRow = page.locator("table tbody tr", { hasText: SUBMIT_INPUT.goal.title });
  await expect(titleRow.first()).toBeVisible({ timeout: 45_000 });

  // The producer phase child renders as a nested subagent row under the run.
  const producerRow = page.locator("table tbody tr", { hasText: "producer" });
  await expect(producerRow.first()).toBeVisible({ timeout: 45_000 });
  // Subagent rows carry the ↪ nesting glyph.
  await expect(producerRow.first()).toContainText("↪");

  // WF-HIST-02a: opening the producer phase's Detail replays a NON-empty
  // transcript (the producer's drained SDK messages were recorded as events).
  // Before this cycle the workflow wrote no event rows, so this Detail was empty.
  await producerRow.first().click();
  const detailBody = page.locator("[data-testid='detail-body']");
  await expect(detailBody).toBeVisible({ timeout: 45_000 });
  // The producer's post-submit assistant text ("submitted") was forwarded +
  // recorded → it renders as a bubble in the replayed Detail.
  await expect(detailBody).toContainText("submitted", { timeout: 45_000 });
  // Close the Detail.
  await page.locator("[data-testid='detail-close-btn']").first().click();

  // WF-HIST-02b: the run ROOT's Detail shows the asked Q&A transcript. The root
  // (main) row carries the "Plan" badge; open it.
  const rootRow = page.locator("table tbody tr", { hasText: SUBMIT_INPUT.goal.title }).first();
  await rootRow.click();
  const rootDetail = page.locator("[data-testid='detail-body']");
  await expect(rootDetail).toBeVisible({ timeout: 45_000 });
  await expect(rootDetail).toContainText("Asked 1 clarifying question", { timeout: 45_000 });
  await expect(rootDetail).toContainText("Which platforms should it target?", { timeout: 45_000 });

  // WFL-D02 drain: this is the only producer-spawning prelude spec that lacked a
  // teardown drain. The /plan producer's headless subprocess outlives submit-time
  // (the busy flag clears BEFORE query().close() reaps the child), so without this
  // it could linger into the `main` project. /__e2e/workflow-drain blocks until
  // every workflow subprocess has actually exited. Mirrors plan-workflow-loop/
  // -goals/-continuation teardown. (Defensive hygiene; per ACTIVITY-01-D03 this
  // drain does NOT fix the separate deterministic header-badges warm-up-turn
  // failure, which is a production defect in the base ACTIVITY-01 work.)
  const cqUrl = process.env["CQ_BASE_URL"] ?? "http://127.0.0.1:5173";
  const drainRes = await fetch(`${cqUrl}/__e2e/workflow-drain`, { method: "POST" });
  expect(drainRes.ok, "workflow-drain hook must report success").toBeTruthy();
  await cq.waitForIdle(45_000).catch(() => undefined);
});
