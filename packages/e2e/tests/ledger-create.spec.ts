/**
 * ledger-create.spec.ts — L9: agent calls mcp__cq__create_ledger end-to-end.
 *
 * Scenario:
 *   1. Open the cq page; wait for ALIVE + idle.
 *   2. Script the mock to first return a tool_use for
 *      mcp__cq__create_ledger{name:"todos", schema:{...}}, then on the
 *      follow-up (tool_result) return a confirmation text "Ledger created.".
 *   3. Send a user prompt asking the model to create the ledger.
 *   4. Wait for "Ledger created." to appear in the stream.
 *   5. Assert that the cq server's --cwd contains ./docs/todos.md with the
 *      expected frontmatter, and ./docs/ledgers.yaml lists the ledger.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test, expect } from "../fixtures/base.ts";
import type { SSEEvent } from "../fixtures/adminMock.ts";

const CREATE_LEDGER_TOOL_USE_ID = "toolu_create_ledger_e2e";

function createLedgerSseEvents(): SSEEvent[] {
  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_create_ledger",
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
          id: CREATE_LEDGER_TOOL_USE_ID,
          name: "mcp__cq__create_ledger",
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
            name: "todos",
            schema: {
              statusValues: ["open", "done"],
              terminalStatuses: ["done"],
              fields: {
                note: { type: "string", required: false },
              },
            },
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

function confirmSseEvents(): SSEEvent[] {
  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_ledger_done",
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
        delta: { type: "text_delta", text: "Ledger created." },
      },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 3 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

test("ledger create: agent calls create_ledger and the file appears on disk", async ({ cq, mock }) => {
  await cq.open();
  await expect(cq.textarea).toBeEnabled({ timeout: 10_000 });

  // Sticky response for any initial preflight / main prompt: emit the
  // create_ledger tool_use. After the tool returns (request body carries
  // tool_result), the mock emits the confirmation text.
  await mock.script(createLedgerSseEvents());
  await mock.scriptOnToolResult(confirmSseEvents());

  await cq.sendMessage("Create a ledger called 'todos' with statuses open/done.");
  await cq.waitForTextInStream("Ledger created.", 25_000);

  // Inspect the cq server's --cwd: docs/todos.md and docs/ledgers.yaml must
  // both reflect the newly-created ledger.
  const cqCwd = process.env["CQ_E2E_CWD"];
  expect(cqCwd, "CQ_E2E_CWD must be set by globalSetup").toBeTruthy();
  const todosMd = path.join(cqCwd!, "docs", "todos.md");
  const registryYaml = path.join(cqCwd!, "docs", "ledgers.yaml");

  const todosText = await fs.readFile(todosMd, "utf8");
  expect(todosText).toContain("ledger: todos");
  expect(todosText).toContain("counters:");
  expect(todosText).toContain("# todos");

  const registryText = await fs.readFile(registryYaml, "utf8");
  expect(registryText).toContain("name: todos");
  expect(registryText).toContain("- open");
  expect(registryText).toContain("- done");
});
