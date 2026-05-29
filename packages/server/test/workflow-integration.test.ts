/**
 * Workflow integration test (REAL Claude SDK subprocess via MockAnthropicHTTP).
 *
 * Proves the full phase-1 wiring through the real SDK: the ClaudeProducer
 * dispatches a headless query exposing the harness-owned `submit_plan` tool;
 * the mocked Anthropic API drives the model to call it with a structured
 * `{goal,questions}` payload; the in-process handler validates + resolves; the
 * WorkflowRuntime (HARNESS) writes the ledgers and emits questions_ready.
 *
 * Mirrors ledger-integration.test.ts / ask-question.test.ts.
 */

import { describe, it, expect } from "bun:test";
import * as fsNode from "node:fs/promises";
import * as osNode from "node:os";
import * as pathNode from "node:path";

import { FsLedgerStore, GOALS_LEDGER, QUESTIONS_LEDGER, MILESTONES_LEDGER } from "@cq/ledger";
import { ClaudeProducer } from "../src/workflow/claudeProducer";
import { WorkflowRuntime, SPEC_MILESTONE_TITLE } from "../src/workflow/index";
import { FakePhaseSubagent } from "./helpers/fakePhaseSubagent";
import type { WorkflowEvent } from "@cq/shared";
import { noopLogger } from "./helpers/mockBridge";
import { startMockAnthropic, type SSEEvent } from "./helpers/MockAnthropicHTTP";

const SUBMIT_TOOL_USE_ID = "toolu_wf_submit_001";

// The structured payload the model "submits" via the submit_plan tool.
const SUBMIT_INPUT = {
  goal: { description: "A local-first encrypted notetaking webapp." },
  questions: [
    { question: "Which platforms?", context: "scope", suggestions: ["web", "desktop"], recommendation: "web" },
    { question: "What encryption scheme?", recommendation: "age" },
  ],
};

// SSE that drives the model to call mcp__wf__submit_plan with SUBMIT_INPUT.
const SUBMIT_SSE_EVENTS: SSEEvent[] = [
  {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: "msg_wf_1",
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
    data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 8 } },
  },
  { event: "message_stop", data: { type: "message_stop" } },
];

// SSE the SDK receives after the tool_result re-enters the conversation.
const DONE_SSE_EVENTS: SSEEvent[] = [
  {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: "msg_wf_2",
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
    data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
  },
  { event: "message_stop", data: { type: "message_stop" } },
];

describe("workflow phase 1 — REAL SDK subprocess via MockAnthropicHTTP", () => {
  it(
    "/plan dispatches the producer, the model calls submit_plan, the harness writes ledgers + questions_ready",
    async () => {
      const tmpHome = await fsNode.mkdtemp(pathNode.join(osNode.tmpdir(), "cq-wf-home-"));
      await fsNode.mkdir(pathNode.join(tmpHome, ".claude"), { recursive: true });
      const tmpCwd = await fsNode.mkdtemp(pathNode.join(osNode.tmpdir(), "cq-wf-cwd-"));

      const store = new FsLedgerStore({ root: tmpCwd });
      await store.init();

      let submitSent = false;
      const mock = await startMockAnthropic({
        scriptedResponder: async (body: string) => {
          if (body.includes("tool_result")) return DONE_SSE_EVENTS;
          // The first substantive prompt (the producer instruction) is large;
          // small priming/quota requests are answered with a benign done so
          // they do not consume the submit turn. Mirrors ledger-integration.
          if (!submitSent && body.length >= 5000) {
            submitSent = true;
            return SUBMIT_SSE_EVENTS;
          }
          return DONE_SSE_EVENTS;
        },
      });

      process.env["ANTHROPIC_BASE_URL"] = mock.url;
      process.env["ANTHROPIC_API_KEY"] = "sk-test-fake";
      process.env["HOME"] = tmpHome;

      const producer = new ClaudeProducer({ logger: noopLogger, cwd: tmpCwd, timeoutMs: 40_000 });
      const rt = new WorkflowRuntime({
        logger: noopLogger,
        store,
        selectProducer: () => producer,
        selectPhaseSubagent: () => new FakePhaseSubagent(),
      });
      const events: Array<Omit<WorkflowEvent, "seq" | "ts">> = [];

      try {
        const result = await rt.startPlan(
          { text: "build a local-first encrypted notetaking webapp", platform: "claude" },
          (e) => events.push(e),
        );

        expect(result.outcome).toBe("questions_ready");
        if (result.outcome !== "questions_ready") throw new Error("unreachable");
        expect(events.map((e) => e.status)).toEqual(["started", "producing", "questions_ready"]);

        // Spec milestone seeded.
        const specItem = store
          .fetch(MILESTONES_LEDGER)
          .milestones.flatMap((g) => g.items)
          .find((i) => i.fields["title"] === SPEC_MILESTONE_TITLE);
        expect(specItem).toBeDefined();
        const specId = specItem!.id;

        // Goal written (clarifying) and linked to the spec milestone.
        const goal = store.fetchItem(GOALS_LEDGER, result.goalId);
        expect(goal.status).toBe("clarifying");
        expect(goal.fields["description"]).toBe(SUBMIT_INPUT.goal.description);
        expect(goal.fields["milestones"]).toEqual([specId]);

        // Two questions under the spec milestone.
        const qs = store.listMilestoneItems(specId)[QUESTIONS_LEDGER] ?? [];
        expect(qs).toHaveLength(2);
        expect(qs.map((q) => q.fields["question"])).toEqual([
          "Which platforms?",
          "What encryption scheme?",
        ]);
      } finally {
        await mock.stop();
        await store.dispose();
        await fsNode.rm(tmpHome, { recursive: true, force: true }).catch(() => undefined);
        await fsNode.rm(tmpCwd, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    60_000,
  );
});
