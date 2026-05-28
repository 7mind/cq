/**
 * titleGenerator.ts — produce a short (4-8 word) human-readable title for a
 * cq session from the user's first prompt and the assistant's first reply.
 *
 * Used by Bridge after the first `result` message of a fresh main session is
 * persisted. Runs out-of-band (async, fire-and-forget); failures are logged
 * and never block the chat. Idempotent: the bridge skips the call when the
 * session already has a non-empty title.
 *
 * Real implementation: AnthropicTitleGenerator wraps `@anthropic-ai/sdk`'s
 * Messages.create with model `claude-haiku-4-5`. The interface accepts an
 * arbitrary `TitleGenerator` so tests can inject a fake (no real network).
 */

import Anthropic from "@anthropic-ai/sdk";

/** Model alias used for title generation. Per Q16. */
export const TITLE_MODEL = "claude-haiku-4-5";

/** Max output tokens. A 4-8 word title fits in well under 50 tokens. */
export const TITLE_MAX_TOKENS = 50;

/** System prompt instructing the model to emit a bare 4-8 word title. */
export const TITLE_SYSTEM_PROMPT =
  "You produce concise session titles for an AI coding assistant chat log. " +
  "Given the user's first message and the assistant's first reply, output a " +
  "single short title of 4 to 8 words that captures the topic. " +
  "Output the title text only — no quotes, no trailing punctuation, no prefix " +
  "like 'Title:'. Use sentence case.";

/** Input to a title generation request. */
export interface TitleInput {
  readonly firstUserMessage: string;
  readonly firstAssistantText: string;
}

/** Pluggable title generator. Real impl: AnthropicTitleGenerator. */
export interface TitleGenerator {
  generate(input: TitleInput): Promise<string>;
}

/**
 * Build the user prompt sent to Haiku. Kept as a pure helper so tests can
 * assert its exact shape.
 */
export function buildTitleUserPrompt(input: TitleInput): string {
  // Truncate both halves to a sane size so a very long first prompt or reply
  // does not blow the context window. Title only needs the gist.
  const u = input.firstUserMessage.slice(0, 2000).trim();
  const a = input.firstAssistantText.slice(0, 2000).trim();
  return (
    `User's first message:\n${u}\n\n` +
    `Assistant's first reply:\n${a}\n\n` +
    `Title (4-8 words, no quotes, no trailing punctuation):`
  );
}

/**
 * Sanitize whatever the model returns into a plain title string.
 * Strips surrounding quotes/whitespace and clamps length defensively.
 */
export function sanitizeTitle(raw: string): string {
  let t = raw.trim();
  // Drop surrounding matching quotes (single or double).
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    t = t.slice(1, -1).trim();
  }
  // Drop trailing period if any.
  if (t.endsWith(".")) t = t.slice(0, -1).trim();
  // Hard cap at 120 chars — defensive against runaway output.
  if (t.length > 120) t = t.slice(0, 120).trim();
  return t;
}

/**
 * Production implementation backed by `@anthropic-ai/sdk`.
 *
 * The Anthropic client picks up `ANTHROPIC_API_KEY` from the environment by
 * default; we do not pass it explicitly. Construction is **lazy**: the client
 * is built on first `generate` call rather than in the constructor, so a
 * Bridge that never triggers title generation (most tests) does not require
 * the env var to be set.
 */
export class AnthropicTitleGenerator implements TitleGenerator {
  private client: Anthropic | null;

  constructor(client: Anthropic | null = null) {
    this.client = client;
  }

  private getClient(): Anthropic {
    if (this.client === null) {
      this.client = new Anthropic();
    }
    return this.client;
  }

  async generate(input: TitleInput): Promise<string> {
    const userPrompt = buildTitleUserPrompt(input);
    const response = await this.getClient().messages.create({
      model: TITLE_MODEL,
      max_tokens: TITLE_MAX_TOKENS,
      system: TITLE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    // Extract the first text block from the response.
    for (const block of response.content) {
      if (block.type === "text") {
        return sanitizeTitle(block.text);
      }
    }
    // No text content at all — return empty so caller treats as failure.
    return "";
  }
}
