/**
 * T82: CSS column proportions — colgroup acceptance test.
 *
 * Verifies that each web table variant emits a <colgroup> that sizes
 * id/status/extra-columns to content (lw-col-narrow) and leaves the summary
 * column unsized so it takes the remaining width.
 *
 * Table variants tested:
 *   1. SubsectionItemTable (non-milestones per-milestone subsections)
 *      columns: id(narrow), status(narrow), summary(none), …extraColumns(narrow)
 *   2. Milestones flat table (isMilestones=true)
 *      columns: milestone(narrow), id(narrow), status(narrow), summary(none), …extraColumns(narrow)
 *   3. ArchiveSubsections (uses SubsectionItemTable with extraColumns=[])
 *      same colgroup shape as variant 1 with no extra columns
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

const q = (sel: string): Element | null => container.querySelector(sel);
const testid = (id: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${id}"]`);

function click(el: Element | null): void {
  if (el === null) throw new Error("click: element not found");
  act(() => {
    (el as HTMLElement).click();
  });
}

async function mount(): Promise<void> {
  fake = new FakeClient();
  await act(async () => {
    root.render(createElement(App, { connect: async () => fake, initialUrl: "http://x/mcp" }));
  });
  await flush();
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

/** Return the <col> elements inside the first <colgroup> of the first table that
 *  is a descendant of `root`. */
function colsOf(root: Element): Element[] {
  const cg = root.querySelector("colgroup");
  if (cg === null) return [];
  return Array.from(cg.querySelectorAll("col"));
}

describe("T82 — colgroup column proportions", () => {
  it("subsection table (non-milestones): id/status are narrow, summary is unsized", async () => {
    await mount();
    await openLedger("bugs"); // non-milestones ledger → subsection layout

    // At least one subsection table should be rendered.
    const table = q("table.lw-table");
    expect(table).not.toBeNull();

    const cols = colsOf(table!);
    // Without extra columns: 3 cols — id(narrow), status(narrow), summary(none).
    expect(cols.length).toBe(3);
    expect(cols[0]!.className).toBe("lw-col-narrow"); // id
    expect(cols[1]!.className).toBe("lw-col-narrow"); // status
    expect(cols[2]!.className).toBe("");               // summary — takes remaining width
  });

  it("subsection table with extra columns: extra cols are narrow", async () => {
    await mount();
    await openLedger("tasks"); // defaultColumns("tasks") seeds suggestedModel

    const table = q("table.lw-table");
    expect(table).not.toBeNull();

    const cols = colsOf(table!);
    // 4 cols: id(narrow), status(narrow), summary(none), suggestedModel(narrow).
    expect(cols.length).toBe(4);
    expect(cols[0]!.className).toBe("lw-col-narrow"); // id
    expect(cols[1]!.className).toBe("lw-col-narrow"); // status
    expect(cols[2]!.className).toBe("");               // summary
    expect(cols[3]!.className).toBe("lw-col-narrow"); // suggestedModel (extra)
  });

  it("milestones flat table: milestone/id/status are narrow, summary is unsized", async () => {
    await mount();
    await openLedger("milestones"); // isMilestones=true → flat table

    const table = q("table.lw-table");
    expect(table).not.toBeNull();

    const cols = colsOf(table!);
    // Without extra columns: 4 cols — milestone(narrow), id(narrow), status(narrow), summary(none).
    expect(cols.length).toBe(4);
    expect(cols[0]!.className).toBe("lw-col-narrow"); // milestone
    expect(cols[1]!.className).toBe("lw-col-narrow"); // id
    expect(cols[2]!.className).toBe("lw-col-narrow"); // status
    expect(cols[3]!.className).toBe("");               // summary — takes remaining width
  });

  it("archive subsections table: id/status are narrow, summary is unsized", async () => {
    await mount();
    await openLedger("bugs"); // bugs ledger has archive pointers A1, A2

    // Show archived sections.
    click(testid("toggle-archive"));
    await flush();

    // Expand the first archive section (A1) so its table renders.
    click(testid("ms-toggle-A1"));
    await flush(); // triggers lazy fetch + render

    // The archive section should now have a table.
    const archiveSection = testid("archive-section");
    expect(archiveSection).not.toBeNull();
    const table = archiveSection!.querySelector("table.lw-table");
    expect(table).not.toBeNull();

    const cols = colsOf(table!);
    // Archive uses SubsectionItemTable with extraColumns=[]: 3 cols.
    expect(cols.length).toBe(3);
    expect(cols[0]!.className).toBe("lw-col-narrow"); // id
    expect(cols[1]!.className).toBe("lw-col-narrow"); // status
    expect(cols[2]!.className).toBe("");               // summary
  });
});
