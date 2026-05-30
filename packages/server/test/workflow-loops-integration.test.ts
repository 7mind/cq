/**
 * wfl-4 — full-loop integration through the REAL Claude SDK subprocess
 * (MockAnthropicHTTP). Drives one complete clarify→plan→review→planned cycle:
 *
 *   1. producer (submit_plan)            → goal + 1 question, status clarifying
 *   2. answer the question (programmatic question.answer via runtime.submitAnswer)
 *   3. clarify-reviewer (submit_clarify_review, clear) → planner runs
 *   4. planner (submit_plan_doc)         → milestones + tasks, status planning
 *   5. plan-reviewer (submit_plan_review, satisfied) → status planned + done
 *
 * Each phase is a SEPARATE headless query (own subprocess); the mock responder
 * keys on the submit-tool name embedded in each phase's prompt so the right
 * structured payload is returned regardless of request interleaving.
 */

import { describe, it, expect } from "bun:test";
import * as fsNode from "node:fs/promises";
import * as osNode from "node:os";
import * as pathNode from "node:path";

import { FsLedgerStore, GOALS_LEDGER, QUESTIONS_LEDGER, TASKS_LEDGER } from "@cq/ledger";
import { ClaudeProducer } from "../src/workflow/claudeProducer";
import { ClaudePhaseSubagent } from "../src/workflow/claudePhaseSubagent";
import { WorkflowRuntime } from "../src/workflow/index";
import type { WorkflowEvent } from "@cq/shared";
import { noopLogger } from "./helpers/mockBridge";
import { startMockAnthropic, type SSEEvent } from "./helpers/MockAnthropicHTTP";

/** Build a tool_use SSE that calls `toolName` with `input`, then ends the turn. */
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
          model: "claude-test",
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
      data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 8 } },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

/** A benign end_turn SSE (used after a tool_result re-enters the conversation). */
function doneSse(): SSEEvent[] {
  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_done",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-test",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 0 },
        },
      },
    },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

describe("workflow full loop — REAL SDK via MockAnthropicHTTP", () => {
  it(
    "drives clarify→plan→review→planned end-to-end",
    async () => {
      const tmpHome = await fsNode.mkdtemp(pathNode.join(osNode.tmpdir(), "cq-wfl-home-"));
      await fsNode.mkdir(pathNode.join(tmpHome, ".claude"), { recursive: true });
      const tmpCwd = await fsNode.mkdtemp(pathNode.join(osNode.tmpdir(), "cq-wfl-cwd-"));

      const store = new FsLedgerStore({ root: tmpCwd });
      await store.init();

      const mock = await startMockAnthropic({
        scriptedResponder: async (body: string) => {
          // A tool_result re-entry ends the phase turn benignly.
          if (body.includes("tool_result")) return doneSse();
          // Key on the submit-tool name embedded in each phase's prompt. Order
          // checked most-specific first; the producer prompt is the only one
          // mentioning submit_plan but NOT submit_plan_doc / submit_plan_review.
          if (body.includes("submit_clarify_review")) {
            return toolUseSse("mcp__wf__submit_clarify_review", { payload: { clear: true, contradictions: [], newQuestions: [] } }, "cr");
          }
          if (body.includes("submit_plan_doc")) {
            return toolUseSse(
              "mcp__wf__submit_plan_doc",
              {
                payload: {
                  milestones: [{ title: "Core", description: "the core build" }],
                  tasks: [{ milestoneRef: 0, headline: "Editor", description: "editor", acceptance: "renders" }],
                },
              },
              "pd",
            );
          }
          if (body.includes("submit_plan_review")) {
            return toolUseSse("mcp__wf__submit_plan_review", { payload: { satisfied: true, findings: [], newQuestions: [] } }, "pr");
          }
          if (body.includes("submit_plan")) {
            return toolUseSse(
              "mcp__wf__submit_plan",
              { goal: { title: "Notes app", description: "A notes app." }, questions: [{ question: "Which platforms?", recommendation: "web" }] },
              "pp",
            );
          }
          return doneSse();
        },
      });

      process.env["ANTHROPIC_BASE_URL"] = mock.url;
      process.env["ANTHROPIC_API_KEY"] = "sk-test-fake";
      process.env["HOME"] = tmpHome;

      const rt = new WorkflowRuntime({
        logger: noopLogger,
        store,
        selectProducer: () => new ClaudeProducer({ logger: noopLogger, cwd: tmpCwd, timeoutMs: 40_000 }),
        selectPhaseSubagent: () => new ClaudePhaseSubagent({ logger: noopLogger, cwd: tmpCwd, timeoutMs: 40_000 }),
      });
      const events: Array<Omit<WorkflowEvent, "seq" | "ts">> = [];
      rt.subscribe((e) => events.push(e));

      try {
        const res = await rt.startPlan({ text: "build a notes app", platform: "claude" }, (e) => events.push(e));
        expect(res.outcome).toBe("questions_ready");
        if (res.outcome !== "questions_ready") throw new Error("unreachable");
        const goalId = res.goalId;

        const specId = (store.fetchItem(GOALS_LEDGER, goalId).fields["milestones"] as string[])[0]!;
        const q0 = (store.listMilestoneItems(specId)[QUESTIONS_LEDGER] ?? [])[0]!.id;

        // Answer programmatically → drives the rest of the loop through the SDK.
        await rt.submitAnswer(q0, "web");

        // Wait for the loop to reach planned (each phase spawns a subprocess).
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          if (store.fetchItem(GOALS_LEDGER, goalId).status === "planned") break;
          await Bun.sleep(100);
        }

        const goal = store.fetchItem(GOALS_LEDGER, goalId);
        expect(goal.status).toBe("planned");
        const ms = goal.fields["milestones"] as string[];
        expect(ms.length).toBe(2); // spec + planner milestone
        const tasks = store.listMilestoneItems(ms[1]!)[TASKS_LEDGER] ?? [];
        expect(tasks).toHaveLength(1);
        expect(tasks[0]!.fields["headline"]).toBe("Editor");
        expect(events.map((e) => e.status)).toContain("done");
      } finally {
        await mock.stop();
        await store.dispose();
        await fsNode.rm(tmpHome, { recursive: true, force: true }).catch(() => undefined);
        await fsNode.rm(tmpCwd, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    120_000,
  );
});
