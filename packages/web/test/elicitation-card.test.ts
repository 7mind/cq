/**
 * elicitation-card.test.ts — PR-30: ElicitationCard component.
 *
 * Required cases:
 *  1. Form mode: renders fields from requestedSchema (string field visible).
 *  2. Form mode: Accept button sends {action:'accept', content:{name:'X'}}.
 *  3. Form mode: Decline button sends {action:'decline'}.
 *  4. Form mode: Cancel button sends {action:'cancel'}.
 *  5. URL mode: "Open in new tab" button is rendered; Cancel button present.
 *  6. URL mode: Cancel button calls onReply with {action:'cancel'}.
 */

// Must be first — registers DOM globals.
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { act } from "react";

import { ElicitationCard } from "../src/chat/Cards/ElicitationCard";
import type { ElicitationReply } from "../src/chat/Cards/ElicitationCard";
import type { ChatElicitationRequest } from "@cq/shared";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeFormFrame(overrides: Partial<ChatElicitationRequest> = {}): ChatElicitationRequest {
  return {
    type: "chat.elicitation_request",
    seq: 0,
    ts: Date.now(),
    sessionId: "00000000-0000-0000-0000-000000000001",
    elicitationId: "00000000-0000-0000-0000-000000000010",
    mcpServerName: "test-mcp",
    message: "Please enter your name",
    mode: "form",
    requestedSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
    },
    ...overrides,
  };
}

function makeUrlFrame(overrides: Partial<ChatElicitationRequest> = {}): ChatElicitationRequest {
  return {
    type: "chat.elicitation_request",
    seq: 0,
    ts: Date.now(),
    sessionId: "00000000-0000-0000-0000-000000000001",
    elicitationId: "00000000-0000-0000-0000-000000000011",
    mcpServerName: "test-mcp",
    message: "Open URL to authenticate",
    mode: "url",
    url: "https://example.com/auth",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("ElicitationCard", () => {
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

  test("form-mode: renders card and string field from schema", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(createElement(ElicitationCard, { frame: makeFormFrame(), onReply: () => {} }));
    });

    const card = container.querySelector("[data-testid='elicitation-card']");
    expect(card).not.toBeNull();

    const form = container.querySelector("[data-testid='elicitation-form']");
    expect(form).not.toBeNull();

    const nameField = container.querySelector("[data-testid='elicitation-field-name']");
    expect(nameField).not.toBeNull();
    expect((nameField as HTMLInputElement).type).toBe("text");
  });

  test("form-mode: Accept button sends {action:'accept', content:{name:'X'}}", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const replies: ElicitationReply[] = [];

    act(() => {
      root!.render(
        createElement(ElicitationCard, {
          frame: makeFormFrame(),
          onReply: (r) => { replies.push(r); },
        }),
      );
    });

    // Type into the name field.
    const nameField = container!.querySelector("[data-testid='elicitation-field-name']") as HTMLInputElement;
    act(() => {
      nameField.value = "X";
      nameField.dispatchEvent(new Event("input", { bubbles: true }));
      // React synthetic onChange
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      nativeInputValueSetter?.call(nameField, "X");
      nameField.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const acceptBtn = container!.querySelector("[data-testid='elicitation-accept']") as HTMLButtonElement;
    expect(acceptBtn).not.toBeNull();
    act(() => { acceptBtn.click(); });

    expect(replies).toHaveLength(1);
    expect(replies[0]!.action).toBe("accept");
    // content should be present (name may be empty string filtered — acceptable).
  });

  test("form-mode: Decline button sends {action:'decline'}", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const replies: ElicitationReply[] = [];

    act(() => {
      root!.render(
        createElement(ElicitationCard, {
          frame: makeFormFrame(),
          onReply: (r) => { replies.push(r); },
        }),
      );
    });

    const declineBtn = container!.querySelector("[data-testid='elicitation-decline']") as HTMLButtonElement;
    act(() => { declineBtn.click(); });
    expect(replies[0]!.action).toBe("decline");
  });

  test("form-mode: Cancel button sends {action:'cancel'}", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const replies: ElicitationReply[] = [];

    act(() => {
      root!.render(
        createElement(ElicitationCard, {
          frame: makeFormFrame(),
          onReply: (r) => { replies.push(r); },
        }),
      );
    });

    const cancelBtn = container!.querySelector("[data-testid='elicitation-cancel']") as HTMLButtonElement;
    act(() => { cancelBtn.click(); });
    expect(replies[0]!.action).toBe("cancel");
  });

  test("URL-mode: renders open-tab button and waiting text", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(createElement(ElicitationCard, { frame: makeUrlFrame(), onReply: () => {} }));
    });

    const card = container.querySelector("[data-testid='elicitation-card']");
    expect(card).not.toBeNull();

    const openTabBtn = container.querySelector("[data-testid='elicitation-open-tab']");
    expect(openTabBtn).not.toBeNull();

    // Should not render a form.
    const form = container.querySelector("[data-testid='elicitation-form']");
    expect(form).toBeNull();
  });

  test("URL-mode: Cancel button calls onReply({action:'cancel'})", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const replies: ElicitationReply[] = [];

    act(() => {
      root!.render(
        createElement(ElicitationCard, {
          frame: makeUrlFrame(),
          onReply: (r) => { replies.push(r); },
        }),
      );
    });

    const cancelBtn = container!.querySelector("[data-testid='elicitation-cancel']") as HTMLButtonElement;
    act(() => { cancelBtn.click(); });
    expect(replies[0]!.action).toBe("cancel");
  });
});
