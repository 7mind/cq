import { registerDom } from "./helpers/dom.js";
registerDom();

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ItemReferenceChip } from "../src/ItemReferenceChip.js";
import type { ReferencePreviewResult } from "../src/referenceLookup.js";

let container: HTMLDivElement;
let root: Root;

const found: ReferencePreviewResult = {
  kind: "found",
  ledger: "tasks",
  id: "T1",
  status: "done",
  summary: "resolved task",
};

beforeEach(() => {
  container = document.createElement("div");
  container.className = "lw-detail-wrap";
  const detail = document.createElement("div");
  detail.className = "lw-detail";
  container.appendChild(detail);
  document.body.appendChild(container);
  root = createRoot(detail);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.querySelectorAll(".lw-ref-preview").forEach((node) => node.remove());
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function chip(): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(".lw-ref-chip");
  if (element === null) throw new Error("chip absent");
  return element;
}

describe("ItemReferenceChip", () => {
  it("opens on hover/focus, renders loading then summary, and portals outside both clippers", async () => {
    let release: ((value: ReferencePreviewResult) => void) | null = null;
    const resolve = (): Promise<ReferencePreviewResult> => new Promise((done) => { release = done; });
    await act(async () => {
      root.render(createElement(ItemReferenceChip, {
        text: "T1",
        reference: { ledger: "tasks", id: "T1" },
        resolve,
      }));
    });

    act(() => chip().dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(document.body.querySelector(".lw-ref-preview")?.textContent).toContain("loading");
    await act(async () => { release?.(found); });
    const preview = document.body.querySelector<HTMLElement>(".lw-ref-preview");
    expect(preview?.textContent).toContain("resolved task");
    expect(container.contains(preview)).toBe(false);
    expect(container.querySelector(".lw-detail")?.contains(preview ?? null)).toBe(false);

    act(() => chip().dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
    expect(document.body.querySelector(".lw-ref-preview")).toBeNull();
    act(() => chip().focus());
    await flush();
    expect(document.body.querySelector(".lw-ref-preview")).not.toBeNull();
    act(() => chip().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.body.querySelector(".lw-ref-preview")).toBeNull();
  });

  it("navigates by click and Enter only after a reference resolves", async () => {
    const navigated: string[] = [];
    await act(async () => {
      root.render(createElement(ItemReferenceChip, {
        text: "T1",
        reference: { ledger: "tasks", id: "T1" },
        resolve: async () => found,
        onNavigate: (ledger: string, id: string) => navigated.push(`${ledger}:${id}`),
      }));
    });
    act(() => chip().click());
    await flush();
    act(() => chip().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await flush();
    expect(navigated).toEqual(["tasks:T1", "tasks:T1"]);

    navigated.length = 0;
    await act(async () => {
      root.render(createElement(ItemReferenceChip, {
        text: "T404",
        reference: { ledger: "tasks", id: "T404" },
        resolve: async (): Promise<ReferencePreviewResult> => ({ kind: "not-found", ledger: "tasks", id: "T404" }),
        onNavigate: (ledger: string, id: string) => navigated.push(`${ledger}:${id}`),
      }));
    });
    act(() => chip().click());
    await flush();
    expect(navigated).toEqual([]);
    expect(document.body.querySelector(".lw-ref-preview")?.textContent).toContain("not found");
  });

  it("ignores a lookup completion after the rendered reference changes", async () => {
    let releaseOld: ((value: ReferencePreviewResult) => void) | null = null;
    const navigated: string[] = [];
    const resolve = (reference: { ledger: string; id: string }): Promise<ReferencePreviewResult> => {
      if (reference.id === "T1") {
        return new Promise((done) => { releaseOld = done; });
      }
      return Promise.resolve({
        kind: "found",
        ledger: "reviews",
        id: "R2",
        status: "open",
        summary: "current review",
      });
    };
    await act(async () => {
      root.render(createElement(ItemReferenceChip, {
        text: "T1",
        reference: { ledger: "tasks", id: "T1" },
        resolve,
        onNavigate: (ledger: string, id: string) => navigated.push(`${ledger}:${id}`),
      }));
    });
    act(() => chip().click());
    await act(async () => {
      root.render(createElement(ItemReferenceChip, {
        text: "R2",
        reference: { ledger: "reviews", id: "R2" },
        resolve,
        onNavigate: (ledger: string, id: string) => navigated.push(`${ledger}:${id}`),
      }));
    });
    await act(async () => { releaseOld?.(found); });
    expect(document.body.textContent).not.toContain("resolved task");
    expect(navigated).toEqual([]);

    act(() => chip().click());
    await flush();
    expect(document.body.querySelector(".lw-ref-preview")?.textContent).toContain("current review");
    expect(navigated).toEqual(["reviews:R2"]);
  });

  it("clamps fixed popup placement at viewport edges and dismisses on blur", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 200 });
    await act(async () => {
      root.render(createElement(ItemReferenceChip, {
        text: "T1",
        reference: { ledger: "tasks", id: "T1" },
        resolve: async () => found,
      }));
    });
    chip().getBoundingClientRect = () => ({
      x: 300, y: 180, left: 300, top: 180, right: 330, bottom: 200,
      width: 30, height: 20, toJSON: () => ({}),
    });
    act(() => chip().focus());
    await flush();
    const preview = document.body.querySelector<HTMLElement>(".lw-ref-preview");
    expect(preview?.style.position).toBe("fixed");
    expect(Number.parseInt(preview?.style.left ?? "999", 10)).toBeGreaterThanOrEqual(8);
    expect(Number.parseInt(preview?.style.left ?? "999", 10)).toBeLessThanOrEqual(8);
    expect(Number.parseInt(preview?.style.top ?? "999", 10)).toBeLessThan(180);
    act(() => chip().blur());
    expect(document.body.querySelector(".lw-ref-preview")).toBeNull();
  });

  it("defines distinct chips, visible focus, bounded preview geometry, and explicit stacking", () => {
    const css = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8");
    expect(css).toMatch(/\.lw-ref-chip\s*\{[^}]*border:/s);
    expect(css).toMatch(/\.lw-ref-chip:focus-visible\s*\{[^}]*outline:/s);
    expect(css).toMatch(/\.lw-ref-preview\s*\{[^}]*z-index:\s*1000/s);
    expect(css).toMatch(/\.lw-ref-preview\s*\{[^}]*width:\s*min\(/s);
    expect(css).toMatch(/\.lw-ref-preview\s*\{[^}]*max-height:\s*min\(/s);
  });
});
