/**
 * State-machines help-tab render test (T203, happy-dom).
 *
 * NEW coverage for the elk migration of the State-machines tab (decision K37):
 * the repo previously had NO DOM test of this tab (app.test only opened the help
 * overlay on the Shortcuts tab; helpTabs covered the OLD computeDagLayout-based
 * scheme). This test drives the migrated tab end-to-end through the in-memory
 * FakeClient and asserts:
 *   (1) one DiagramSvg per ledger under the documented T202 testid scheme
 *       (`help-statemachine-${ledger}` section + `${idPrefix}-svg` svg +
 *       `${idPrefix}-node-${status}` / `${idPrefix}-edge-${from}-${to}`);
 *   (2) a schema WITH a self-loop transition renders its self-loop edge testid —
 *       the behavior the elk migration newly ENABLES (computeDagLayout dropped
 *       self-loops);
 *   (3) LEFT-ALIGNMENT / D33: the elk-laid-out nodes are flush-left with no
 *       empty leading layer-0 gap (min node.x within elk's small default left
 *       padding, well below the between-layer spacing).
 *
 * Pure-data: the layout is elkjs (no getBBox / ResizeObserver / DOMMatrix). The
 * left-alignment assertion runs layoutDiagram directly on the adapter's model so
 * it never measures the DOM.
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { FakeClient } from "./fakeClient";
import { computeStateMachine } from "../src/stateMachine";
import { layoutDiagram } from "../src/diagramLayout";
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
// The tab fires a batched schema fetch AND an async elk layout per diagram;
// flush a few times so both settle before asserting.
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

async function openStateMachinesTab(): Promise<void> {
  await mount();
  press("?");
  await flush();
  click(testid("help-tab-statemachines"));
  await settle();
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

describe("State-machines tab (elk migration, T203)", () => {
  it("renders exactly one DiagramSvg per ledger under the documented testid scheme", async () => {
    await openStateMachinesTab();

    const ledgers = (await fake.enumerateLedgers()).map((l) => l.name);
    expect(ledgers.length).toBeGreaterThan(0);
    for (const name of ledgers) {
      // The per-ledger <section> container.
      expect(testid(`help-statemachine-${name}`)).not.toBeNull();
      // Exactly ONE svg per ledger (idPrefix `help-statemachine-${name}`).
      const svgs = container.querySelectorAll(`[data-testid="help-statemachine-${name}-svg"]`);
      expect(svgs).toHaveLength(1);

      // Every status of the schema renders a node + rect under the scheme.
      const { schema } = await fake.fetchLedger(name);
      for (const status of schema.statusValues) {
        expect(testid(`help-statemachine-${name}-node-${status}`)).not.toBeNull();
        expect(testid(`help-statemachine-${name}-rect-${status}`)).not.toBeNull();
      }
    }

    // A known directed (non-self) transition edge renders (bugs: open -> wip).
    expect(testid("help-statemachine-bugs-edge-open-wip")).not.toBeNull();
  });

  it("renders a self-loop edge testid that the old computeDagLayout dropped", async () => {
    await openStateMachinesTab();

    // The fake `tasks` schema declares wip -> wip (a self-loop). The old
    // computeDagLayout-based model dropped self-loops; the elk renderer keeps it.
    expect(testid("help-statemachine-tasks-edge-wip-wip")).not.toBeNull();
  });

  it("lays out left-aligned with no empty leading layer-0 gap (D33 guard)", async () => {
    // Run the SAME adapter + elk layout the tab uses, on a cyclic schema (the
    // shape that made the homegrown computeDagLayout leave layer 0 empty and
    // right-shift the diagram — D33). Pure data: no DOM measurement.
    const cyclic: LedgerSchema = {
      statusValues: ["open", "wip", "closed"],
      terminalStatuses: ["closed"],
      fields: { headline: { type: "string", required: true } },
      // open <-> wip cycle: every node is a transition target, so a layered
      // layout that mis-handles cycles would leave layer 0 empty.
      transitions: { open: ["wip"], wip: ["open", "closed"], closed: [] },
    };
    const laid = await layoutDiagram(computeStateMachine(cyclic));

    const minX = Math.min(...laid.nodes.map((n) => n.x));
    // elk's default left padding is small (~12px); the between-layer spacing is
    // 56px. A phantom empty layer-0 would push the leftmost node out by at least
    // one node width + spacing (>> 56). Flush-left ⇒ minX is within the padding.
    const BETWEEN_LAYER_SPACING = 56;
    expect(minX).toBeLessThan(BETWEEN_LAYER_SPACING);
    expect(minX).toBeGreaterThanOrEqual(0);
  });
});
