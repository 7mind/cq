/**
 * ask-question.test.ts — PR-31: AskCard component.
 *
 * Required cases:
 *  1. 3-choice radio question → user picks choice 2 → fires chat.question_reply payload
 *     with { toolUseId, answers: { "0": ["Option B"] } }.
 *  2. Multi-select → user picks 2 of 3 options → payload answers contains both labels.
 */

// Must be first — registers DOM globals.
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { act } from "react";

import { AskCard } from "../src/chat/Cards/AskCard";
import type { AskUserQuestionInput, QuestionReplyPayload } from "../src/chat/Cards/AskCard";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeRadioQuestion(): AskUserQuestionInput {
  return {
    questions: [
      {
        question: "Which library should we use for date formatting?",
        header: "Library",
        multiSelect: false,
        options: [
          { label: "Option A", description: "First choice" },
          { label: "Option B", description: "Second choice" },
          { label: "Option C", description: "Third choice" },
        ],
      },
    ],
  };
}

function makeMultiSelectQuestion(): AskUserQuestionInput {
  return {
    questions: [
      {
        question: "Which features do you want to enable?",
        header: "Features",
        multiSelect: true,
        options: [
          { label: "Feature A", description: "First feature" },
          { label: "Feature B", description: "Second feature" },
          { label: "Feature C", description: "Third feature" },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("AskCard", () => {
  let container: HTMLElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    if (root !== null) {
      act(() => { root!.unmount(); });
      root = null;
    }
    if (container !== null && container.parentNode !== null) {
      container.parentNode.removeChild(container);
      container = null;
    }
  });

  test("3-choice radio question: pick choice 2 → fires payload with answers.0 = ['Option B']", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const replies: QuestionReplyPayload[] = [];
    const TOOL_USE_ID = "tu-radio-001";

    act(() => {
      root!.render(
        createElement(AskCard, {
          toolUseId: TOOL_USE_ID,
          input: makeRadioQuestion(),
          onReply: (p) => { replies.push(p); },
        }),
      );
    });

    const card = container!.querySelector("[data-testid='ask-card']");
    expect(card).not.toBeNull();

    // Submit should be disabled (nothing selected yet).
    const submitBtn = container!.querySelector("[data-testid='ask-submit']") as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    // Pick second radio option (index 1 = "Option B").
    const optionB = container!.querySelector("[data-testid='ask-input-0-1']") as HTMLInputElement;
    expect(optionB).not.toBeNull();
    expect(optionB.type).toBe("radio");

    act(() => {
      optionB.click();
    });

    // Submit should now be enabled.
    expect(submitBtn.disabled).toBe(false);

    act(() => { submitBtn.click(); });

    expect(replies).toHaveLength(1);
    const payload = replies[0]!;
    expect(payload.toolUseId).toBe(TOOL_USE_ID);
    const answers = payload.answers as Record<string, unknown>;
    expect(answers["0"]).toEqual(["Option B"]);
  });

  test("multi-select question: pick Feature A and Feature C → payload answers contains both", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const replies: QuestionReplyPayload[] = [];
    const TOOL_USE_ID = "tu-multi-001";

    act(() => {
      root!.render(
        createElement(AskCard, {
          toolUseId: TOOL_USE_ID,
          input: makeMultiSelectQuestion(),
          onReply: (p) => { replies.push(p); },
        }),
      );
    });

    // Checkboxes for features A (index 0) and C (index 2).
    const checkboxA = container!.querySelector("[data-testid='ask-input-0-0']") as HTMLInputElement;
    const checkboxC = container!.querySelector("[data-testid='ask-input-0-2']") as HTMLInputElement;
    expect(checkboxA.type).toBe("checkbox");
    expect(checkboxC.type).toBe("checkbox");

    act(() => {
      checkboxA.click();
    });

    act(() => {
      checkboxC.click();
    });

    const submitBtn = container!.querySelector("[data-testid='ask-submit']") as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
    act(() => { submitBtn.click(); });

    expect(replies).toHaveLength(1);
    const payload = replies[0]!;
    expect(payload.toolUseId).toBe(TOOL_USE_ID);
    const answers = payload.answers as Record<string, string[]>;
    expect(answers["0"]).toContain("Feature A");
    expect(answers["0"]).toContain("Feature C");
    expect(answers["0"]).not.toContain("Feature B");
  });
});
