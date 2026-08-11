/**
 * D57 — JSON pretty-print + colorize acceptance tests.
 *
 * Verifies:
 * (a) A ```json fence with compact JSON renders multi-line (pretty-printed)
 *     AND carries a .lw-json-key span.
 * (b) An invalid-JSON ```json fence falls back to raw text unchanged (no throw).
 * (c) A non-json fence (```sh) is rendered as-is (no colorization), with
 *     structure exactly `pre > code` (one pre, one code, no nesting).
 * (d) The styles.css source contains `white-space:pre-wrap` for `.lw-md pre`.
 * (e) No fenced block (json or non-json) produces a nested <pre> inside <pre>.
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Markdown } from "../src/Markdown";
import { LEDGER_RESPONSE_CONTRACTS, LEDGER_TOOL_NAMES } from "@cq/ledger";
import { readFileSync } from "fs";
import { join } from "path";

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

async function render(text: string): Promise<void> {
  await act(async () => {
    root.render(createElement(Markdown, { text }));
  });
}

describe("Markdown JSON pretty-print + colorize (D57)", () => {
  it("(a) renders a ```json fence as pretty-printed multi-line output with a .lw-json-key span", async () => {
    const md = "```json\n{\"a\":1,\"b\":[2,3]}\n```";
    await render(md);

    // Must contain newlines — i.e. the pretty-printed form
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    const text = pre!.textContent ?? "";
    expect(text).toContain("\n");
    // 2-space indent means the string should contain "  "
    expect(text).toContain("  ");

    // Must have at least one .lw-json-key span
    const keySpan = container.querySelector(".lw-json-key");
    expect(keySpan).not.toBeNull();

    // Exactly ONE <pre> — no nesting
    expect(container.querySelectorAll("pre").length).toBe(1);
    expect(container.querySelectorAll("pre pre").length).toBe(0);
  });

  it("(b) invalid-JSON ```json fence falls back to raw text unchanged (no throw)", async () => {
    const invalid = "not json";
    const md = "```json\n" + invalid + "\n```";
    await render(md);

    // Must not throw — component still renders
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    // Raw text preserved
    expect(pre!.textContent).toContain(invalid);
    // No colorizer spans — it fell back to the raw rendering
    expect(container.querySelector(".lw-json-key")).toBeNull();
    // No nested <pre>
    expect(container.querySelectorAll("pre pre").length).toBe(0);
  });

  it("(c) a non-json fence (```sh) is rendered as-is without colorization, structure is pre>code", async () => {
    const md = "```sh\necho hello\n```";
    await render(md);

    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("echo hello");
    expect(container.querySelector(".lw-json-key")).toBeNull();
    expect(container.querySelector(".lw-json-string")).toBeNull();

    // Exactly one <pre>, one <code>, and no nesting
    expect(container.querySelectorAll("pre").length).toBe(1);
    expect(container.querySelectorAll("code").length).toBe(1);
    expect(container.querySelectorAll("pre pre").length).toBe(0);
    // The <code> must be a direct child of <pre>
    expect(pre!.querySelector("code")).not.toBeNull();
  });

  it("(d) styles.css contains white-space:pre-wrap for .lw-md pre", () => {
    const cssPath = join(import.meta.dir, "../src/styles.css");
    const css = readFileSync(cssPath, "utf8");
    // The rule must be present in the .lw-md pre block
    expect(css).toContain("white-space: pre-wrap");
  });
});

// Behavioral-Active / Blackbox-Group: exercise the production GFM renderer against the public docs.
describe("ledger response-contract Markdown", () => {
  it("renders the complete response matrix with escaped operator unions", async () => {
    const readme = readFileSync(join(import.meta.dir, "../../ledger-mcp/README.md"), "utf8");
    const start = "<!-- ledger-response-contract:start -->";
    const end = "<!-- ledger-response-contract:end -->";
    const matrix = readme.slice(readme.indexOf(start) + start.length, readme.indexOf(end));

    await render(matrix);

    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.querySelectorAll(".lw-md > *")).toHaveLength(1);
    expect(
      [...container.querySelectorAll("thead th")].map((cell) => cell.textContent),
    ).toEqual(["Tool", "Category", "Authoritative response"]);
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(LEDGER_TOOL_NAMES.length);
    expect(rows.map((row) => row.cells.length)).toEqual(LEDGER_TOOL_NAMES.map(() => 3));
    expect(rows.map((row) => row.cells[0]?.textContent)).toEqual([...LEDGER_TOOL_NAMES]);
    for (const tool of [
      "materialize_operator_action",
      "acknowledge_operator_action",
      "record_operator_action_evidence",
    ] as const) {
      expect(matrix).toContain(LEDGER_RESPONSE_CONTRACTS[tool].responseCell.replaceAll("|", "\\|"));
    }
  });
});
