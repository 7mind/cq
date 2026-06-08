/**
 * Agents help-tab render test (T279, happy-dom).
 *
 * Opens the help overlay, clicks the Agents tab, and asserts:
 *   (1) the tab button `help-tab-agents` exists and is selectable;
 *   (2) the panel `help-agents` renders on click;
 *   (3) every role in AGENT_ROLES renders a `help-agent-<id>` section;
 *   (4) a sample role (implement-worker) shows description + inputs + outputs
 *       + model class text;
 *   (5) `help-agent-implement-worker-privilege` shows "RW" and
 *       `help-agent-plan-reviewer-privilege` shows "RO";
 *   (6) `help-agent-<id>-tools` renders (per-kind descriptor present);
 *   (7) the prompt `<details>` (`help-agent-<id>-prompt`) is COLLAPSED by
 *       default (no `open` attribute / .open === false), then expands on toggle.
 *
 * Static data only — like the Flows tab, no async MCP fetch is needed.
 * Uses the same in-memory harness as flowsTab.test.tsx.
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { FakeClient } from "./fakeClient";
import { AGENT_ROLES } from "../src/agentsCatalogue";

let container: HTMLElement;
let root: Root;
let fake: FakeClient;

const sleep = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function flush(): Promise<void> {
  await act(async () => {
    await sleep(10);
  });
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

async function openAgentsTab(): Promise<void> {
  await mount();
  press("?");
  await flush();
  click(testid("help-tab-agents"));
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

describe("Agents tab (T279)", () => {
  it("exposes a selectable Agents tab button", async () => {
    await mount();
    press("?");
    await flush();

    const btn = testid("help-tab-agents");
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute("aria-selected")).toBe("false");

    click(btn);
    await flush();
    expect(testid("help-tab-agents")!.getAttribute("aria-selected")).toBe("true");
    expect(testid("help-agents")).not.toBeNull();
  });

  it("renders a help-agent-<id> section for every AGENT_ROLES entry", async () => {
    await openAgentsTab();

    // Sanity: the catalogue must be non-empty (the gen file must have been
    // populated by T276 — if AGENT_ROLES is still the empty placeholder, this
    // assertion fires and the test suite flags the regression).
    expect(AGENT_ROLES.length).toBeGreaterThan(0);

    for (const role of AGENT_ROLES) {
      const section = testid(`help-agent-${role.id}`);
      expect(section).not.toBeNull();
    }
  });

  it("shows description + inputs + outputs + model class for implement-worker", async () => {
    await openAgentsTab();

    // Pick a role with known non-empty catalogue data: implement-worker.
    const role = AGENT_ROLES.find((r) => r.id === "implement-worker");
    expect(role).not.toBeUndefined();

    const section = testid("help-agent-implement-worker");
    expect(section).not.toBeNull();
    const text = section!.textContent ?? "";

    // Description is rendered verbatim in the section.
    expect(text).toContain(role!.description.slice(0, 40));

    // At least one input and one output string from the catalogue block renders.
    if (role!.inputs.length > 0) {
      expect(text).toContain(role!.inputs[0]!.slice(0, 20));
    }
    if (role!.outputs.length > 0) {
      expect(text).toContain(role!.outputs[0]!.slice(0, 20));
    }

    // Model class label (e.g. "standard") appears in the section.
    expect(text).toContain(role!.model);
  });

  it("shows RW privilege badge for implement-worker and RO for plan-reviewer", async () => {
    await openAgentsTab();

    // implement-worker is RW (no mutating tools in its disallowedTools deny-list).
    const rwBadge = testid("help-agent-implement-worker-privilege");
    expect(rwBadge).not.toBeNull();
    expect(rwBadge!.textContent?.trim()).toBe("RW");

    // plan-reviewer is RO (disallowedTools includes Write/Edit/Bash etc.).
    const roBadge = testid("help-agent-plan-reviewer-privilege");
    expect(roBadge).not.toBeNull();
    expect(roBadge!.textContent?.trim()).toBe("RO");
  });

  it("renders a per-kind tools descriptor for every role", async () => {
    await openAgentsTab();

    for (const role of AGENT_ROLES) {
      const toolsEl = testid(`help-agent-${role.id}-tools`);
      expect(toolsEl).not.toBeNull();
      // The descriptor must be non-empty text (Disallowed: … / Allowed: … /
      // none declared — see formatExposedTools).
      expect((toolsEl!.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  it("prompt <details> is collapsed by default, then expands on click", async () => {
    await openAgentsTab();

    // Use the first role as the representative sample.
    const firstRole = AGENT_ROLES[0]!;
    const details = testid(`help-agent-${firstRole.id}-prompt`) as HTMLDetailsElement | null;
    expect(details).not.toBeNull();

    // COLLAPSED by default: the <details> element must NOT carry the `open` attr.
    expect(details!.hasAttribute("open")).toBe(false);
    expect(details!.open).toBe(false);

    // Toggle open via a click on the <summary> child.
    const summary = details!.querySelector("summary");
    expect(summary).not.toBeNull();
    click(summary);
    await flush();

    expect(details!.open).toBe(true);
  });
});
