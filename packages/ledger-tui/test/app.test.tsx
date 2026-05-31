/**
 * ledger-tui UI tests.
 *
 * Drive the Ink <App> with the in-memory FakeClient via ink-testing-library:
 * assert rendered frames and simulate keystrokes to cover navigation
 * (ledgers → items → detail), search, and the edit/create flows.
 *
 * Keystrokes are sent one at a time with an await between them: ink parses
 * one keypress per stdin data chunk, so two synchronous writes would coalesce
 * into a single chunk and drop the second key.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/app.js";
import { FakeClient } from "./fakeClient.js";

const DOWN = "[B";
const ENTER = "\r";

const tick = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Harness {
  client: FakeClient;
  frame: () => string;
  key: (s: string) => Promise<void>;
  unmount: () => void;
}

async function mount(): Promise<Harness> {
  const client = new FakeClient();
  const r = render(<App client={client} />);
  await tick(); // let enumerateLedgers resolve
  return {
    client,
    frame: () => r.lastFrame() ?? "",
    key: async (s: string) => {
      r.stdin.write(s);
      await tick();
    },
    unmount: r.unmount,
  };
}

/** Type a string one character at a time (distinct stdin chunks). */
async function type(h: Harness, text: string): Promise<void> {
  for (const ch of text) await h.key(ch);
}

describe("ledger-tui App", () => {
  it("lists ledgers on connect", async () => {
    const h = await mount();
    expect(h.frame()).toContain("bugs");
    expect(h.frame()).toContain("milestones");
    h.unmount();
  });

  it("opens a ledger and shows its items", async () => {
    const h = await mount();
    await h.key(ENTER); // open bugs (cursor starts at index 0)
    expect(h.frame()).toContain("D1");
    expect(h.frame()).toContain("warp leak");
    h.unmount();
  });

  it("opens item detail showing fields", async () => {
    const h = await mount();
    await h.key(ENTER); // bugs
    await h.key(ENTER); // detail D1
    expect(h.frame()).toContain("D1");
    expect(h.frame()).toContain("headline");
    expect(h.frame()).toContain("intermittent");
    h.unmount();
  });

  it("edits an item's status through the status picker", async () => {
    const h = await mount();
    await h.key(ENTER); // bugs
    await h.key(ENTER); // detail D1
    await h.key("s"); // status picker: open/wip/closed
    await h.key(DOWN); // -> wip
    await h.key(ENTER);
    await tick(40);
    expect(h.frame()).toContain("D1 → wip");
    expect((await h.client.fetchItem("bugs", "D1")).status).toBe("wip");
    h.unmount();
  });

  it("edits an item field value", async () => {
    const h = await mount();
    await h.key(ENTER); // bugs
    await h.key(ENTER); // detail D1
    await h.key("e"); // pick field (headline is first)
    await h.key(ENTER); // choose 'headline'
    await type(h, " fixed"); // append to the prefilled value
    await h.key(ENTER);
    await tick(40);
    expect((await h.client.fetchItem("bugs", "D1")).fields["headline"]).toBe("warp leak fixed");
    h.unmount();
  });

  it("creates a milestone in the milestones ledger", async () => {
    const h = await mount();
    await h.key(DOWN); // bugs -> milestones
    await h.key(ENTER); // open milestones
    await h.key("n"); // new milestone
    await type(h, "Phase Two");
    await h.key(ENTER);
    await tick(40);
    const ms = await h.client.fetchLedger("milestones");
    const titles = ms.milestones.flatMap((g) => g.items.map((i) => i.fields["title"]));
    expect(titles).toContain("Phase Two");
    expect(h.frame()).toContain("created M2");
    h.unmount();
  });

  it("creates an item via the multi-step form", async () => {
    const h = await mount();
    await h.key(ENTER); // bugs
    await h.key("n"); // new item -> pick milestone
    await h.key(ENTER); // choose M1
    await h.key(ENTER); // choose status 'open' (index 0)
    await type(h, "ion drive misalignment"); // headline*
    await h.key(ENTER);
    await h.key(ENTER); // note (optional) left empty
    await tick(40);
    const ledger = await h.client.fetchLedger("bugs");
    const headlines = ledger.milestones.flatMap((g) => g.items.map((i) => i.fields["headline"]));
    expect(headlines).toContain("ion drive misalignment");
    h.unmount();
  });

  it("searches across ledgers and opens a hit", async () => {
    const h = await mount();
    await h.key("/"); // search from ledgers
    await type(h, "warp");
    await h.key(ENTER);
    await tick(40);
    expect(h.frame()).toContain("bugs/D1");
    await h.key(ENTER); // open the hit -> detail
    await tick(40);
    expect(h.frame()).toContain("headline");
    h.unmount();
  });
});
