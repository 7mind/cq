/**
 * Batch modal sizing test (T93 / item 19).
 *
 * Verifies that the batch-answer modal is styled with appropriate width, height,
 * and font sizing to accommodate longer question content with better readability.
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { FakeClient } from "./fakeClient";
import { readFileSync } from "fs";
import { join, dirname } from "path";

let container: HTMLElement;
let root: Root;
let fake: FakeClient;

const sleep = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function flush(): Promise<void> {
  await act(async () => {
    await sleep(10);
  });
}

const testid = (id: string): HTMLElement | null => container.querySelector(`[data-testid="${id}"]`);

function click(el: Element | null): void {
  if (el === null) throw new Error("click: element not found");
  act(() => {
    (el as HTMLElement).click();
  });
}

async function mount(): Promise<void> {
  fake = new FakeClient();
  await act(async () => {
    root.render(createElement(App, { connect: async () => fake, initialUrl: "http://x/mcp" }));
  });
  await flush();
}

beforeEach(() => {
  localStorage.clear();
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

describe("batch modal sizing (T93)", () => {
  it("opens the batch-answer modal", async () => {
    await mount();
    const batchOpenBtn = testid("batch-open");
    expect(batchOpenBtn).not.toBeNull();
    click(batchOpenBtn);
    await flush();

    const modal = testid("batch-overlay");
    expect(modal).not.toBeNull();
  });

  it("batch modal CSS rule includes larger sizing", async () => {
    // Read the styles.css file and verify the .lw-batch rule has the new sizing
    const stylesPath = join(dirname(import.meta.url.replace("file://", "")), "../src/styles.css");
    const content = readFileSync(stylesPath, "utf-8");

    // Verify the new sizing rule exists in styles.css
    expect(content).toContain(".lw-batch");
    expect(content).toContain("width: min(900px, 90vw)");
    expect(content).toContain("max-height: 90vh");
    expect(content).toContain("font-size: 0.95rem");
    expect(content).toContain("overflow-y: auto");
    // Behavioral: the .lw-batch rule must declare overflow-y: auto so long content scrolls
    const batchRuleMatch = content.match(/\.lw-batch\s*\{([^}]*)/);
    expect(batchRuleMatch).not.toBeNull();
    const batchRuleBody = batchRuleMatch![1];
    expect(batchRuleBody).toContain("overflow-y: auto");
  });

  it("batch modal dialog element renders with proper class", async () => {
    await mount();

    // Open the batch modal
    const batchOpenBtn = testid("batch-open");
    expect(batchOpenBtn).not.toBeNull();
    click(batchOpenBtn);
    await flush();

    // Verify the modal element with .lw-batch class exists
    const batchDialog = container.querySelector(".lw-batch") as HTMLElement | null;
    expect(batchDialog).not.toBeNull();
    expect(batchDialog?.getAttribute("role")).toBe("dialog");
  });
});
