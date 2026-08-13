import { registerDom } from "./helpers/dom.js";
registerDom();

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Markdown } from "../src/Markdown.js";
import type { ReferencePreviewResult } from "../src/referenceLookup.js";

let container: HTMLDivElement;
let root: Root;
const resolved: ReferencePreviewResult = {
  kind: "found",
  ledger: "tasks",
  id: "T1",
  status: "done",
  summary: "linked task",
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.querySelectorAll(".lw-ref-preview").forEach((node) => node.remove());
});

describe("Markdown item references", () => {
  it("linkifies sanitized GFM prose while leaving inline and fenced code literal", async () => {
    await act(async () => {
      root.render(createElement(Markdown, {
        text: "See **T1** and tasks:T1. `T1`\n\n```txt\ntasks:T1\n```\n\n| ref |\n| --- |\n| T1 |",
        resolveReference: async () => resolved,
      }));
    });

    expect([...container.querySelectorAll(".lw-ref-chip")].map((node) => node.textContent)).toEqual([
      "T1",
      "tasks:T1",
      "T1",
    ]);
    expect(container.querySelector("code .lw-ref-chip")).toBeNull();
    expect(container.querySelector("pre .lw-ref-chip")).toBeNull();
    expect(container.querySelectorAll("table")).toHaveLength(1);
  });

  it("keeps sanitize active and does not navigate when callbacks are omitted", async () => {
    await act(async () => {
      root.render(createElement(Markdown, { text: "T1\n\n<script>alert(1)</script>" }));
    });
    expect(container.querySelector("script")).toBeNull();
    const chip = container.querySelector<HTMLButtonElement>(".lw-ref-chip");
    expect(chip).not.toBeNull();
    act(() => chip?.click());
    expect(document.body.querySelector(".lw-ref-preview")).toBeNull();
  });
});
