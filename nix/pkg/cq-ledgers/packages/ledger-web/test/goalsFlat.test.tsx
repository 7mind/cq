/**
 * T83 / Q48 (user-deviated): the GOALS ledger renders as a FLAT list with NO
 * per-coordination-milestone subsections, and a goal's detail panel shows its
 * WORK-milestone ids (fields.milestones) instead of the single coordination
 * 'milestone' row. Web mirror of the TUI's T84.
 *
 * Acceptance:
 *  - the goals LIST is a single flat table with NO `ms-section-*` subsections;
 *  - the detail panel for a goal shows a `milestones` list with the
 *    fields.milestones ids (M12, M13, M14) and NOT a single 'milestone' row;
 *  - a non-goal ledger (tasks here) still renders per-milestone subsections and
 *    the single 'milestone' detail row, unchanged.
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import type {
  AgentModelsResult,
  ArchiveContent,
  ArchivePointer,
  DerivedPredicates,
  FetchedLedger,
  FtsHit,
  Item,
  ItemInit,
  ItemPatch,
  LedgerClient,
  LedgerSchema,
  LedgerSummary,
  ListProjectsResult,
  MilestonePatch,
  ReadLogResult,
} from "../src/types.js";

const TS = "2026-01-01T00:00:00.000Z";

const goalsSchema: LedgerSchema = {
  statusValues: ["clarifying", "planning", "planned", "building", "done", "abandoned"],
  terminalStatuses: ["done", "abandoned"],
  idPrefix: "G",
  fields: {
    title: { type: "string", required: true },
    description: { type: "string", required: false },
    milestones: { type: "id[]", required: false },
  },
};
const tasksSchema: LedgerSchema = {
  statusValues: ["planned", "wip", "done"],
  terminalStatuses: ["done"],
  idPrefix: "T",
  fields: { headline: { type: "string", required: true } },
};

/**
 * A client whose goals ledger spans two coordination-milestone groups (M1, M2),
 * each holding one goal. G2 carries fields.milestones = [M12, M13, M14] (its
 * work-milestone ids). A separate tasks ledger keeps its subsection grouping.
 */
class GoalsClient implements LedgerClient {
  displayName(): string {
    return "cq1";
  }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [
      { name: "goals", itemCount: 2 },
      { name: "tasks", itemCount: 1 },
    ];
  }
  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id === "goals") {
      return {
        id: "goals",
        schema: goalsSchema,
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
        schema: tasksSchema,
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
  async fetchLedgerArchive(): Promise<ArchiveContent> {
    throw new Error("not used");
  }
  async fetchItem(): Promise<Item> {
    throw new Error("not used");
  }
  async createItem(_l: string, _m: string, _i: ItemInit): Promise<Item> {
    throw new Error("not used");
  }
  async updateItem(_l: string, _i: string, _p: ItemPatch): Promise<Item> {
    throw new Error("not used");
  }
  async ftsSearch(): Promise<FtsHit[]> {
    return [];
  }
  async createMilestone(): Promise<Item> {
    throw new Error("not used");
  }
  async updateMilestone(_m: string, _p: MilestonePatch): Promise<Item> {
    throw new Error("not used");
  }
  async archiveMilestone(): Promise<ArchivePointer> {
    throw new Error("not used");
  }
  async readLog(): Promise<ReadLogResult> {
    throw new Error("not used");
  }
  async getAgentModels(): Promise<AgentModelsResult> {
    // Minimal stub — not used in goals-flat tests.
    return { configured: false, agents: [] };
  }
  async listProjects(): Promise<ListProjectsResult> {
    return { projects: [{ key: "cq1", displayName: "cq1" }] };
  }
  async derivePredicates(): Promise<DerivedPredicates> {
    throw new Error("not used");
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

let container: HTMLElement;
let root: Root;

const sleep = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function flush(): Promise<void> {
  await act(async () => {
    await sleep(10);
  });
}
const testid = (id: string): HTMLElement | null => container.querySelector(`[data-testid="${id}"]`);
function click(el: Element | null): void {
  if (el === null) throw new Error("click: element not found");
  act(() => {
    (el as HTMLElement).click();
  });
}

async function mount(): Promise<void> {
  const fake = new GoalsClient();
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

describe("T83 — goals ledger flat list + fields.milestones", () => {
  it("renders the goals list FLAT with no per-coordination-milestone subsection", async () => {
    await mount();
    await openLedger("goals");

    // Both goals are present.
    expect(testid("item-G1")).not.toBeNull();
    expect(testid("item-G2")).not.toBeNull();
    // No coordination-milestone subsection wrappers.
    expect(testid("ms-section-M1")).toBeNull();
    expect(testid("ms-section-M2")).toBeNull();
    expect(container.querySelector(".lw-milestone-section")).toBeNull();
    // Exactly one table renders for the whole list.
    expect(container.querySelectorAll("table.lw-table").length).toBe(1);
    // The flat goals table has NO `milestone` column header (only id/status/summary).
    const headers = Array.from(container.querySelectorAll("table.lw-table thead th")).map(
      (th) => th.textContent,
    );
    expect(headers).toEqual(["id", "status", "summary"]);
  });

  it("the detail panel for a goal shows its fields.milestones list, not the coordination 'milestone' row", async () => {
    await mount();
    await openLedger("goals");

    // Open G2 (carries fields.milestones = [M12, M13, M14]).
    click(testid("item-G2"));
    await flush();

    expect(testid("detail-id")?.textContent).toBe("G2");
    // Work-milestone ids appear as a `milestones` list.
    const list = testid("detail-goal-milestones");
    expect(list).not.toBeNull();
    const ids = Array.from(list!.querySelectorAll("li")).map((li) => li.textContent);
    expect(ids).toEqual(["M12", "M13", "M14"]);
    // The single coordination-milestone field row must NOT be rendered, and the
    // `milestones` field must not be duplicated in the generic field list.
    expect(testid("detail-field-milestones")).toBeNull();
    // The detail <dl> must not carry a bare `milestone` dt (only `milestones`).
    const dts = Array.from(container.querySelectorAll("[data-testid='detail'] dt")).map(
      (dt) => dt.textContent,
    );
    expect(dts).toContain("milestones");
    expect(dts).not.toContain("milestone");
  });

  it("a goal with no fields.milestones shows an empty milestones placeholder, not a coordination row", async () => {
    await mount();
    await openLedger("goals");

    click(testid("item-G1"));
    await flush();

    expect(testid("detail-id")?.textContent).toBe("G1");
    const list = testid("detail-goal-milestones");
    expect(list).not.toBeNull();
    expect(list!.querySelectorAll("li").length).toBe(0);
    const dts = Array.from(container.querySelectorAll("[data-testid='detail'] dt")).map(
      (dt) => dt.textContent,
    );
    expect(dts).not.toContain("milestone");
  });

  it("a non-goal ledger (tasks) still renders per-milestone subsections and the single 'milestone' detail row", async () => {
    await mount();
    await openLedger("tasks");

    // Subsection grouping intact.
    expect(testid("ms-section-M1")).not.toBeNull();
    expect(testid("item-T1")).not.toBeNull();

    // Detail panel shows the single coordination-milestone row, not a list.
    click(testid("item-T1"));
    await flush();
    expect(testid("detail-goal-milestones")).toBeNull();
    const dts = Array.from(container.querySelectorAll("[data-testid='detail'] dt")).map(
      (dt) => dt.textContent,
    );
    expect(dts).toContain("milestone");
  });
});
