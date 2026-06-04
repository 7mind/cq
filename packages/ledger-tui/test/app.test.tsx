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
import { App, buildItemEntries } from "../src/app.js";
import { FakeClient } from "./fakeClient.js";
import type { ArchiveContent, FetchedLedger, Item, LedgerClient, LedgerSummary } from "../src/types.js";
import type { Milestone } from "@cq/ledger";
import { MILESTONES_SCHEMA } from "@cq/ledger";

const DOWN = "[B";
const LEFT = "[D";
const RIGHT = "[C";
const ENTER = "\r";
const ESC = "\u001b";
const CTRL_R = "\u0012"; // ctrl+r -> ink key.ctrl + input "r"

const TS = "2026-01-01T00:00:00.000Z";

/** A client with a single ledger of N items, for the scroll test. */
class ManyItemsClient implements LedgerClient {
  constructor(private readonly n: number) {}
  displayName(): string { return "cq1"; }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [{ name: "work", itemCount: this.n }];
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
  async fetchLedgerArchive(): Promise<ArchiveContent> {
    throw new Error("not used");
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

/** A single-ledger client whose schema declares NO `transitions` map. */
class NoTransitionsClient implements LedgerClient {
  displayName(): string { return "cq1"; }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [{ name: "work", itemCount: 1 }];
  }
  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id !== "work") throw new Error(`Ledger not found: ${id}`);
    return {
      id: "work",
      schema: {
        statusValues: ["todo", "doing", "done"],
        terminalStatuses: ["done"],
        fields: { headline: { type: "string", required: true } },
        // no `transitions` → quick-transition picker falls back to all statuses
      },
      counters: { milestone: 1, item: 2 },
      milestones: [
        {
          id: "active",
          milestone: { id: "active", status: "open", title: "", description: "" },
          items: [
            { id: "T1", milestoneId: "active", status: "todo", fields: { headline: "thing" }, createdAt: TS, updatedAt: TS },
          ],
        },
      ],
      archivePointers: [],
    };
  }
  async fetchLedgerArchive(): Promise<ArchiveContent> {
    throw new Error("not used");
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

/** Poll the rendered frame until it contains `substr`. */
async function waitFor(h: Harness, substr: string, ms = 1500): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (h.frame().includes(substr)) return;
    await tick(10);
  }
  throw new Error(`waitFor: '${substr}' never appeared`);
}

/** Poll a raw frame getter until it contains `substr`. */
async function waitForFrame(getFrame: () => string, substr: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (getFrame().includes(substr)) return;
    await tick(10);
  }
  throw new Error(`waitForFrame: '${substr}' never appeared`);
}

/**
 * Advance a multi-step overlay one step by pressing Enter, resilient to a
 * dropped keystroke. On a cold first render the freshly-mounted SelectList can
 * miss the Enter that arrives before its input handler attaches; we re-press
 * Enter only while the current step (`still`) is still showing and `done` has
 * not yet appeared. Because every step here advances on Enter against its
 * default selection, a re-press is idempotent (re-picks the same option), so
 * this can never overshoot past `done`.
 *
 * Uses a poll-until-condition loop with a generous budget (default 4000 ms,
 * matching waitForFrame) instead of a fixed 1500 ms wall-clock deadline that
 * was prone to spurious failures under CPU contention (D23).
 */
async function advance(h: Harness, still: string, done: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (h.frame().includes(done)) return;
    if (h.frame().includes(still)) await h.key(ENTER);
    else await tick(10);
  }
  throw new Error(`advance: '${done}' never appeared (stuck on '${still}')`);
}

describe("ledger-tui App", () => {
  it("lists ledgers on connect", async () => {
    const h = await mount();
    expect(h.frame()).toContain("bugs");
    expect(h.frame()).toContain("milestones");
    h.unmount();
  });

  it("renders [<dir>] LLM ledgers in the header using the client's displayName (T68)", async () => {
    const client = new FakeClient("cq1");
    const r = render(<App client={client} />);
    await tick();
    expect(r.lastFrame()).toContain("[cq1] LLM ledgers");
    r.unmount();
  });

  it("shows each ledger's item count right-aligned in the ledgers list", async () => {
    const h = await mount();
    // FakeClient: bugs has 2 items (D1 + the huge D2), milestones has 1 item
    // (M1). The count is rendered after the name, right-aligned via padding.
    expect(h.frame()).toMatch(/bugs\s{2,}2/);
    expect(h.frame()).toMatch(/milestones\s{2,}1/);
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

  it("an overflowing item keeps its header/metadata at the top and scrolls (windowing)", async () => {
    const h = await mount();
    await h.key(ENTER); // open bugs
    await waitForFrame(() => h.frame(), "D2"); // list shows the huge item
    await h.key(DOWN); // cursor → D2 (its `note` is far taller than the pane)
    await waitForFrame(() => h.frame(), "D2 @ bugs"); // header MUST render at the top
    const top = h.frame();
    // Regression (windowing top-clip): the header + metadata + start of the long
    // field must be visible even though the content overflows the pane.
    expect(top).toContain("D2 @ bugs"); // header line
    expect(top).toContain("milestone M1"); // metadata line, not clipped off the top
    expect(top).toContain("Line 1:"); // start of the long field
    expect(top).not.toContain("Line 40:"); // the end is below the fold
    // Focus the content pane (Enter) and scroll to the bottom.
    await h.key(ENTER);
    expect(h.frame()).toContain("scroll · "); // focus moved to the content pane (scroll hint)
    for (let i = 0; i < 45; i++) await h.key(DOWN); // scroll past the end (clamps)
    await tick(40);
    expect(h.frame()).toContain("Line 40:"); // deep content now visible → scroll works
    h.unmount();
  }, 20000);

  it("edits an item's status through the status picker", async () => {
    const h = await mount();
    await h.key(ENTER); // bugs
    await h.key(ENTER); // detail D1
    // D1 is "open"; the guard map allows open → [wip, closed], so the picker
    // lists exactly those two — "wip" is the first option.
    await h.key("s"); // status picker: wip/closed (legal transitions only)
    await h.key(ENTER); // -> wip (first allowed target)
    await tick(40);
    expect(h.frame()).toContain("D1 → wip");
    expect((await h.client.fetchItem("bugs", "D1")).status).toBe("wip");
    h.unmount();
  });

  it("status picker offers only the guard-allowed transitions (multi-target)", async () => {
    const h = await mount();
    await h.key(ENTER); // bugs
    await h.key(ENTER); // detail D1 (status "open")
    await h.key("s"); // open the status picker
    await tick(20);
    const f = h.frame();
    // open → [wip, closed]: both legal targets shown, the illegal "open" is not.
    expect(f).toContain("wip");
    expect(f).toContain("closed");
    expect(f).not.toContain("(no transitions from this status)");
    h.unmount();
  });

  it("status picker shows no actions from a terminal status ([])", async () => {
    const h = await mount();
    // Drive D1 to the terminal status before opening the ledger, so the fetched
    // view shows it as "closed" (transitions["closed"] === []).
    await h.client.updateItem("bugs", "D1", { status: "closed" });
    await h.key(ENTER); // open bugs (fresh fetch → D1 is "closed")
    await h.key(ENTER); // detail D1 (terminal)
    await h.key("s"); // status picker
    await tick(20);
    const f = h.frame();
    expect(f).toContain("(no transitions from this status)");
    expect(f).not.toContain("[wip]"); // no transition action offered
    h.unmount();
  });

  it("status picker falls back to the full status list when no map is present", async () => {
    const client = new NoTransitionsClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open the only ledger
    await waitForFrame(() => r.lastFrame() ?? "", "T1"); // ledger loaded
    r.stdin.write(ENTER); // detail of the first item (status "todo")
    await tick(30);
    r.stdin.write("s"); // status picker
    await tick(30);
    const f = r.lastFrame() ?? "";
    // No transitions map → the picker lists every status value.
    expect(f).toContain("todo");
    expect(f).toContain("doing");
    expect(f).toContain("done");
    expect(f).not.toContain("(no transitions from this status)");
    r.unmount();
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

  it("answers a question and resolves it in one step (a → type → Enter)", async () => {
    const h = await mount();
    await h.key(DOWN); // bugs -> milestones
    await h.key(DOWN); // milestones -> questions
    await h.key(ENTER); // open questions (cursor on Q1)
    expect(h.frame()).toContain("a answer"); // hint advertises the affordance
    await h.key("a"); // open the answer prompt
    await type(h, "ship it");
    await h.key(ENTER);
    await tick(40);
    const q = await h.client.fetchItem("questions", "Q1");
    expect(q.status).toBe("answered");
    expect(q.fields["answer"]).toBe("ship it");
    h.unmount();
  });

  it("answers a question 'as recommended' with one key (r)", async () => {
    const h = await mount();
    await h.key(DOWN); // -> milestones
    await h.key(DOWN); // -> questions
    await h.key(ENTER); // open questions
    await h.key("r"); // answer as recommended (Q1 has a recommendation)
    await tick(40);
    const q = await h.client.fetchItem("questions", "Q1");
    expect(q.status).toBe("answered");
    expect(q.fields["answer"]).toBe("as recommended");
    h.unmount();
  });

  // --- batch-answer stepper (T64) ----------------------------------------
  // FakeClient questions ledger: Q1 (open, recommendation), Q2 (open, no
  // recommendation), Q3 (open). All three are answerable, in that order.

  /** Open questions and enter the batch-answer overlay (key `b`). */
  async function openBatch(h: Harness): Promise<void> {
    await h.key(DOWN); // bugs -> milestones
    await h.key(DOWN); // milestones -> questions
    await h.key(ENTER); // open questions
    await h.key("b"); // enter batch-answer overlay
  }

  it("the keybinding opens the batch overlay on the first open question (T64.1)", async () => {
    const h = await mount();
    await openBatch(h);
    expect(h.frame()).toContain("batch answer");
    expect(h.frame()).toContain("Q1");
    expect(h.frame()).toContain("1/3 open");
    expect(h.frame()).toContain("Ship on Friday?");
    h.unmount();
  });

  it("submitting an answer marks it answered and advances to the next open question (T64.2)", async () => {
    const h = await mount();
    await openBatch(h);
    await type(h, "do it");
    await h.key(ENTER);
    await tick(40);
    const q1 = await h.client.fetchItem("questions", "Q1");
    expect(q1.status).toBe("answered");
    expect(q1.fields["answer"]).toBe("do it");
    // Q1 dropped out; the stepper now shows Q2 as the first of the 2 remaining.
    expect(h.frame()).toContain("Q2");
    expect(h.frame()).toContain("1/2 open");
    h.unmount();
  });

  it("the 'as recommended' shortcut writes AS_RECOMMENDED_ANSWER (T64.3)", async () => {
    const h = await mount();
    await openBatch(h); // first open item is Q1 (has a recommendation)
    await h.key(CTRL_R);
    await tick(40);
    const q1 = await h.client.fetchItem("questions", "Q1");
    expect(q1.status).toBe("answered");
    expect(q1.fields["answer"]).toBe("as recommended");
    h.unmount();
  });

  it("prev/next moves between open questions (T64.4)", async () => {
    const h = await mount();
    await openBatch(h);
    expect(h.frame()).toContain("Q1");
    await h.key(RIGHT); // -> Q2
    expect(h.frame()).toContain("Q2");
    expect(h.frame()).toContain("2/3 open");
    await h.key(RIGHT); // -> Q3
    expect(h.frame()).toContain("Q3");
    await h.key(LEFT); // back to Q2
    expect(h.frame()).toContain("Q2");
    await h.key(LEFT); // back to Q1
    expect(h.frame()).toContain("Q1");
    expect(h.frame()).toContain("1/3 open");
    h.unmount();
  });

  it("Esc exits the batch overlay back to the questions list (T64.5)", async () => {
    const h = await mount();
    await openBatch(h);
    expect(h.frame()).toContain("batch answer");
    await h.key(ESC);
    await tick(20);
    expect(h.frame()).not.toContain("batch answer");
    // Back on the questions list (its hints advertise batch-answer).
    expect(h.frame()).toContain("b batch-answer");
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

  // Explicit 20 s timeout: chains four advance() calls each with a 4000 ms
  // poll budget; under CPU contention the 5000 ms bun default is exhausted.
  // Mirrors the scroll test's 20_000 ms precedent (D23).
  it("creates an item via the multi-step form", async () => {
    const h = await mount();
    await h.key(ENTER); // bugs
    await h.key("n"); // new item -> pick milestone (async: fetches milestones)
    // Gate every step on its rendered marker before sending the next key: a
    // SelectList swapped in by the previous step's onSelect registers its
    // input handler on mount, so an Enter sent before that render commits is
    // dropped. Polling each step's marker makes the flow timing-independent.
    await advance(h, "Bootstrap", "closed"); // pick M1 → status step (open/wip/closed)
    await advance(h, "closed", "field 1/2"); // pick status 'open' → headline field
    await type(h, "ion drive misalignment"); // headline*
    await advance(h, "field 1/2", "field 2/2"); // submit headline → note field
    await advance(h, "field 2/2", "created"); // submit (empty note) → "created Dn" flash
    const ledger = await h.client.fetchLedger("bugs");
    const headlines = ledger.milestones.flatMap((g) => g.items.map((i) => i.fields["headline"]));
    expect(headlines).toContain("ion drive misalignment");
    h.unmount();
  }, 20_000); // explicit 20 s: generous budget for worst-case CPU contention

  it("searches across ledgers as you type and opens a hit", async () => {
    const h = await mount();
    await h.key("/"); // open live search from ledgers
    await type(h, "warp");
    await waitFor(h, "bugs/D1"); // debounced live results appear (no submit)
    await h.key(ENTER); // open the highlighted hit -> detail
    await waitFor(h, "headline");
    expect(h.frame()).toContain("headline");
    h.unmount();
  });

  it("shows the path (ledger → milestone → item) in the header", async () => {
    const h = await mount();
    await h.key(ENTER); // open bugs (cursor 0)
    await waitFor(h, "bugs → M1 → D1"); // poll until path header renders
    expect(h.frame()).toContain("bugs → M1 → D1");
    h.unmount();
  });

  it("shows the highlighted item's detail in the content pane (two-pane)", async () => {
    const h = await mount();
    await h.key(ENTER); // open bugs; D1 auto-highlighted → content pane shows it
    // Poll until the content pane renders (replaces fixed tick(60) settle).
    await waitFor(h, "headline: warp leak");
    const f = h.frame();
    // short fields render inline (key: value on one line), no second Enter needed
    expect(f).toContain("headline: warp leak");
    expect(f).toContain("note: intermittent");
    h.unmount();
  });

  it("filters the item list by status type (active/terminal)", async () => {
    const h = await mount();
    await h.key(ENTER); // open bugs — D1 [open] visible (open is non-terminal)
    await waitFor(h, "D1"); // poll until the ledger items load after ENTER
    expect(h.frame()).toContain("D1");
    expect(h.frame()).toContain("[open]");

    await h.key("f"); // filter overlay: all / active / terminal / status:…
    await h.key(DOWN); // → active
    await h.key(DOWN); // → terminal
    await h.key(ENTER);
    // Poll until the stable positive co-indicator appears, THEN assert the negative.
    // This prevents a race where the filter hasn't yet committed when we check.
    await waitFor(h, "[terminal]"); // header chip (positive settle signal)
    expect(h.frame()).toContain("[terminal]"); // confirmed stable
    expect(h.frame()).not.toContain("D1"); // the only item is non-terminal → hidden

    await h.key("f");
    await h.key(DOWN); // → active
    await h.key(ENTER);
    await waitFor(h, "D1"); // poll until active filter re-shows the open item
    expect(h.frame()).toContain("D1"); // active filter shows the open item again
    h.unmount();
  });

  it("toggles pane orientation and resizes without losing content", async () => {
    const h = await mount();
    await h.key(ENTER); // open bugs → two panes (list + detail)
    await waitFor(h, "headline"); // poll until the ledger loads and detail pane renders
    expect(h.frame()).toContain("D1");
    expect(h.frame()).toContain("headline"); // detail pane visible
    await h.key("o"); // right → bottom orientation
    // Poll until the layout re-renders with 'headline' present after the toggle.
    await waitFor(h, "headline");
    expect(h.frame()).toContain("D1");
    expect(h.frame()).toContain("headline"); // both panes still render stacked
    await h.key("]"); // grow the list pane
    await h.key("["); // shrink it back
    await waitFor(h, "D1");
    expect(h.frame()).toContain("D1");
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
  // Explicit 20 s timeout: the loop sends 59 DOWN presses × tick(4) = ~236 ms
  // minimum plus per-keystroke render time. Under CPU contention the 5000 ms
  // bun default is routinely exhausted; a generous budget makes this deterministic.
  it("scrolls a long list and shows a scrollbar", async () => {
    const client = new ManyItemsClient(60);
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open the only ledger
    // Poll until T0 is rendered (replaces fixed tick(40) settle)
    await waitForFrame(() => r.lastFrame() ?? "", "T0 ", 5000);
    const first = r.lastFrame() ?? "";
    expect(first).toContain("T0 "); // top item visible
    expect(first).toContain("█"); // scrollbar thumb present (list overflows)
    expect(first).not.toContain("T59 "); // last item not in the initial window
    // page down to the bottom; use a tick between each key to avoid coalescing
    for (let i = 0; i < 59; i++) {
      r.stdin.write(DOWN);
      await tick(4);
    }
    // Poll until T59 scrolls into view (replaces fixed tick(40) settle)
    await waitForFrame(() => r.lastFrame() ?? "", "T59 ", 5000);
    expect(r.lastFrame() ?? "").toContain("T59 "); // scrolled into view
    r.unmount();
  }, 20_000); // explicit 20 s: generous budget for worst-case CPU contention
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
    // Bounded wait-for: push and poll until the re-fetched frame contains the
    // pushed item (up to 50 iterations × 20 ms = 1 s max). Re-pushing on each
    // iteration covers the race where React's passive effects (updating
    // refreshRef.current with the current reloadItems closure) hadn't fired yet
    // when the first push arrived — eventually they fire, and the next push
    // triggers the correct async refetch+render.
    for (let i = 0; i < 50; i++) {
      if ((r.lastFrame() ?? "").includes("pushed-tui")) break;
      FakeWS.instances[0]!.push({ type: "changed", ledger: "bugs" });
      await tick(20);
    }
    expect(r.lastFrame() ?? "").toContain("pushed-tui");
    r.unmount();
  });
});

// ---------------------------------------------------------------------------
// Column alignment and per-milestone subsection headers (Req3 + Req4)
// ---------------------------------------------------------------------------

/**
 * A client whose single ledger has items with varying id lengths (T1 vs T14)
 * and two milestone groups, so we can assert column alignment and subsections.
 */
class MultiMilestoneClient implements LedgerClient {
  displayName(): string { return "cq1"; }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [{ name: "tasks", itemCount: 3 }];
  }
  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id !== "tasks") throw new Error(`Ledger not found: ${id}`);
    return {
      id: "tasks",
      schema: {
        statusValues: ["planned", "wip", "done"],
        terminalStatuses: ["done"],
        fields: { headline: { type: "string", required: true } },
        idPrefix: "T",
      },
      counters: { milestone: 2, item: 3 },
      milestones: [
        {
          id: "M1",
          milestone: { id: "M1", status: "open", title: "Bootstrap", description: "" },
          items: [
            { id: "T1", milestoneId: "M1", status: "planned", fields: { headline: "alpha" }, createdAt: TS, updatedAt: TS },
            { id: "T2", milestoneId: "M1", status: "wip", fields: { headline: "beta" }, createdAt: TS, updatedAt: TS },
          ],
        },
        {
          id: "M2",
          milestone: { id: "M2", status: "open", title: "Phase Two", description: "" },
          items: [
            { id: "T14", milestoneId: "M2", status: "planned", fields: { headline: "gamma" }, createdAt: TS, updatedAt: TS },
          ],
        },
      ],
      archivePointers: [],
    };
  }
  async fetchLedgerArchive(): Promise<ArchiveContent> { throw new Error("not used"); }
  async fetchItem(): Promise<Item> { throw new Error("not used"); }
  async createItem(): Promise<Item> { throw new Error("not used"); }
  async updateItem(): Promise<Item> { throw new Error("not used"); }
  async ftsSearch(): Promise<never[]> { return []; }
  async createMilestone(): Promise<Item> { throw new Error("not used"); }
  async updateMilestone(): Promise<Item> { throw new Error("not used"); }
  async close(): Promise<void> { /* no-op */ }
}

describe("ledger-tui column alignment and subsection headers (Req3+Req4)", () => {
  it("pads id column to the max id width so columns align (T1 vs T14)", async () => {
    const client = new MultiMilestoneClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open tasks
    await waitForFrame(() => r.lastFrame() ?? "", "T14 ");
    const f = r.lastFrame() ?? "";
    // T1 must be padded to match T14's width (3 chars): "T1 " appears before status
    // T14 appears at width 3 with no extra space before the status separator
    expect(f).toContain("T1 "); // id "T1" padded to 3 chars
    expect(f).toContain("T14 "); // id "T14" followed by status sep space
    r.unmount();
  });

  it("renders per-milestone subsection headers in group order", async () => {
    const client = new MultiMilestoneClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open tasks
    await waitForFrame(() => r.lastFrame() ?? "", "Phase Two");
    const f = r.lastFrame() ?? "";
    // Both milestone headers should be visible
    expect(f).toContain("M1");
    expect(f).toContain("Bootstrap");
    expect(f).toContain("M2");
    expect(f).toContain("Phase Two");
    // M1 header must appear before M2 header in the rendered output
    expect(f.indexOf("M1")).toBeLessThan(f.indexOf("M2"));
    r.unmount();
  });

  it("items appear under their milestone subsection header", async () => {
    const client = new MultiMilestoneClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open tasks
    await waitForFrame(() => r.lastFrame() ?? "", "Phase Two");
    const f = r.lastFrame() ?? "";
    // T1 and T2 appear after M1 header, T14 appears after M2 header
    const m1Pos = f.indexOf("Bootstrap");
    const t1Pos = f.indexOf("T1 "); // padded id
    const m2Pos = f.indexOf("Phase Two");
    const t14Pos = f.indexOf("T14");
    expect(m1Pos).toBeGreaterThanOrEqual(0);
    expect(t1Pos).toBeGreaterThan(m1Pos);
    expect(m2Pos).toBeGreaterThan(t1Pos);
    expect(t14Pos).toBeGreaterThan(m2Pos);
    r.unmount();
  });

  it("milestones ledger shows no per-milestone subsection headers", async () => {
    const h = await mount();
    await h.key(DOWN); // bugs → milestones
    await h.key(ENTER); // open milestones
    await waitFor(h, "M1"); // poll until milestones ledger loads
    const f = h.frame();
    // The milestones ledger should show the milestone item (M1) in the list
    expect(f).toContain("M1");
    // But no subsection header format like "active [open]" (the group id for
    // milestones is "active", which would appear as a header only if subsections
    // were emitted — they should not be for the milestones ledger)
    // The key invariant: item rows appear directly without a separate group header
    // interleaved. We verify by checking there's no bold "active [" header line
    // distinct from the content pane's detail text.
    expect(f).not.toContain("active [open]");
    h.unmount();
  });

  it("status column is padded to the schema's max status width", async () => {
    const client = new MultiMilestoneClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open tasks
    await waitForFrame(() => r.lastFrame() ?? "", "planned");
    const f = r.lastFrame() ?? "";
    // Schema status values: planned(7), wip(3), done(4). Max = 7 ("planned").
    // So "wip" row should show "wip    " (padded to 7 chars) before the summary.
    // We check that "wip" appears padded (followed by spaces before "beta").
    // "planned" appears for T1: "planned alpha" and T14: "planned gamma"
    expect(f).toContain("planned"); // T1 and T14 both have status "planned"
    // "wip" for T2: padded to "wip    " (4 trailing spaces to reach 7)
    expect(f).toMatch(/wip\s+beta/); // wip padded then summary
    r.unmount();
  });
});

// ---------------------------------------------------------------------------
// summarize() — legacy review fallback (Req5)
// ---------------------------------------------------------------------------

describe("ledger-tui summarize() legacy review fallback (Req5)", () => {
  it("shows the summary field for a modern review (has summary)", async () => {
    const h = await mount();
    // Navigate to the reviews ledger (sorted: bugs=0, milestones=1, questions=2, reviews=3)
    await h.key(DOWN); // → milestones
    await h.key(DOWN); // → questions
    await h.key(DOWN); // → reviews
    await h.key(ENTER); // open reviews
    await waitFor(h, "Looks good overall"); // poll until reviews ledger loads
    const f = h.frame();
    // R2 has summary "Looks good overall" — must appear.
    expect(f).toContain("Looks good overall");
    // R2's criticism "Minor nit only" must NOT be shown as the summary.
    expect(f).not.toContain("Minor nit only");
    h.unmount();
  });

  it("shows the first criticism line (truncated) for a legacy review with no summary", async () => {
    const h = await mount();
    // Navigate to reviews ledger.
    await h.key(DOWN); // → milestones
    await h.key(DOWN); // → questions
    await h.key(DOWN); // → reviews
    await h.key(ENTER); // open reviews
    await waitFor(h, "The plan lacks detail"); // poll until reviews ledger loads
    const f = h.frame();
    // R1 has no summary — first criticism line must appear.
    expect(f).toContain("The plan lacks detail on error handling");
    // Second criticism "Missing rollback strategy" must NOT be joined in.
    expect(f).not.toContain("Missing rollback strategy");
    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// Archive toggle + read-only affordance (T33)
// ---------------------------------------------------------------------------

/**
 * A client with one active item and one archived milestone group.
 * Pressing A shows the archived section; archived items are read-only.
 */
class ArchiveClient implements LedgerClient {
  archiveFetched = false;
  statusApplied = false;

  displayName(): string { return "cq1"; }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [{ name: "jobs", itemCount: 1 }];
  }

  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id !== "jobs") throw new Error(`Ledger not found: ${id}`);
    return {
      id: "jobs",
      schema: {
        statusValues: ["planned", "done"],
        terminalStatuses: ["done"],
        fields: { headline: { type: "string", required: true } },
        idPrefix: "J",
      },
      counters: { milestone: 2, item: 2 },
      milestones: [
        {
          id: "M1",
          milestone: { id: "M1", status: "open", title: "Active work", description: "" },
          items: [
            { id: "J1", milestoneId: "M1", status: "planned", fields: { headline: "active task" }, createdAt: TS, updatedAt: TS },
          ],
        },
      ],
      archivePointers: [
        { id: "M0", path: "./archive/jobs/M0.md", summary: "Archived sprint", title: "Archived Sprint", status: "done" },
      ],
    };
  }

  async fetchLedgerArchive(ledgerId: string, archiveId: string): Promise<ArchiveContent> {
    if (ledgerId !== "jobs" || archiveId !== "M0") throw new Error("unexpected");
    this.archiveFetched = true;
    const milestone: Milestone = {
      id: "M0",
      title: "Archived sprint",
      description: "",
      items: [
        { id: "J0", milestoneId: "M0", status: "done", fields: { headline: "archived task" }, createdAt: TS, updatedAt: TS },
      ],
    };
    return { kind: "group", milestone };
  }

  async fetchItem(): Promise<Item> { throw new Error("not used"); }
  async createItem(): Promise<Item> { throw new Error("not used"); }
  async updateItem(): Promise<Item> {
    this.statusApplied = true;
    throw new Error("should not be called on archived item");
  }
  async ftsSearch(): Promise<never[]> { return []; }
  async createMilestone(): Promise<Item> { throw new Error("not used"); }
  async updateMilestone(): Promise<Item> { throw new Error("not used"); }
  async close(): Promise<void> { /* no-op */ }
}

describe("ledger-tui archive view (T33)", () => {
  it("shows the archive toggle hint when archivePointers exist", async () => {
    const client = new ArchiveClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open jobs ledger
    // Poll until the active item appears (ledger has loaded before asserting the hint).
    await waitForFrame(() => r.lastFrame() ?? "", "active task");
    // The hint bar should advertise the A key for showing archives.
    // The hint may wrap across lines in the terminal; collapse whitespace before checking.
    const f = (r.lastFrame() ?? "").replace(/\s+/g, " ");
    expect(f).toContain("A show archived");
    r.unmount();
  });

  it("pressing A toggles the archive section visible with a header", async () => {
    const client = new ArchiveClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open jobs
    // Poll until the active item appears before pressing A.
    await waitForFrame(() => r.lastFrame() ?? "", "active task");
    r.stdin.write("A"); // toggle archive on
    // Wait until the async fetch resolves and the archived item row appears.
    await waitForFrame(() => r.lastFrame() ?? "", "archived task");
    const f = r.lastFrame() ?? "";
    expect(f).toContain("── archived ──"); // section header visible
    expect(f).toContain("archived task"); // archived item visible
    r.unmount();
  });

  it("pressing A a second time hides the archive section", async () => {
    const client = new ArchiveClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open jobs
    // Poll until the active item appears before pressing A.
    await waitForFrame(() => r.lastFrame() ?? "", "active task");
    r.stdin.write("A"); // show archive
    await waitForFrame(() => r.lastFrame() ?? "", "archived task");
    r.stdin.write("A"); // hide archive
    await tick(80);
    const f = r.lastFrame() ?? "";
    expect(f).not.toContain("archived task");
    r.unmount();
  });

  it("navigating to an archived item shows the read-only badge in content pane", async () => {
    const client = new ArchiveClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open jobs
    // Poll until the active item appears before pressing A.
    await waitForFrame(() => r.lastFrame() ?? "", "active task");
    r.stdin.write("A"); // show archive
    await waitForFrame(() => r.lastFrame() ?? "", "archived task");
    r.stdin.write(DOWN); // move cursor to the archived item (active has 1 item → cursor 1)
    await tick(40);
    r.stdin.write(ENTER); // open content pane
    await tick(40);
    const f = r.lastFrame() ?? "";
    expect(f).toContain("read-only");
    expect(f).toContain("[archived");
    r.unmount();
  });

  it("the 's' key is inert on an archived item (no status overlay opens)", async () => {
    const client = new ArchiveClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open jobs
    await waitForFrame(() => r.lastFrame() ?? "", "active task"); // ledger loaded
    r.stdin.write("A"); // show archive
    await waitForFrame(() => r.lastFrame() ?? "", "archived task");
    r.stdin.write(DOWN); // cursor on archived item
    // Poll until the archived item's read-only view is rendered in the content pane
    // ('[archived]' in path header) — this is the stable positive that must still
    // hold after pressing 's'. Using waitForFrame here also acts as the settle for
    // the DOWN keypress, replacing the fixed tick(40).
    await waitForFrame(() => r.lastFrame() ?? "", "[archived]");
    r.stdin.write("s"); // attempt status change — must be suppressed
    // Negative assertion: we can't poll-until-absent. Settle deterministically:
    // re-poll until the stable positive invariant ('[archived]') is confirmed still
    // present, then assert that no overlay marker appeared.
    await waitForFrame(() => r.lastFrame() ?? "", "[archived]");
    const f = r.lastFrame() ?? "";
    // The status picker overlay, if opened, renders the SelectList which puts a `› ` cursor
    // prefix before the first status value and shows all status values in the content pane.
    // When suppressed, the path header still shows "[archived]" (not replaced by the overlay).
    expect(f).toContain("[archived]"); // path header unchanged → overlay was not opened
    // The underlying archived item row must still be visible in the list.
    expect(f).toContain("archived task");
    // PRIMARY (regression-sensitive): the content pane still shows the read-only badge.
    // If 's' opened the status overlay, the content pane swaps to <Overlays/> (app.tsx:1071-1073)
    // and the badge '[archived · read-only]' disappears — this assertion catches that regression.
    expect(f).toContain("[archived · read-only]");
    // OPTIONAL (content-pane-scoped): the status picker's SelectList cursor marker ('› ') must
    // be absent from the content-pane slice. We scope to contentSide() because the list pane's
    // own SelectList always renders '› ' for the selected row — asserting absence whole-frame
    // would be a false red on a correct codebase.
    expect(contentSide(f)).not.toContain("› ");
    r.unmount();
  });

  it("the 'e' key is inert on an archived item (no edit overlay opens)", async () => {
    const client = new ArchiveClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open jobs
    await waitForFrame(() => r.lastFrame() ?? "", "active task"); // ledger loaded
    r.stdin.write("A"); // show archive
    await waitForFrame(() => r.lastFrame() ?? "", "archived task");
    r.stdin.write(DOWN); // cursor on archived item
    // Poll until '[archived]' appears in the path header — the stable positive
    // invariant that must hold after 'e'. Also acts as settle for the DOWN keypress.
    await waitForFrame(() => r.lastFrame() ?? "", "[archived]");
    r.stdin.write("e"); // attempt edit — must be suppressed
    // Negative assertion: settle via re-polling the stable positive ('[archived]'),
    // then assert the field-picker overlay did NOT open and read-only badge persists.
    await waitForFrame(() => r.lastFrame() ?? "", "[archived]");
    const f = r.lastFrame() ?? "";
    // When the edit overlay opens for a real item, the content pane shows a
    // field picker SelectList "headline = <value>". When suppressed, the content
    // pane still shows the item detail with the read-only badge.
    expect(f).toContain("read-only"); // content pane still shows item detail
    r.unmount();
  });

  it("active items remain editable while archive section is shown", async () => {
    const client = new ArchiveClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open jobs
    await waitForFrame(() => r.lastFrame() ?? "", "active task"); // ledger loaded
    r.stdin.write("A"); // show archive (cursor stays on active item J1 at idx 0)
    await waitForFrame(() => r.lastFrame() ?? "", "archived task");
    // Cursor is still at index 0 (active J1) — 's' should open the status picker.
    r.stdin.write("s");
    await tick(40);
    const f = r.lastFrame() ?? "";
    // Status picker should open for J1 (no transitions map → all statuses listed)
    expect(f).toContain("done");
    r.unmount();
  });

  it("archive rows use the same column layout as active rows (id + status + summary)", async () => {
    const client = new ArchiveClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open jobs
    await waitForFrame(() => r.lastFrame() ?? "", "active task"); // ledger loaded
    r.stdin.write("A"); // show archive
    await waitForFrame(() => r.lastFrame() ?? "", "archived task");
    const f = r.lastFrame() ?? "";
    // Archived row J0 must appear with id + status + summary columns
    expect(f).toContain("J0");
    expect(f).toContain("done");
    expect(f).toContain("archived task");
    r.unmount();
  });
});

// ---------------------------------------------------------------------------
// M6 follow-up cross-cutting regression (T34)
// Confirms that the combined archive / subsection / column follow-up changes
// do NOT break active-item editing or plan/implement flows.
// No single per-task test covers this because it spans subsection rendering +
// status-filter + archive toggle + edit/transition key bindings simultaneously.
// ---------------------------------------------------------------------------

/**
 * A client that combines multi-milestone subsections AND an archive pointer,
 * so we can exercise all M6 follow-up features in a single scenario.
 */
class MultiMilestoneArchiveClient implements LedgerClient {
  statusApplied = "";

  displayName(): string { return "cq1"; }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [{ name: "tasks", itemCount: 2 }];
  }

  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id !== "tasks") throw new Error(`Ledger not found: ${id}`);
    return {
      id: "tasks",
      schema: {
        statusValues: ["planned", "wip", "done"],
        terminalStatuses: ["done"],
        fields: { headline: { type: "string", required: true } },
        idPrefix: "T",
        transitions: { planned: ["wip", "done"], wip: ["done"], done: [] },
      },
      counters: { milestone: 2, item: 2 },
      milestones: [
        {
          id: "M1",
          milestone: { id: "M1", status: "open", title: "Sprint One", description: "" },
          items: [
            { id: "T1", milestoneId: "M1", status: "planned", fields: { headline: "active item" }, createdAt: TS, updatedAt: TS },
          ],
        },
        {
          id: "M2",
          milestone: { id: "M2", status: "open", title: "Sprint Two", description: "" },
          items: [
            { id: "T2", milestoneId: "M2", status: "wip", fields: { headline: "in progress" }, createdAt: TS, updatedAt: TS },
          ],
        },
      ],
      archivePointers: [
        { id: "M0", path: "./archive/tasks/M0.md", summary: "Archived sprint", title: "Archived Sprint", status: "done" },
      ],
    };
  }

  async fetchLedgerArchive(ledgerId: string, archiveId: string): Promise<ArchiveContent> {
    if (ledgerId !== "tasks" || archiveId !== "M0") throw new Error("unexpected");
    const milestone: import("@cq/ledger").Milestone = {
      id: "M0",
      title: "Archived sprint",
      description: "",
      items: [
        { id: "T0", milestoneId: "M0", status: "done", fields: { headline: "old archived task" }, createdAt: TS, updatedAt: TS },
      ],
    };
    return { kind: "group", milestone };
  }

  async fetchItem(): Promise<Item> { throw new Error("not used"); }
  async createItem(): Promise<Item> { throw new Error("not used"); }
  async updateItem(_ledger: string, _id: string, patch: import("../src/types.js").ItemPatch): Promise<Item> {
    this.statusApplied = patch.status ?? "";
    return { id: "T1", milestoneId: "M1", status: patch.status ?? "planned", fields: { headline: "active item" }, createdAt: TS, updatedAt: TS };
  }
  async ftsSearch(): Promise<never[]> { return []; }
  async createMilestone(): Promise<Item> { throw new Error("not used"); }
  async updateMilestone(): Promise<Item> { throw new Error("not used"); }
  async close(): Promise<void> { /* no-op */ }
}

// ---------------------------------------------------------------------------
// suggestions field: bulleted list rendering (T57)
// ---------------------------------------------------------------------------

describe("ledger-tui suggestions bulleted list (T57)", () => {
  it("renders suggestions string[] as one bulleted line per element in the content pane", async () => {
    const h = await mount();
    // Navigate to questions ledger (ledgers sorted: bugs=0, milestones=1, questions=2, reviews=3)
    await h.key(DOWN); // → milestones
    await h.key(DOWN); // → questions
    await h.key(ENTER); // open questions (cursor on Q1)
    // Move to Q2 which has suggestions ["opt a", "opt b"]
    await h.key(DOWN);
    // Poll until the bulleted suggestion appears (replaces fixed tick(40) settle).
    await waitFor(h, "• opt a");
    // Each suggestion must appear on its own line with the bullet glyph.
    expect(h.frame()).toContain("• opt a");
    expect(h.frame()).toContain("• opt b");
    // Must NOT be comma-joined on a single line.
    expect(h.frame()).not.toContain("opt a, opt b");
    h.unmount();
  });
});

describe("ledger-tui question detail field order (T59)", () => {
  it("renders milestone, status, by, question, context, suggestions, recommendation, answer in that vertical order", async () => {
    const h = await mount();
    // Navigate to questions ledger (sorted: bugs=0, milestones=1, questions=2, reviews=3)
    await h.key(DOWN); // → milestones
    await h.key(DOWN); // → questions
    await h.key(ENTER); // open questions (cursor on Q1)
    await h.key(DOWN); // → Q2
    await h.key(DOWN); // → Q3 (full narrative: question/context/suggestions/recommendation/answer)
    await waitFor(h, "Q3 @ questions");
    const f = h.frame();

    // Content-pane-unique tokens for each label (the bare words "questions"/
    // "status" also occur in the left list and the footer hint bar, so we match
    // the exact rendered forms of the content-pane lines instead).
    const labels = [
      { label: "milestone", token: "milestone M1" },
      { label: "status", token: "status open" },
      { label: "by", token: "by opus-4.8[1m]" },
      { label: "question", token: "question: Full narrative?" },
      { label: "context", token: "context: the why" },
      { label: "suggestions", token: "suggestions" },
      { label: "recommendation", token: "recommendation" },
      { label: "answer", token: "answer: picked s1" },
    ];
    const positions = labels.map(({ label, token }) => ({ label, idx: f.indexOf(token) }));
    for (const { label, idx } of positions) {
      expect(idx, `label "${label}" must be present in the content pane`).toBeGreaterThanOrEqual(0);
    }
    // Each label appears strictly after the previous one (vertical order).
    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i - 1]!;
      const cur = positions[i]!;
      expect(cur.idx, `"${cur.label}" must follow "${prev.label}"`).toBeGreaterThan(prev.idx);
    }
    h.unmount();
  });

  it("leaves non-question item leading lines unchanged (milestone · created · updated)", async () => {
    const h = await mount();
    // bugs ledger (index 0) → open → D1 detail.
    await h.key(ENTER); // open bugs
    await tick(40);
    const f = h.frame();
    expect(f).toContain("created");
    expect(f).toContain("updated");
    h.unmount();
  });
});

describe("ledger-tui M6 cross-cutting regression (T34)", () => {
  it("subsection headers + archive toggle + status picker all coexist: active items remain editable", async () => {
    const client = new MultiMilestoneArchiveClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open tasks ledger
    // Poll until the ledger items load (replaces fixed tick(40)).
    await waitForFrame(() => r.lastFrame() ?? "", "Sprint One");
    const afterOpen = r.lastFrame() ?? "";

    // (1) Subsection headers for both milestone groups are rendered (T31 follow-up).
    expect(afterOpen).toContain("Sprint One");
    expect(afterOpen).toContain("T1");
    expect(afterOpen).toContain("Sprint Two");

    // (2) Show archive section — subsection headers and active items must persist
    //     alongside the archive section (combined T31+T33 state).
    r.stdin.write("A");
    await waitForFrame(() => r.lastFrame() ?? "", "old archived task");
    const withArchive = r.lastFrame() ?? "";
    expect(withArchive).toContain("Sprint One");        // subsection header still present
    expect(withArchive).toContain("T1 ");               // active item still visible
    expect(withArchive).toContain("old archived task"); // archive section appeared

    // (3) Cursor is on T1 (index 0 = first active item); 's' opens status picker.
    //     This verifies the plan/implement write path — active items are editable
    //     even when subsection headers and the archive section are all rendered.
    r.stdin.write("s");
    await tick(40);
    const withPicker = r.lastFrame() ?? "";
    // The status picker for T1 (planned) should offer the guard-allowed targets
    // from the transitions map: planned → [wip, done].
    expect(withPicker).toContain("wip");
    expect(withPicker).toContain("done");

    // (4) Apply the transition (pick "wip" — first option).
    r.stdin.write(ENTER);
    await tick(40);
    // The update was applied (client.statusApplied updated in updateItem).
    expect(client.statusApplied).toBe("wip");

    // (5) Edit the item's field while the archive is visible ('e' key).
    r.stdin.write("e"); // open field editor
    await tick(40);
    const withEditor = r.lastFrame() ?? "";
    // The field editor lists available fields — "headline" is the only one.
    expect(withEditor).toContain("headline");

    r.unmount();
  });
});

// ---------------------------------------------------------------------------
// Column selector overlay + extra columns, per-ledger in memory (T62)
// ---------------------------------------------------------------------------

const SPACE = " ";

/**
 * Extract the left list-pane portion of each rendered row (text before the
 * vertical border that splits the list pane from the content pane). The
 * content pane echoes an item's full field set, so a substring check against
 * the whole frame cannot tell a list COLUMN apart from a detail FIELD; slicing
 * to the list side makes column assertions unambiguous.
 */
function listSide(frame: string): string {
  return frame
    .split("\n")
    .map((line) => {
      const i = line.indexOf("│", line.indexOf("│") + 1);
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join("\n");
}

/**
 * Extract the right content-pane portion of each rendered row (text after the
 * vertical border that splits the list pane from the content pane — the
 * complement of listSide). Using this slice ensures assertions about the
 * content-pane overlay state are not contaminated by the list pane's own
 * SelectList cursor marker (`› `).
 */
function contentSide(frame: string): string {
  return frame
    .split("\n")
    .map((line) => {
      const i = line.indexOf("│", line.indexOf("│") + 1);
      return i >= 0 ? line.slice(i) : "";
    })
    .join("\n");
}

/**
 * Press DOWN until the column picker's cursor (`› `) sits on `field`,
 * resilient to a dropped first keystroke on the freshly-mounted overlay.
 */
async function waitForCursorOn(h: Harness, field: string, ms = 1500): Promise<void> {
  const end = Date.now() + ms;
  const onField = (): boolean =>
    h.frame().split("\n").some((l) => l.includes("› ") && l.includes(field));
  while (Date.now() < end) {
    if (onField()) return;
    await h.key(DOWN);
  }
  throw new Error(`waitForCursorOn: cursor never reached '${field}'`);
}

/** Navigate the freshly-mounted App to the tasks ledger and open it. */
async function openTasks(h: Harness): Promise<void> {
  // Ledgers sorted: bugs(0), milestones(1), questions(2), reviews(3), tasks(4).
  await h.key(DOWN);
  await h.key(DOWN);
  await h.key(DOWN);
  await h.key(DOWN);
  await h.key(ENTER);
  await waitFor(h, "T1 ");
}

describe("ledger-tui column selector (T62)", () => {
  it("opening the tasks ledger shows the suggestedModel column by default", async () => {
    const h = await mount();
    await openTasks(h);
    const f = listSide(h.frame());
    // defaultColumns("tasks") === ["suggestedModel"]; the cell values appear in
    // the list rows alongside id/status/summary.
    expect(f).toContain("opus"); // T1.suggestedModel
    expect(f).toContain("sonnet"); // T2.suggestedModel
    // The summary (headline) still renders after the extra column.
    expect(f).toContain("wire mcp");
    expect(f.indexOf("opus")).toBeLessThan(f.indexOf("wire mcp"));
    h.unmount();
  });

  it("the column overlay toggles a field on/off and rows gain/lose that column", async () => {
    const h = await mount();
    await openTasks(h);
    // Default: suggestedModel shown, tags NOT shown — assert on the list side
    // only (the content pane always echoes the selected item's tags field).
    expect(listSide(h.frame())).not.toContain("backend"); // T1.tags = ["backend"]

    // Open the column picker; eligible fields: suggestedModel, tags.
    await h.key("c");
    await waitFor(h, "Space toggle");
    const picker = h.frame();
    expect(picker).toContain("suggestedModel");
    expect(picker).toContain("tags");
    expect(picker).toContain("[x] suggestedModel"); // default selection checked
    expect(picker).toContain("[ ] tags"); // not selected

    // Move cursor to "tags" and toggle it on, then apply. A freshly-mounted
    // overlay can drop the first keystroke before its input handler attaches;
    // gate the DOWN on the cursor (›) actually landing on the tags row.
    await waitForCursorOn(h, "tags");
    await h.key(SPACE); // toggle tags on
    await waitFor(h, "[x] tags"); // confirm the toggle registered
    await h.key(ENTER); // apply
    await waitFor(h, "backend"); // tags cell now rendered in the rows
    expect(listSide(h.frame())).toContain("backend"); // T1.tags in the list row
    expect(listSide(h.frame())).toContain("opus"); // suggestedModel still present

    // Re-open and toggle suggestedModel OFF; the column disappears from rows.
    await h.key("c");
    await waitFor(h, "Space toggle");
    await waitForCursorOn(h, "suggestedModel"); // cursor starts at index 0
    await h.key(SPACE); // toggle suggestedModel off
    await waitFor(h, "[ ] suggestedModel"); // confirm the toggle registered
    await h.key(ENTER);
    await tick(40);
    const f = listSide(h.frame());
    expect(f).not.toContain("opus"); // suggestedModel column removed from rows
    expect(f).toContain("backend"); // tags column remains
    h.unmount();
  });

  it("column selection persists while navigating away and back within the session", async () => {
    const h = await mount();
    await openTasks(h);
    // Turn on the tags column (in addition to the default suggestedModel).
    await h.key("c");
    await waitFor(h, "Space toggle");
    await waitForCursorOn(h, "tags");
    await h.key(SPACE); // tags on
    await waitFor(h, "[x] tags");
    await h.key(ENTER);
    await waitFor(h, "backend");

    // Navigate away: Esc back to the ledgers list, then re-open tasks.
    await h.key(ESC);
    await waitFor(h, "› tasks"); // cursor restored on the tasks row
    await h.key(ENTER);
    await waitFor(h, "T1 ");
    // The session selection (suggestedModel + tags) survived the round trip.
    const f = listSide(h.frame());
    expect(f).toContain("opus"); // suggestedModel still shown
    expect(f).toContain("backend"); // tags still shown
    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// Milestone subsection header: colored status token (T81)
// ---------------------------------------------------------------------------
// These are unit tests on buildItemEntries (exported for testability).
// They inspect the React element props of the returned header node directly,
// rather than rendering a full frame, which avoids false-positive passes
// caused by other cyan/green ANSI sources in the frame (selected-row color,
// item status badges).

/**
 * Shared FetchedLedger fixture: two milestone groups with "open" and "done"
 * milestone statuses. Item statuses use "wip" / "abandoned" (yellow / gray) so
 * they never produce cyan or green and cannot contaminate assertions.
 */
const T81_VIEW: FetchedLedger = {
  id: "tasks",
  schema: {
    statusValues: ["wip", "abandoned"],
    terminalStatuses: ["abandoned"],
    fields: { headline: { type: "string", required: true } },
    idPrefix: "T",
  },
  counters: { milestone: 2, item: 2 },
  milestones: [
    {
      id: "M1",
      milestone: { id: "M1", status: "open", title: "Open sprint", description: "" },
      items: [
        { id: "T1", milestoneId: "M1", status: "wip", fields: { headline: "alpha" }, createdAt: TS, updatedAt: TS },
      ],
    },
    {
      id: "M2",
      milestone: { id: "M2", status: "done", title: "Done sprint", description: "" },
      items: [
        { id: "T2", milestoneId: "M2", status: "abandoned", fields: { headline: "beta" }, createdAt: TS, updatedAt: TS },
      ],
    },
  ],
  archivePointers: [],
};

/**
 * Walk a React element tree breadth-first and collect all `color` prop values
 * found on any node.
 */
function collectColors(node: React.ReactNode): string[] {
  if (!React.isValidElement(node)) return [];
  const colors: string[] = [];
  const el = node as React.ReactElement<{ color?: string; children?: React.ReactNode }>;
  if (el.props.color !== undefined) colors.push(el.props.color);
  const children = el.props.children;
  if (children !== undefined && children !== null) {
    const childArray = Array.isArray(children) ? children : [children];
    for (const child of childArray) {
      colors.push(...collectColors(child as React.ReactNode));
    }
  }
  return colors;
}

describe("ledger-tui milestone header colored status token (T81)", () => {
  // filteredRows for T81_VIEW
  const rows = T81_VIEW.milestones.flatMap((g) =>
    g.items.map((item) => ({ item, milestoneId: g.id }))
  );

  it("open milestone header node carries cyan color on the status token", () => {
    const entries = buildItemEntries(T81_VIEW, rows, false, MILESTONES_SCHEMA);
    const m1Header = entries.find((e) => e.t === "header" && e.label.startsWith("M1"));
    expect(m1Header).toBeDefined();
    expect(m1Header!.t).toBe("header");
    const node = (m1Header as { t: "header"; label: string; node?: React.ReactNode }).node;
    expect(node).toBeDefined();
    const colors = collectColors(node!);
    // The status token "open" maps to the "start" bucket → cyan.
    expect(colors).toContain("cyan");
  });

  it("done milestone header node carries green color on the status token", () => {
    const entries = buildItemEntries(T81_VIEW, rows, false, MILESTONES_SCHEMA);
    const m2Header = entries.find((e) => e.t === "header" && e.label.startsWith("M2"));
    expect(m2Header).toBeDefined();
    expect(m2Header!.t).toBe("header");
    const node = (m2Header as { t: "header"; label: string; node?: React.ReactNode }).node;
    expect(node).toBeDefined();
    const colors = collectColors(node!);
    // The status token "done" maps to the "done" bucket → green.
    expect(colors).toContain("green");
  });

  it("open and done milestone headers carry distinct colors", () => {
    const entries = buildItemEntries(T81_VIEW, rows, false, MILESTONES_SCHEMA);
    const headers = entries.filter((e) => e.t === "header") as Array<{ t: "header"; label: string; node?: React.ReactNode }>;
    expect(headers).toHaveLength(2);
    const allColors = headers.flatMap((h) => collectColors(h.node!));
    expect(allColors).toContain("cyan");
    expect(allColors).toContain("green");
  });

  it("non-milestone item entries carry no node prop (headers-only change)", () => {
    const entries = buildItemEntries(T81_VIEW, rows, false, MILESTONES_SCHEMA);
    const itemEntries = entries.filter((e) => e.t === "item");
    expect(itemEntries).toHaveLength(2);
    // Item entries are plain { t, item, itemIdx } — no node field.
    for (const e of itemEntries) {
      expect((e as Record<string, unknown>).node).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Goals ledger: flat list (no subsection headers) + fields.milestones in the
// content pane (T84 / Q48)
// ---------------------------------------------------------------------------

/**
 * A client whose goals ledger spans two coordination-milestone groups (M1, M2),
 * each holding one goal. G2 carries fields.milestones = [M12, M13, M14] (its
 * work-milestone ids). The goals view must render as a FLAT list with no
 * per-coordination-milestone subsection header, and the content pane must show
 * the work-milestone ids — not the single coordination-milestone line.
 */
class GoalsClient implements LedgerClient {
  displayName(): string { return "cq1"; }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [{ name: "goals", itemCount: 2 }, { name: "tasks", itemCount: 1 }];
  }
  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id === "goals") {
      return {
        id: "goals",
        schema: {
          statusValues: ["clarifying", "planning", "planned", "building", "done", "abandoned"],
          terminalStatuses: ["done", "abandoned"],
          fields: {
            title: { type: "string", required: true },
            description: { type: "string", required: true },
            milestones: { type: "id[]", required: false },
          },
          idPrefix: "G",
        },
        counters: { milestone: 3, item: 3 },
        milestones: [
          {
            id: "M1",
            milestone: { id: "M1", status: "open", title: "Coordination Alpha", description: "" },
            items: [
              { id: "G1", milestoneId: "M1", status: "planning", fields: { title: "first goal", description: "d1" }, createdAt: TS, updatedAt: TS },
            ],
          },
          {
            id: "M2",
            milestone: { id: "M2", status: "open", title: "Coordination Beta", description: "" },
            items: [
              { id: "G2", milestoneId: "M2", status: "building", fields: { title: "second goal", description: "d2", milestones: ["M12", "M13", "M14"] }, createdAt: TS, updatedAt: TS },
            ],
          },
        ],
        archivePointers: [],
      };
    }
    if (id === "tasks") {
      return {
        id: "tasks",
        schema: {
          statusValues: ["planned", "wip", "done"],
          terminalStatuses: ["done"],
          fields: { headline: { type: "string", required: true } },
          idPrefix: "T",
        },
        counters: { milestone: 2, item: 2 },
        milestones: [
          {
            id: "M1",
            milestone: { id: "M1", status: "open", title: "Sprint One", description: "" },
            items: [
              { id: "T1", milestoneId: "M1", status: "planned", fields: { headline: "alpha" }, createdAt: TS, updatedAt: TS },
            ],
          },
        ],
        archivePointers: [],
      };
    }
    throw new Error(`Ledger not found: ${id}`);
  }
  async fetchLedgerArchive(): Promise<ArchiveContent> { throw new Error("not used"); }
  async fetchItem(): Promise<Item> { throw new Error("not used"); }
  async createItem(): Promise<Item> { throw new Error("not used"); }
  async updateItem(): Promise<Item> { throw new Error("not used"); }
  async ftsSearch(): Promise<never[]> { return []; }
  async createMilestone(): Promise<Item> { throw new Error("not used"); }
  async updateMilestone(): Promise<Item> { throw new Error("not used"); }
  async close(): Promise<void> { /* no-op */ }
}

describe("ledger-tui goals flat list + fields.milestones (T84)", () => {
  it("renders the goals list FLAT with no per-coordination-milestone subsection header", async () => {
    const client = new GoalsClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open goals (cursor 0)
    // Poll until G1 appears (replaces fixed tick(40) settle).
    await waitForFrame(() => r.lastFrame() ?? "", "G1");
    const f = listSide(r.lastFrame() ?? "");
    // Both goals visible.
    expect(f).toContain("G1");
    expect(f).toContain("G2");
    // No coordination-milestone subsection header lines (they would render as
    // "M1 Coordination Alpha [open]" / "M2 Coordination Beta [open]").
    expect(f).not.toContain("Coordination Alpha");
    expect(f).not.toContain("Coordination Beta");
    expect(f).not.toContain("[open]");
    r.unmount();
  });

  it("the content pane for a goal shows its fields.milestones list, not the coordination milestone line", async () => {
    const client = new GoalsClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(ENTER); // open goals
    // Poll until G1 appears before moving cursor.
    await waitForFrame(() => r.lastFrame() ?? "", "G1");
    r.stdin.write(DOWN); // move to G2 (has fields.milestones = [M12, M13, M14])
    // Poll until G2's content pane shows the milestones list.
    await waitForFrame(() => r.lastFrame() ?? "", "G2 @ goals");
    const f = r.lastFrame() ?? "";
    expect(f).toContain("G2 @ goals");
    // Work-milestone ids appear as a `milestones` list.
    expect(f).toContain("milestones");
    expect(f).toContain("M12");
    expect(f).toContain("M13");
    expect(f).toContain("M14");
    // The single coordination-milestone line ("milestone M2") must NOT appear.
    expect(f).not.toContain("milestone M2");
    r.unmount();
  });

  it("leaves another ledger's subsection grouping unchanged (tasks still grouped)", async () => {
    const client = new GoalsClient();
    const r = render(<App client={client} />);
    await tick();
    r.stdin.write(DOWN); // goals -> tasks
    await tick(20);
    r.stdin.write(ENTER); // open tasks
    // Poll until the tasks ledger loads (replaces fixed tick(40) settle).
    await waitForFrame(() => r.lastFrame() ?? "", "Sprint One");
    const f = listSide(r.lastFrame() ?? "");
    // The tasks ledger keeps its per-milestone subsection header.
    expect(f).toContain("Sprint One");
    expect(f).toContain("T1");
    r.unmount();
  });
});

// ---------------------------------------------------------------------------
// Number keys 1-9 pick the Nth suggestion (T87)
// FakeClient: Q2 has suggestions ["opt a", "opt b"] and is open/answerable.
// ---------------------------------------------------------------------------

/** Navigate to questions ledger (sorted: bugs=0, milestones=1, questions=2). */
async function openQuestions(h: Harness): Promise<void> {
  await h.key(DOWN); // bugs → milestones
  await h.key(DOWN); // milestones → questions
  await h.key(ENTER); // open questions (cursor on Q1)
}

describe("ledger-tui number-key suggestion picker (T87)", () => {
  it("pressing '2' on a question with suggestions picks the 2nd suggestion and marks it answered (list focus)", async () => {
    const h = await mount();
    await openQuestions(h);
    await h.key(DOWN); // Q1 → Q2 (has suggestions ["opt a", "opt b"])
    await tick(20);
    await h.key("2"); // pick 2nd suggestion "opt b"
    await tick(40);
    const q = await h.client.fetchItem("questions", "Q2");
    expect(q.status).toBe("answered");
    expect(q.fields["answer"]).toBe("opt b");
    h.unmount();
  });

  it("pressing '1' on a question with suggestions picks the 1st suggestion (list focus)", async () => {
    const h = await mount();
    await openQuestions(h);
    await h.key(DOWN); // → Q2
    await tick(20);
    await h.key("1"); // pick 1st suggestion "opt a"
    await tick(40);
    const q = await h.client.fetchItem("questions", "Q2");
    expect(q.status).toBe("answered");
    expect(q.fields["answer"]).toBe("opt a");
    h.unmount();
  });

  it("pressing a number beyond the suggestion count is a no-op (list focus)", async () => {
    const h = await mount();
    await openQuestions(h);
    await h.key(DOWN); // → Q2 (2 suggestions)
    await tick(20);
    await h.key("9"); // beyond range — no-op
    await tick(40);
    const q = await h.client.fetchItem("questions", "Q2");
    expect(q.status).toBe("open"); // unchanged
    h.unmount();
  });

  it("pressing '2' on a question with suggestions works in content focus too", async () => {
    const h = await mount();
    await openQuestions(h);
    await h.key(DOWN); // → Q2
    await h.key(ENTER); // open content pane
    await tick(20);
    await h.key("2"); // pick 2nd suggestion
    await tick(40);
    const q = await h.client.fetchItem("questions", "Q2");
    expect(q.status).toBe("answered");
    expect(q.fields["answer"]).toBe("opt b");
    h.unmount();
  });

  it("number keys are inert when the item has no suggestions (Q1 has recommendation but no suggestions)", async () => {
    const h = await mount();
    await openQuestions(h);
    // Q1 is at cursor 0: has recommendation "yes, ship it" but no suggestions field
    await h.key("1"); // no-op
    await tick(40);
    const q = await h.client.fetchItem("questions", "Q1");
    expect(q.status).toBe("open"); // unchanged
    h.unmount();
  });

  it("number keys are inert when the item is not answerable (answered/withdrawn item)", async () => {
    const h = await mount();
    // Pre-answer Q2 so it's no longer answerable.
    await h.client.updateItem("questions", "Q2", { status: "answered", fields: { answer: "pre-answered" } });
    await openQuestions(h);
    await h.key(DOWN); // → Q2 (now terminal)
    await tick(20);
    await h.key("1"); // no-op — not answerable
    await tick(40);
    const q = await h.client.fetchItem("questions", "Q2");
    expect(q.fields["answer"]).toBe("pre-answered"); // unchanged
    h.unmount();
  });

  it("the key hints show '1-9 pick suggestion' when the item has suggestions", async () => {
    const h = await mount();
    await openQuestions(h);
    await h.key(DOWN); // → Q2 (has suggestions)
    await tick(20);
    const hints = h.frame();
    expect(hints).toContain("1-9 pick suggestion");
    h.unmount();
  });

  it("the key hints do NOT show '1-9' when the item has no suggestions (Q1)", async () => {
    const h = await mount();
    await openQuestions(h);
    // Q1 has no suggestions
    const hints = h.frame();
    expect(hints).not.toContain("1-9 pick suggestion");
    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// T89: r and number-pick keys are inert when persisted answer is non-empty
// Q3 in FakeClient: open, has recommendation "do s1", suggestions ["s1","s2"],
// AND a non-empty persisted answer "picked s1" — answerable but already answered.
// ---------------------------------------------------------------------------

describe("ledger-tui inert r/1-9 when persisted answer non-empty (T89)", () => {
  // Navigate to Q3 (index 2 in questions list: Q1=0, Q2=1, Q3=2).
  async function openQ3(h: Harness): Promise<void> {
    await openQuestions(h); // lands on Q1
    await h.key(DOWN); // Q1 → Q2
    await h.key(DOWN); // Q2 → Q3
    await tick(20);
  }

  it("'r' is a no-op (list focus) when persisted answer is non-empty", async () => {
    const h = await mount();
    await openQ3(h);
    await h.key("r"); // Q3 has recommendation AND non-empty answer → inert
    await tick(40);
    const q = await h.client.fetchItem("questions", "Q3");
    // status must remain open; answer must remain the original "picked s1"
    expect(q.status).toBe("open");
    expect(q.fields["answer"]).toBe("picked s1");
    h.unmount();
  });

  it("'r' is a no-op (content focus) when persisted answer is non-empty", async () => {
    const h = await mount();
    await openQ3(h);
    await h.key(ENTER); // open content pane
    await tick(20);
    await h.key("r"); // inert
    await tick(40);
    const q = await h.client.fetchItem("questions", "Q3");
    expect(q.status).toBe("open");
    expect(q.fields["answer"]).toBe("picked s1");
    h.unmount();
  });

  it("number key '1' is a no-op (list focus) when persisted answer is non-empty", async () => {
    const h = await mount();
    await openQ3(h);
    await h.key("1"); // Q3 has suggestions AND non-empty answer → inert
    await tick(40);
    const q = await h.client.fetchItem("questions", "Q3");
    expect(q.status).toBe("open");
    expect(q.fields["answer"]).toBe("picked s1");
    h.unmount();
  });

  it("number key '1' is a no-op (content focus) when persisted answer is non-empty", async () => {
    const h = await mount();
    await openQ3(h);
    await h.key(ENTER); // open content pane
    await tick(20);
    await h.key("1"); // inert
    await tick(40);
    const q = await h.client.fetchItem("questions", "Q3");
    expect(q.status).toBe("open");
    expect(q.fields["answer"]).toBe("picked s1");
    h.unmount();
  });

  it("'r' still works (list focus) when persisted answer is empty/whitespace", async () => {
    const h = await mount();
    await openQuestions(h); // lands on Q1: has recommendation, no persisted answer
    await h.key("r");
    await tick(40);
    const q = await h.client.fetchItem("questions", "Q1");
    expect(q.status).toBe("answered");
    expect(q.fields["answer"]).toBe("as recommended");
    h.unmount();
  });

  it("number key '1' still works (list focus) when persisted answer is empty", async () => {
    const h = await mount();
    await openQuestions(h);
    await h.key(DOWN); // → Q2 (has suggestions, no persisted answer)
    await tick(20);
    await h.key("1");
    await tick(40);
    const q = await h.client.fetchItem("questions", "Q2");
    expect(q.status).toBe("answered");
    expect(q.fields["answer"]).toBe("opt a");
    h.unmount();
  });

  it("key hints hide 'r as-recommended' when persisted answer is non-empty", async () => {
    const h = await mount();
    await openQ3(h); // Q3 has recommendation but non-empty answer
    const f = h.frame();
    // The hint for 'r' must not appear (answer already filled).
    expect(f).not.toContain("r as-recommended");
    h.unmount();
  });

  it("key hints hide '1-9 pick suggestion' when persisted answer is non-empty", async () => {
    const h = await mount();
    await openQ3(h); // Q3 has suggestions but non-empty answer
    const f = h.frame();
    expect(f).not.toContain("1-9 pick suggestion");
    h.unmount();
  });

  it("Ctrl+R in batch overlay is a no-op when persisted answer is non-empty", async () => {
    const h = await mount();
    // Enter batch-answer overlay from questions (Q1 is first open item).
    await h.key(DOWN); // bugs → milestones
    await h.key(DOWN); // milestones → questions
    await h.key(ENTER); // open questions
    await h.key("b"); // enter batch-answer overlay (Q1, idx 0)
    await tick(20);
    expect(h.frame()).toContain("batch answer");
    expect(h.frame()).toContain("Q1");
    // Navigate to Q3 (idx 2) using RIGHT twice.
    await h.key(RIGHT); // Q1 → Q2
    await h.key(RIGHT); // Q2 → Q3
    await tick(20);
    expect(h.frame()).toContain("Q3");
    await h.key(CTRL_R); // Q3 has recommendation + persisted answer → inert
    await tick(40);
    const q = await h.client.fetchItem("questions", "Q3");
    // Q3's answer must remain "picked s1" (not overwritten with "as recommended")
    expect(q.fields["answer"]).toBe("picked s1");
    expect(q.status).toBe("open");
    h.unmount();
  });
});
