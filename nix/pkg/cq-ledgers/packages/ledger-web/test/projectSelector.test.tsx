/**
 * T589 (G81, Q276/Q284 lock): the always-visible project selector.
 *
 * Q276 supersedes Q284's hide-when-single recommendation — the selector is
 * ALWAYS rendered, switch-only, listing whatever `list_projects` answers:
 *  - embedded/xdg single-project mode: exactly one entry, switch is a no-op;
 *  - a multi-project `cq serve` hub: N entries, switching reconnects the
 *    LedgerClient to `/p/<key>/mcp` and re-points the live-updates WS to
 *    `/p/<key>/ws`, tearing down the old subscription.
 *
 * The `<select>` is CONTROLLED (fine under happy-dom per the project's
 * uncontrolled-input convention, which applies to TEXT inputs only — no text
 * input is introduced here).
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { FakeClient } from "./fakeClient";
import type { LedgerClient } from "../src/types.js";

let container: HTMLElement;
let root: Root;

const sleep = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function flush(): Promise<void> {
  await act(async () => {
    await sleep(10);
  });
}
const q = (sel: string): HTMLElement | null => container.querySelector(sel);
const testid = (id: string): HTMLElement | null => q(`[data-testid="${id}"]`);
const text = (): string => container.textContent ?? "";

function click(el: Element | null): void {
  if (el === null) throw new Error("click: element not found");
  act(() => {
    (el as HTMLElement).click();
  });
}
/** Drive a controlled <select> the same way app.test.tsx does. */
function setValue(el: Element | null, value: string): void {
  if (el === null) throw new Error("setValue: element not found");
  act(() => {
    const node = el as HTMLSelectElement;
    node.focus();
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value");
    desc?.set?.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "about:blank");
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

describe("project selector — embedded/xdg single-project mode", () => {
  it("renders exactly one entry, and switching to it is a no-op", async () => {
    const fake = new FakeClient("cq1");
    const connectedUrls: string[] = [];
    const connect = async (url: string): Promise<LedgerClient> => {
      connectedUrls.push(url);
      return fake;
    };
    await act(async () => {
      root.render(createElement(App, { connect, initialUrl: "http://x/mcp" }));
    });
    await flush();

    const select = testid("project-selector") as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    const options = Array.from(select!.querySelectorAll("option"));
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toBe("cq1");
    expect(select!.value).toBe("cq1");

    // "Switching" to the already-active (only) entry must not reconnect.
    expect(connectedUrls).toHaveLength(1);
    setValue(select, "cq1");
    await flush();
    expect(connectedUrls).toHaveLength(1);
  });
});

describe("project selector — multi-project hub", () => {
  /** Build a project's FakeClient: shares the two-entry registry, distinct data. */
  function makeProject(displayName: string): FakeClient {
    const c = new FakeClient(displayName);
    c.projects = [
      { key: "p1", displayName: "Project One" },
      { key: "p2", displayName: "Project Two" },
    ];
    return c;
  }

  it("renders N entries; switching reconnects MCP + ws and re-renders from the new project's data", async () => {
    const p1 = makeProject("Project One");
    const p2 = makeProject("Project Two");
    // Distinguish p2's data from p1's so a re-render is observable.
    await p2.createItem("bugs", "M1", { status: "open", fields: { headline: "only in project two" } });

    const connectedUrls: string[] = [];
    const connect = async (url: string): Promise<LedgerClient> => {
      connectedUrls.push(url);
      return url.includes("/p/p2/mcp") ? p2 : p1;
    };

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
    FakeWS.instances = [];

    await act(async () => {
      root.render(
        createElement(App, {
          connect,
          initialUrl: "http://x/p/p1/mcp",
          liveUrl: "ws://x/p/p1/ws",
          liveWsCtor: FakeWS as unknown as { new (url: string): WebSocket },
        }),
      );
    });
    await flush();

    // Boots against p1: one connect call, the selector lists both projects,
    // active = p1, and one live ws opened against p1's topic.
    expect(connectedUrls).toEqual(["http://x/p/p1/mcp"]);
    const select = testid("project-selector") as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    const options = Array.from(select!.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual(["Project One", "Project Two"]);
    expect(select!.value).toBe("p1");
    expect(FakeWS.instances).toHaveLength(1);
    expect(FakeWS.instances[0]!.url).toBe("ws://x/p/p1/ws");
    act(() => FakeWS.instances[0]!.open());
    await flush();

    // p1's bugs ledger does NOT have the p2-only item.
    click(testid("ledger-bugs"));
    await flush();
    expect(text()).not.toContain("only in project two");

    // Switch to p2 via the selector.
    setValue(select, "p2");
    await flush();

    // A new MCP connect was issued to /p/p2/mcp, and a new ws opened to /p/p2/ws
    // (the old p1 ws subscription is torn down — a fresh FakeWS is constructed).
    expect(connectedUrls).toEqual(["http://x/p/p1/mcp", "http://x/p/p2/mcp"]);
    expect(FakeWS.instances).toHaveLength(2);
    expect(FakeWS.instances[1]!.url).toBe("ws://x/p/p2/ws");
    expect(select!.value).toBe("p2");
    // The URL persists the choice (?project=<key>) for reloads/shared links.
    expect(window.location.search).toContain("project=p2");

    // Views re-render from the new project's (p2's) data.
    click(testid("ledger-bugs"));
    await flush();
    expect(text()).toContain("only in project two");

    // A changedFrame over the ACTIVE (p2) ws drives the same onChanged refresh.
    act(() => FakeWS.instances[1]!.open());
    await flush();
    await p2.createItem("bugs", "M1", { status: "open", fields: { headline: "pushed after switch" } });
    act(() => FakeWS.instances[1]!.push({ type: "changed", ledger: "bugs" }));
    await flush();
    expect(text()).toContain("pushed after switch");
  });
});
