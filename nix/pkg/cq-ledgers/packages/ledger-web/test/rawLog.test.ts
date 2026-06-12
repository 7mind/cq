/**
 * T412 — JSONL transcript parser / conversation-model unit tests.
 *
 * Verifies parseRawLog over a sample subagent .jsonl (the real Claude Code
 * transcript shape: per-line JSON events with message.content[] carrying
 * text / tool_use / tool_result blocks):
 *   - yields the expected ordered turns;
 *   - pairs tool_use → tool_result by id;
 *   - represents an unparseable line as a raw-marker entry rather than throwing;
 *   - surfaces a 'truncated at 4 MiB' notice when the truncated flag is set.
 */

import { describe, it, expect } from "bun:test";
import {
  parseRawLog,
  type UserTurn,
  type ToolUseTurn,
  type ToolResultTurn,
  type AssistantTurn,
} from "../src/rawLog";

// A representative subagent transcript: an attachment (no message content),
// a string-content user prompt, then assistant text + tool_use, then a
// user tool_result, then a closing assistant text.
const SAMPLE_LINES = [
  { type: "attachment", attachment: { kind: "x" } },
  { type: "user", message: { role: "user", content: "do the thing" } },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "I'll read the file." },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "/a/b.ts" } },
      ],
    },
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "line1\nline2" },
      ],
    },
  },
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
  },
];

const SAMPLE_JSONL = SAMPLE_LINES.map((o) => JSON.stringify(o)).join("\n") + "\n";

describe("parseRawLog", () => {
  it("yields the expected ordered turns with tool_use/tool_result paired", () => {
    const model = parseRawLog(SAMPLE_JSONL);
    expect(model.truncatedNotice).toBeNull();

    const kinds = model.turns.map((t) => t.kind);
    expect(kinds).toEqual(["user", "assistant", "tool_use", "tool_result", "assistant"]);

    const userTurn = model.turns[0] as UserTurn;
    expect(userTurn.text).toBe("do the thing");

    const assistantTurn = model.turns[1] as AssistantTurn;
    expect(assistantTurn.text).toBe("I'll read the file.");

    const toolUse = model.turns[2] as ToolUseTurn;
    expect(toolUse.toolName).toBe("Read");
    expect(toolUse.toolUseId).toBe("toolu_1");
    // Input is pretty-printed JSON.
    expect(toolUse.inputPretty).toBe(JSON.stringify({ path: "/a/b.ts" }, null, 2));
    expect(toolUse.inputPretty).toContain("\n");

    const toolResult = model.turns[3] as ToolResultTurn;
    expect(toolResult.toolUseId).toBe("toolu_1");
    expect(toolResult.pairedToolName).toBe("Read");
    expect(toolResult.resultPretty).toBe("line1\nline2");
    expect(toolResult.isError).toBe(false);

    const closing = model.turns[4] as AssistantTurn;
    expect(closing.text).toBe("Done.");
  });

  it("pretty-prints array-form tool_result content (text blocks concatenated)", () => {
    const jsonl =
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_x",
              content: [{ type: "text", text: "out" }],
              is_error: true,
            },
          ],
        },
      }) + "\n";
    const model = parseRawLog(jsonl);
    const tr = model.turns[0] as ToolResultTurn;
    expect(tr.kind).toBe("tool_result");
    expect(tr.resultPretty).toBe("out");
    expect(tr.isError).toBe(true);
    // No earlier tool_use → no pairing.
    expect(tr.pairedToolName).toBeNull();
  });

  it("represents an unparseable line as a raw-marker entry rather than throwing", () => {
    const jsonl = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      "{ this is not valid json",
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
    ].join("\n");

    let model: ReturnType<typeof parseRawLog> | undefined;
    expect(() => {
      model = parseRawLog(jsonl);
    }).not.toThrow();

    const turns = model!.turns;
    expect(turns.map((t) => t.kind)).toEqual(["user", "raw", "assistant"]);
    const rawTurn = turns[1]!;
    expect(rawTurn.kind).toBe("raw");
    if (rawTurn.kind === "raw") {
      expect(rawTurn.raw).toBe("{ this is not valid json");
      expect(rawTurn.reason).toBe("unparseable");
    }
  });

  it("skips blank lines and trailing newline", () => {
    const jsonl =
      "\n" +
      JSON.stringify({ type: "user", message: { role: "user", content: "x" } }) +
      "\n\n";
    const model = parseRawLog(jsonl);
    expect(model.turns).toHaveLength(1);
    expect(model.turns[0]!.kind).toBe("user");
  });

  it("surfaces a 'truncated at 4 MiB' notice when the truncated flag is set", () => {
    const model = parseRawLog(SAMPLE_JSONL, true);
    expect(model.truncatedNotice).toBe("truncated at 4 MiB");
  });

  it("returns an empty model for empty input without throwing", () => {
    const model = parseRawLog("");
    expect(model.turns).toEqual([]);
    expect(model.truncatedNotice).toBeNull();
  });

  it("surfaces a non-object JSON line (e.g. a bare array) as a raw entry", () => {
    const jsonl = "[1,2,3]";
    const model = parseRawLog(jsonl);
    expect(model.turns).toHaveLength(1);
    const turn = model.turns[0]!;
    expect(turn.kind).toBe("raw");
    if (turn.kind === "raw") {
      expect(turn.reason).toBe("unclassified");
    }
  });
});
