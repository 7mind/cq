/**
 * T414 — paired raw-log toggle + RawLogViewer test (web-only).
 *
 * Verifies that, in the DetailPanel SessionLogsPanel:
 *  - an item with sessionLogs + a paired (same-stem) rawLogs entry shows a
 *    "raw" toggle next to the summary log link;
 *  - clicking the toggle for a `.jsonl` rawLogs entry calls onReadLog with the
 *    .jsonl path and renders the T412-parsed conversation (a role label appears
 *    and a tool_use turn is collapsible: a <details>/<summary>);
 *  - a non-.jsonl rawLogs entry (pi `.md`) opens via the existing markdown
 *    LogModal path (Markdown blob, not the structured viewer);
 *  - an item with sessionLogs but NO paired rawLogs shows no raw toggle.
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { FakeClient } from "./fakeClient";

const TS = "2026-01-01T00:00:00.000Z";

const SUMMARY_PATH = ".cq/logs/20260101-1200-session.md";
const RAW_JSONL_PATH = ".cq/logs/raw/20260101-1200-session.jsonl";
// Second summary whose paired raw transcript is a pi `.md` shellout (non-jsonl).
const PI_SUMMARY_PATH = ".cq/logs/20260102-1300-pi.md";
const PI_RAW_MD_PATH = ".cq/logs/raw/20260102-1300-pi.md";

// A minimal Claude-Code JSONL transcript: a user prompt, an assistant turn with
// a tool_use block, and a tool_result.
const JSONL = [
  JSON.stringify({ type: "user", message: { role: "user", content: "do the thing" } }),
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "running a command" },
        { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file1\nfile2" }],
    },
  }),
].join("\n");

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
  const data = (fake as unknown as { data: Record<string, { groups: Array<{ id: string; items: Array<Record<string, unknown>> }> }> }).data;
  // Item with sessionLogs + paired rawLogs (one .jsonl, one pi .md).
  data["bugs"]!.groups[0]!.items.push({
    id: "D20",
    milestoneId: "M1",
    status: "open",
    fields: {
      headline: "raw-log item",
      sessionLogs: [SUMMARY_PATH, PI_SUMMARY_PATH],
      rawLogs: [RAW_JSONL_PATH, PI_RAW_MD_PATH],
    },
    createdAt: TS,
    updatedAt: TS,
  });
  // Item with sessionLogs but NO rawLogs.
  data["bugs"]!.groups[0]!.items.push({
    id: "D21",
    milestoneId: "M1",
    status: "open",
    fields: {
      headline: "no-raw item",
      sessionLogs: [SUMMARY_PATH],
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

async function selectD20(): Promise<void> {
  click(testid("ledger-bugs"));
  await flush();
  click(testid("item-D20"));
  await flush();
}

describe("RawLogViewer + paired raw toggle (T414)", () => {
  it("shows a raw toggle next to a summary log that has a paired rawLogs entry", async () => {
    await mount();
    await selectD20();
    expect(testid(`log-link-${SUMMARY_PATH}`)).not.toBeNull();
    expect(testid(`log-raw-toggle-${SUMMARY_PATH}`)).not.toBeNull();
    expect(testid(`log-raw-toggle-${PI_SUMMARY_PATH}`)).not.toBeNull();
  });

  it("clicking the raw toggle for a .jsonl entry calls onReadLog with the .jsonl path and renders the parsed conversation", async () => {
    await mount();
    fake.readLogResults.set(RAW_JSONL_PATH, { path: RAW_JSONL_PATH, content: JSONL });

    await selectD20();
    click(testid(`log-raw-toggle-${SUMMARY_PATH}`));
    await flush();

    // Opened the .jsonl raw transcript (not the .md summary).
    expect(testid("log-modal-path")?.textContent).toBe(RAW_JSONL_PATH);
    // Structured viewer, not a markdown blob.
    expect(testid("raw-log-viewer")).not.toBeNull();
    expect(testid("log-modal-content")).toBeNull();

    // A role label appears.
    const roles = container.querySelectorAll('[data-testid="raw-turn-role"]');
    const roleTexts = Array.from(roles).map((r) => r.textContent ?? "");
    expect(roleTexts.some((t) => t.includes("assistant"))).toBe(true);

    // A tool_use turn is collapsible (<details>).
    const toolUse = testid("raw-turn-tool_use");
    expect(toolUse).not.toBeNull();
    expect(toolUse?.tagName.toLowerCase()).toBe("details");
    expect(toolUse?.querySelector("summary")).not.toBeNull();
    expect(toolUse?.textContent).toContain("Bash");
  });

  it("opens a non-.jsonl (pi .md) raw entry via the existing markdown modal", async () => {
    await mount();
    fake.readLogResults.set(PI_RAW_MD_PATH, { path: PI_RAW_MD_PATH, content: "# pi raw log\nsome text" });

    await selectD20();
    click(testid(`log-raw-toggle-${PI_SUMMARY_PATH}`));
    await flush();

    expect(testid("log-modal-path")?.textContent).toBe(PI_RAW_MD_PATH);
    // Markdown path, not the structured viewer.
    expect(testid("log-modal-content")).not.toBeNull();
    expect(testid("raw-log-viewer")).toBeNull();
    expect(testid("log-modal-content")?.textContent).toContain("pi raw log");
  });

  it("shows NO raw toggle for an item with sessionLogs but no rawLogs", async () => {
    await mount();
    click(testid("ledger-bugs"));
    await flush();
    click(testid("item-D21"));
    await flush();

    expect(testid("session-logs-section")).not.toBeNull();
    expect(testid(`log-link-${SUMMARY_PATH}`)).not.toBeNull();
    expect(testid(`log-raw-toggle-${SUMMARY_PATH}`)).toBeNull();
  });
});
