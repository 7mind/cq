import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { FakeClient } from "./fakeClient";

const sleep = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function flush(): Promise<void> {
  await act(async () => {
    await sleep(10);
  });
}

let container: HTMLElement;
let root: Root;
const testid = (id: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${id}"]`);

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

describe("T819 upstreamBlocked indicator", () => {
  it("shows exact blocked task ids and hides when empty", async () => {
    const client = new FakeClient();
    client.derivePredicatesResult.upstreamBlocked = { value: true, items: ["T9"] };
    await act(async () => {
      root.render(createElement(App, { connect: async () => client, initialUrl: "http://x/mcp" }));
    });
    await flush();
    expect(testid("upstream-blocked-indicator")?.textContent ?? "").toContain("T9");

    client.derivePredicatesResult.upstreamBlocked = { value: false, items: [] };
    await act(async () => {
      root.render(createElement(App, { connect: async () => client, initialUrl: "http://x/mcp" }));
    });
    await flush();
    expect(testid("upstream-blocked-indicator")).toBeNull();
  });
});
