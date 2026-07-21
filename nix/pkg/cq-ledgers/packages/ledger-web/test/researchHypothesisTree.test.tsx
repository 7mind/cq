/**
 * Tests for the researches → linked-hypothesis-tree detail panel (T561,
 * G80/M246, Q262).
 *
 * The FakeClient is seeded with:
 *  - a "researches" ledger: RS1 (question/scope/findings/conclusion/
 *    recommendation fields) and RS2 (no linked hypotheses)
 *  - a "hypothesis" ledger: H1 (root, ledgerRefs=["researches:RS1"]) → H2
 *    (child of H1, SAME ledgerRefs) — both linked to RS1, NOT to any defect —
 *    plus H9 which links only to a defect (ledgerRefs=["defects:D1"], no
 *    researches ref anywhere) to confirm hypothesis handling never hard-codes
 *    "defects:" as the only possible owning ref.
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { FakeClient } from "./fakeClient";

const TS = "2026-01-01T00:00:00.000Z";

const sleep = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function flush(): Promise<void> {
  await act(async () => {
    await sleep(10);
  });
}

let container: HTMLElement;
let root: Root;
let fake: FakeClient;

const q = (sel: string): HTMLElement | null => container.querySelector(sel);
const testid = (id: string): HTMLElement | null => q(`[data-testid="${id}"]`);

function click(el: Element | null): void {
  if (el === null) throw new Error("click: element not found");
  act(() => {
    (el as HTMLElement).click();
  });
}

/**
 * Extends FakeClient with a canonical "researches" ledger and a "hypothesis"
 * ledger, by monkey-patching the private `data` map after construction
 * (mirroring RelationshipsClient in relationships.test.tsx).
 */
class ResearchClient extends FakeClient {
  constructor() {
    super();
    const data = (this as unknown as { data: Record<string, unknown> }).data;
    data["researches"] = {
      schema: {
        statusValues: ["open", "wip", "concluded", "inconclusive", "abandoned"],
        terminalStatuses: ["concluded", "abandoned"],
        idPrefix: "RS",
        transitions: {
          open: ["wip", "abandoned"],
          wip: ["concluded", "inconclusive", "abandoned"],
          inconclusive: ["wip", "abandoned"],
          concluded: [],
          abandoned: [],
        },
        fields: {
          question: { type: "string", required: true },
          scope: { type: "string", required: false },
          findings: { type: "string", required: false },
          conclusion: { type: "string", required: false },
          recommendation: { type: "string", required: false },
        },
      },
      groups: [
        {
          id: "M1",
          items: [
            {
              id: "RS1",
              milestoneId: "M1",
              status: "concluded",
              fields: {
                question: "does the widget leak memory under load?",
                scope: "the widget subsystem only",
                findings: "confirmed a leak in the connection pool",
                conclusion: "the pool never releases closed connections",
                recommendation: "close connections eagerly in the pool's release path",
              },
              createdAt: TS,
              updatedAt: TS,
            },
            {
              id: "RS2",
              milestoneId: "M1",
              status: "open",
              fields: { question: "is the cache thread-safe?" },
              createdAt: TS,
              updatedAt: TS,
            },
          ],
        },
      ],
    };
    data["hypothesis"] = {
      schema: {
        statusValues: ["open", "confirmed", "wrong"],
        terminalStatuses: ["confirmed", "wrong"],
        idPrefix: "H",
        transitions: { open: ["confirmed", "wrong"], confirmed: [], wrong: [] },
        fields: {
          headline: { type: "string", required: true },
          parentHypothesis: { type: "id", required: false },
          ledgerRefs: { type: "id[]", required: false },
        },
      },
      groups: [
        {
          id: "M1",
          items: [
            {
              id: "H1",
              milestoneId: "M1",
              status: "confirmed",
              fields: { headline: "root cause is the connection pool", ledgerRefs: ["researches:RS1"] },
              createdAt: TS,
              updatedAt: TS,
            },
            {
              id: "H2",
              milestoneId: "M1",
              status: "open",
              fields: {
                headline: "narrower: only pooled TLS connections leak",
                parentHypothesis: "H1",
                ledgerRefs: ["researches:RS1"],
              },
              createdAt: TS,
              updatedAt: TS,
            },
            {
              id: "H9",
              milestoneId: "M1",
              status: "open",
              // Linked ONLY to a defect — no researches ref anywhere. Exists
              // to confirm ordinary defect-linked hypotheses still render.
              fields: { headline: "unrelated defect hypothesis", ledgerRefs: ["defects:D1"] },
              createdAt: TS,
              updatedAt: TS,
            },
          ],
        },
      ],
    };
  }
}

async function mount(): Promise<void> {
  fake = new ResearchClient();
  await act(async () => {
    root.render(createElement(App, { connect: async () => fake, initialUrl: "http://x/mcp" }));
  });
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

describe("researches detail view: linked hypothesis tree (T561)", () => {
  it("renders the hypothesis tree for a research with two linked hypotheses", async () => {
    await mount();
    click(testid("ledger-researches"));
    await flush();
    click(testid("item-RS1"));
    // Wait for the aux hypothesis fetch to complete.
    await act(async () => { await sleep(30); });

    expect(testid("research-hypothesis-tree-section")).not.toBeNull();
    // H1 (root) and H2 (its child) are both linked to RS1 and must appear.
    expect(testid("research-hyp-H1")).not.toBeNull();
    expect(testid("research-hyp-H2")).not.toBeNull();
    // H9 links only to a defect, not RS1 — must NOT appear.
    expect(testid("research-hyp-H9")).toBeNull();
  });

  it("nests H2 as a child of H1 rather than as a second root", async () => {
    await mount();
    click(testid("ledger-researches"));
    await flush();
    click(testid("item-RS1"));
    await act(async () => { await sleep(30); });

    const h1 = testid("research-hyp-H1");
    const h2 = testid("research-hyp-H2");
    expect(h1).not.toBeNull();
    expect(h2).not.toBeNull();
    // H2's row is contained within H1's <li>, not a sibling root <li>.
    const h1Li = h1!.closest("li");
    expect(h1Li?.contains(h2)).toBe(true);
  });

  it("renders the conclusion and recommendation fields as markdown", async () => {
    await mount();
    click(testid("ledger-researches"));
    await flush();
    click(testid("item-RS1"));
    await flush();

    expect(testid("detail")?.textContent).toContain("the pool never releases closed connections");
    expect(testid("detail")?.textContent).toContain("close connections eagerly in the pool's release path");
  });

  it("renders the scope and findings fields", async () => {
    await mount();
    click(testid("ledger-researches"));
    await flush();
    click(testid("item-RS1"));
    await flush();

    expect(testid("detail")?.textContent).toContain("the widget subsystem only");
    expect(testid("detail")?.textContent).toContain("confirmed a leak in the connection pool");
  });

  it("shows no hypothesis-tree section for a research with no linked hypotheses", async () => {
    await mount();
    click(testid("ledger-researches"));
    await flush();
    click(testid("item-RS2"));
    await act(async () => { await sleep(30); });

    expect(testid("research-hypothesis-tree-section")).toBeNull();
  });

  it("clicking a linked hypothesis navigates to the hypothesis ledger and selects it", async () => {
    await mount();
    click(testid("ledger-researches"));
    await flush();
    click(testid("item-RS1"));
    await act(async () => { await sleep(30); });

    click(testid("research-hyp-H1"));
    await flush();

    expect(testid("detail-id")?.textContent).toBe("H1");
    expect(testid("item-H1")).not.toBeNull();
  });

  it("does not show the research hypothesis-tree section for non-research ledgers", async () => {
    await mount();
    click(testid("ledger-hypothesis"));
    await flush();
    click(testid("item-H1"));
    await flush();

    expect(testid("research-hypothesis-tree-section")).toBeNull();
  });
});

describe("hypothesis with no defect anywhere (T561, audit part b)", () => {
  it("renders a standalone research-linked hypothesis without error", async () => {
    await mount();
    click(testid("ledger-hypothesis"));
    await flush();
    click(testid("item-H1"));
    await flush();

    // H1 links only researches:RS1 — no "defects:" ref exists on it at all.
    // Rendering its own detail (the ordinary hypothesis-ledger ancestry/
    // children panel) must not assume a defect owning ref anywhere.
    expect(testid("detail-id")?.textContent).toBe("H1");
    expect(testid("hypothesis-tree-section")).not.toBeNull();
    expect(testid("hypothesis-children")).not.toBeNull();
    expect(testid("child-H2")).not.toBeNull();
  });
});
