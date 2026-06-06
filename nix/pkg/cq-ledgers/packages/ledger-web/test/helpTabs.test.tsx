/**
 * Tabbed help dialog tests (T5, happy-dom).
 *
 * Opens the help dialog and asserts: two tabs render; tab 1 keeps the shortcut
 * list; tab 2 renders one SVG state-machine per ledger; a node's SVG fill equals
 * BUCKET_HEX[statusBucket(status, schema)] for a known status; a directed edge
 * exists for a known transition pair; and a transitions-less ledger renders
 * colored nodes with no edges. Driven by the in-memory FakeClient.
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { FakeClient } from "./fakeClient";
import { BUCKET_HEX, statusBucket } from "../src/status";
import type { LedgerSchema } from "../src/types";

let container: HTMLElement;
let root: Root;
let fake: FakeClient;

const sleep = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function flush(): Promise<void> {
  await act(async () => {
    await sleep(10);
  });
}
// The state-machines tab fires a batched schema fetch AND an async elk layout
// per diagram (layoutDiagram drives a fake worker); flush a few times so both
// the fetch promise and every layout useEffect settle before asserting.
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await flush();
}
const q = (sel: string): HTMLElement | null => container.querySelector(sel);
const testid = (id: string): HTMLElement | null => q(`[data-testid="${id}"]`);

function click(el: Element | null): void {
  if (el === null) throw new Error("click: element not found");
  act(() => {
    (el as HTMLElement).click();
  });
}
function press(key: string): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
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
  act(() => root.unmount());
  container.remove();
});

// The bugs ledger's known schema (mirrors fakeClient): drives the color/edge
// assertions against a stable status + transition pair.
const bugsSchema: LedgerSchema = {
  statusValues: ["open", "wip", "closed"],
  terminalStatuses: ["closed"],
  fields: { headline: { type: "string", required: true } },
  transitions: { open: ["wip", "closed"], wip: ["closed", "open"], closed: [] },
};

describe("tabbed help dialog", () => {
  it("shows two tabs; tab 1 keeps the shortcut list", async () => {
    await mount();
    press("?");
    await flush();
    expect(testid("help-overlay")).not.toBeNull();
    expect(testid("help-close")).not.toBeNull();
    // Two tab controls.
    expect(testid("help-tab-shortcuts")).not.toBeNull();
    expect(testid("help-tab-statemachines")).not.toBeNull();
    // Tab 1 lists the shortcuts (the `?` row is part of SHORTCUTS).
    const list = testid("help-shortcuts");
    expect(list).not.toBeNull();
    expect(list?.textContent).toContain("Show / hide this help");
  });

  it("tab 2 renders one SVG state-machine per ledger; node fill + edge match the schema", async () => {
    await mount();
    press("?");
    await flush();
    click(testid("help-tab-statemachines"));
    await settle();

    // A diagram container per ledger that the fake enumerates. The svg testid
    // follows DiagramSvg's `${idPrefix}-svg` scheme with idPrefix
    // `help-statemachine-${ledger}` (T203 elk migration).
    const ledgers = (await fake.enumerateLedgers()).map((l) => l.name);
    for (const name of ledgers) {
      expect(testid(`help-statemachine-${name}`)).not.toBeNull();
      expect(testid(`help-statemachine-${name}-svg`)).not.toBeNull();
    }

    // A known node's SVG fill equals the shared bucket palette color.
    const openFill = testid("help-statemachine-bugs-rect-open")?.getAttribute("fill");
    expect(openFill).toBe(BUCKET_HEX[statusBucket("open", bugsSchema)]);
    // sanity: open (non-terminal) is the `start` bucket.
    expect(openFill).toBe(BUCKET_HEX.start);

    // A directed edge exists for a known transition pair (open -> wip).
    expect(testid("help-statemachine-bugs-edge-open-wip")).not.toBeNull();
    expect(testid("help-statemachine-bugs-edge-open-closed")).not.toBeNull();
  });

  it("renders colored nodes with no edges for a ledger without a transitions map", async () => {
    await mount();
    press("?");
    await flush();
    click(testid("help-tab-statemachines"));
    await settle();

    // `plain` declares no transitions: nodes present, no edges.
    expect(testid("help-statemachine-plain")).not.toBeNull();
    expect(testid("help-statemachine-plain-node-open")).not.toBeNull();
    expect(testid("help-statemachine-plain-rect-open")?.getAttribute("fill")).toBe(
      BUCKET_HEX[statusBucket("open", { statusValues: ["open", "closed"], terminalStatuses: ["closed"], fields: {} })],
    );
    expect(container.querySelector('[data-testid^="help-statemachine-plain-edge-"]')).toBeNull();

    // Regression guard (giant-node + alignment defect): the svg carries explicit
    // intrinsic width/height attrs AND an inline max-width = intrinsic width. CSS
    // width:100% fills the dialog (wide diagrams can't overflow → no right-shift)
    // while the inline max-width caps upscaling, so a narrow edgeless diagram
    // renders at its natural small size. An edgeless ledger stacks its statuses
    // in a single column, so the intrinsic width stays narrow.
    const svg = testid("help-statemachine-plain-svg") as unknown as SVGElement | null;
    const w = Number(svg?.getAttribute("width"));
    const h = Number(svg?.getAttribute("height"));
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
    expect(w).toBeLessThan(200); // single-column edgeless diagram is narrow, never stretched wide
    // Inline max-width pins upscaling to the intrinsic width (px).
    expect((svg as HTMLElement | null)?.style.maxWidth).toBe(`${w}px`);
  });

  it("Esc still closes the dialog and help-overlay/help-close testids persist", async () => {
    await mount();
    press("?");
    await flush();
    expect(testid("help-overlay")).not.toBeNull();
    press("Escape");
    await flush();
    expect(testid("help-overlay")).toBeNull();
  });
});
