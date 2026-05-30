/**
 * plan-workflow-goals.spec.ts — Goals tab end-to-end (cycle 4).
 *
 * Scenario:
 *   1. Open cq; wait for idle.
 *   2. Script the four phase submit tools (producer + clarify + planner +
 *      reviewer), same as plan-workflow-loop, but the producer returns a
 *      question with a suggestion + recommendation so the Goals-tab question
 *      card has chips to render.
 *   3. Type `/plan …` → wait for the questions_ready banner.
 *   4. Switch to the Goals tab. Assert: the goal row, its open question, and the
 *      badge (totalOpenQuestions ≥ 1).
 *   5. Answer the question INLINE via the Goals-tab UI (pre-fill from the
 *      recommended chip, then click Submit answer) — this emits question.answer
 *      through the UI, auto-advancing the clarify→plan→review loop.
 *   6. Wait for the goal status chip to read `planned`; assert a planner
 *      milestone + a task chip are now rendered, and the badge cleared to 0.
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

test("/plan: Goals tab renders, answers inline, and converges to planned", async ({ cq, mock, page }) => {
  // Drives 4 sequential headless SDK subprocesses (producer + 3 loop phases).
  test.setTimeout(180_000);
  await cq.open();
  await expect(cq.textarea).toBeEnabled({ timeout: 10_000 });
  await cq.waitForIdle(15_000);

  await mock.scriptByKey(
    "submit_clarify_review",
    toolUseSse("mcp__wf__submit_clarify_review", { payload: { clear: true, contradictions: [], newQuestions: [] } }, "cr"),
  );
  await mock.scriptByKey(
    "submit_plan_doc",
    toolUseSse(
      "mcp__wf__submit_plan_doc",
      {
        payload: {
          milestones: [{ title: "Core build", description: "the core" }],
          tasks: [{ milestoneRef: 0, headline: "Editor", description: "rich editor", acceptance: "renders markdown" }],
        },
      },
      "pd",
    ),
  );
  await mock.scriptByKey(
    "submit_plan_review",
    toolUseSse("mcp__wf__submit_plan_review", { payload: { satisfied: true, findings: [], newQuestions: [] } }, "pr"),
  );
  await mock.scriptByKey(
    "submit_plan",
    toolUseSse(
      "mcp__wf__submit_plan",
      {
        goal: { title: "Local-first notes app", description: "A local-first notes app." },
        questions: [{ question: "Which platforms?", context: "target surface", suggestions: ["web", "desktop"], recommendation: "web" }],
      },
      "pp",
    ),
  );

  await cq.textarea.click();
  await cq.textarea.fill("/plan build a local-first notes app");
  await page.keyboard.press("Enter");

  const banner = page.locator("[data-testid='workflow-banner']");
  await expect(banner).toBeVisible({ timeout: 40_000 });
  await expect(banner).toHaveAttribute("data-status", "questions_ready", { timeout: 40_000 });

  // Switch to the Goals tab.
  await page.getByRole("tab", { name: "Goals" }).click();

  // The goal row + its open question render; the badge shows the open count.
  // Scope to the LATEST goal (highest G-id) so this spec stays robust against
  // earlier prelude specs having created goals in the shared cwd (WFL-D02).
  const goal = page.locator("[data-testid^='goal-G']").last();
  await expect(goal).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-testid='goals-badge']")).toHaveText("1", { timeout: 10_000 });

  // Find this goal's open question card + its answer input/submit (G/Q-prefixed).
  const questionCard = goal.locator("[data-testid^='goal-question-Q'][data-answered='false']").first();
  await expect(questionCard).toBeVisible({ timeout: 10_000 });
  const questionId = (await questionCard.getAttribute("data-testid"))!.replace("goal-question-", "");

  // Pre-fill from the recommended chip, then submit the answer INLINE.
  const recommendedChip = page.locator(`[data-testid='goal-suggestion-${questionId}-0']`);
  await recommendedChip.click();
  const answerInput = page.locator(`[data-testid='goal-answer-input-${questionId}']`);
  await expect(answerInput).toHaveValue("web");
  await page.locator(`[data-testid='goal-answer-submit-${questionId}']`).click();

  // The loop auto-advances clarify→plan→review→planned. The Goals tab refreshes
  // on each workflow.event; wait for the goal status chip to read planned.
  const statusChip = goal.locator("[data-testid^='goal-status-']");
  await expect(statusChip).toHaveText("planned", { timeout: 120_000 });

  // The planner milestone + its task chip are now rendered, and the badge cleared.
  await expect(goal.locator("text=Core build").first()).toBeVisible({ timeout: 10_000 });
  await expect(goal.locator("[data-testid^='goal-task-']").first()).toContainText("Editor", { timeout: 10_000 });
  await expect(page.locator("[data-testid='goals-badge']")).toHaveCount(0);

  // Drain the workflow lane so no lingering child leaks into the next spec.
  const cqUrl = process.env["CQ_BASE_URL"] ?? "http://127.0.0.1:5173";
  const drainRes = await fetch(`${cqUrl}/__e2e/workflow-drain`, { method: "POST" });
  expect(drainRes.ok, "workflow-drain hook must report success").toBeTruthy();
  await cq.waitForIdle(15_000).catch(() => undefined);
});
