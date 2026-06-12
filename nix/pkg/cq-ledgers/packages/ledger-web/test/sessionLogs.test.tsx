/**
 * T152 — sessionLogs clickable-links popup test.
 *
 * Verifies that an item with a `sessionLogs` string[] field renders a "logs"
 * section where each path is a clickable link; clicking opens a modal that
 * fetches content via `onReadLog` (FakeClient.readLog); truncated logs show
 * a notice; a read_log error renders a message, not a crash; closing the modal
 * works via the ✕ button.
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
  if (el === null) throw new Error(`click: element not found`);
  act(() => {
    (el as HTMLElement).click();
  });
}

async function mount(): Promise<void> {
  fake = new FakeClient();
  // Inject an item with sessionLogs into the bugs ledger.
  // Access private data via index (mirrors the RelationshipsClient pattern).
  const data = (fake as unknown as { data: Record<string, { groups: Array<{ id: string; items: Array<Record<string, unknown>> }> }> }).data;
  data["bugs"]!.groups[0]!.items.push({
    id: "D10",
    milestoneId: "M1",
    status: "open",
    fields: {
      headline: "session-log item",
      sessionLogs: [".cq/logs/20260101-1200-session.md", ".cq/logs/20260102-1300-other.md"],
    },
    createdAt: TS,
    updatedAt: TS,
  });
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

describe("sessionLogs panel (T152)", () => {
  it("renders a logs section with clickable links for each sessionLog path", async () => {
    await mount();
    click(testid("ledger-bugs"));
    await flush();
    click(testid("item-D10"));
    await flush();

    const section = testid("session-logs-section");
    expect(section).not.toBeNull();
    expect(testid("log-link-.cq/logs/20260101-1200-session.md")).not.toBeNull();
    expect(testid("log-link-.cq/logs/20260102-1300-other.md")).not.toBeNull();
  });

  it("opens a modal and fetches log content when a link is clicked", async () => {
    await mount();
    fake.readLogResults.set(".cq/logs/20260101-1200-session.md", {
      path: ".cq/logs/20260101-1200-session.md",
      content: "line1\nline2\nline3",
    });

    click(testid("ledger-bugs"));
    await flush();
    click(testid("item-D10"));
    await flush();

    click(testid("log-link-.cq/logs/20260101-1200-session.md"));
    await flush();

    expect(testid("log-modal")).not.toBeNull();
    expect(testid("log-modal-path")?.textContent).toBe(".cq/logs/20260101-1200-session.md");
    expect(testid("log-modal-content")?.textContent).toContain("line1");
    expect(testid("log-modal-truncated")).toBeNull();
  });

  it("shows a truncation notice when the log result has truncated:true", async () => {
    await mount();
    fake.readLogResults.set(".cq/logs/20260101-1200-session.md", {
      path: ".cq/logs/20260101-1200-session.md",
      content: "partial content…",
      truncated: true,
    });

    click(testid("ledger-bugs"));
    await flush();
    click(testid("item-D10"));
    await flush();
    click(testid("log-link-.cq/logs/20260101-1200-session.md"));
    await flush();

    expect(testid("log-modal-truncated")).not.toBeNull();
    expect(testid("log-modal-content")?.textContent).toContain("partial content");
  });

  it("renders an error message (not a crash) when read_log rejects", async () => {
    await mount();
    fake.readLogResults.set(
      ".cq/logs/20260101-1200-session.md",
      new Error("log not found"),
    );

    click(testid("ledger-bugs"));
    await flush();
    click(testid("item-D10"));
    await flush();
    click(testid("log-link-.cq/logs/20260101-1200-session.md"));
    await flush();

    expect(testid("log-modal")).not.toBeNull();
    expect(testid("log-modal-error")?.textContent).toContain("log not found");
    expect(testid("log-modal-content")).toBeNull();
  });

  it("closes the modal when the ✕ button is clicked", async () => {
    await mount();
    click(testid("ledger-bugs"));
    await flush();
    click(testid("item-D10"));
    await flush();
    click(testid("log-link-.cq/logs/20260101-1200-session.md"));
    await flush();

    expect(testid("log-modal")).not.toBeNull();
    click(testid("log-modal-close"));
    await flush();
    expect(testid("log-modal")).toBeNull();
  });

  it("shows no logs section for an item without sessionLogs", async () => {
    await mount();
    click(testid("ledger-bugs"));
    await flush();
    click(testid("item-D1")); // D1 has no sessionLogs
    await flush();

    expect(testid("session-logs-section")).toBeNull();
  });
});
