/**
 * T622 (goal G83): consolidated regression suite for the web finalize flow,
 * covering the delta NOT already exercised by finalizeMenu.test.tsx (T619:
 * button placement/gating, menu options, Escape-at-menu, goals presence,
 * option-pick stub, reset-on-switch) or finalizePreviewModal.test.tsx (T620:
 * eligible/skipped ids, partial-hold no-op, in-order sweep incl. one failing
 * updateItem id, archive summary synthesis, empty-plan state, stale-async
 * generation-token regression):
 *
 *  1. Finalize launched from the GOALS view opens the combined goals-scope
 *     graph, defaults every eligible goal selected, and recomputes exact
 *     work/coordination operations after per-goal opt-out;
 *  2. archive-sweep exactness: a 3-way milestone fixture (fully-terminal /
 *     item-terminal-but-self-open / non-terminal-item) mirroring T623's TUI
 *     ArchiveExactnessClient — only the fully-terminal milestone is ever
 *     archived;
 *  3. archive-mode partial failure: one archivable milestone's
 *     archiveMilestone rejects, a LATER archivable milestone still executes
 *     (Q292 mid-sweep continuation) and the failed row renders its error;
 *  4. Escape dismisses the finalize preview modal at the PREVIEW step and at
 *     the RESULTS step (menu-step Escape is T619's territory);
 *  5. finalize's toolbar addition does not regress the '+ milestone' create
 *     flow on the milestones view (the finalize-btn now shares the toolbar
 *     row with 'new-item-or-milestone').
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { HOLD_MS, type HoldClock } from "../src/HoldButton.js";
import { MILESTONES_SCHEMA } from "@cq/ledger/constants";
import { SKIP_INCOMPLETE_MILESTONE, SKIP_MILESTONE_NOT_TERMINAL, SKIP_NON_TERMINAL_ITEMS } from "@cq/ledger/finalize";
import type {
  AgentModelsResult,
  ArchiveContent,
  ArchivePointer,
  DerivedPredicates,
  FetchedLedger,
  FtsHit,
  Item,
  ItemPatch,
  LedgerClient,
  LedgerSchema,
  LedgerSummary,
  ListProjectsResult,
  MilestonePatch,
  ReadLogResult,
} from "../src/types.js";

const TS = "2026-01-01T00:00:00.000Z";

interface GoalsParityFixture {
  milestones: Array<{ id: string; status: string; title: string }>;
  archivePointers: ArchivePointer[];
  tasks: Array<{ id: string; milestoneId: string; status: string }>;
  goals: Array<{
    id: string;
    milestoneId: string;
    status: string;
    title: string;
    milestones: string[];
  }>;
  failure: { goalId: string; status: string; message: string };
  expected: {
    eligibleGoalSelections: Array<{ id: string; selected: boolean }>;
    skippedGoalId: string;
    incompleteMilestoneId: string;
    operationIds: string[];
    attemptedOperationIds: string[];
    suppressedOperationIds: string[];
  };
}

const GOALS_PARITY_FIXTURE = JSON.parse(
  readFileSync(
    new URL("../../ledger/test/fixtures/goals-finalize-parity.json", import.meta.url),
    "utf8",
  ),
) as GoalsParityFixture;

class FakeClock implements HoldClock {
  private current = 0;
  private nextHandle = 1;
  private scheduled = new Map<number, { due: number; cb: () => void }>();
  now(): number { return this.current; }
  setTimeout(cb: () => void, ms: number): number {
    const handle = this.nextHandle++;
    this.scheduled.set(handle, { due: this.current + ms, cb });
    return handle;
  }
  clearTimeout(handle: number): void { this.scheduled.delete(handle); }
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      let nextHandle: number | null = null;
      let nextDue = Infinity;
      for (const [handle, entry] of this.scheduled) {
        if (entry.due <= target && entry.due < nextDue) {
          nextDue = entry.due;
          nextHandle = handle;
        }
      }
      if (nextHandle === null) break;
      const entry = this.scheduled.get(nextHandle)!;
      this.scheduled.delete(nextHandle);
      this.current = entry.due;
      entry.cb();
    }
    this.current = target;
  }
}

function item(id: string, milestoneId: string, status: string, fields: Item["fields"]): Item {
  return { id, milestoneId, status, fields, createdAt: TS, updatedAt: TS };
}

function emptyPredicates(): DerivedPredicates {
  const v = (): { value: boolean; items: string[] } => ({ value: false, items: [] });
  return {
    pInvestigate: v(),
    pSeed: v(),
    pPlan: v(),
    pResearch: v(),
    pImplement: v(),
    openQuestionGate: v(),
    belowFloor: v(),
    goalDrift: v(),
  };
}

const tasksSchema: LedgerSchema = {
  statusValues: ["planned", "wip", "done"],
  terminalStatuses: ["done"],
  idPrefix: "T",
  fields: { headline: { type: "string", required: true } },
};
const goalsSchema: LedgerSchema = {
  statusValues: ["planned", "building", "done"],
  terminalStatuses: ["done"],
  idPrefix: "G",
  transitions: {
    planned: ["building"],
    building: ["done"],
    done: [],
  },
  fields: {
    title: { type: "string", required: true },
    milestones: { type: "string[]", required: false },
  },
};

type RecordedCall =
  | { op: "updateMilestone"; milestoneId: string; status: string | undefined }
  | { op: "updateItem"; ledger: string; id: string; status: string | undefined }
  | { op: "archiveMilestone"; milestoneId: string; summary: string };

/**
 * Goals-scope fixture for scenario (1). G1 (planned) and G2 (building) share
 * coordination milestone C-SHARED and reference complete work milestones W1
 * and W2. G3 references incomplete W-BAD and remains skipped. Deselecting G2
 * must remove W2's unique archive and make C-SHARED ineligible under projected
 * Q290 because the deselected G2 remains non-terminal.
 */
class GoalsFlowClient implements LedgerClient {
  readonly calls: RecordedCall[] = [];
  failG1Building = false;
  deferNextArchive = false;
  private archiveRelease: (() => void) | null = null;

  get archivePending(): boolean {
    return this.archiveRelease !== null;
  }

  releaseArchive(): void {
    const release = this.archiveRelease;
    if (release === null) throw new Error("releaseArchive: no archive pending");
    this.archiveRelease = null;
    release();
  }

  displayName(): string { return "cq1"; }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [
      { name: "goals", itemCount: 3 },
      { name: "milestones", itemCount: 5 },
      { name: "tasks", itemCount: 3 },
    ];
  }
  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id === "milestones") {
      return {
        id: "milestones",
        schema: MILESTONES_SCHEMA,
        counters: { milestone: 1, item: 5 },
        milestones: [
          {
            id: "active",
            milestone: { id: "active", status: "open", title: "active", description: "" },
            items: [
              item("W1", "active", "open", { title: "Work one" }),
              item("W2", "active", "done", { title: "Work two" }),
              item("W-BAD", "active", "open", { title: "Incomplete work" }),
              item("C-SHARED", "active", "open", { title: "Shared coordination" }),
              item("C-BAD", "active", "open", { title: "Incomplete coordination" }),
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
        counters: { milestone: 1, item: 3 },
        milestones: [
          { id: "W1", milestone: { id: "W1", status: "open", title: "W1", description: "" }, items: [item("T1", "W1", "done", { headline: "t1" })] },
          { id: "W2", milestone: { id: "W2", status: "done", title: "W2", description: "" }, items: [item("T2", "W2", "done", { headline: "t2" })] },
          { id: "W-BAD", milestone: { id: "W-BAD", status: "open", title: "W-BAD", description: "" }, items: [item("T3", "W-BAD", "wip", { headline: "t3" })] },
        ],
        archivePointers: [],
      };
    }
    if (id === "goals") {
      return {
        id: "goals",
        schema: goalsSchema,
        counters: { milestone: 1, item: 3 },
        milestones: [
          {
            id: "C-SHARED",
            milestone: { id: "C-SHARED", status: "open", title: "Shared coordination", description: "" },
            items: [
              item("G1", "C-SHARED", "planned", { title: "Goal one", milestones: ["W1"] }),
              item("G2", "C-SHARED", "building", { title: "Goal two", milestones: ["W2"] }),
            ],
          },
          {
            id: "C-BAD",
            milestone: { id: "C-BAD", status: "open", title: "Incomplete coordination", description: "" },
            items: [
              item("G3", "C-BAD", "building", { title: "Goal three", milestones: ["W-BAD"] }),
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
  async updateItem(ledger: string, id: string, patch: ItemPatch): Promise<Item> {
    this.calls.push({ op: "updateItem", ledger, id, status: patch.status });
    if (this.failG1Building && id === "G1" && patch.status === "building") {
      throw new Error("G1 building refused");
    }
    return item(id, "C-SHARED", patch.status ?? "open", patch.fields ?? {});
  }
  async ftsSearch(): Promise<FtsHit[]> { return []; }
  async createMilestone(): Promise<Item> { throw new Error("not used"); }
  async archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer> {
    this.calls.push({ op: "archiveMilestone", milestoneId, summary });
    if (this.deferNextArchive) {
      this.deferNextArchive = false;
      await new Promise<void>((resolve) => {
        this.archiveRelease = resolve;
      });
    }
    return { id: milestoneId, path: `./archive/milestones/${milestoneId}.md`, summary, title: milestoneId, status: "done" };
  }
  async updateMilestone(milestoneId: string, patch: MilestonePatch): Promise<Item> {
    this.calls.push({ op: "updateMilestone", milestoneId, status: patch.status });
    return item(milestoneId, "active", patch.status ?? "open", {});
  }
  async readLog(): Promise<ReadLogResult> { throw new Error("not used"); }
  async getAgentModels(): Promise<AgentModelsResult> { return { configured: false, agents: [] }; }
  async listProjects(): Promise<ListProjectsResult> { return { projects: [{ key: "cq1", displayName: "cq1" }] }; }
  async derivePredicates(): Promise<DerivedPredicates> { return emptyPredicates(); }
  async close(): Promise<void> { /* no-op */ }
}

class EmptyGoalsFlowClient extends GoalsFlowClient {
  override async fetchLedger(id: string): Promise<FetchedLedger> {
    const view = await super.fetchLedger(id);
    if (id !== "tasks") return view;
    return {
      ...view,
      milestones: view.milestones.map((group) => ({
        ...group,
        items: group.items.map((entry) => ({ ...entry, status: "wip" })),
      })),
    };
  }
}

class GoalsParityClient implements LedgerClient {
  readonly calls: RecordedCall[] = [];

  displayName(): string { return "cq1"; }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [
      { name: "goals", itemCount: GOALS_PARITY_FIXTURE.goals.length },
      { name: "milestones", itemCount: GOALS_PARITY_FIXTURE.milestones.length },
      { name: "tasks", itemCount: GOALS_PARITY_FIXTURE.tasks.length },
    ];
  }
  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id === "milestones") {
      return {
        id,
        schema: MILESTONES_SCHEMA,
        counters: { milestone: 1, item: 1 },
        milestones: [{
          id: "active",
          milestone: { id: "active", status: "open", title: "active", description: "" },
          items: GOALS_PARITY_FIXTURE.milestones.map((entry) =>
            item(entry.id, "active", entry.status, { title: entry.title }),
          ),
        }],
        archivePointers: GOALS_PARITY_FIXTURE.archivePointers,
      };
    }
    if (id === "tasks") {
      return {
        id,
        schema: tasksSchema,
        counters: { milestone: 1, item: 1 },
        milestones: GOALS_PARITY_FIXTURE.tasks.map((entry) => {
          const milestone = GOALS_PARITY_FIXTURE.milestones.find(
            ({ id: milestoneId }) => milestoneId === entry.milestoneId,
          );
          if (milestone === undefined) throw new Error(`missing milestone ${entry.milestoneId}`);
          return {
            id: entry.milestoneId,
            milestone: {
              id: entry.milestoneId,
              status: milestone.status,
              title: milestone.title,
              description: "",
            },
            items: [item(entry.id, entry.milestoneId, entry.status, { headline: entry.id })],
          };
        }),
        archivePointers: [],
      };
    }
    if (id === "goals") {
      const coordinationIds = [...new Set(
        GOALS_PARITY_FIXTURE.goals.map(({ milestoneId }) => milestoneId),
      )];
      return {
        id,
        schema: goalsSchema,
        counters: { milestone: 1, item: 1 },
        milestones: coordinationIds.map((coordinationId) => {
          const milestone = GOALS_PARITY_FIXTURE.milestones.find(
            ({ id: milestoneId }) => milestoneId === coordinationId,
          );
          if (milestone === undefined) throw new Error(`missing milestone ${coordinationId}`);
          return {
            id: coordinationId,
            milestone: {
              id: coordinationId,
              status: milestone.status,
              title: milestone.title,
              description: "",
            },
            items: GOALS_PARITY_FIXTURE.goals
              .filter(({ milestoneId }) => milestoneId === coordinationId)
              .map((goal) => item(goal.id, coordinationId, goal.status, {
                title: goal.title,
                milestones: goal.milestones,
              })),
          };
        }),
        archivePointers: [],
      };
    }
    throw new Error(`Ledger not found: ${id}`);
  }
  async fetchLedgerArchive(): Promise<ArchiveContent> { throw new Error("not used"); }
  async fetchItem(): Promise<Item> { throw new Error("not used"); }
  async createItem(): Promise<Item> { throw new Error("not used"); }
  async updateItem(ledger: string, id: string, patch: ItemPatch): Promise<Item> {
    this.calls.push({ op: "updateItem", ledger, id, status: patch.status });
    if (
      id === GOALS_PARITY_FIXTURE.failure.goalId &&
      patch.status === GOALS_PARITY_FIXTURE.failure.status
    ) {
      throw new Error(GOALS_PARITY_FIXTURE.failure.message);
    }
    return item(id, "active", patch.status ?? "open", patch.fields ?? {});
  }
  async ftsSearch(): Promise<FtsHit[]> { return []; }
  async createMilestone(): Promise<Item> { throw new Error("not used"); }
  async archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer> {
    this.calls.push({ op: "archiveMilestone", milestoneId, summary });
    return {
      id: milestoneId,
      path: `./archive/milestones/${milestoneId}.md`,
      summary,
      title: milestoneId,
      status: "done",
    };
  }
  async updateMilestone(milestoneId: string, patch: MilestonePatch): Promise<Item> {
    this.calls.push({ op: "updateMilestone", milestoneId, status: patch.status });
    return item(milestoneId, "active", patch.status ?? "open", {});
  }
  async readLog(): Promise<ReadLogResult> { throw new Error("not used"); }
  async getAgentModels(): Promise<AgentModelsResult> { return { configured: false, agents: [] }; }
  async listProjects(): Promise<ListProjectsResult> {
    return { projects: [{ key: "cq1", displayName: "cq1" }] };
  }
  async derivePredicates(): Promise<DerivedPredicates> { return emptyPredicates(); }
  async close(): Promise<void> { /* no-op */ }
}

function recordedOperationIds(calls: RecordedCall[]): string[] {
  return calls.map((call) => {
    switch (call.op) {
      case "updateMilestone":
        return `milestone:${call.milestoneId}:close`;
      case "updateItem":
        return `goal:${call.id}:to-${call.status}`;
      case "archiveMilestone":
        return `milestone:${call.milestoneId}:archive`;
    }
  });
}

/**
 * Archive-sweep exactness fixture (mirrors T623's TUI ArchiveExactnessClient
 * in happy-dom): MA is fully terminal (all grouped items terminal AND its own
 * status is terminal) -> archivable; MB's grouped items are all terminal but
 * the milestone ITSELF is still "open" -> SKIP_MILESTONE_NOT_TERMINAL; MC has
 * a non-terminal grouped item -> SKIP_NON_TERMINAL_ITEMS. Only MA may ever
 * reach archiveMilestone.
 */
class ArchiveExactnessClient implements LedgerClient {
  readonly calls: RecordedCall[] = [];
  /** milestone ids whose archiveMilestone rejects (deliberate per-id failure). */
  readonly failArchiveIds = new Set<string>();

  displayName(): string { return "cq1"; }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [
      { name: "milestones", itemCount: 3 },
      { name: "tasks", itemCount: 3 },
    ];
  }
  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id === "milestones") {
      return {
        id: "milestones",
        schema: MILESTONES_SCHEMA,
        counters: { milestone: 1, item: 3 },
        milestones: [
          {
            id: "active",
            milestone: { id: "active", status: "open", title: "active", description: "" },
            items: [
              item("MA", "active", "done", { title: "Alpha" }),
              item("MB", "active", "open", { title: "Bravo" }),
              item("MC", "active", "open", { title: "Charlie" }),
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
        counters: { milestone: 1, item: 3 },
        milestones: [
          { id: "MA", milestone: { id: "MA", status: "done", title: "Alpha", description: "" }, items: [item("T1", "MA", "done", { headline: "a-work" })] },
          { id: "MB", milestone: { id: "MB", status: "open", title: "Bravo", description: "" }, items: [item("T2", "MB", "done", { headline: "b-work" })] },
          { id: "MC", milestone: { id: "MC", status: "open", title: "Charlie", description: "" }, items: [item("T3", "MC", "planned", { headline: "c-work" })] },
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
  async ftsSearch(): Promise<FtsHit[]> { return []; }
  async createMilestone(): Promise<Item> { throw new Error("not used"); }
  async archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer> {
    this.calls.push({ op: "archiveMilestone", milestoneId, summary });
    if (this.failArchiveIds.has(milestoneId)) throw new Error(`${milestoneId} archive refused`);
    return { id: milestoneId, path: `./archive/milestones/${milestoneId}.md`, summary, title: milestoneId, status: "done" };
  }
  async updateMilestone(): Promise<Item> { throw new Error("not used"); }
  async readLog(): Promise<ReadLogResult> { throw new Error("not used"); }
  async getAgentModels(): Promise<AgentModelsResult> { return { configured: false, agents: [] }; }
  async listProjects(): Promise<ListProjectsResult> { return { projects: [{ key: "cq1", displayName: "cq1" }] }; }
  async derivePredicates(): Promise<DerivedPredicates> { return emptyPredicates(); }
  async close(): Promise<void> { /* no-op */ }
}

/**
 * Two-archivable-milestone fixture for scenario (3): MA and MD are BOTH
 * fully terminal (archivable); archiveMilestone rejects for MA specifically.
 * MD must still execute (Q292 mid-sweep continuation) even though it comes
 * after MA in the plan.
 */
class ArchivePartialFailureClient implements LedgerClient {
  readonly calls: RecordedCall[] = [];

  displayName(): string { return "cq1"; }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [
      { name: "milestones", itemCount: 2 },
      { name: "tasks", itemCount: 2 },
    ];
  }
  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id === "milestones") {
      return {
        id: "milestones",
        schema: MILESTONES_SCHEMA,
        counters: { milestone: 1, item: 2 },
        milestones: [
          {
            id: "active",
            milestone: { id: "active", status: "open", title: "active", description: "" },
            items: [
              item("MA", "active", "done", { title: "Alpha" }),
              item("MD", "active", "done", { title: "Delta" }),
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
        counters: { milestone: 1, item: 2 },
        milestones: [
          { id: "MA", milestone: { id: "MA", status: "done", title: "Alpha", description: "" }, items: [item("T1", "MA", "done", { headline: "a-work" })] },
          { id: "MD", milestone: { id: "MD", status: "done", title: "Delta", description: "" }, items: [item("T2", "MD", "done", { headline: "d-work" })] },
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
  async ftsSearch(): Promise<FtsHit[]> { return []; }
  async createMilestone(): Promise<Item> { throw new Error("not used"); }
  async archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer> {
    this.calls.push({ op: "archiveMilestone", milestoneId, summary });
    if (milestoneId === "MA") throw new Error("MA archive refused");
    return { id: milestoneId, path: `./archive/milestones/${milestoneId}.md`, summary, title: milestoneId, status: "done" };
  }
  async updateMilestone(): Promise<Item> { throw new Error("not used"); }
  async readLog(): Promise<ReadLogResult> { throw new Error("not used"); }
  async getAgentModels(): Promise<AgentModelsResult> { return { configured: false, agents: [] }; }
  async listProjects(): Promise<ListProjectsResult> { return { projects: [{ key: "cq1", displayName: "cq1" }] }; }
  async derivePredicates(): Promise<DerivedPredicates> { return emptyPredicates(); }
  async close(): Promise<void> { /* no-op */ }
}

/**
 * Minimal milestones-only fixture for scenario (5): finalize-btn must render
 * alongside 'new-item-or-milestone' without breaking the '+ milestone' create
 * flow. `createMilestone` records calls and returns a fresh M2.
 */
class MilestonesOnlyClient implements LedgerClient {
  readonly createMilestoneCalls: Array<{ title: string }> = [];

  displayName(): string { return "cq1"; }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [{ name: "milestones", itemCount: 1 }];
  }
  async fetchLedger(id: string): Promise<FetchedLedger> {
    if (id !== "milestones") throw new Error(`Ledger not found: ${id}`);
    return {
      id: "milestones",
      schema: MILESTONES_SCHEMA,
      counters: { milestone: 1, item: 1 },
      milestones: [
        {
          id: "active",
          milestone: { id: "active", status: "open", title: "active", description: "" },
          items: [item("M1", "active", "open", { title: "Wave 1" })],
        },
      ],
      archivePointers: [],
    };
  }
  async fetchLedgerArchive(): Promise<ArchiveContent> { throw new Error("not used"); }
  async fetchItem(): Promise<Item> { throw new Error("not used"); }
  async createItem(): Promise<Item> { throw new Error("not used"); }
  async updateItem(): Promise<Item> { throw new Error("not used"); }
  async ftsSearch(): Promise<FtsHit[]> { return []; }
  async createMilestone(patch: { title: string }): Promise<Item> {
    this.createMilestoneCalls.push({ title: patch.title });
    return item("M2", "active", "open", { title: patch.title });
  }
  async archiveMilestone(): Promise<ArchivePointer> { throw new Error("not used"); }
  async updateMilestone(): Promise<Item> { throw new Error("not used"); }
  async readLog(): Promise<ReadLogResult> { throw new Error("not used"); }
  async getAgentModels(): Promise<AgentModelsResult> { return { configured: false, agents: [] }; }
  async listProjects(): Promise<ListProjectsResult> { return { projects: [{ key: "cq1", displayName: "cq1" }] }; }
  async derivePredicates(): Promise<DerivedPredicates> { return emptyPredicates(); }
  async close(): Promise<void> { /* no-op */ }
}

let container: HTMLElement;
let root: Root;
let holdClock: FakeClock;

const sleep = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function flush(): Promise<void> {
  await act(async () => { await sleep(10); });
}
const testid = (id: string): HTMLElement | null => container.querySelector(`[data-testid="${id}"]`);
const testids = (prefix: string): string[] =>
  Array.from(container.querySelectorAll(`[data-testid^="${prefix}"]`)).map(
    (el) => el.getAttribute("data-testid")!.slice(prefix.length),
  );
function click(el: Element | null): void {
  if (el === null) throw new Error("click: element not found");
  act(() => { (el as HTMLElement).click(); });
}
function press(key: string): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}
function setValue(el: Element | null, value: string): void {
  if (el === null) throw new Error("setValue: element not found");
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function holdFull(el: Element | null): Promise<void> {
  if (el === null) throw new Error("holdFull: element not found");
  act(() => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  });
  act(() => { holdClock.advance(HOLD_MS); });
  await flush();
}

async function mount(client: LedgerClient): Promise<void> {
  holdClock = new FakeClock();
  await act(async () => {
    root.render(
      createElement(App, {
        connect: async () => client,
        initialUrl: "http://x/mcp",
        holdClock,
      }),
    );
  });
  await flush();
}

async function openPreview(view: string, mode: "apply-done" | "archive"): Promise<void> {
  click(testid(`ledger-${view}`));
  await flush();
  click(testid("finalize-btn"));
  await flush();
  click(testid(`finalize-option-${mode}`));
  await flush();
}

async function openGoalsPreview(): Promise<void> {
  click(testid("ledger-goals"));
  await flush();
  click(testid("finalize-btn"));
  await flush();
  click(testid("finalize-option-goals"));
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe("T622 — web finalize flow regression suite", () => {
  it("goals view imports the shared presentation and opens the combined default-all graph", async () => {
    const client = new GoalsFlowClient();
    await mount(client);
    await openGoalsPreview();

    expect(testid("finalize-preview-mode")?.textContent).toBe("goals");
    expect(testid("finalize-caption")?.textContent).toContain("selected completed goals");
    expect(testid("finalize-caption")?.textContent).toContain("work and coordination milestones");
    expect(testid("finalize-caption")?.textContent).toContain("Q290");
    expect((testid("finalize-goal-G1") as HTMLInputElement).checked).toBe(true);
    expect((testid("finalize-goal-G2") as HTMLInputElement).checked).toBe(true);
    expect(testids("finalize-operation-")).toEqual([
      "milestone:W1:close",
      "goal:G1:to-building",
      "goal:G1:to-done",
      "goal:G2:to-done",
      "milestone:C-SHARED:close",
      "milestone:W1:archive",
      "milestone:C-SHARED:archive",
      "milestone:W2:archive",
    ]);
    expect(testid("finalize-skipped-G3")?.textContent).toContain(SKIP_INCOMPLETE_MILESTONE);

    const modal = testid("finalize-preview")!;
    const body = modal.querySelector<HTMLElement>(".lw-modal-body")!;
    const execute = testid("finalize-execute")!;
    expect(body.contains(testid("finalize-goals-selection"))).toBe(true);
    expect(body.contains(testid("finalize-goals-operations"))).toBe(true);
    expect(body.contains(execute)).toBe(false);
    expect(execute.parentElement?.parentElement).toBe(modal);
  });

  it("goal opt-out recomputes unique operations and shared coordination Q290 eligibility", async () => {
    const client = new GoalsFlowClient();
    await mount(client);
    await openGoalsPreview();

    click(testid("finalize-goal-G2"));
    await flush();

    expect((testid("finalize-goal-G1") as HTMLInputElement).checked).toBe(true);
    expect((testid("finalize-goal-G2") as HTMLInputElement).checked).toBe(false);
    expect(testids("finalize-operation-")).toEqual([
      "milestone:W1:close",
      "goal:G1:to-building",
      "goal:G1:to-done",
      "milestone:W1:archive",
    ]);
    expect(testid("finalize-operation-goal:G2:to-done")).toBeNull();
    expect(testid("finalize-operation-milestone:W2:archive")).toBeNull();
    expect(testid("finalize-operation-milestone:C-SHARED:close")).toBeNull();
    expect(testid("finalize-operation-milestone:C-SHARED:archive")).toBeNull();
  });

  it("matches the common representative selection, operation, and suppression contract", async () => {
    const client = new GoalsParityClient();
    await mount(client);
    await openGoalsPreview();

    expect(testids("finalize-goal-")).toEqual(
      GOALS_PARITY_FIXTURE.expected.eligibleGoalSelections.map(({ id }) => id),
    );
    for (const expected of GOALS_PARITY_FIXTURE.expected.eligibleGoalSelections) {
      if (!expected.selected) click(testid(`finalize-goal-${expected.id}`));
    }
    await flush();

    for (const expected of GOALS_PARITY_FIXTURE.expected.eligibleGoalSelections) {
      expect((testid(`finalize-goal-${expected.id}`) as HTMLInputElement).checked).toBe(
        expected.selected,
      );
    }
    expect(testid(`finalize-skipped-${GOALS_PARITY_FIXTURE.expected.skippedGoalId}`)?.textContent)
      .toContain(GOALS_PARITY_FIXTURE.expected.incompleteMilestoneId);
    expect(testids("finalize-operation-")).toEqual(
      GOALS_PARITY_FIXTURE.expected.operationIds,
    );

    await holdFull(testid("finalize-execute"));

    expect(testids("finalize-result-")).toEqual(GOALS_PARITY_FIXTURE.expected.operationIds);
    expect(recordedOperationIds(client.calls)).toEqual(
      GOALS_PARITY_FIXTURE.expected.attemptedOperationIds,
    );
    expect(
      testid(`finalize-result-goal:${GOALS_PARITY_FIXTURE.failure.goalId}:to-building`)
        ?.textContent,
    ).toContain(GOALS_PARITY_FIXTURE.failure.message);
    for (const operationId of GOALS_PARITY_FIXTURE.expected.suppressedOperationIds) {
      expect(testid(`finalize-result-${operationId}`)?.textContent).toContain("suppressed");
    }
    expect(testid("finalize-result-goal:G-INDEPENDENT:to-done")?.textContent).toContain("ok");
    expect(testid("finalize-result-milestone:C-INDEPENDENT:archive")?.textContent)
      .toContain("ok");
  });

  it("renders the shared explanatory empty state when no goal is eligible", async () => {
    await mount(new EmptyGoalsFlowClient());
    await openGoalsPreview();

    expect(testid("finalize-goals-selection")).toBeNull();
    expect(testid("finalize-goals-operations")).toBeNull();
    expect(testid("finalize-empty")?.textContent).toBe(
      "No actions are eligible for this Finalize operation.",
    );
    expect(testid("finalize-execute")).toBeNull();
  });

  it("partial hold writes nothing; completed hold dispatches once and renders stable attempted results", async () => {
    const client = new GoalsFlowClient();
    await mount(client);
    await openGoalsPreview();

    const execute = testid("finalize-execute")!;
    act(() => {
      execute.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    });
    act(() => { holdClock.advance(HOLD_MS / 2); });
    act(() => {
      execute.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(client.calls).toEqual([]);

    await holdFull(testid("finalize-execute"));

    expect(client.calls).toEqual([
      { op: "updateMilestone", milestoneId: "W1", status: "done" },
      { op: "updateItem", ledger: "goals", id: "G1", status: "building" },
      { op: "updateItem", ledger: "goals", id: "G1", status: "done" },
      { op: "updateItem", ledger: "goals", id: "G2", status: "done" },
      { op: "updateMilestone", milestoneId: "C-SHARED", status: "done" },
      { op: "archiveMilestone", milestoneId: "W1", summary: "finalized: Work one" },
      { op: "archiveMilestone", milestoneId: "C-SHARED", summary: "finalized: Shared coordination" },
      { op: "archiveMilestone", milestoneId: "W2", summary: "finalized: Work two" },
    ]);
    expect(testids("finalize-result-")).toEqual([
      "milestone:W1:close",
      "goal:G1:to-building",
      "goal:G1:to-done",
      "goal:G2:to-done",
      "milestone:C-SHARED:close",
      "milestone:W1:archive",
      "milestone:C-SHARED:archive",
      "milestone:W2:archive",
    ]);
    expect(testid("finalize-results-tally")?.textContent).toBe("all 8 succeeded");
    expect(testid("finalize-execute")).toBeNull();
  });

  it("renders failed and suppressed repeated-target results under unique operation ids", async () => {
    const client = new GoalsFlowClient();
    client.failG1Building = true;
    await mount(client);
    await openGoalsPreview();
    await holdFull(testid("finalize-execute"));

    expect(testid("finalize-result-goal:G1:to-building")?.textContent).toContain("failed");
    expect(testid("finalize-result-goal:G1:to-building")?.textContent).toContain("G1 building refused");
    expect(testid("finalize-result-goal:G1:to-done")?.textContent).toContain("suppressed");
    expect(testid("finalize-result-goal:G1:to-done")?.textContent).toContain(
      "goal:G1:to-building",
    );
    expect(testid("finalize-result-milestone:C-SHARED:close")?.textContent).toContain(
      "suppressed",
    );
    expect(
      client.calls.filter((call) => call.op === "updateItem" && call.id === "G1"),
    ).toEqual([{ op: "updateItem", ledger: "goals", id: "G1", status: "building" }]);
    expect(
      client.calls.some(
        (call) => call.op === "archiveMilestone" && call.milestoneId === "C-SHARED",
      ),
    ).toBe(false);
  });

  it("a stale goals execution completion cannot overwrite a reopened goals preview", async () => {
    const client = new GoalsFlowClient();
    client.deferNextArchive = true;
    await mount(client);
    await openGoalsPreview();

    await holdFull(testid("finalize-execute"));
    expect(client.archivePending).toBe(true);
    press("Escape");
    await flush();
    expect(testid("finalize-preview")).toBeNull();

    click(testid("finalize-btn"));
    await flush();
    click(testid("finalize-option-goals"));
    await flush();
    expect(testid("finalize-goals-selection")).not.toBeNull();
    expect(testid("finalize-results")).toBeNull();

    client.releaseArchive();
    await flush();
    expect(testid("finalize-goals-selection")).not.toBeNull();
    expect(testid("finalize-results")).toBeNull();
  });

  it("archive sweep archives exactly the fully-terminal milestone in a 3-way mixed fixture", async () => {
    const client = new ArchiveExactnessClient();
    await mount(client);
    await openPreview("milestones", "archive");

    expect(testids("finalize-affected-")).toEqual(["MA"]);
    expect(testid("finalize-affected-MA")?.textContent).toContain("archive-milestone");
    // MB: grouped items all terminal, but the milestone's own status ("open") is not.
    expect(testid("finalize-skipped-MB")?.textContent).toContain(SKIP_MILESTONE_NOT_TERMINAL);
    expect(testid("finalize-skipped-MB")?.textContent).toContain("open");
    // MC: has a non-terminal grouped item.
    expect(testid("finalize-skipped-MC")?.textContent).toContain(SKIP_NON_TERMINAL_ITEMS);
    expect(testid("finalize-skipped-MC")?.textContent).toContain("tasks:T3");

    await holdFull(testid("finalize-execute"));

    // Exactness: archiveMilestone was called for MA only, never MB/MC.
    expect(client.calls).toEqual([
      { op: "archiveMilestone", milestoneId: "MA", summary: "finalized: Alpha" },
    ]);
    expect(testids("finalize-result-")).toEqual(["MA"]);
    expect(testid("finalize-result-MA")?.textContent).toContain("ok");
  });

  it("archive-mode partial failure: a later archivable id still executes after an earlier archiveMilestone rejects", async () => {
    const client = new ArchivePartialFailureClient();
    await mount(client);
    await openPreview("milestones", "archive");

    expect(testids("finalize-affected-")).toEqual(["MA", "MD"]);

    await holdFull(testid("finalize-execute"));

    // Mid-sweep continuation: MA's rejection did not prevent MD's write.
    expect(client.calls).toEqual([
      { op: "archiveMilestone", milestoneId: "MA", summary: "finalized: Alpha" },
      { op: "archiveMilestone", milestoneId: "MD", summary: "finalized: Delta" },
    ]);
    expect(testids("finalize-result-")).toEqual(["MA", "MD"]);
    expect(testid("finalize-result-MA")?.textContent).toContain("failed");
    expect(testid("finalize-result-MA")?.textContent).toContain("MA archive refused");
    expect(testid("finalize-result-MD")?.textContent).toContain("ok");
  });

  it("Escape dismisses the finalize preview modal at the PREVIEW step without executing anything", async () => {
    const client = new ArchiveExactnessClient();
    await mount(client);
    await openPreview("milestones", "archive");

    expect(testid("finalize-preview")).not.toBeNull();
    press("Escape");
    await flush();
    expect(testid("finalize-preview")).toBeNull();
    // Dismissing at the preview step must not have fired any write.
    expect(client.calls).toEqual([]);
  });

  it("Escape dismisses the finalize preview modal at the RESULTS (summary) step without re-executing or reverting", async () => {
    const client = new ArchiveExactnessClient();
    await mount(client);
    await openPreview("milestones", "archive");
    await holdFull(testid("finalize-execute"));

    expect(testid("finalize-results")).not.toBeNull();
    press("Escape");
    await flush();
    expect(testid("finalize-preview")).toBeNull();
    // The single sweep call from the hold-execute is unchanged by Escape —
    // dismissal at the results step neither re-runs nor reverts it.
    expect(client.calls).toEqual([
      { op: "archiveMilestone", milestoneId: "MA", summary: "finalized: Alpha" },
    ]);
  });

  it("does not regress the '+ milestone' create flow on the milestones view now that finalize-btn shares its toolbar row", async () => {
    const client = new MilestonesOnlyClient();
    await mount(client);
    click(testid("ledger-milestones"));
    await flush();

    // Both controls coexist in the toolbar.
    expect(testid("finalize-btn")).not.toBeNull();
    expect(testid("new-item-or-milestone")).not.toBeNull();

    click(testid("new-item-or-milestone"));
    await flush();
    setValue(testid("ms-title"), "Phase Two");
    await holdFull(testid("ms-create"));

    expect(testid("flash")?.textContent).toContain("created M2");
    expect(client.createMilestoneCalls).toEqual([{ title: "Phase Two" }]);
  });
});
