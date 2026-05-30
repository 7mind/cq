/**
 * plan-workflow.spec.ts — `/plan` phase-1 end-to-end.
 *
 * Scenario:
 *   1. Open the cq page; wait for ALIVE + idle.
 *   2. Script the mock to return a tool_use for mcp__wf__submit_plan with a
 *      structured {goal,questions} payload; on the follow-up (tool_result)
 *      return a confirmation. The producer's headless query is the only
 *      streaming request `/plan` triggers (the interactive chat stays idle).
 *   3. Type `/plan let's build …` and submit.
 *   4. Wait for the questions_ready workflow banner.
 *   5. Assert the cq server's --cwd has: docs/goals.md with a clarifying goal,
 *      docs/milestones.md with the spec milestone, docs/questions.md with ≥1
 *      question.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test, expect } from "../fixtures/base.ts";
import type { SSEEvent } from "../fixtures/adminMock.ts";

const SUBMIT_TOOL_USE_ID = "toolu_wf_submit_e2e";

const SUBMIT_INPUT = {
  goal: { title: "Local-first notes app", description: "A local-first encrypted notetaking webapp." },
  questions: [
    { question: "Which platforms should it target?", suggestions: ["web", "desktop"], recommendation: "web" },
    { question: "What encryption scheme?", recommendation: "age" },
  ],
};

function submitPlanSse(): SSEEvent[] {
  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_wf_submit",
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
        content_block: { type: "tool_use", id: SUBMIT_TOOL_USE_ID, name: "mcp__wf__submit_plan", input: {} },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(SUBMIT_INPUT) },
      },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

function confirmSse(): SSEEvent[] {
  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_wf_done",
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
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "submitted" } },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

test("/plan: phase 1 writes goal + spec milestone + questions and surfaces a banner", async ({ cq, mock, page }) => {
  // Raise the per-test budget above the default 60s: the producer's headless
  // subprocess cold-start can be slow under full-suite CPU load (the server
  // bounds it at 120s), and this spec runs adjacent to the workflow-loop spec
  // which spawns several subprocesses of its own.
  test.setTimeout(150_000);
  await cq.open();
  await expect(cq.textarea).toBeEnabled({ timeout: 10_000 });
  // Let the auto-started interactive chat session reach idle BEFORE dispatching
  // /plan. The workflow runs in its own lane, but the interactive chat's SDK
  // subprocess spawns on page load; waiting for it to settle removes the
  // concurrent-subprocess-init contention that otherwise makes the producer's
  // own headless subprocess start slowly under full-suite CPU load.
  await cq.waitForIdle(15_000);

  await mock.script(submitPlanSse());
  await mock.scriptOnToolResult(confirmSse());

  // Type the /plan line. Fill sets the value directly (no per-char input
  // events), so the slash popover does not open and Enter submits cleanly.
  await cq.textarea.click();
  await cq.textarea.fill("/plan let's build a local-first encrypted notetaking webapp");
  await page.keyboard.press("Enter");

  // Wait for the questions_ready banner. Generous timeout: the producer spawns
  // its own SDK subprocess whose cold-start can be slow under full-suite load.
  const banner = page.locator("[data-testid='workflow-banner']");
  await expect(banner).toBeVisible({ timeout: 90_000 });
  await expect(banner).toHaveAttribute("data-status", "questions_ready", { timeout: 90_000 });

  // Inspect the cq server's --cwd ledger files.
  const cqCwd = process.env["CQ_E2E_CWD"];
  expect(cqCwd, "CQ_E2E_CWD must be set by globalSetup").toBeTruthy();

  const goalsMd = await fs.readFile(path.join(cqCwd!, "docs", "goals.md"), "utf8");
  expect(goalsMd).toContain("ledger: goals");
  expect(goalsMd).toContain("clarifying");
  expect(goalsMd).toContain("local-first encrypted notetaking");

  const milestonesMd = await fs.readFile(path.join(cqCwd!, "docs", "milestones.md"), "utf8");
  expect(milestonesMd).toContain("produce an actionable specification");

  const questionsMd = await fs.readFile(path.join(cqCwd!, "docs", "questions.md"), "utf8");
  expect(questionsMd).toContain("ledger: questions");
  expect(questionsMd).toContain("Which platforms should it target?");
});
