/**
 * markdown.test.ts — Markdown component: GFM table, fenced code, task list, footnote.
 *
 * Four named cases per the PR-22a brief.
 *
 * Shiki interaction note:
 *   Shiki uses WebAssembly (oniguruma) internally. happy-dom provides a
 *   functional WebAssembly global; Shiki loads its wasm via dynamic import
 *   rather than `fetch`, so it works in the Bun test runner. The CodeBlock
 *   highlight is async (useEffect), so tests that need to verify highlighting
 *   must await the effect. For the GFM-structure tests below, only the DOM
 *   structure (table, checkbox, footnote) is asserted — Shiki output is
 *   tested in code-block.test.ts.
 */

// Must be first — registers DOM globals (document, window, etc.)
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { act } from "react";

import { Markdown } from "../src/chat/Markdown";

// ---------------------------------------------------------------------------
// DOM container lifecycle
// ---------------------------------------------------------------------------

let container: HTMLDivElement | null = null;
let reactRoot: ReturnType<typeof createRoot> | null = null;

function setup(): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  reactRoot = createRoot(container);
  return container;
}

function teardown(): void {
  if (reactRoot) {
    act(() => {
      reactRoot!.unmount();
    });
    reactRoot = null;
  }
  if (container?.parentNode) {
    container.parentNode.removeChild(container);
  }
  container = null;
}

afterEach(() => {
  teardown();
});

function renderMarkdown(src: string): HTMLDivElement {
  const c = setup();
  act(() => {
    reactRoot!.render(createElement(Markdown, null, src));
  });
  return c;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Poll until predicate returns true or the timeout (ms) elapses.
 * Returns true if the predicate passed, false if timed out.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
    // Flush any pending React state updates.
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
    });
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe("Markdown — GFM rendering", () => {
  test("renders GFM table with thead and th", () => {
    const src = `
| Name  | Value |
|-------|-------|
| alpha | 1     |
| beta  | 2     |
`.trim();

    const c = renderMarkdown(src);

    expect(c.querySelector("table")).not.toBeNull();
    expect(c.querySelector("thead")).not.toBeNull();
    expect(c.querySelector("th")).not.toBeNull();
    const ths = c.querySelectorAll("th");
    expect(ths.length).toBe(2);
  });

  test("renders fenced code block via CodeBlock (lang label present)", () => {
    const src = "```ts\nconst x = 1;\n```";

    const c = renderMarkdown(src);

    // CodeBlock renders a data-testid="code-block-typescript" because "ts" normalises to "typescript"
    // It also renders a lang label element.
    const langEl = c.querySelector("[data-testid='code-block-lang']");
    expect(langEl).not.toBeNull();
    // The displayed lang is the normalised form "typescript"
    expect(langEl?.textContent).toBe("typescript");
  });

  test("renders task list (GFM checkbox)", () => {
    const src = `
- [x] done
- [ ] pending
`.trim();

    const c = renderMarkdown(src);

    const checkboxes = c.querySelectorAll("input[type='checkbox']");
    expect(checkboxes.length).toBeGreaterThanOrEqual(2);

    // First checkbox should be checked.
    const first = checkboxes[0] as HTMLInputElement;
    expect(first.checked).toBe(true);

    // Second checkbox should not be checked.
    const second = checkboxes[1] as HTMLInputElement;
    expect(second.checked).toBe(false);
  });

  test("renders footnote (GFM footnote reference and definition)", async () => {
    const src = `text with a footnote[^1]\n\n[^1]: the footnote text`;

    const c = renderMarkdown(src);

    // remark-gfm renders footnotes inside <section data-footnotes>
    // We wait briefly for any async rendering to settle.
    const found = await waitFor(() => {
      const section = c.querySelector("[data-footnotes]");
      const supLink = c.querySelector("a[href^='#user-content-fn']") ??
                      c.querySelector("sup") ??
                      c.querySelector(".footnote-ref") ??
                      c.querySelector("[id^='user-content-fn']");
      return section !== null || supLink !== null;
    }, 2000);

    expect(found).toBe(true);
  });
});
