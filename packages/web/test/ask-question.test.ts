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

  // -------------------------------------------------------------------------
  // "Other…" free-form affordance
  // -------------------------------------------------------------------------

  function mount(input: AskUserQuestionInput): {
    replies: QuestionReplyPayload[];
    toolUseId: string;
  } {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const replies: QuestionReplyPayload[] = [];
    const toolUseId = "tu-other-001";
    act(() => {
      root!.render(
        createElement(AskCard, {
          toolUseId,
          input,
          onReply: (p) => { replies.push(p); },
        }),
      );
    });
    return { replies, toolUseId };
  }

  function q(testid: string): HTMLInputElement {
    return container!.querySelector(`[data-testid='${testid}']`) as HTMLInputElement;
  }

  function setText(el: HTMLInputElement, value: string): void {
    // happy-dom + React 19 do not deliver a synthetically-dispatched `input`
    // event to React's ChangeEventPlugin for text inputs (the internal value
    // tracker is not satisfied by `dispatchEvent`). `<select>`/checkbox change
    // works, text input does not. Invoke the controlled input's React onChange
    // handler directly off the fiber props with a minimal synthetic event —
    // deterministic and independent of the event-tracker quirk.
    const propsKey = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
    if (propsKey === undefined) throw new Error("no React props on input element");
    const props = (el as unknown as Record<string, { onChange?: (e: unknown) => void }>)[propsKey];
    if (typeof props.onChange !== "function") throw new Error("input has no onChange prop");
    act(() => {
      el.value = value;
      props.onChange!({ target: el, currentTarget: el });
    });
  }

  test("radio: select Other, type text, submit → answers.0 = [text]", () => {
    const { replies } = mount(makeRadioQuestion());

    const submitBtn = q("ask-submit") as unknown as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    const otherRadio = q("ask-other-input-0");
    expect(otherRadio.type).toBe("radio");
    act(() => { otherRadio.click(); });

    // Other active but empty → still disabled.
    expect(submitBtn.disabled).toBe(true);

    const text = q("ask-other-text-0");
    expect(text).not.toBeNull();
    setText(text, "my custom answer");

    expect(submitBtn.disabled).toBe(false);
    act(() => { submitBtn.click(); });

    expect(replies).toHaveLength(1);
    const answers = replies[0]!.answers as Record<string, unknown>;
    expect(answers["0"]).toEqual(["my custom answer"]);
  });

  test("checkbox: check a real option + Other + type → payload contains both", () => {
    const { replies } = mount(makeMultiSelectQuestion());

    const featureA = q("ask-input-0-0");
    act(() => { featureA.click(); });

    const otherBox = q("ask-other-input-0");
    expect(otherBox.type).toBe("checkbox");
    act(() => { otherBox.click(); });

    setText(q("ask-other-text-0"), "Markdown editor");

    const submitBtn = q("ask-submit") as unknown as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
    act(() => { submitBtn.click(); });

    expect(replies).toHaveLength(1);
    const answers = replies[0]!.answers as Record<string, string[]>;
    expect(answers["0"]).toEqual(["Feature A", "Markdown editor"]);
  });

  test("empty-text guard (checkbox): real option checked + Other checked-but-empty → Submit disabled", () => {
    mount(makeMultiSelectQuestion());

    const featureA = q("ask-input-0-0");
    act(() => { featureA.click(); });

    const submitBtn = q("ask-submit") as unknown as HTMLButtonElement;
    // A real box is checked → would normally be complete…
    expect(submitBtn.disabled).toBe(false);

    const otherBox = q("ask-other-input-0");
    act(() => { otherBox.click(); });
    // …but an active-but-empty Other makes the question unanswered.
    expect(submitBtn.disabled).toBe(true);
  });

  test("keep-on-switch (radio): type in Other, pick a real option, re-select Other → text restored", () => {
    const { replies } = mount(makeRadioQuestion());

    const otherRadio = q("ask-other-input-0");
    act(() => { otherRadio.click(); });
    setText(q("ask-other-text-0"), "remembered text");

    // Switch to a real radio option — text field disappears but state retained.
    const optionA = q("ask-input-0-0");
    act(() => { optionA.click(); });
    expect(q("ask-other-text-0")).toBeNull();

    // Re-select Other — the field reappears with the prior text.
    act(() => { otherRadio.click(); });
    const text = q("ask-other-text-0");
    expect(text.value).toBe("remembered text");

    const submitBtn = q("ask-submit") as unknown as HTMLButtonElement;
    act(() => { submitBtn.click(); });
    const answers = replies[0]!.answers as Record<string, unknown>;
    expect(answers["0"]).toEqual(["remembered text"]);
  });

  test("whitespace-only Other text is treated as empty → Submit disabled", () => {
    mount(makeRadioQuestion());
    const otherRadio = q("ask-other-input-0");
    act(() => { otherRadio.click(); });
    setText(q("ask-other-text-0"), "   \t  ");

    const submitBtn = q("ask-submit") as unknown as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
  });

  test("trims custom text before sending", () => {
    const { replies } = mount(makeRadioQuestion());
    const otherRadio = q("ask-other-input-0");
    act(() => { otherRadio.click(); });
    setText(q("ask-other-text-0"), "  padded answer  ");

    const submitBtn = q("ask-submit") as unknown as HTMLButtonElement;
    act(() => { submitBtn.click(); });
    const answers = replies[0]!.answers as Record<string, unknown>;
    expect(answers["0"]).toEqual(["padded answer"]);
  });
});
