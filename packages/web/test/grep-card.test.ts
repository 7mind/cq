/**
 * grep-card.test.ts — PR-37: Grep/Glob/WebFetch/WebSearch tool cards.
 *
 * Cases:
 *  1. GrepCard with 12 hits — header shows "12 hits", <details> collapsed.
 *  2. GrepCard expand — opening <details> reveals all hit lines.
 *  3. GrepCard no matches — shows "No matches" body, no <details>.
 *  4. GlobCard — dispatches via toolName="Glob", shows pattern.
 *  5. WebCard (WebFetch) — shows URL and truncated snippet.
 *  6. WebCard (WebSearch) — shows query and snippet.
 *
 * Test environment: happy-dom via GlobalRegistrator (preloaded by bunfig.toml).
 * React 19 + react-dom/client for rendering.
 */

// Must be first — registers DOM globals.
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { act } from "react";

import { GrepCard } from "../src/chat/Cards/GrepCard";
import { WebCard } from "../src/chat/Cards/WebCard";

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

function render<P extends object>(component: React.ComponentType<P>, props: P): HTMLDivElement {
  const c = setup();
  act(() => {
    reactRoot!.render(createElement(component, props));
  });
  return c;
}

// ---------------------------------------------------------------------------
// Build a result content block of 12 grep-style hit lines.
// ---------------------------------------------------------------------------

function makeHits(count: number): string {
  return Array.from({ length: count }, (_, i) => `match-line-${i + 1}`).join("\n");
}

// ---------------------------------------------------------------------------
// Case 1: GrepCard with 12 hits — collapsed by default, count shown in header
// ---------------------------------------------------------------------------

describe("GrepCard — Grep/Glob tool card", () => {
  test("shows 12 hits in header, <details> collapsed by default", () => {
    const hits = makeHits(12);
    const c = render(GrepCard, {
      toolName: "Grep" as const,
      input: { pattern: "foo\\(.*\\)" },
      resultContent: hits,
    });

    const card = c.querySelector("[data-testid='grep-card']");
    expect(card).not.toBeNull();

    // Header contains tool name.
    const header = card?.querySelector(".header") ?? card?.querySelector("[class*='header']");
    const headerText = (header ?? card)?.textContent ?? "";
    expect(headerText).toContain("Grep");
    expect(headerText).toContain("foo");

    // Match count badge.
    const countEl = card?.querySelector("[data-testid='grep-match-count']");
    expect(countEl).not.toBeNull();
    expect(countEl?.textContent).toContain("12");
    expect(countEl?.textContent).toContain("hits");

    // <details> present but not open by default.
    const details = card?.querySelector("[data-testid='grep-details']") as HTMLDetailsElement | null;
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Case 2: Expand <details> — all hit lines visible
  // -------------------------------------------------------------------------

  test("expanding <details> reveals all 12 hit lines", () => {
    const hits = makeHits(12);
    const c = render(GrepCard, {
      toolName: "Grep" as const,
      input: { pattern: "foo\\(.*\\)" },
      resultContent: hits,
    });

    const details = c.querySelector("[data-testid='grep-details']") as HTMLDetailsElement | null;
    expect(details).not.toBeNull();

    // Programmatically open.
    act(() => {
      details!.open = true;
    });

    const hitsEl = c.querySelector("[data-testid='grep-hits']");
    expect(hitsEl).not.toBeNull();

    const hitsText = hitsEl?.textContent ?? "";
    for (let i = 1; i <= 12; i++) {
      expect(hitsText).toContain(`match-line-${i}`);
    }
  });

  // -------------------------------------------------------------------------
  // Case 3: Empty result — no <details>, shows "No matches"
  // -------------------------------------------------------------------------

  test("shows 'No matches' when result is empty", () => {
    const c = render(GrepCard, {
      toolName: "Grep" as const,
      input: { pattern: "notfound" },
      resultContent: "",
    });

    const card = c.querySelector("[data-testid='grep-card']");
    const details = card?.querySelector("[data-testid='grep-details']");
    expect(details).toBeNull();

    const cardText = card?.textContent ?? "";
    expect(cardText).toContain("No matches");
  });

  // -------------------------------------------------------------------------
  // Case 4: GlobCard — uses toolName="Glob"
  // -------------------------------------------------------------------------

  test("GlobCard renders with Glob tool name and path pattern", () => {
    const c = render(GrepCard, {
      toolName: "Glob" as const,
      input: { pattern: "**/*.ts" },
      resultContent: "src/index.ts\nsrc/utils.ts",
    });

    const card = c.querySelector("[data-testid='grep-card']");
    expect(card?.textContent).toContain("Glob");
    expect(card?.textContent).toContain("**/*.ts");

    const countEl = card?.querySelector("[data-testid='grep-match-count']");
    expect(countEl?.textContent).toContain("2");
  });
});

// ---------------------------------------------------------------------------
// WebCard tests
// ---------------------------------------------------------------------------

describe("WebCard — WebFetch/WebSearch tool card", () => {
  test("WebFetch card shows URL and result snippet", () => {
    const url = "https://example.com/docs";
    const body = "This is the fetched page content with some useful information.";
    const c = render(WebCard, {
      toolName: "WebFetch" as const,
      input: { url },
      resultContent: body,
    });

    const card = c.querySelector("[data-testid='web-card']");
    expect(card).not.toBeNull();

    const target = card?.querySelector("[data-testid='web-target']");
    expect(target?.textContent).toBe(url);

    const snippet = card?.querySelector("[data-testid='web-snippet']");
    expect(snippet?.textContent).toContain("fetched page content");
  });

  test("WebSearch card shows query and truncated snippet", () => {
    const query = "TypeScript strict mode config";
    // 500 chars — exceeds the 400-char truncation limit
    const longResult = "a".repeat(500);
    const c = render(WebCard, {
      toolName: "WebSearch" as const,
      input: { query },
      resultContent: longResult,
    });

    const card = c.querySelector("[data-testid='web-card']");
    const target = card?.querySelector("[data-testid='web-target']");
    expect(target?.textContent).toBe(query);

    const snippet = card?.querySelector("[data-testid='web-snippet']");
    const snippetText = snippet?.textContent ?? "";
    // Truncated: should end with ellipsis and be shorter than 500
    expect(snippetText.length).toBeLessThan(500);
    expect(snippetText).toContain("…");
  });
});
