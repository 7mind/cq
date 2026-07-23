/**
 * ledger-web finalize-menu test (T619).
 *
 * Drives <App> under happy-dom with the in-memory FakeClient to cover the
 * toolbar 'Finalize' control that is wired for the milestones/goals views:
 *  1. on the milestones view, a 'finalize-btn' button renders immediately
 *     after the '+ item'/'+ milestone' control;
 *  2. clicking it opens a menu with exactly the two labeled options;
 *  3. Escape closes the menu;
 *  4. the button is absent on a non-milestones/goals view (tasks);
 *  5. picking each option raises the finalize-preview state (surfaced via the
 *     hidden finalize-preview-mode stub) and closes the menu;
 *  6. the button also renders on the goals view (via a local FakeClient
 *     subclass carrying a minimal goals-ledger fixture — the shared
 *     fakeClient.ts has no goals ledger and gains none from this file);
 *  7. switching ledgers resets any pending finalize-preview/menu-open state.
 *
 * This task wires button + menu + state plumbing only — no execution (T620
 * consumes the raised finalize-preview state; see App.tsx's exported
 * FinalizePreviewState type).
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { FakeClient } from "./fakeClient";
import type { FetchedLedger, LedgerSummary } from "../src/types.js";

const GOALS_TS = "2026-01-01T00:00:00.000Z";

/**
 * FakeClient + a minimal `goals` ledger, purpose-built for this test file
 * only (the shared fakeClient.ts intentionally carries no goals fixture, so
 * this stays local rather than widening every other test's sidebar/ledger
 * enumeration).
 */
class FakeClientWithGoals extends FakeClient {
  override async enumerateLedgers(): Promise<LedgerSummary[]> {
    const base = await super.enumerateLedgers();
    return [...base, { name: "goals", itemCount: 1 }].sort((a, b) => a.name.localeCompare(b.name));
  }
  override async fetchLedger(ledgerId: string): Promise<FetchedLedger> {
    if (ledgerId !== "goals") return super.fetchLedger(ledgerId);
    return {
      id: "goals",
      schema: {
        statusValues: ["open", "done"],
        terminalStatuses: ["done"],
        fields: { title: { type: "string", required: true } },
        idPrefix: "G",
      },
      counters: { milestone: 1, item: 1 },
      milestones: [
        {
          id: "M1",
          milestone: { id: "M1", status: "open", title: "Bootstrap", description: "" },
          items: [
            {
              id: "G1",
              milestoneId: "M1",
              status: "open",
              fields: { title: "Ship G83" },
              createdAt: GOALS_TS,
              updatedAt: GOALS_TS,
            },
          ],
        },
      ],
      archivePointers: [],
    };
  }
}

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

async function mount(client: FakeClient = new FakeClient()): Promise<void> {
  fake = client;
  await act(async () => {
    root.render(createElement(App, { connect: async () => fake, initialUrl: "http://x/mcp" }));
  });
  await flush(); // resolve connect + enumerateLedgers
}

async function openLedger(name: string): Promise<void> {
  click(testid(`ledger-${name}`));
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

describe("ledger-web finalize menu", () => {
  it("renders 'finalize-btn' right after the '+ item' control on the milestones view", async () => {
    await mount();
    await openLedger("milestones");
    const toolbar = testid("new-item-or-milestone")?.parentElement ?? null;
    expect(toolbar).not.toBeNull();
    const children = Array.from(toolbar!.children);
    const newItemIdx = children.indexOf(testid("new-item-or-milestone")!);
    // finalize-btn's toolbar-level ancestor (the wrapper the button renders
    // inside) must sit immediately after the '+ item'/'+ milestone' control.
    const finalizeWrapperIdx = children.findIndex((c) => c.contains(testid("finalize-btn")));
    expect(finalizeWrapperIdx).toBe(newItemIdx + 1);
  });

  it("opens a menu with exactly the two finalize options, and Escape closes it", async () => {
    await mount();
    await openLedger("milestones");

    expect(testid("finalize-menu")).toBeNull();
    click(testid("finalize-btn"));
    await flush();

    const menu = testid("finalize-menu");
    expect(menu).not.toBeNull();
    const applyDone = testid("finalize-option-apply-done");
    const archive = testid("finalize-option-archive");
    expect(applyDone).not.toBeNull();
    expect(archive).not.toBeNull();
    expect(applyDone?.textContent).toBe("Apply Done to completed items");
    expect(archive?.textContent).toBe("Archive all Done items");
    // Exactly two options in the menu.
    expect(menu!.querySelectorAll('[data-testid^="finalize-option-"]').length).toBe(2);

    press("Escape");
    await flush();
    expect(testid("finalize-menu")).toBeNull();
  });

  it("is absent on the tasks view", async () => {
    await mount();
    await openLedger("tasks");
    expect(testid("finalize-btn")).toBeNull();
  });

  it("renders 'finalize-btn' on the goals view too", async () => {
    await mount(new FakeClientWithGoals());
    await openLedger("goals");
    expect(testid("finalize-btn")).not.toBeNull();
  });

  it("picking 'apply-done' raises the preview state and closes the menu", async () => {
    await mount();
    await openLedger("milestones");
    click(testid("finalize-btn"));
    await flush();
    expect(testid("finalize-preview-mode")).toBeNull();

    click(testid("finalize-option-apply-done"));
    await flush();
    expect(testid("finalize-menu")).toBeNull();
    expect(testid("finalize-preview-mode")?.textContent).toBe("apply-done");
  });

  it("picking 'archive' raises the preview state and closes the menu", async () => {
    await mount();
    await openLedger("milestones");
    click(testid("finalize-btn"));
    await flush();

    click(testid("finalize-option-archive"));
    await flush();
    expect(testid("finalize-menu")).toBeNull();
    expect(testid("finalize-preview-mode")?.textContent).toBe("archive");
  });

  it("resets the finalize preview/menu state on a ledger switch", async () => {
    await mount();
    await openLedger("milestones");
    click(testid("finalize-btn"));
    await flush();
    click(testid("finalize-option-archive"));
    await flush();
    expect(testid("finalize-preview-mode")?.textContent).toBe("archive");

    await openLedger("tasks");
    expect(testid("finalize-preview-mode")).toBeNull();
    expect(testid("finalize-menu")).toBeNull();

    // Switching back to milestones must not resurrect the stale preview.
    await openLedger("milestones");
    expect(testid("finalize-preview-mode")).toBeNull();
  });
});
