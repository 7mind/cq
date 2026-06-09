/**
 * Tests for terminal-node visual distinction in {@link DiagramSvg} (T333).
 *
 * A terminal node (terminal===true) must render its rect with rx=4 and a
 * thicker stroke (2.5); a non-terminal node must use rx=14 and stroke=1.
 * These constants match RX_TERMINAL/RX_NORMAL and STROKE_TERMINAL/STROKE_NORMAL
 * in DiagramSvg.tsx — the renderer already keys on `n.terminal`.
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DiagramSvg } from "../src/DiagramSvg";
import type { LaidOutDiagram } from "../src/diagramLayout";

function model(): LaidOutDiagram {
  return {
    width: 400,
    height: 200,
    edges: [],
    nodes: [
      {
        id: "terminal-node",
        label: "terminal",
        x: 0,
        y: 0,
        w: 120,
        h: 40,
        terminal: true,
        fill: "#4ea1ff",
      },
      {
        id: "normal-node",
        label: "normal",
        x: 0,
        y: 80,
        w: 120,
        h: 40,
        terminal: false,
        fill: "#57d18a",
      },
    ],
  };
}

async function mount(
  el: React.ReactElement,
): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(el);
  });
  return { container, root };
}

async function unmount(container: HTMLDivElement, root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

describe("DiagramSvg terminal node rendering (T333)", () => {
  it("a terminal node's rect uses rx=4", async () => {
    const { container, root } = await mount(
      createElement(DiagramSvg, { idPrefix: "diag", model: model() }),
    );

    const rect = container.querySelector('[data-testid="diag-rect-terminal-node"]');
    expect(rect).not.toBeNull();
    expect(rect!.getAttribute("rx")).toBe("4");

    await unmount(container, root);
  });

  it("a non-terminal node's rect uses rx=14", async () => {
    const { container, root } = await mount(
      createElement(DiagramSvg, { idPrefix: "diag", model: model() }),
    );

    const rect = container.querySelector('[data-testid="diag-rect-normal-node"]');
    expect(rect).not.toBeNull();
    expect(rect!.getAttribute("rx")).toBe("14");

    await unmount(container, root);
  });

  it("terminal node rect has strokeWidth=2.5 and normal node has strokeWidth=1", async () => {
    const { container, root } = await mount(
      createElement(DiagramSvg, { idPrefix: "diag", model: model() }),
    );

    const termRect = container.querySelector('[data-testid="diag-rect-terminal-node"]');
    const normRect = container.querySelector('[data-testid="diag-rect-normal-node"]');
    expect(termRect!.getAttribute("stroke-width")).toBe("2.5");
    expect(normRect!.getAttribute("stroke-width")).toBe("1");

    await unmount(container, root);
  });
});
