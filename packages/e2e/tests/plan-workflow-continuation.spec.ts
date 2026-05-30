/**
 * plan-workflow-continuation.spec.ts — `/plan G<id> <feature>` append-increment
 * continuation end-to-end (Q10).
 *
 * Scenario:
 *   1. Open cq; wait for idle. Script the four phase submit tools (producer +
 *      clarify + planner + reviewer) AND a distinct `submit_continuation` for
 *      the continuation producer.
 *   2. `/plan …` → drive a fresh goal to `planned` (via the Goals-tab inline
 *      answer), capturing its goal id and the original milestone title.
 *   3. `/plan G<id> <feature>` → wait for the questions_ready banner; switch to
 *      the Goals tab and assert a NEW increment milestone + a NEW scoped
 *      question appear while the ORIGINAL milestone remains.
 *   4. Answer the increment question inline → the loop appends a new milestone
 *      and converges back to `planned`; assert BOTH the original and the new
 *      increment-plan milestones are present.
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

test("/plan G<id>: continuation appends an increment milestone + new questions; original milestone intact", async ({ cq, mock, page }) => {
  // Two full /plan flows (fresh + continuation) → up to 8 sequential headless
  // SDK subprocesses; raise the per-test budget well above the default.
  test.setTimeout(300_000);
  await cq.open();
  await expect(cq.textarea).toBeEnabled({ timeout: 10_000 });
  await cq.waitForIdle(15_000);

  // Shared loop phases (used by BOTH the fresh plan and the continuation).
  await mock.scriptByKey(
    "submit_clarify_review",
    toolUseSse("mcp__wf__submit_clarify_review", { payload: { clear: true, contradictions: [], newQuestions: [] } }, "cr"),
  );
  await mock.scriptByKey(
    "submit_plan_review",
    toolUseSse("mcp__wf__submit_plan_review", { payload: { satisfied: true, findings: [], newQuestions: [] } }, "pr"),
  );
  // The planner key returns the ORIGINAL milestone for the fresh plan; the
  // continuation planner (different prompt — "immutable read-only context")
  // gets its own keyed response so its NEW increment milestone is distinct.
  await mock.scriptByKey(
    "immutable read-only context",
    toolUseSse(
      "mcp__wf__submit_plan_doc",
      {
        payload: {
          milestones: [{ title: "Attachment crypto", description: "encrypt attachments" }],
          tasks: [{ milestoneRef: 0, headline: "Key envelope", description: "per-file key wrap", acceptance: "round-trips" }],
        },
      },
      "pd2",
    ),
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
  // Continuation producer (distinct tool → distinct key, matched before the
  // bare `submit_plan` producer key below).
  await mock.scriptByKey(
    "submit_continuation",
    toolUseSse(
      "mcp__wf__submit_continuation",
      {
        payload: {
          goal: { description: "A local-first notes app WITH attachment E2E encryption." },
          questions: [{ question: "Which attachment types?", context: "scope", suggestions: ["images", "any"], recommendation: "any" }],
        },
      },
      "ct",
    ),
  );
  // Phase-1 producer key checked last (its prompt contains "submit_plan").
  await mock.scriptByKey(
    "submit_plan",
    toolUseSse(
      "mcp__wf__submit_plan",
      {
        goal: { description: "A local-first notes app." },
        questions: [{ question: "Which platforms?", context: "surface", suggestions: ["web", "desktop"], recommendation: "web" }],
      },
      "pp",
    ),
  );

  const banner = page.locator("[data-testid='workflow-banner']");

  // ── 1. Fresh /plan → planned. ──────────────────────────────────────────── //
  await cq.textarea.click();
  await cq.textarea.fill("/plan build a local-first notes app");
  await page.keyboard.press("Enter");
  await expect(banner).toBeVisible({ timeout: 40_000 });
  await expect(banner).toHaveAttribute("data-status", "questions_ready", { timeout: 40_000 });

  await page.getByRole("tab", { name: "Goals" }).click();
  // The goal under continuation = the LAST goal row (highest G-id), to stay
  // robust against earlier prelude specs having created goals in the shared cwd.
  const goal = page.locator("[data-testid^='goal-G']").last();
  await expect(goal).toBeVisible({ timeout: 10_000 });
  const goalTestId = (await goal.getAttribute("data-testid"))!; // e.g. goal-G3
  const goalId = goalTestId.replace("goal-", "");

  // Answer the original question inline → loop converges to planned.
  await answerFirstOpenQuestion(page);
  const statusChip = goal.locator("[data-testid^='goal-status-']");
  await expect(statusChip).toHaveText("planned", { timeout: 120_000 });
  await expect(goal.locator("text=Core build").first()).toBeVisible({ timeout: 10_000 });

  // ── 2. Continuation: /plan G<id> <feature>. ────────────────────────────── //
  await page.getByRole("tab", { name: "Chat" }).click();
  await cq.textarea.click();
  await cq.textarea.fill(`/plan ${goalId} add end-to-end encryption for attachments`);
  await page.keyboard.press("Enter");
  await expect(banner).toHaveAttribute("data-status", "questions_ready", { timeout: 60_000 });

  // Goals tab: the goal is clarifying-an-increment; a NEW increment milestone +
  // a NEW scoped question render; the ORIGINAL "Core build" milestone remains.
  await page.getByRole("tab", { name: "Goals" }).click();
  await expect(statusChip).toHaveText("clarifying", { timeout: 15_000 });
  await expect(goal.locator("text=Core build").first()).toBeVisible({ timeout: 10_000 }); // original intact
  await expect(goal.locator("text=/increment:/").first()).toBeVisible({ timeout: 10_000 }); // new increment milestone
  await expect(goal.locator("text=Which attachment types?").first()).toBeVisible({ timeout: 10_000 });
  // The badge reflects the new open increment question.
  await expect(page.locator("[data-testid='goals-badge']")).toHaveText("1", { timeout: 10_000 });

  // ── 3. Answer the increment question → append plan → planned again. ────── //
  await answerFirstOpenQuestion(page);
  await expect(statusChip).toHaveText("planned", { timeout: 120_000 });
  // BOTH the original and the appended increment-plan milestone are present.
  await expect(goal.locator("text=Core build").first()).toBeVisible({ timeout: 10_000 });
  await expect(goal.locator("text=Attachment crypto").first()).toBeVisible({ timeout: 10_000 });
  await expect(goal.locator("[data-testid^='goal-task-']").filter({ hasText: "Key envelope" }).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-testid='goals-badge']")).toHaveCount(0);

  // Drain the workflow lane so no lingering child leaks into the next spec.
  const cqUrl = process.env["CQ_BASE_URL"] ?? "http://127.0.0.1:5173";
  const drainRes = await fetch(`${cqUrl}/__e2e/workflow-drain`, { method: "POST" });
  expect(drainRes.ok, "workflow-drain hook must report success").toBeTruthy();
  await cq.waitForIdle(15_000).catch(() => undefined);
});

/** Answer the first open question card inline via the Goals-tab UI. */
async function answerFirstOpenQuestion(page: import("@playwright/test").Page): Promise<void> {
  const questionCard = page.locator("[data-testid^='goal-question-Q'][data-answered='false']").first();
  await expect(questionCard).toBeVisible({ timeout: 15_000 });
  const questionId = (await questionCard.getAttribute("data-testid"))!.replace("goal-question-", "");
  const recommendedChip = page.locator(`[data-testid='goal-suggestion-${questionId}-0']`);
  await recommendedChip.click();
  await page.locator(`[data-testid='goal-answer-submit-${questionId}']`).click();
}
