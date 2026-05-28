/**
 * cards.test.ts — PR-23: tool cards for Read / Write / Edit / Bash.
 *
 * Four named cases:
 *  1. ReadCard — shows file path and snippet from result content.
 *  2. WriteCard — shows file path and content preview.
 *  3. EditCard — shows hand-rolled line-diff; additions in green (diffAdd),
 *                 deletions in red (diffDel), with correct line numbers.
 *  4. BashCard — shows command, stdout, stderr, exit code, run_in_background flag.
 *
 * Test environment: happy-dom via GlobalRegistrator (preloaded by bunfig.toml).
 * React 19 + react-dom/client for rendering.
 */

// Must be first — registers DOM globals (document, window, etc.)
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { act } from "react";

import { ReadCard } from "../src/chat/Cards/ReadCard";
import { WriteCard } from "../src/chat/Cards/WriteCard";
import { EditCard } from "../src/chat/Cards/EditCard";
import { BashCard } from "../src/chat/Cards/BashCard";
import { lineDiff } from "../src/chat/Cards/diffLine";

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
// Case 1: ReadCard — shows file path and snippet
// ---------------------------------------------------------------------------

describe("Cards — tool card rendering", () => {
  test("ReadCard shows file path and result snippet", () => {
    const c = render(ReadCard, {
      input: { file_path: "/home/user/foo.ts", offset: 10, limit: 50 },
      resultContent: [{ type: "text", text: "const x = 1;\nconst y = 2;" }],
    });

    const card = c.querySelector("[data-testid='read-card']");
    expect(card).not.toBeNull();

    // Header contains the tool name and file path.
    const headerText = card?.querySelector("div")?.textContent ?? "";
    expect(headerText).toContain("Read");
    expect(headerText).toContain("/home/user/foo.ts");

    // Body contains the snippet text.
    const pre = card?.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("const x = 1;");
  });

  // -------------------------------------------------------------------------
  // Case 2: WriteCard — shows file path and content preview
  // -------------------------------------------------------------------------

  test("WriteCard shows file path and content preview", () => {
    const content = "export function hello() {\n  return 'world';\n}\n";
    const c = render(WriteCard, {
      input: { file_path: "/home/user/hello.ts", content },
    });

    const card = c.querySelector("[data-testid='write-card']");
    expect(card).not.toBeNull();

    // Header contains the tool name and file path.
    const headerText = card?.querySelector("div")?.textContent ?? "";
    expect(headerText).toContain("Write");
    expect(headerText).toContain("/home/user/hello.ts");

    // Body contains a preview of the content.
    const pre = card?.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("export function hello");
  });

  // -------------------------------------------------------------------------
  // Case 3: EditCard — shows diff with green adds and red deletions
  // -------------------------------------------------------------------------

  test("EditCard shows diff with green additions and red deletions", () => {
    const oldString = "line one\nline two\nline three";
    const newString = "line one\nline TWO\nline three\nline four";

    const c = render(EditCard, {
      input: {
        file_path: "/home/user/edit.ts",
        old_string: oldString,
        new_string: newString,
      },
    });

    const card = c.querySelector("[data-testid='edit-card']");
    expect(card).not.toBeNull();

    // Header contains Edit and file path.
    const headerText = card?.querySelector("div")?.textContent ?? "";
    expect(headerText).toContain("Edit");
    expect(headerText).toContain("/home/user/edit.ts");

    // The diff container is present.
    const diff = card?.querySelector("[data-testid='edit-diff']");
    expect(diff).not.toBeNull();

    // Additions: 'line TWO' (changed) and 'line four' (new) are 'add' rows.
    const addRows = diff?.querySelectorAll("[data-diff-type='add']") ?? [];
    expect(addRows.length).toBeGreaterThanOrEqual(1);

    // The add rows contain the added text.
    const addTexts = Array.from(addRows).map((r) => r.textContent ?? "");
    expect(addTexts.some((t) => t.includes("line TWO") || t.includes("line four"))).toBe(true);

    // Deletions: 'line two' (changed) is a 'del' row.
    const delRows = diff?.querySelectorAll("[data-diff-type='del']") ?? [];
    expect(delRows.length).toBeGreaterThanOrEqual(1);

    const delTexts = Array.from(delRows).map((r) => r.textContent ?? "");
    expect(delTexts.some((t) => t.includes("line two"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Case 4: BashCard — shows command, stdout, stderr, exit code, background flag
  // -------------------------------------------------------------------------

  test("BashCard shows command, stdout, stderr, exit code, and background flag", () => {
    const c = render(BashCard, {
      input: { command: "ls -la /tmp", run_in_background: true },
      result: { stdout: "total 0\ndrwxr-xr-x  2 root root 40 Jan  1 00:00 .", stderr: "permission denied", exitCode: 0 },
    });

    const card = c.querySelector("[data-testid='bash-card']");
    expect(card).not.toBeNull();

    const fullText = card?.textContent ?? "";

    // Header contains Bash tool name.
    expect(fullText).toContain("Bash");

    // Background badge is present.
    expect(fullText).toContain("background");

    // Exit code is shown.
    expect(fullText).toContain("exit 0");

    // Command is rendered.
    expect(fullText).toContain("ls -la /tmp");

    // Stdout is rendered.
    expect(fullText).toContain("total 0");

    // Stderr is rendered.
    expect(fullText).toContain("permission denied");
  });
});

// ---------------------------------------------------------------------------
// lineDiff unit tests (pure function — no DOM needed)
// ---------------------------------------------------------------------------

describe("lineDiff — hand-rolled LCS-based diff", () => {
  test("identical strings produce only 'eq' entries", () => {
    const text = "alpha\nbeta\ngamma";
    const entries = lineDiff(text, text);
    expect(entries.every((e) => e.type === "eq")).toBe(true);
    expect(entries).toHaveLength(3);
  });

  test("added line is tagged as 'add'", () => {
    const before = "alpha\nbeta";
    const after = "alpha\nbeta\ngamma";
    const entries = lineDiff(before, after);
    const added = entries.filter((e) => e.type === "add");
    expect(added).toHaveLength(1);
    expect(added[0]?.text).toBe("gamma");
  });

  test("deleted line is tagged as 'del'", () => {
    const before = "alpha\nbeta\ngamma";
    const after = "alpha\ngamma";
    const entries = lineDiff(before, after);
    const deleted = entries.filter((e) => e.type === "del");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.text).toBe("beta");
  });

  test("changed line appears as del + add pair", () => {
    const before = "alpha\nbeta\ngamma";
    const after = "alpha\nBETA\ngamma";
    const entries = lineDiff(before, after);
    const del = entries.filter((e) => e.type === "del");
    const add = entries.filter((e) => e.type === "add");
    expect(del.some((e) => e.text === "beta")).toBe(true);
    expect(add.some((e) => e.text === "BETA")).toBe(true);
  });
});
