/**
 * Always-visible project selector (T590 / Q276 lock / Q284 selector-only
 * boundary).
 *
 * Covers:
 *  - the selector element (the persistent chrome indicator + the keybound
 *    picker overlay it opens) renders in BOTH embedded mode (no `--mcp-url`,
 *    a client with no `listProjects` capability at all) and remote mode
 *    (`--mcp-url`, a multi-project stub client);
 *  - against a stubbed multi-project REMOTE client, picking the second
 *    project reconnects `McpLedgerClient` to that project's `/p/<key>/mcp`
 *    endpoint (via an injected `connect` stub — no real network) and the
 *    item list re-populates from the new project's stubbed data;
 *  - embedded mode's switch is a no-op (single project, nothing to reconnect
 *    to).
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/app.js";
import type {
  ArchiveContent,
  ArchivePointer,
  FetchedLedger,
  FtsHit,
  Item,
  LedgerClient,
  LedgerSchema,
  LedgerSummary,
  MilestonePatch,
  ProjectEntry,
} from "../src/types.js";

const TS = "2026-01-01T00:00:00.000Z";
const DOWN = "[B";
const ENTER = "\r";
const ESC = "";

const tick = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll the rendered frame until it contains `substr`. */
async function waitForFrame(getFrame: () => string, substr: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (getFrame().includes(substr)) return;
    await tick(10);
  }
  throw new Error(`waitForFrame: '${substr}' never appeared. Last frame:\n${getFrame()}`);
}

const workSchema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: { headline: { type: "string", required: true } },
};

/**
 * A LedgerClient for exactly one project: `work` ledger holding ONE item
 * whose headline distinguishes which project served it. `projects` is the
 * FULL registry this project's server would answer for `list_projects` (a
 * real multi-tenant hub answers with every tenant, not just the caller's
 * own) — so both stub instances below share the SAME two-entry list.
 */
class NamedProjectClient implements LedgerClient {
  public closed = false;
  constructor(
    private readonly name: string,
    private readonly headline: string,
    private readonly projects: ProjectEntry[] | null,
  ) {}
  displayName(): string {
    return this.name;
  }
  async listProjects(): Promise<ProjectEntry[]> {
    if (this.projects === null) throw new Error("listProjects not supported");
    return this.projects;
  }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [{ name: "work", itemCount: 1 }];
  }
  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id !== "work") throw new Error(`Ledger not found: ${id}`);
    return {
      id: "work",
      schema: workSchema,
      counters: { milestone: 1, item: 2 },
      milestones: [
        {
          id: "active",
          milestone: { id: "active", status: "open", title: "", description: "" },
          items: [
            {
              id: "T1",
              milestoneId: "active",
              status: "open",
              fields: { headline: this.headline },
              createdAt: TS,
              updatedAt: TS,
            },
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
  async ftsSearch(): Promise<FtsHit[]> {
    return [];
  }
  async createMilestone(): Promise<Item> {
    throw new Error("not used");
  }
  async updateMilestone(_id: string, _p: MilestonePatch): Promise<Item> {
    throw new Error("not used");
  }
  async archiveMilestone(): Promise<ArchivePointer> {
    throw new Error("not used");
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

/** A client with NO `listProjects` capability at all — the pre-T590 shape. */
class NoProjectsClient extends NamedProjectClient {
  constructor(name: string, headline: string) {
    super(name, headline, null);
  }
}
// Delete the inherited method so `typeof client.listProjects === "function"`
// is false, exactly like a pre-T590 fake that never declared it.
delete (NoProjectsClient.prototype as { listProjects?: unknown }).listProjects;

const REGISTRY: ProjectEntry[] = [
  { key: "alpha", displayName: "Alpha" },
  { key: "beta", displayName: "Beta" },
];

describe("ledger-tui project selector (T590)", () => {
  it("the selector renders in EMBEDDED mode (no mcp-url, no listProjects capability)", async () => {
    const client = new NoProjectsClient("solo", "solo task");
    const r = render(<App client={client} />);
    await tick();
    // The always-visible chrome indicator, synthesized from displayName().
    expect(r.lastFrame()).toContain("project: solo");
    // The keybound picker overlay opens too, showing the single entry.
    r.stdin.write("p");
    await tick();
    expect(r.lastFrame()).toContain("solo");
    r.stdin.write(ESC);
    await tick();
    r.unmount();
  });

  it("the selector renders in REMOTE mode (mcp-url, multi-project stub client)", async () => {
    const client = new NamedProjectClient("Alpha", "alpha task", REGISTRY);
    const r = render(<App client={client} mcpUrl="http://hub.example/mcp" />);
    await tick();
    // Persistent indicator shows the current project + the registry count.
    await waitForFrame(() => r.lastFrame() ?? "", "project: Alpha");
    expect(r.lastFrame()).toContain("[2]");
    // The picker overlay lists both projects.
    r.stdin.write("p");
    await tick();
    expect(r.lastFrame()).toContain("Alpha");
    expect(r.lastFrame()).toContain("Beta");
    r.stdin.write(ESC);
    await tick();
    r.unmount();
  });

  it("embedded mode's switch is a no-op (single project, nothing to reconnect to)", async () => {
    const client = new NoProjectsClient("solo", "solo task");
    let connectCalls = 0;
    const stubConnect = async (): Promise<LedgerClient> => {
      connectCalls += 1;
      throw new Error("must not be called in embedded mode");
    };
    const r = render(<App client={client} connect={stubConnect} />);
    await tick();
    r.stdin.write("p");
    await tick();
    r.stdin.write(ENTER); // select the only (already-current) entry
    await tick();
    expect(connectCalls).toBe(0);
    r.unmount();
  });

  it(
    "picking the second project reconnects to its /p/<key>/mcp endpoint and the item list re-populates",
    async () => {
      const clientA = new NamedProjectClient("Alpha", "alpha task", REGISTRY);
      const clientB = new NamedProjectClient("Beta", "beta task", REGISTRY);
      const connectCalls: string[] = [];
      const stubConnect = async (url: string): Promise<LedgerClient> => {
        connectCalls.push(url);
        return clientB;
      };
      const r = render(
        <App client={clientA} mcpUrl="http://hub.example/mcp" connect={stubConnect} />,
      );
      await tick();
      await waitForFrame(() => r.lastFrame() ?? "", "project: Alpha");

      // Confirm project A's data is what's initially visible.
      r.stdin.write(ENTER); // open the only ledger ("work")
      await waitForFrame(() => r.lastFrame() ?? "", "alpha task");

      // Back out to the ledgers root, then open the picker and pick the
      // SECOND entry (Beta).
      r.stdin.write(ESC);
      await tick();
      r.stdin.write("p");
      await tick();
      r.stdin.write(DOWN);
      await tick();
      r.stdin.write(ENTER);

      // Reconnect happened: the stub was called with the rewritten endpoint.
      await waitForFrame(() => r.lastFrame() ?? "", "project: Beta");
      expect(connectCalls).toHaveLength(1);
      expect(connectCalls[0]).toBe("http://hub.example/p/beta/mcp");
      // The previous (Alpha) client is closed once the switch lands.
      expect(clientA.closed).toBe(true);

      // The navigation stack reset to the ledgers root on switch (Q284:
      // switching is a CONNECTION-layer op — every view below it is reset to
      // a fresh single-project view). Re-open the ledger: its item list is
      // now served by clientB's stubbed data, not clientA's.
      r.stdin.write(ENTER); // open "work" again, now against project B
      await waitForFrame(() => r.lastFrame() ?? "", "beta task");
      expect(r.lastFrame()).not.toContain("alpha task");

      r.unmount();
    },
  );
});
