/**
 * plan-workflow-loop.spec.ts — `/plan` full loop end-to-end (cycle 3).
 *
 * Scenario:
 *   1. Open cq; wait for idle.
 *   2. Register substring-keyed mock responses for each phase's submit tool:
 *        submit_plan (producer)          → goal + 1 question
 *        submit_clarify_review (clear)   → advance to planner
 *        submit_plan_doc (planner)       → 1 milestone + 1 task
 *        submit_plan_review (satisfied)  → planned
 *   3. Type `/plan …` → wait for the questions_ready banner.
 *   4. POST /__e2e/answer (the cycle-3 stand-in for the Goals-tab
 *      `question.answer` frame) → answers every open question, auto-advancing
 *      the loop.
 *   5. Wait for the `planned` banner.
 *   6. Assert the cq --cwd ledgers: goal status `planned`, a planner milestone,
 *      a task, and the question answered.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
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

test("/plan: full clarify→plan→review→planned loop populates the ledgers", async ({ cq, mock, page }) => {
  // This spec drives 4 sequential headless SDK subprocesses (producer + 3 loop
  // phases); raise the per-test budget above the default 60s to absorb cold
  // starts under full-suite CPU load.
  test.setTimeout(180_000);
  await cq.open();
  await expect(cq.textarea).toBeEnabled({ timeout: 10_000 });
  await cq.waitForIdle(15_000);

  // Per-phase keyed responses (matched by the submit-tool name in the body).
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
  // Producer key checked last (its prompt mentions submit_plan but not the others).
  await mock.scriptByKey(
    "submit_plan",
    toolUseSse(
      "mcp__wf__submit_plan",
      { goal: { description: "A local-first notes app." }, questions: [{ question: "Which platforms?", recommendation: "web" }] },
      "pp",
    ),
  );

  await cq.textarea.click();
  await cq.textarea.fill("/plan build a local-first notes app");
  await page.keyboard.press("Enter");

  const banner = page.locator("[data-testid='workflow-banner']");
  await expect(banner).toBeVisible({ timeout: 40_000 });
  await expect(banner).toHaveAttribute("data-status", "questions_ready", { timeout: 40_000 });

  // Answer the open question(s) via the cycle-3 test hook → auto-advance.
  const cqUrl = process.env["CQ_BASE_URL"] ?? "http://127.0.0.1:5173";
  const ansRes = await fetch(`${cqUrl}/__e2e/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer: "web" }),
  });
  expect(ansRes.ok).toBeTruthy();

  // Wait for the loop to terminate. The runtime emits `planned` then `done`
  // back-to-back, and the banner shows only the latest frame, so assert `done`
  // (the terminal lifecycle frame). The goal-status `planned` is verified in
  // the ledger below. Generous timeout: the loop spawns 3 more headless
  // subprocesses (clarify/plan/review) whose cold-starts can be slow under
  // full-suite CPU load (the server bounds each at 120s).
  await expect(banner).toHaveAttribute("data-status", "done", { timeout: 110_000 });

  const cqCwd = process.env["CQ_E2E_CWD"];
  expect(cqCwd, "CQ_E2E_CWD must be set by globalSetup").toBeTruthy();

  const goalsMd = await fs.readFile(path.join(cqCwd!, "docs", "goals.md"), "utf8");
  expect(goalsMd).toContain("planned");
  expect(goalsMd).toContain("local-first notes app");

  const milestonesMd = await fs.readFile(path.join(cqCwd!, "docs", "milestones.md"), "utf8");
  expect(milestonesMd).toContain("Core build");

  const tasksMd = await fs.readFile(path.join(cqCwd!, "docs", "tasks.md"), "utf8");
  expect(tasksMd).toContain("Editor");

  const questionsMd = await fs.readFile(path.join(cqCwd!, "docs", "questions.md"), "utf8");
  expect(questionsMd).toContain("answered");

  // Fully drain the workflow lane so this workflow-heavy spec (4 sequential
  // headless subprocesses: producer + clarify + planner + reviewer) leaves NO
  // lingering child processes before the next serial spec runs (WFL-D02). The
  // busy flag (workflow-idle) clears at submit-time, BEFORE query().close()
  // finishes reaping the subprocess — so it is NOT a reliable "drained" signal.
  // /__e2e/workflow-drain blocks until every workflow subprocess has actually
  // exited, eliminating the cross-spec CPU contention that intermittently
  // tipped the timing-sensitive stop.spec.ts.
  const drainRes = await fetch(`${cqUrl}/__e2e/workflow-drain`, { method: "POST" });
  expect(drainRes.ok, "workflow-drain hook must report success").toBeTruthy();
  await cq.waitForIdle(15_000).catch(() => undefined);
});
