/**
 * Behavioral-Active Blackbox-Group workset manager contract against the
 * hand-written LedgerClient dummy. The real MCP adapter shares its workset
 * contract in T1992; this file owns browser interaction and stale-response
 * behavior only.
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WorksetRequest, WorksetResultFor } from "@cq/ledger";
import { App } from "../src/App.js";
import type { LedgerClient } from "../src/types.js";
import { FakeClient } from "./fakeClient.js";

let container: HTMLElement;
let root: Root;

const sleep = (ms = 15): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function flush(): Promise<void> {
  await act(async () => {
    await sleep(10);
  });
}

function testid(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

function click(element: Element | null): void {
  if (element === null) throw new Error("click: element not found");
  act(() => {
    (element as HTMLElement).click();
  });
}

function press(key: string): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function pressOn(element: Element | null, key: string): void {
  if (element === null) throw new Error("pressOn: element not found");
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function setInput(element: Element | null, value: string): void {
  if (element === null) throw new Error("setInput: element not found");
  act(() => {
    const input = element as HTMLInputElement;
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value");
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function seedWorkset(fake: FakeClient, roots: readonly string[]): Promise<void> {
  await fake.workset({ op: "set", roots });
  fake.worksetCalls.length = 0;
}

async function mount(client: FakeClient = new FakeClient()): Promise<void> {
  await act(async () => {
    root.render(
      createElement(App, {
        connect: async () => client,
        initialUrl: "http://x/mcp",
      }),
    );
  });
  await flush();
}

async function openWorkset(): Promise<void> {
  click(testid("workset-toggle"));
  await flush();
}

function addRootByPointer(ref: string): void {
  setInput(testid("workset-root-input"), ref);
  click(testid("workset-add-root"));
}

function addRootByKeyboard(ref: string): void {
  const input = testid("workset-root-input");
  if (document.activeElement !== input) throw new Error("workset root input is not focused");
  setInput(input, ref);
  pressOn(document.activeElement, "Enter");
}

type WorksetOperation = WorksetRequest["op"];

class DeferredWorksetClient extends FakeClient {
  private readonly deferCounts = new Map<WorksetOperation, number>();
  private readonly pending: Array<{ op: WorksetOperation; release: () => void }> = [];

  deferNext(op: WorksetOperation): void {
    this.deferCounts.set(op, (this.deferCounts.get(op) ?? 0) + 1);
  }

  pendingCount(op: WorksetOperation): number {
    return this.pending.filter((entry) => entry.op === op).length;
  }

  releaseNext(op: WorksetOperation): void {
    const index = this.pending.findIndex((entry) => entry.op === op);
    const entry = index < 0 ? undefined : this.pending.splice(index, 1)[0];
    if (entry === undefined) throw new Error(`releaseNext: no pending ${op}`);
    entry.release();
  }

  override async workset<R extends WorksetRequest>(request: R): Promise<WorksetResultFor<R>> {
    const result = await super.workset(request);
    const remaining = this.deferCounts.get(request.op) ?? 0;
    if (remaining === 0) return result;
    this.deferCounts.set(request.op, remaining - 1);
    await new Promise<void>((release) => this.pending.push({ op: request.op, release }));
    return result;
  }
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

describe("web workset manager", () => {
  it("loads the compact current graph and renders roots, nodes, and edges", async () => {
    const fake = new FakeClient();
    await fake.updateItem("tasks", "T1", { fields: { dependsOn: ["tasks:T2"] } });
    await seedWorkset(fake, ["milestones:M1"]);
    await mount(fake);

    await openWorkset();

    expect(fake.worksetCalls).toEqual([{ op: "get", projection: "compact" }]);
    expect(testid("workset-current-root-milestones:M1")?.textContent).toContain("milestones:M1");
    expect(testid("workset-current-node-milestones:M1")?.textContent).toContain("Bootstrap");
    expect(testid("workset-current-node-tasks:T1")?.textContent).toContain("wire toolbar");
    expect(testid("workset-current-node-tasks:T2")?.textContent).toContain("persist columns");
    expect(testid("workset-current-edge-0")?.textContent).toContain(
      "tasks:T1 prerequisite tasks:T2",
    );
    expect(testid("workset-current-restrictive")?.textContent).toContain("prioritized");
  });

  it("does not expose draft editing until a delayed initial get has hydrated it", async () => {
    const fake = new DeferredWorksetClient();
    await seedWorkset(fake, ["tasks:T1"]);
    fake.deferNext("get");
    await mount(fake);
    await openWorkset();

    expect(fake.pendingCount("get")).toBe(1);
    expect(testid("workset-loading")).not.toBeNull();
    expect(testid("workset-root-input")).toBeNull();
    expect(testid("workset-apply")).toBeNull();

    fake.releaseNext("get");
    await flush();
    expect(testid("workset-root-input")).not.toBeNull();
    expect(testid("workset-current-root-tasks:T1")).not.toBeNull();
    expect(testid("workset-draft-root-tasks:T1")).not.toBeNull();
  });

  it("adds by pointer, removes a root, applies the exact draft, and refreshes current state", async () => {
    const fake = new FakeClient();
    await seedWorkset(fake, ["milestones:M1", "tasks:T2"]);
    await mount(fake);
    await openWorkset();

    addRootByPointer("T1");
    click(testid("workset-remove-tasks:T2"));
    click(testid("workset-apply"));
    await flush();

    expect(fake.worksetCalls).toEqual([
      { op: "get", projection: "compact" },
      { op: "set", roots: ["milestones:M1", "T1"] },
      { op: "get", projection: "compact" },
    ]);
    expect(testid("workset-current-root-tasks:T1")).not.toBeNull();
    expect(testid("workset-current-root-tasks:T2")).toBeNull();
    expect(testid("workset-epoch")?.textContent).toBe("applied epoch 2");
  });

  it("adds by Enter and previews a canonical graph without mutating persisted roots", async () => {
    const fake = new FakeClient();
    await seedWorkset(fake, ["milestones:M1"]);
    await mount(fake);
    await openWorkset();

    addRootByKeyboard("T2");
    click(testid("workset-preview"));
    await flush();

    expect(fake.worksetCalls).toEqual([
      { op: "get", projection: "compact" },
      { op: "fetch", roots: ["milestones:M1", "T2"], projection: "compact" },
    ]);
    expect(testid("workset-draft-root-tasks:T2")).not.toBeNull();
    expect(document.activeElement).toBe(testid("workset-root-input"));
    expect(testid("workset-preview-node-tasks:T2")?.textContent).toContain("persist columns");
    expect(testid("workset-current-root-tasks:T2")).toBeNull();

    const persisted = await fake.workset({ op: "get", projection: "id" });
    expect(persisted.graph.roots).toEqual(["milestones:M1"]);
    expect(fake.worksetCalls.some((call) => call.op === "set")).toBe(false);
  });

  it("applies an empty draft as an explicit clear and renders no prioritization", async () => {
    const fake = new FakeClient();
    await seedWorkset(fake, ["tasks:T2"]);
    await mount(fake);
    await openWorkset();

    click(testid("workset-clear"));
    click(testid("workset-apply"));
    await flush();

    expect(fake.worksetCalls).toEqual([
      { op: "get", projection: "compact" },
      { op: "set", roots: [] },
      { op: "get", projection: "compact" },
    ]);
    expect(testid("workset-current-empty")?.textContent).toContain("no prioritization");
    expect(testid("workset-current-restrictive")?.textContent).toContain("unrestricted");
  });

  it("keeps the visible draft after preview validation and set failures", async () => {
    const fake = new FakeClient();
    await seedWorkset(fake, ["milestones:M1"]);
    await mount(fake);
    await openWorkset();

    addRootByKeyboard("tasks:T999");
    click(testid("workset-preview"));
    await flush();

    expect(testid("workset-error")?.textContent).toContain("inactive");
    expect(testid("workset-draft-root-tasks:T999")).not.toBeNull();
    expect(testid("workset-current-root-milestones:M1")).not.toBeNull();

    click(testid("workset-remove-tasks:T999"));
    addRootByPointer("tasks:T2");
    fake.worksetFailure = new Error("replacement denied");
    click(testid("workset-apply"));
    await flush();
    fake.worksetFailure = null;

    expect(testid("workset-error")?.textContent).toContain("replacement denied");
    expect(testid("workset-draft-root-tasks:T2")).not.toBeNull();
    expect(testid("workset-current-root-tasks:T2")).toBeNull();
  });

  it("drops an out-of-order preview after the draft revision advances", async () => {
    const fake = new DeferredWorksetClient();
    await mount(fake);
    await openWorkset();

    addRootByPointer("tasks:T1");
    fake.deferNext("fetch");
    click(testid("workset-preview"));
    await flush();
    expect(fake.pendingCount("fetch")).toBe(1);

    click(testid("workset-remove-tasks:T1"));
    addRootByKeyboard("tasks:T2");
    click(testid("workset-preview"));
    await flush();
    expect(testid("workset-preview-node-tasks:T2")).not.toBeNull();
    expect(testid("workset-preview-node-tasks:T1")).toBeNull();

    fake.releaseNext("fetch");
    await flush();
    expect(testid("workset-preview-node-tasks:T2")).not.toBeNull();
    expect(testid("workset-preview-node-tasks:T1")).toBeNull();
    expect(testid("workset-draft-root-tasks:T2")).not.toBeNull();
  });

  it("fences a stale post-set refresh by modal generation and acknowledgement epoch", async () => {
    const fake = new DeferredWorksetClient();
    await mount(fake);
    await openWorkset();

    addRootByPointer("tasks:T1");
    fake.deferNext("get");
    click(testid("workset-apply"));
    await flush();
    expect(fake.pendingCount("get")).toBe(1);
    expect(testid("workset-epoch")?.textContent).toBe("applied epoch 1");

    press("Escape");
    expect(testid("workset-modal")).toBeNull();
    await openWorkset();
    click(testid("workset-remove-tasks:T1"));
    addRootByPointer("tasks:T2");
    click(testid("workset-apply"));
    await flush();
    expect(testid("workset-epoch")?.textContent).toBe("applied epoch 2");
    expect(testid("workset-current-root-tasks:T2")).not.toBeNull();

    fake.releaseNext("get");
    await flush();
    expect(testid("workset-epoch")?.textContent).toBe("applied epoch 2");
    expect(testid("workset-current-root-tasks:T2")).not.toBeNull();
    expect(testid("workset-current-root-tasks:T1")).toBeNull();
  });

  it("fences a stale project load even when reconnect returns the same client object", async () => {
    const fake = new DeferredWorksetClient("Project One");
    fake.projects = [
      { key: "p1", displayName: "Project One" },
      { key: "p2", displayName: "Project Two" },
    ];
    await seedWorkset(fake, ["tasks:T1"]);
    fake.deferNext("get");
    const connectedUrls: string[] = [];
    const connect = async (url: string): Promise<LedgerClient> => {
      connectedUrls.push(url);
      return fake;
    };
    await act(async () => {
      root.render(
        createElement(App, {
          connect,
          initialUrl: "http://x/p/p1/mcp",
        }),
      );
    });
    await flush();
    await openWorkset();
    expect(fake.pendingCount("get")).toBe(1);
    press("Escape");

    await fake.workset({ op: "set", roots: ["tasks:T2"] });
    click(testid("app-title"));
    click(testid("project-option-p2"));
    await flush();
    await openWorkset();
    expect(testid("workset-current-root-tasks:T2")).not.toBeNull();

    fake.releaseNext("get");
    await flush();
    expect(connectedUrls).toEqual(["http://x/p/p1/mcp", "http://x/p/p2/mcp"]);
    expect(testid("workset-current-root-tasks:T2")).not.toBeNull();
    expect(testid("workset-current-root-tasks:T1")).toBeNull();
  });

  it("uses the shared guarded backdrop behavior and Escape dismissal", async () => {
    await mount();
    await openWorkset();
    const backdrop = testid("workset-backdrop");
    const modal = testid("workset-modal");
    if (backdrop === null || modal === null) throw new Error("expected workset modal");

    act(() => {
      modal.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      backdrop.click();
    });
    expect(testid("workset-modal")).not.toBeNull();

    act(() => {
      backdrop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      backdrop.click();
    });
    expect(testid("workset-modal")).toBeNull();

    await openWorkset();
    press("Escape");
    expect(testid("workset-modal")).toBeNull();
  });
});
