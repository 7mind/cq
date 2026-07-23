/**
 * Tests for the goalDrift REPORT-ONLY warning indicator (G84/D113, T611):
 * a header/status-area warning, fed by the `derive_predicates` MCP tool's
 * `goalDrift` verdict, visible only when `goalDrift.value` is true and
 * listing the drifted goal ids. Refreshed on the same WS 'changed' path the
 * header progress bars use (see headerProgressBars.test.tsx).
 */

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

// ---------------------------------------------------------------------------
// Minimal fake WebSocket for live-refresh tests (mirrors headerProgressBars.test.tsx).
// ---------------------------------------------------------------------------

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

describe("goalDrift warning indicator (G84/D113, T611)", () => {
  it("renders the warning indicator with the drifted goal id when goalDrift.value is true", async () => {
    const client = new FakeClient();
    client.derivePredicatesResult.goalDrift = { value: true, items: ["G7"] };

    await act(async () => {
      root.render(createElement(App, { connect: async () => client, initialUrl: "http://x/mcp" }));
    });
    await flush();

    const indicator = testid("goal-drift-indicator");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent ?? "").toContain("G7");
  });

  it("renders NO indicator when goalDrift.value is false", async () => {
    const client = new FakeClient();
    client.derivePredicatesResult.goalDrift = { value: false, items: [] };

    await act(async () => {
      root.render(createElement(App, { connect: async () => client, initialUrl: "http://x/mcp" }));
    });
    await flush();

    expect(testid("goal-drift-indicator")).toBeNull();
  });

  it("refreshes the indicator on a simulated 'changed' WS push", async () => {
    FakeWS.instances = [];
    const client = new FakeClient();
    client.derivePredicatesResult.goalDrift = { value: false, items: [] };

    await act(async () => {
      root.render(
        createElement(App, {
          connect: async () => client,
          initialUrl: "http://x/mcp",
          liveUrl: "ws://x/ws",
          liveWsCtor: FakeWS as unknown as { new (url: string): WebSocket },
        }),
      );
    });
    await flush();

    // Verify initial state: no drift, no indicator.
    expect(testid("goal-drift-indicator")).toBeNull();

    // Simulate the server detecting drift on a goal.
    client.derivePredicatesResult.goalDrift = { value: true, items: ["G9"] };

    // Trigger a 'changed' WS push → App re-derives predicates.
    const ws = FakeWS.instances[0]!;
    act(() => ws.open());
    await flush();
    act(() => ws.push({ type: "changed", ledger: "goals" }));
    await flush();

    const indicator = testid("goal-drift-indicator");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent ?? "").toContain("G9");
  });
});
