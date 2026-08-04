/**
 * T1515 — the TUI usage-stats overlay (I20/G155): `u` fetches
 * getUsageStats on mount and renders a compact endpoint / calls / bytesIn /
 * bytesOut table plus a totals row; Esc closes. The binding is advertised in
 * the footer help text.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/app.js";
import { FakeClient } from "./fakeClient.js";

const ESC = "";

const tick = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Harness {
  frame: () => string;
  key: (s: string) => Promise<void>;
  unmount: () => void;
}

async function mount(client: FakeClient): Promise<Harness> {
  const r = render(<App client={client} />);
  await tick();
  return {
    frame: () => r.lastFrame() ?? "",
    key: async (s: string) => {
      r.stdin.write(s);
      await tick();
    },
    unmount: r.unmount,
  };
}

async function waitFor(h: Harness, substr: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (h.frame().includes(substr)) return;
    await tick(10);
  }
  throw new Error(`waitFor: '${substr}' never appeared; frame:\n${h.frame()}`);
}

/** Press Esc until `marker` disappears from the frame (drop-resilient). */
async function escapeUntilGone(h: Harness, marker: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!h.frame().includes(marker)) return;
    await h.key(ESC);
  }
  throw new Error(`escapeUntilGone: '${marker}' still showing; frame:\n${h.frame()}`);
}

describe("TUI usage-stats overlay (T1515)", () => {
  it("u opens the overlay against a seeded client and renders endpoint rows plus totals; Esc closes", async () => {
    const client = new FakeClient();
    client.usageStats = {
      endpoints: [
        { name: "fetch_ledger", callCount: 3, bytesIn: 120, bytesOut: 4560 },
        { name: "update_item", callCount: 1, bytesIn: 40, bytesOut: 200 },
      ],
      totals: { name: "totals", callCount: 4, bytesIn: 160, bytesOut: 4760 },
    };
    const h = await mount(client);
    expect(h.frame()).toContain("u usage"); // footer help advertises the binding
    await h.key("u");
    await waitFor(h, "fetch_ledger");
    expect(h.frame()).toContain("usage stats");
    expect(h.frame()).toMatch(/endpoint\s+calls\s+bytesIn\s+bytesOut/);
    expect(h.frame()).toMatch(/fetch_ledger\s+3\s+120\s+4560/);
    expect(h.frame()).toMatch(/update_item\s+1\s+40\s+200/);
    expect(h.frame()).toMatch(/totals\s+4\s+160\s+4760/);
    await escapeUntilGone(h, "usage stats"); // Esc closes
    h.unmount();
  });

  it("empty snapshot renders the empty state plus a zero totals row", async () => {
    const h = await mount(new FakeClient());
    await h.key("u");
    await waitFor(h, "(no recorded calls)");
    expect(h.frame()).toMatch(/totals\s+0\s+0\s+0/);
    await escapeUntilGone(h, "usage stats");
    h.unmount();
  });
});
