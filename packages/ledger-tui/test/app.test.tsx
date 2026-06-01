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
import type { FetchedLedger, Item, LedgerClient } from "../src/types.js";

const DOWN = "[B";
const ENTER = "\r";
const ESC = "\u001b";

const TS = "2026-01-01T00:00:00.000Z";

/** A client with a single ledger of N items, for the scroll test. */
class ManyItemsClient implements LedgerClient {
  constructor(private readonly n: number) {}
  async enumerateLedgers(): Promise<string[]> {
    return ["work"];
  }
  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id !== "work") throw new Error(`Ledger not found: ${id}`);
    const items: Item[] = Array.from({ length: this.n }, (_, i) => ({
      id: `T${i}`,
      milestoneId: "active",
      status: "open",
      fields: { headline: `task ${i}` },
      createdAt: TS,
      updatedAt: TS,
    }));
    return {
      id: "work",
      schema: {
        statusValues: ["open", "done"],
        terminalStatuses: ["done"],
        fields: { headline: { type: "string", required: true } },
      },
      counters: { milestone: 1, item: this.n + 1 },
      milestones: [
        { id: "active", milestone: { id: "active", status: "open", title: "", description: "" }, items },
      ],
      archivePointers: [],
    };
  }
  async fetchItem(): Promise<Item> {
    throw new Error("not used");
  }
  async createItem(): Promise<Item> {
    throw new Error("not used");
  }
  async updateItem(): Promise<Item> {
    throw new Error("not used");
  }
  async ftsSearch(): Promise<never[]> {
    return [];
  }
  async createMilestone(): Promise<Item> {
    throw new Error("not used");
  }
  async updateMilestone(): Promise<Item> {
    throw new Error("not used");
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

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

/** Poll the rendered frame until it contains `substr` (robust to async steps). */
async function waitFor(h: Harness, substr: string, ms = 1500): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (h.frame().includes(substr)) return;
    await tick(10);
  }
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
    await h.key("n"); // new item -> pick milestone (async: fetches milestones)
    await waitFor(h, "Bootstrap"); // milestone-pick overlay rendered
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

  it("shows the path (ledger → milestone → item) in the header", async () => {
    const h = await mount();
    await h.key(ENTER); // open bugs (cursor 0)
    expect(h.frame()).toContain("bugs → M1 → D1");
    h.unmount();
  });

  it("shows the highlighted item's detail in the content pane (two-pane)", async () => {
    const h = await mount();
    await h.key(ENTER); // open bugs; D1 auto-highlighted → content pane shows it
    await tick(60);
    const f = h.frame();
    // content pane shows the item's field labels + values (no second Enter needed)
    expect(f).toContain("headline");
    expect(f).toContain("note");
    expect(f).toContain("intermittent");
    // markdown is rendered (see markdownText.test.tsx for the renderer itself)
    h.unmount();
  });

  it("preserves the list position when going back with Esc", async () => {
    const h = await mount();
    await h.key(DOWN); // bugs → milestones
    await h.key(ENTER); // open milestones
    await h.key(ESC); // Esc → back to ledgers
    // cursor must still be on milestones (the › marker), not reset to bugs
    expect(h.frame()).toContain("› milestones");
    h.unmount();
  });
});

describe("ledger-tui scrolling", () => {
  it("scrolls a long list and shows a scrollbar", async () => {
    const client = new ManyItemsClient(60);
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open the only ledger
    await tick(40);
    const first = r.lastFrame() ?? "";
    expect(first).toContain("T0 "); // top item visible
    expect(first).toContain("█"); // scrollbar thumb present (list overflows)
    expect(first).not.toContain("T59 "); // last item not in the initial window
    // page down to the bottom
    for (let i = 0; i < 59; i++) {
      r.stdin.write(DOWN);
      await tick(4);
    }
    await tick(40);
    expect(r.lastFrame() ?? "").toContain("T59 "); // scrolled into view
    r.unmount();
  });
});

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

describe("ledger-tui live updates", () => {
  it("shows a live badge and refetches the current frame on a pushed change", async () => {
    FakeWS.instances = [];
    const client = new FakeClient();
    const r = render(
      <App client={client} liveUrl="ws://x/ws" liveWsCtor={FakeWS as unknown as { new (u: string): WebSocket }} />,
    );
    await tick();
    expect(FakeWS.instances.length).toBeGreaterThanOrEqual(1);
    FakeWS.instances[0]!.open();
    await tick(20);
    expect(r.lastFrame() ?? "").toContain("live");

    r.stdin.write(ENTER); // open bugs
    await tick(30);
    expect(r.lastFrame() ?? "").not.toContain("pushed-tui");

    await client.createItem("bugs", "M1", { status: "open", fields: { headline: "pushed-tui" } });
    FakeWS.instances[0]!.push({ type: "changed", ledger: "bugs" });
    await tick(60);
    expect(r.lastFrame() ?? "").toContain("pushed-tui");
    r.unmount();
  });
});
