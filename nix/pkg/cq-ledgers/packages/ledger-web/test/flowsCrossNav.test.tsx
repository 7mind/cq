/**
 * Flows-tab cross-nav + color legend tests (T329, FU-4b / FU-4d, happy-dom).
 *
 * FU-4b: activating an agentId-carrying flow node (the plan flow's planner node,
 * whose authored agentId is `plan-advance`) — by CLICK and by ENTER —
 *   (a) flips the help tab to 'agents' (help-tab-agents becomes aria-selected),
 *   (b) invokes Element.prototype.scrollIntoView (spied) on the EXACT
 *       `help-agent-plan-advance` section.
 * Activating an ABSTRACT (non-agentId) node (the plan flow's `user` node) does
 * NEITHER — the tab stays on 'flows' and scrollIntoView is not called.
 *
 * FU-4d: the Flows tab renders a legend with one swatch per RoleKind whose
 * inline background-color equals ROLE_KIND_FILL[kind].
 *
 * Layout is elkjs (pure data, no getBBox / ResizeObserver / DOMMatrix); the
 * cross-nav scroll is deferred via rAF, so we flush after activation.
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { FakeClient } from "./fakeClient";
import { ROLE_KIND_FILL, type RoleKind } from "../src/roleActions";

let container: HTMLElement;
let root: Root;
let fake: FakeClient;

const sleep = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function flush(): Promise<void> {
  await act(async () => {
    await sleep(10);
  });
}
// elk layout per flow + the deferred (rAF) cross-nav scroll: flush a few times.
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await flush();
}
const q = (sel: string): HTMLElement | null => container.querySelector(sel);
const testid = (id: string): HTMLElement | null => q(`[data-testid="${id}"]`);

function press(key: string): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

// happy-dom has no Element.prototype.scrollIntoView; install a spy recording the
// receiver element so the exact `help-agent-<id>` target can be asserted.
function spyScrollIntoView(): { calls: Element[]; restore: () => void } {
  const calls: Element[] = [];
  const proto = Element.prototype as unknown as Record<string, unknown>;
  const prev = proto["scrollIntoView"];
  proto["scrollIntoView"] = function (this: Element): void {
    calls.push(this);
  };
  return {
    calls,
    restore: () => {
      proto["scrollIntoView"] = prev;
    },
  };
}

async function mount(): Promise<void> {
  fake = new FakeClient();
  await act(async () => {
    root.render(createElement(App, { connect: async () => fake, initialUrl: "http://x/mcp" }));
  });
  await flush();
}

async function openFlowsTab(): Promise<void> {
  await mount();
  press("?");
  await flush();
  testid("help-tab-flows")!.click();
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

describe("Flows tab cross-nav + legend (T329)", () => {
  it("clicking an agentId node (plan→planner / plan-advance) flips to Agents and scrolls help-agent-plan-advance", async () => {
    await openFlowsTab();
    expect(testid("help-tab-flows")!.getAttribute("aria-selected")).toBe("true");

    const node = testid("help-flow-plan-node-planner");
    expect(node).not.toBeNull();
    expect(node!.getAttribute("role")).toBe("button");

    const spy = spyScrollIntoView();
    try {
      await act(async () => {
        node!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await settle();

      // (a) the help tab flipped to 'agents'.
      expect(testid("help-tab-agents")!.getAttribute("aria-selected")).toBe("true");
      expect(testid("help-tab-flows")!.getAttribute("aria-selected")).toBe("false");

      // (b) scrollIntoView fired on the EXACT help-agent-plan-advance section.
      const target = container.querySelector('section[id="help-agent-plan-advance"]');
      expect(target).not.toBeNull();
      expect(spy.calls).toContain(target!);
    } finally {
      spy.restore();
    }
  });

  it("pressing Enter on an agentId node flips to Agents and scrolls help-agent-plan-advance", async () => {
    await openFlowsTab();

    const node = testid("help-flow-plan-node-planner")!;
    const spy = spyScrollIntoView();
    try {
      await act(async () => {
        node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      await settle();

      expect(testid("help-tab-agents")!.getAttribute("aria-selected")).toBe("true");
      const target = container.querySelector('section[id="help-agent-plan-advance"]');
      expect(target).not.toBeNull();
      expect(spy.calls).toContain(target!);
    } finally {
      spy.restore();
    }
  });

  it("activating an abstract (non-agentId) node does NEITHER", async () => {
    await openFlowsTab();

    // The plan flow's `user` node carries no agentId → inert.
    const abstract = testid("help-flow-plan-node-user");
    expect(abstract).not.toBeNull();
    expect(abstract!.getAttribute("role")).toBeNull();

    const spy = spyScrollIntoView();
    try {
      await act(async () => {
        abstract!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await act(async () => {
        abstract!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      await settle();

      // Tab stays on Flows; no scroll.
      expect(testid("help-tab-flows")!.getAttribute("aria-selected")).toBe("true");
      expect(testid("help-tab-agents")!.getAttribute("aria-selected")).toBe("false");
      expect(spy.calls).toHaveLength(0);
    } finally {
      spy.restore();
    }
  });

  it("renders a legend with one swatch per RoleKind whose background-color is ROLE_KIND_FILL[kind]", async () => {
    await openFlowsTab();

    const legend = testid("help-flow-legend");
    expect(legend).not.toBeNull();

    const kinds = Object.keys(ROLE_KIND_FILL) as RoleKind[];
    for (const kind of kinds) {
      const swatch = testid(`help-flow-legend-swatch-${kind}`);
      expect(swatch).not.toBeNull();
      // happy-dom normalises hex to rgb(...) in style.backgroundColor; compare
      // by re-setting the property on a probe element to the same expected hex.
      const probe = document.createElement("span");
      probe.style.backgroundColor = ROLE_KIND_FILL[kind];
      expect(swatch!.style.backgroundColor).toBe(probe.style.backgroundColor);
    }
    // Exactly one swatch per kind, no extras.
    expect(container.querySelectorAll('[data-testid^="help-flow-legend-swatch-"]')).toHaveLength(kinds.length);
  });
});
