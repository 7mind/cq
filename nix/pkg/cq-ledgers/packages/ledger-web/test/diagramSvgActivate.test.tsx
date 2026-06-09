/**
 * Tests for the FU-4 renderer foundation in {@link DiagramSvg} (T326):
 *   - a node carrying `agentId` (with an `onActivateAgent` handler) renders as
 *     an activatable button: click AND Enter AND Space invoke the handler with
 *     that id; the <g> has role="button", tabIndex=0, cursor:pointer;
 *   - a node WITHOUT `agentId` stays static — no role="button", no onClick,
 *     clicking it does nothing;
 *   - fill resolution is unchanged: an authored `fill` renders verbatim, a node
 *     without one renders DEFAULT_FILL (renderer keeps `n.fill ?? DEFAULT_FILL`,
 *     locked Q181 — no fillForRoleKind in the renderer).
 *
 * happy-dom is registered so React can mount the SVG and dispatch DOM events.
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DiagramSvg } from "../src/DiagramSvg";
import type { LaidOutDiagram } from "../src/diagramLayout";

const DEFAULT_FILL = "#8b93a7";
const AUTHORED_FILL = "#4ea1ff";

// A pre-laid-out model (no elk needed): one agentId node, one plain node.
function model(): LaidOutDiagram {
  return {
    width: 400,
    height: 200,
    edges: [],
    nodes: [
      {
        id: "agent",
        label: "agent",
        x: 0,
        y: 0,
        w: 120,
        h: 40,
        terminal: false,
        fill: AUTHORED_FILL,
        agentId: "wt-T326",
      },
      {
        id: "plain",
        label: "plain",
        x: 0,
        y: 80,
        w: 120,
        h: 40,
        terminal: false,
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

describe("DiagramSvg agentId activation (T326)", () => {
  it("a node with agentId is a button: click, Enter, and Space invoke onActivateAgent with its id", async () => {
    const calls: string[] = [];
    const { container, root } = await mount(
      createElement(DiagramSvg, {
        idPrefix: "diag",
        model: model(),
        onActivateAgent: (id: string) => calls.push(id),
      }),
    );

    const node = container.querySelector(
      '[data-testid="diag-node-agent"]',
    ) as HTMLElement;
    expect(node).not.toBeNull();
    expect(node.getAttribute("role")).toBe("button");
    expect(node.getAttribute("tabindex")).toBe("0");
    expect(node.style.cursor).toBe("pointer");

    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      node.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await act(async () => {
      node.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true }),
      );
    });

    expect(calls).toEqual(["wt-T326", "wt-T326", "wt-T326"]);

    await unmount(container, root);
  });

  it("a node without agentId is static: no role=button, no handler, click is inert", async () => {
    const calls: string[] = [];
    const { container, root } = await mount(
      createElement(DiagramSvg, {
        idPrefix: "diag",
        model: model(),
        onActivateAgent: (id: string) => calls.push(id),
      }),
    );

    const plain = container.querySelector(
      '[data-testid="diag-node-plain"]',
    ) as HTMLElement;
    expect(plain).not.toBeNull();
    expect(plain.getAttribute("role")).toBeNull();
    expect(plain.style.cursor).toBe("");

    await act(async () => {
      plain.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(calls).toEqual([]);

    await unmount(container, root);
  });

  it("activatable node label has text-decoration:underline; plain node label has none (T332)", async () => {
    const { container, root } = await mount(
      createElement(DiagramSvg, {
        idPrefix: "diag",
        model: model(),
        onActivateAgent: (_id: string) => {},
      }),
    );

    // The <text> element is a child of the <g> node group.
    const agentGroup = container.querySelector('[data-testid="diag-node-agent"]');
    const plainGroup = container.querySelector('[data-testid="diag-node-plain"]');
    const agentLabel = agentGroup?.querySelector("text") as SVGTextElement | null;
    const plainLabel = plainGroup?.querySelector("text") as SVGTextElement | null;

    expect(agentLabel).not.toBeNull();
    expect(plainLabel).not.toBeNull();

    // happy-dom exposes inline styles via the style attribute or CSSStyleDeclaration
    expect((agentLabel as SVGTextElement).style.textDecoration).toBe("underline");
    expect((plainLabel as SVGTextElement).style.textDecoration).toBe("");

    await unmount(container, root);
  });

  it("renders authored fill verbatim and DEFAULT_FILL otherwise (n.fill ?? DEFAULT_FILL unchanged)", async () => {
    const { container, root } = await mount(
      createElement(DiagramSvg, { idPrefix: "diag", model: model() }),
    );

    const authored = container.querySelector('[data-testid="diag-rect-agent"]');
    const fallback = container.querySelector('[data-testid="diag-rect-plain"]');
    expect(authored!.getAttribute("fill")).toBe(AUTHORED_FILL);
    expect(fallback!.getAttribute("fill")).toBe(DEFAULT_FILL);

    await unmount(container, root);
  });

  // Edge labels render directly on the help-panel background (var(--panel) ===
  // #171a21). A hard-coded dark fill made them invisible in the dark theme. They
  // must use the themed foreground var(--fg); node labels (on a filled rect) keep
  // the dark #171a21 fill.
  it("edge labels use themed var(--fg) fill (not the #171a21 panel background); node labels keep #171a21", async () => {
    const withEdge: LaidOutDiagram = {
      width: 400,
      height: 200,
      edges: [
        {
          from: "agent",
          to: "plain",
          points: [
            { x: 60, y: 40 },
            { x: 60, y: 80 },
          ],
          label: "dispatches",
          labelPos: { x: 60, y: 60 },
        },
      ],
      nodes: model().nodes,
    };
    const { container, root } = await mount(
      createElement(DiagramSvg, { idPrefix: "diag", model: withEdge }),
    );

    const edgeLabel = container.querySelector(
      '[data-testid="diag-edge-label-agent-plain-0"]',
    );
    expect(edgeLabel).not.toBeNull();
    expect(edgeLabel!.getAttribute("fill")).toBe("var(--fg)");
    expect(edgeLabel!.getAttribute("fill")).not.toBe("#171a21");

    // Node labels (on a filled rect) stay the dark fill for contrast.
    const nodeLabel = container
      .querySelector('[data-testid="diag-node-plain"]')
      ?.querySelector("text");
    expect(nodeLabel!.getAttribute("fill")).toBe("#171a21");

    await unmount(container, root);
  });
});
