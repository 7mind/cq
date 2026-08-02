import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getFinalOutput, parseChildJsonEvent } from "./cq-subagent-dispatch.ts";

describe("Pi subagent JSON output [BA]", () => {
  test("preserves message_end assistant text as the final output", () => {
    const message = parseChildJsonEvent(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
          provider: "openai-codex",
          model: "gpt-5.6-sol",
        },
      }),
    );

    expect(message).not.toBeNull();
    expect(getFinalOutput(message === null ? [] : [message])).toBe("first\nsecond");
  });

  test("accepts tool_result_end and ignores malformed or unrelated records", () => {
    expect(
      parseChildJsonEvent(
        JSON.stringify({ type: "tool_result_end", message: { role: "toolResult" } }),
      ),
    ).toEqual({ role: "toolResult" });
    expect(parseChildJsonEvent("not-json")).toBeNull();
    expect(parseChildJsonEvent(JSON.stringify({ type: "turn_start" }))).toBeNull();
  });

  test("delegates cancellation to process-control without ChildProcess.killed or timers", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./cq-subagent-dispatch.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("await launchPiChild(");
    expect(source).not.toContain("proc.killed");
    expect(source).not.toContain("proc.kill(");
    expect(source).not.toContain("setTimeout(");
  });
});
