/**
 * ledger-web finalize-menu test (T619).
 *
 * Drives <App> under happy-dom with the in-memory FakeClient to cover the
 * toolbar 'Finalize' control that is wired for the milestones/goals views:
 *  1. on the milestones view, a 'finalize-btn' button renders immediately
 *     after the '+ item'/'+ milestone' control;
 *  2. clicking it opens a menu with exactly the two labeled options;
 *  3. Escape closes the menu;
 *  4. the button is absent on a non-milestones/goals view (tasks).
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
});
