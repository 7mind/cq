/**
 * titleGenerator.test.ts — unit tests for the pure helpers and the
 * AnthropicTitleGenerator class with an injected fake client.
 *
 * Cases:
 *  1. buildTitleUserPrompt — includes both halves and trailing instruction.
 *  2. buildTitleUserPrompt — truncates long inputs to 2000 chars each.
 *  3. sanitizeTitle — strips matching surrounding quotes.
 *  4. sanitizeTitle — strips trailing period.
 *  5. sanitizeTitle — clamps to 120 chars.
 *  6. AnthropicTitleGenerator — calls messages.create with the expected
 *     model id, token cap, system prompt, and user content; returns the
 *     extracted text block.
 *  7. AnthropicTitleGenerator — returns "" when the response has no text
 *     block.
 */

import { describe, it, expect } from "bun:test";
import {
  buildTitleUserPrompt,
  sanitizeTitle,
  AnthropicTitleGenerator,
  TITLE_MODEL,
  TITLE_MAX_TOKENS,
  TITLE_SYSTEM_PROMPT,
} from "../src/agent/titleGenerator";

describe("buildTitleUserPrompt", () => {
  it("contains both halves and the trailing instruction", () => {
    const out = buildTitleUserPrompt({
      firstUserMessage: "Hello there",
      firstAssistantText: "General Kenobi",
    });
    expect(out).toContain("Hello there");
    expect(out).toContain("General Kenobi");
    expect(out).toContain("Title (4-8 words");
  });

  it("truncates each half to 2000 chars", () => {
    const longUser = "u".repeat(5000);
    const longAssistant = "a".repeat(5000);
    const out = buildTitleUserPrompt({
      firstUserMessage: longUser,
      firstAssistantText: longAssistant,
    });
    expect(out.includes("u".repeat(2000))).toBe(true);
    expect(out.includes("u".repeat(2001))).toBe(false);
    expect(out.includes("a".repeat(2000))).toBe(true);
    expect(out.includes("a".repeat(2001))).toBe(false);
  });
});

describe("sanitizeTitle", () => {
  it("strips matching surrounding double quotes", () => {
    expect(sanitizeTitle('"Fix race in scheduler"')).toBe("Fix race in scheduler");
  });
  it("strips matching surrounding single quotes", () => {
    expect(sanitizeTitle("'Fix race in scheduler'")).toBe("Fix race in scheduler");
  });
  it("does not strip mismatched quotes", () => {
    expect(sanitizeTitle("'Fix race in scheduler\"")).toBe('\'Fix race in scheduler"');
  });
  it("strips a trailing period", () => {
    expect(sanitizeTitle("Fix race in scheduler.")).toBe("Fix race in scheduler");
  });
  it("clamps to 120 characters", () => {
    const t = sanitizeTitle("x".repeat(500));
    expect(t.length).toBeLessThanOrEqual(120);
  });
});

describe("AnthropicTitleGenerator", () => {
  it("invokes messages.create with the expected shape and returns the text block", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeClient = {
      messages: {
        create: async (params: Record<string, unknown>): Promise<unknown> => {
          calls.push(params);
          return {
            content: [{ type: "text", text: '"Refactor session bridge"' }],
          };
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gen = new AnthropicTitleGenerator(fakeClient as any);
    const title = await gen.generate({
      firstUserMessage: "Help me refactor the bridge.",
      firstAssistantText: "Sure, let's split the runLoop.",
    });

    expect(title).toBe("Refactor session bridge");
    expect(calls).toHaveLength(1);
    const params = calls[0]!;
    expect(params.model).toBe(TITLE_MODEL);
    expect(params.max_tokens).toBe(TITLE_MAX_TOKENS);
    expect(params.system).toBe(TITLE_SYSTEM_PROMPT);
    const messages = params.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toContain("Help me refactor the bridge.");
    expect(messages[0]!.content).toContain("Sure, let's split the runLoop.");
  });

  it("returns empty string when the response has no text block", async () => {
    const fakeClient = {
      messages: {
        create: async (): Promise<unknown> => ({
          content: [{ type: "tool_use", id: "t1", name: "noop", input: {} }],
        }),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gen = new AnthropicTitleGenerator(fakeClient as any);
    const title = await gen.generate({
      firstUserMessage: "x",
      firstAssistantText: "y",
    });
    expect(title).toBe("");
  });
});
