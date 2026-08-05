/**
 * T621 — the TUI finalize overlay (G83): `F` on the goals/milestones frames
 * opens a two-option select (Q291), selection computes the shared
 * `@cq/ledger/finalize` plan and shows the preview (the SAME id list the web
 * preview shows, Q292, plus skipped reasons), Enter executes through the
 * client (updateMilestone / updateItem / archiveMilestone) and the results
 * step lists per-id ok/failed. Esc cancels at every step.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import { render } from "ink-testing-library";
import { App, GoalsFinalizePreview, GoalsFinalizeResults } from "../src/app.js";
import { FakeClient } from "./fakeClient.js";
import {
  buildFinalizeSnapshot,
  runGoalsFinalize,
  SKIP_INCOMPLETE_MILESTONE,
  SKIP_WRONG_PHASE,
  type GoalsFinalizePlan,
} from "@cq/ledger/finalize";
import type {
  ArchiveContent,
  ArchivePointer,
  FetchedLedger,
  Item,
  ItemMutationAckDto,
  ItemPatch,
  LedgerClient,
  LedgerSchema,
  LedgerSummary,
  MilestoneMutationAckDto,
  MilestonePatch,
} from "../src/types.js";

const UP = "[A";
const DOWN = "[B";
const ENTER = "\r";
const ESC = "";
const BACKSPACE = "\x7f";
const SPACE = " ";

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

const PICK_APPLY = "Apply Done to completed items";
const PICK_ARCHIVE = "Archive all Done items";

const tick = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Harness {
  frame: () => string;
  key: (s: string) => Promise<void>;
  unmount: () => void;
}

async function mountElement(element: React.ReactElement): Promise<Harness> {
  const r = render(element);
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

function mount(client: LedgerClient): Promise<Harness> {
  return mountElement(<App client={client} />);
}

async function waitFor(h: Harness, substr: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (h.frame().includes(substr)) return;
    await tick(10);
  }
  throw new Error(`waitFor: '${substr}' never appeared; frame:\n${h.frame()}`);
}

/**
 * Advance one overlay step by pressing Enter, resilient to a dropped
 * keystroke (cf. app.test.tsx's `advance`, D23): a freshly-mounted step can
 * miss an Enter that arrives before its input handler attaches. Re-presses
 * only while `still` is showing and `done` has not appeared, so it never
 * overshoots (the execute step is additionally guarded in-component).
 */
async function advance(h: Harness, still: string, done: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (h.frame().includes(done)) return;
    if (h.frame().includes(still)) await h.key(ENTER);
    else await tick(10);
  }
  throw new Error(`advance: '${done}' never appeared (stuck on '${still}'); frame:\n${h.frame()}`);
}

async function typeFinalize(h: Harness): Promise<void> {
  await tick(50);
  for (const character of "FINALIZE") await h.key(character);
}

async function confirmFinalize(h: Harness): Promise<void> {
  await typeFinalize(h);
  expect(h.frame()).toContain("confirmation: FINALIZE▌");
  await h.key(ENTER);
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

const milestonesSchema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: { title: { type: "string", required: true } },
  idPrefix: "M",
};

const tasksSchema: LedgerSchema = {
  statusValues: ["planned", "wip", "done"],
  terminalStatuses: ["done"],
  fields: { headline: { type: "string", required: true } },
  idPrefix: "T",
};

function item(
  id: string,
  milestoneId: string,
  status: string,
  fields: Record<string, string | string[]>,
): Item {
  return { id, milestoneId, status, fields, createdAt: TS, updatedAt: TS };
}

function itemAcknowledgement(value: Item): ItemMutationAckDto {
  return {
    id: value.id,
    milestoneId: value.milestoneId,
    status: value.status,
    fields: {},
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function milestoneAcknowledgement(value: Item): MilestoneMutationAckDto {
  return {
    id: value.id,
    status: value.status,
    fields: {},
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/**
 * Eligible fixture: M1 (open, "Alpha") has only terminal work → apply-done
 * closes it; M2 (done, "Beta") is fully terminal AND itself done → archive
 * sweeps it. Records every updateMilestone/archiveMilestone call.
 */
class EligibleClient implements LedgerClient {
  async getUsageStats(): Promise<import("../src/types.js").UsageStatsSnapshot> {
    throw new Error("not used");
  }
  milestoneUpdates: Array<[string, MilestonePatch]> = [];
  archives: Array<[string, string]> = [];

  displayName(): string {
    return "cq1";
  }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [
      { name: "milestones", itemCount: 2 },
      { name: "tasks", itemCount: 2 },
    ];
  }
  async fetchLedger(id: string, _projection: import("../src/types.js").ItemProjection): Promise<FetchedLedger> {
    if (id === "milestones") {
      return {
        id,
        schema: milestonesSchema,
        counters: { milestone: 3, item: 3 },
        milestones: [
          {
            id: "active",
            milestone: { id: "active", status: "open", title: "", description: "" },
            items: [
              item("M1", "active", "open", { title: "Alpha" }),
              item("M2", "active", "done", { title: "Beta" }),
            ],
          },
        ],
        archivePointers: [],
      };
    }
    if (id === "tasks") {
      return {
        id,
        schema: tasksSchema,
        counters: { milestone: 3, item: 3 },
        milestones: [
          {
            id: "M1",
            milestone: { id: "M1", status: "open", title: "Alpha", description: "" },
            items: [item("T1", "M1", "done", { headline: "shipped" })],
          },
          {
            id: "M2",
            milestone: { id: "M2", status: "done", title: "Beta", description: "" },
            items: [item("T2", "M2", "done", { headline: "also shipped" })],
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
  async fetchItem(_ledgerId: string, _itemId: string, _projection: import("../src/types.js").ItemProjection): Promise<Item> {
    throw new Error("not used");
  }
  async createItem(): Promise<never> {
    throw new Error("not used");
  }
  async updateItem(): Promise<never> {
    throw new Error("not used");
  }
  async ftsSearch(_query: string, _projection: import("../src/types.js").ItemProjection): Promise<never[]> {
    return [];
  }
  async createMilestone(): Promise<never> {
    throw new Error("not used");
  }
  async updateMilestone(
    milestoneId: string,
    patch: MilestonePatch,
  ): Promise<MilestoneMutationAckDto> {
    this.milestoneUpdates.push([milestoneId, patch]);
    return milestoneAcknowledgement(
      item(milestoneId, "active", patch.status ?? "open", { title: "Alpha" }),
    );
  }
  async archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer> {
    this.archives.push([milestoneId, summary]);
    return { id: milestoneId, path: `./archive/milestones/${milestoneId}.md`, summary, title: "Beta", status: "done" };
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

/**
 * Partial-failure fixture (review round 1): TWO apply-done-eligible
 * milestones — M1 (open, "Alpha") and M2 (open, "Gamma") — each with only
 * terminal work. `updateMilestone` REJECTS for M1 and succeeds for M2, so a
 * sweep must continue past the failure (Q292 mid-sweep continuation) and the
 * results step must render the per-id failed/ok split. Every attempt is
 * recorded, success or not.
 */
class PartialFailureClient implements LedgerClient {
  async getUsageStats(): Promise<import("../src/types.js").UsageStatsSnapshot> {
    throw new Error("not used");
  }
  attempts: Array<[string, MilestonePatch]> = [];

  displayName(): string {
    return "cq1";
  }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [
      { name: "milestones", itemCount: 2 },
      { name: "tasks", itemCount: 2 },
    ];
  }
  async fetchLedger(id: string, _projection: import("../src/types.js").ItemProjection): Promise<FetchedLedger> {
    if (id === "milestones") {
      return {
        id,
        schema: milestonesSchema,
        counters: { milestone: 3, item: 3 },
        milestones: [
          {
            id: "active",
            milestone: { id: "active", status: "open", title: "", description: "" },
            items: [
              item("M1", "active", "open", { title: "Alpha" }),
              item("M2", "active", "open", { title: "Gamma" }),
            ],
          },
        ],
        archivePointers: [],
      };
    }
    if (id === "tasks") {
      return {
        id,
        schema: tasksSchema,
        counters: { milestone: 3, item: 3 },
        milestones: [
          {
            id: "M1",
            milestone: { id: "M1", status: "open", title: "Alpha", description: "" },
            items: [item("T1", "M1", "done", { headline: "shipped" })],
          },
          {
            id: "M2",
            milestone: { id: "M2", status: "open", title: "Gamma", description: "" },
            items: [item("T2", "M2", "done", { headline: "also shipped" })],
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
  async fetchItem(_ledgerId: string, _itemId: string, _projection: import("../src/types.js").ItemProjection): Promise<Item> {
    throw new Error("not used");
  }
  async createItem(): Promise<never> {
    throw new Error("not used");
  }
  async updateItem(): Promise<never> {
    throw new Error("not used");
  }
  async ftsSearch(_query: string, _projection: import("../src/types.js").ItemProjection): Promise<never[]> {
    return [];
  }
  async createMilestone(): Promise<never> {
    throw new Error("not used");
  }
  async updateMilestone(
    milestoneId: string,
    patch: MilestonePatch,
  ): Promise<MilestoneMutationAckDto> {
    this.attempts.push([milestoneId, patch]);
    if (milestoneId === "M1") throw new Error("disk on fire");
    return milestoneAcknowledgement(
      item(milestoneId, "active", patch.status ?? "open", { title: "Gamma" }),
    );
  }
  async archiveMilestone(): Promise<ArchivePointer> {
    throw new Error("not used");
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

/** Open the milestones frame of the default FakeClient (ledgers sort: bugs,
 * milestones, questions, reviews, tasks → milestones is index 1). */
async function openFakeMilestones(h: Harness): Promise<void> {
  await h.key(DOWN);
  await h.key(ENTER);
  await waitFor(h, "M1");
}

const goalsSchema: LedgerSchema = {
  statusValues: ["clarifying", "planning", "planned", "building", "done", "abandoned"],
  terminalStatuses: ["done", "abandoned"],
  fields: {
    title: { type: "string", required: true },
    description: { type: "string", required: true },
    milestones: { type: "id[]", required: false },
  },
  idPrefix: "G",
};

/**
 * Goals-frame fixture (delta coverage, T623): `F` is gated on the goals frame
 * too (app.tsx: `top.ledger === MILESTONES || top.ledger === GOALS_LEDGER`).
 * M1 is a milestone with ZERO items recorded under it in any OTHER ledger
 * (this fixture registers only "milestones" + "goals") — Q288/R722 treats
 * that as `SKIP_EMPTY_MILESTONE`, so M1 never joins `completeForGoals`.
 * G1 is not in the `building` phase → `SKIP_WRONG_PHASE`; G2 is `building`
 * but lists the (incomplete) M1 as its only work milestone →
 * `SKIP_INCOMPLETE_MILESTONE`. Both land in the apply-done plan's
 * `skipped[]`, which the preview must render with their reasons — this is
 * the assertion that fails if the TUI stops consuming `plan.skipped[]`.
 */
class GoalsClient implements LedgerClient {
  async getUsageStats(): Promise<import("../src/types.js").UsageStatsSnapshot> {
    throw new Error("not used");
  }
  displayName(): string {
    return "cq1";
  }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [
      { name: "goals", itemCount: 2 },
      { name: "milestones", itemCount: 1 },
    ];
  }
  async fetchLedger(id: string, _projection: import("../src/types.js").ItemProjection): Promise<FetchedLedger> {
    if (id === "milestones") {
      return {
        id,
        schema: milestonesSchema,
        counters: { milestone: 2, item: 2 },
        milestones: [
          {
            id: "active",
            milestone: { id: "active", status: "open", title: "", description: "" },
            items: [item("M1", "active", "open", { title: "Alpha" })],
          },
        ],
        archivePointers: [],
      };
    }
    if (id === "goals") {
      return {
        id,
        schema: goalsSchema,
        counters: { milestone: 2, item: 2 },
        milestones: [
          {
            id: "GHOME",
            milestone: { id: "GHOME", status: "open", title: "", description: "" },
            items: [
              item("G1", "GHOME", "planning", { title: "Ship the thing", description: "d", milestones: ["M1"] }),
              item("G2", "GHOME", "building", { title: "Ship the other thing", description: "d", milestones: ["M1"] }),
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
  async fetchItem(_ledgerId: string, _itemId: string, _projection: import("../src/types.js").ItemProjection): Promise<Item> {
    throw new Error("not used");
  }
  async createItem(): Promise<never> {
    throw new Error("not used");
  }
  async updateItem(): Promise<never> {
    throw new Error("not used");
  }
  async ftsSearch(_query: string, _projection: import("../src/types.js").ItemProjection): Promise<never[]> {
    return [];
  }
  async createMilestone(): Promise<never> {
    throw new Error("not used");
  }
  async updateMilestone(): Promise<never> {
    throw new Error("not used");
  }
  async archiveMilestone(): Promise<ArchivePointer> {
    throw new Error("not used");
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

class GoalsFinalizeClient implements LedgerClient {
  async getUsageStats(): Promise<import("../src/types.js").UsageStatsSnapshot> {
    throw new Error("not used");
  }
  itemUpdates: Array<[string, string, ItemPatch]> = [];
  milestoneUpdates: Array<[string, MilestonePatch]> = [];
  archives: Array<[string, string]> = [];
  private firstMilestoneRelease: (() => void) | null = null;
  private firstMilestoneWait: Promise<void> | null = null;

  constructor(
    private readonly failMilestoneId: string | null = null,
    pauseFirstMilestone = false,
  ) {
    if (pauseFirstMilestone) {
      this.firstMilestoneWait = new Promise((resolve) => {
        this.firstMilestoneRelease = resolve;
      });
    }
  }

  releaseFirstMilestone(): void {
    const release = this.firstMilestoneRelease;
    if (release === null) throw new Error("first milestone write is not paused");
    this.firstMilestoneRelease = null;
    release();
  }

  displayName(): string {
    return "cq1";
  }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [
      { name: "goals", itemCount: 2 },
      { name: "milestones", itemCount: 4 },
      { name: "tasks", itemCount: 2 },
    ];
  }
  async fetchLedger(id: string, _projection: import("../src/types.js").ItemProjection): Promise<FetchedLedger> {
    if (id === "milestones") {
      return {
        id,
        schema: milestonesSchema,
        counters: { milestone: 5, item: 5 },
        milestones: [
          {
            id: "active",
            milestone: { id: "active", status: "open", title: "", description: "" },
            items: [
              item("MW1", "active", "open", { title: "Work one" }),
              item("MW2", "active", "done", { title: "Work two" }),
              item("MC1", "active", "open", { title: "Coordination one" }),
              item("MC2", "active", "done", { title: "Coordination two" }),
            ],
          },
        ],
        archivePointers: [],
      };
    }
    if (id === "goals") {
      return {
        id,
        schema: goalsSchema,
        counters: { milestone: 3, item: 3 },
        milestones: [
          {
            id: "MC1",
            milestone: { id: "MC1", status: "open", title: "Coordination one", description: "" },
            items: [
              item("G1", "MC1", "building", {
                title: "First goal",
                description: "d1",
                milestones: ["MW1"],
              }),
            ],
          },
          {
            id: "MC2",
            milestone: { id: "MC2", status: "done", title: "Coordination two", description: "" },
            items: [
              item("G2", "MC2", "planned", {
                title: "Second goal",
                description: "d2",
                milestones: ["MW2"],
              }),
            ],
          },
        ],
        archivePointers: [],
      };
    }
    if (id === "tasks") {
      return {
        id,
        schema: tasksSchema,
        counters: { milestone: 3, item: 3 },
        milestones: [
          {
            id: "MW1",
            milestone: { id: "MW1", status: "open", title: "Work one", description: "" },
            items: [item("T1", "MW1", "done", { headline: "first work" })],
          },
          {
            id: "MW2",
            milestone: { id: "MW2", status: "done", title: "Work two", description: "" },
            items: [item("T2", "MW2", "done", { headline: "second work" })],
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
  async fetchItem(_ledgerId: string, _itemId: string, _projection: import("../src/types.js").ItemProjection): Promise<Item> {
    throw new Error("not used");
  }
  async createItem(): Promise<never> {
    throw new Error("not used");
  }
  async updateItem(
    ledgerId: string,
    itemId: string,
    patch: ItemPatch,
  ): Promise<ItemMutationAckDto> {
    this.itemUpdates.push([ledgerId, itemId, patch]);
    return itemAcknowledgement(
      item(itemId, itemId === "G1" ? "MC1" : "MC2", patch.status ?? "building", {
        title: itemId,
        description: "updated",
        milestones: [itemId === "G1" ? "MW1" : "MW2"],
      }),
    );
  }
  async ftsSearch(_query: string, _projection: import("../src/types.js").ItemProjection): Promise<never[]> {
    return [];
  }
  async createMilestone(): Promise<never> {
    throw new Error("not used");
  }
  async updateMilestone(
    milestoneId: string,
    patch: MilestonePatch,
  ): Promise<MilestoneMutationAckDto> {
    this.milestoneUpdates.push([milestoneId, patch]);
    if (this.firstMilestoneWait !== null) {
      const wait = this.firstMilestoneWait;
      this.firstMilestoneWait = null;
      await wait;
    }
    if (milestoneId === this.failMilestoneId) throw new Error(`cannot close ${milestoneId}`);
    return milestoneAcknowledgement(
      item(milestoneId, "active", patch.status ?? "open", { title: milestoneId }),
    );
  }
  async archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer> {
    this.archives.push([milestoneId, summary]);
    return {
      id: milestoneId,
      path: `./archive/milestones/${milestoneId}.md`,
      summary,
      title: milestoneId,
      status: "done",
    };
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

class GoalsParityClient implements LedgerClient {
  async getUsageStats(): Promise<import("../src/types.js").UsageStatsSnapshot> {
    throw new Error("not used");
  }
  readonly calls: string[] = [];

  displayName(): string {
    return "cq1";
  }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [
      { name: "goals", itemCount: GOALS_PARITY_FIXTURE.goals.length },
      { name: "milestones", itemCount: GOALS_PARITY_FIXTURE.milestones.length },
      { name: "tasks", itemCount: GOALS_PARITY_FIXTURE.tasks.length },
    ];
  }
  async fetchLedger(id: string, _projection: import("../src/types.js").ItemProjection): Promise<FetchedLedger> {
    if (id === "milestones") {
      return {
        id,
        schema: milestonesSchema,
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
                description: "",
                milestones: goal.milestones,
              })),
          };
        }),
        archivePointers: [],
      };
    }
    throw new Error(`Ledger not found: ${id}`);
  }
  async fetchLedgerArchive(): Promise<ArchiveContent> {
    throw new Error("not used");
  }
  async fetchItem(_ledgerId: string, _itemId: string, _projection: import("../src/types.js").ItemProjection): Promise<Item> {
    throw new Error("not used");
  }
  async createItem(): Promise<never> {
    throw new Error("not used");
  }
  async updateItem(
    ledgerId: string,
    itemId: string,
    patch: ItemPatch,
  ): Promise<ItemMutationAckDto> {
    this.calls.push(`goal:${itemId}:to-${patch.status}`);
    if (
      itemId === GOALS_PARITY_FIXTURE.failure.goalId &&
      patch.status === GOALS_PARITY_FIXTURE.failure.status
    ) {
      throw new Error(GOALS_PARITY_FIXTURE.failure.message);
    }
    return itemAcknowledgement(
      item(itemId, "active", patch.status ?? "open", {
        title: itemId,
        description: "",
        milestones: [],
      }),
    );
  }
  async ftsSearch(_query: string, _projection: import("../src/types.js").ItemProjection): Promise<never[]> {
    return [];
  }
  async createMilestone(): Promise<never> {
    throw new Error("not used");
  }
  async updateMilestone(
    milestoneId: string,
    patch: MilestonePatch,
  ): Promise<MilestoneMutationAckDto> {
    this.calls.push(`milestone:${milestoneId}:close`);
    return milestoneAcknowledgement(
      item(milestoneId, "active", patch.status ?? "open", { title: milestoneId }),
    );
  }
  async archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer> {
    this.calls.push(`milestone:${milestoneId}:archive`);
    return {
      id: milestoneId,
      path: `./archive/milestones/${milestoneId}.md`,
      summary,
      title: milestoneId,
      status: "done",
    };
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

async function openGoalsFinalize(h: Harness): Promise<void> {
  await h.key(ENTER);
  await waitFor(h, "G1");
  await h.key("F");
  await waitFor(h, "finalize · goals · preview");
  await tick(50);
}

/**
 * Archive-sweep exactness fixture (delta coverage, T623): three milestones
 * spanning the archive predicate's (Q290) three outcomes — MA is fully
 * terminal (all grouped items terminal AND its own status is terminal) →
 * archivable; MB's grouped items are all terminal but the milestone ITSELF
 * is still "open" (item-terminal-but-self-open) → `SKIP_MILESTONE_NOT_TERMINAL`;
 * MC has a non-terminal grouped item → `SKIP_NON_TERMINAL_ITEMS`. Only MA may
 * ever reach `archiveMilestone`.
 */
class ArchiveExactnessClient implements LedgerClient {
  async getUsageStats(): Promise<import("../src/types.js").UsageStatsSnapshot> {
    throw new Error("not used");
  }
  archives: Array<[string, string]> = [];

  displayName(): string {
    return "cq1";
  }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [
      { name: "milestones", itemCount: 3 },
      { name: "tasks", itemCount: 3 },
    ];
  }
  async fetchLedger(id: string, _projection: import("../src/types.js").ItemProjection): Promise<FetchedLedger> {
    if (id === "milestones") {
      return {
        id,
        schema: milestonesSchema,
        counters: { milestone: 4, item: 4 },
        milestones: [
          {
            id: "active",
            milestone: { id: "active", status: "open", title: "", description: "" },
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
        id,
        schema: tasksSchema,
        counters: { milestone: 4, item: 4 },
        milestones: [
          {
            id: "MA",
            milestone: { id: "MA", status: "done", title: "Alpha", description: "" },
            items: [item("T1", "MA", "done", { headline: "a-work" })],
          },
          {
            id: "MB",
            milestone: { id: "MB", status: "open", title: "Bravo", description: "" },
            items: [item("T2", "MB", "done", { headline: "b-work" })],
          },
          {
            id: "MC",
            milestone: { id: "MC", status: "open", title: "Charlie", description: "" },
            items: [item("T3", "MC", "planned", { headline: "c-work" })],
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
  async fetchItem(_ledgerId: string, _itemId: string, _projection: import("../src/types.js").ItemProjection): Promise<Item> {
    throw new Error("not used");
  }
  async createItem(): Promise<never> {
    throw new Error("not used");
  }
  async updateItem(): Promise<never> {
    throw new Error("not used");
  }
  async ftsSearch(_query: string, _projection: import("../src/types.js").ItemProjection): Promise<never[]> {
    return [];
  }
  async createMilestone(): Promise<never> {
    throw new Error("not used");
  }
  async updateMilestone(): Promise<never> {
    throw new Error("not used");
  }
  async archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer> {
    this.archives.push([milestoneId, summary]);
    return { id: milestoneId, path: `./archive/milestones/${milestoneId}.md`, summary, title: milestoneId, status: "done" };
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

describe("TUI finalize overlay (T621)", () => {
  it("F on the milestones frame opens the two-option select; Esc closes it", async () => {
    const h = await mount(new FakeClient());
    await openFakeMilestones(h);
    expect(h.frame()).toContain("F finalize"); // footer hint
    await h.key("F");
    await waitFor(h, PICK_APPLY);
    expect(h.frame()).toContain(PICK_ARCHIVE);
    await escapeUntilGone(h, PICK_APPLY); // Esc closes at the pick step
    h.unmount();
  });

  it("F is inert (and unadvertised) on a non-gated ledger frame", async () => {
    const h = await mount(new FakeClient());
    await h.key(ENTER); // open bugs (index 0)
    await waitFor(h, "D1");
    expect(h.frame()).not.toContain("F finalize");
    await h.key("F");
    await tick(30);
    expect(h.frame()).not.toContain(PICK_APPLY);
    h.unmount();
  });

  it("non-eligible fixture: preview shows the 'nothing eligible' state with the skipped list; Esc closes", async () => {
    // FakeClient's M1 has open bugs/tasks under it → nothing is actionable.
    const h = await mount(new FakeClient());
    await openFakeMilestones(h);
    await h.key("F");
    await waitFor(h, PICK_APPLY);
    await advance(h, PICK_APPLY, "nothing eligible"); // pick apply-done
    expect(h.frame()).toContain("This is a store-wide milestone sweep across");
    expect(h.frame()).toContain("all ledgers.");
    // Skipped reasons are listed (M1 blocked by a non-terminal item).
    expect(h.frame()).toContain("M1");
    expect(h.frame()).toContain("non-terminal items");
    await escapeUntilGone(h, "nothing eligible"); // Esc closes at the preview step
    h.unmount();
  });

  it("apply-done: preview lists the plan ids, Enter executes updateMilestone, results list per id", async () => {
    const client = new EligibleClient();
    const h = await mount(client);
    await h.key(ENTER); // open milestones (index 0)
    await waitFor(h, "M1");
    await h.key("F");
    await waitFor(h, PICK_APPLY);
    await advance(h, PICK_APPLY, "close-milestone"); // pick apply-done → preview
    // The same computed id list the web preview shows (Q292) + skipped reasons.
    expect(h.frame()).toContain("M1");
    expect(h.frame()).toContain("already terminal"); // M2 skipped
    await confirmFinalize(h);
    await waitFor(h, "finalize · results");
    expect(client.milestoneUpdates).toEqual([["M1", { status: "done" }]]);
    await waitFor(h, "ok");
    expect(h.frame()).toContain("M1");
    await escapeUntilGone(h, "finalize · results"); // Esc closes at the results step
    expect(h.frame()).not.toContain("close-milestone");
    h.unmount();
  });

  it("partial failure: the sweep continues past a rejecting id and results render the per-id failed/ok split", async () => {
    const client = new PartialFailureClient();
    const h = await mount(client);
    await h.key(ENTER); // open milestones (index 0)
    await waitFor(h, "M1");
    await h.key("F");
    await waitFor(h, PICK_APPLY);
    await advance(h, PICK_APPLY, "close-milestone"); // pick apply-done → preview
    // Both milestones are eligible — the preview lists both.
    expect(h.frame()).toContain("M1");
    expect(h.frame()).toContain("M2");
    await confirmFinalize(h);
    await waitFor(h, "finalize · results");
    // Mid-sweep continuation: M1's rejection did not stop the M2 write.
    expect(client.attempts).toEqual([
      ["M1", { status: "done" }],
      ["M2", { status: "done" }],
    ]);
    // Per-id split: the rejecting id shows the failed marker + its error
    // text; the later id shows ok. Both ids are listed.
    expect(h.frame()).toContain("failed M1");
    expect(h.frame()).toContain("disk on fire");
    expect(h.frame()).toMatch(/ok\s+M2/);
    // Footer counts the failures.
    expect(h.frame()).toContain("1 failed");
    h.unmount();
  });

  it("archive: Enter drives archiveMilestone with the synthesized summary and lists the id in results", async () => {
    const client = new EligibleClient();
    const h = await mount(client);
    await h.key(ENTER); // open milestones
    await waitFor(h, "M1");
    await h.key("F");
    await waitFor(h, PICK_ARCHIVE);
    // Move the pick cursor to the archive option (drop-resilient).
    {
      const end = Date.now() + 2000;
      while (!h.frame().includes(`› ${PICK_ARCHIVE}`) && Date.now() < end) await h.key(DOWN);
    }
    await advance(h, `› ${PICK_ARCHIVE}`, "finalize · archive"); // pick archive → preview
    await waitFor(h, "archive-milestone");
    expect(h.frame()).toContain("M2");
    expect(h.frame()).toContain("milestone status not terminal"); // M1 skipped
    await confirmFinalize(h);
    await waitFor(h, "finalize · results");
    expect(client.archives).toEqual([["M2", "finalized: Beta"]]);
    expect(h.frame()).toContain("M2");
    expect(h.frame()).toContain("ok");
    h.unmount();
  });

  it("F is inert (and unadvertised) on the tasks frame", async () => {
    const h = await mount(new FakeClient());
    // ledgers sort: bugs, milestones, questions, reviews, tasks → tasks is index 4.
    await h.key(DOWN);
    await h.key(DOWN);
    await h.key(DOWN);
    await h.key(DOWN);
    await h.key(ENTER);
    await waitFor(h, "T1");
    expect(h.frame()).not.toContain("F finalize");
    await h.key("F");
    await tick(30);
    expect(h.frame()).not.toContain(PICK_APPLY);
    h.unmount();
  });

  it("goals scope lists skipped goals with their reasons", async () => {
    const h = await mount(new GoalsClient());
    await h.key(ENTER); // open goals (index 0, alphabetically before milestones)
    await waitFor(h, "G1");
    expect(h.frame()).toContain("F finalize"); // footer hint live on the goals frame too
    await h.key("F");
    await waitFor(h, "finalize · goals · preview");
    // G1 is not `building` → SKIP_WRONG_PHASE (detail: its actual status).
    expect(h.frame()).toContain(`G1 — ${SKIP_WRONG_PHASE} (planning)`);
    // G2 is `building` but its only work milestone (M1) is empty/incomplete
    // → SKIP_INCOMPLETE_MILESTONE (detail: the offending milestone id). This
    // assertion binds to the shared plan's skipped[] list (@cq/ledger/finalize)
    // and fails if the TUI stops rendering it.
    expect(h.frame()).toContain(`G2 — ${SKIP_INCOMPLETE_MILESTONE} (M1)`);
    await escapeUntilGone(h, "finalize · goals · preview");
    h.unmount();
  });

  it("archive: sweep issues archiveMilestone for exactly the fully-terminal milestones in a mixed fixture", async () => {
    const client = new ArchiveExactnessClient();
    const h = await mount(client);
    await h.key(ENTER); // open milestones (index 0)
    await waitFor(h, "MA");
    await h.key("F");
    await waitFor(h, PICK_ARCHIVE);
    {
      const end = Date.now() + 2000;
      while (!h.frame().includes(`› ${PICK_ARCHIVE}`) && Date.now() < end) await h.key(DOWN);
    }
    await advance(h, `› ${PICK_ARCHIVE}`, "finalize · archive"); // pick archive → preview
    await waitFor(h, "archive-milestone");
    // MA (fully terminal, incl. its own status) is the only affected entry.
    expect(h.frame()).toContain("MA");
    // MB: grouped items all terminal, but the milestone's OWN status ("open")
    // is not — item-terminal-but-self-open.
    expect(h.frame()).toContain("MB — milestone status not terminal (open)");
    // MC: has a non-terminal grouped item.
    expect(h.frame()).toContain("MC — non-terminal items (tasks:T3)");
    await confirmFinalize(h);
    await waitFor(h, "finalize · results");
    // Exactness: archiveMilestone was called for MA only, with the
    // synthesized 'finalized: <title>' summary — never for MB or MC.
    expect(client.archives).toEqual([["MA", "finalized: Alpha"]]);
    expect(h.frame()).toContain("MA");
    expect(h.frame()).toContain("ok");
    h.unmount();
  });

  it("goals scope defaults all eligible goals selected and Space recomputes work and coordination operations", async () => {
    const h = await mount(new GoalsFinalizeClient());
    await openGoalsFinalize(h);

    expect(h.frame()).toContain("This finalizes selected completed goals and");
    expect(h.frame()).toContain("their related work and coordination");
    expect(h.frame()).toContain("Q290 are archived.");
    expect(h.frame()).toContain("› [x] G1");
    expect(h.frame()).toContain("  [x] G2");
    expect(h.frame()).toContain("milestone:MW1:close");
    expect(h.frame()).toContain("milestone:MC1:close");
    expect(h.frame()).toContain("milestone:MW2:archive");
    expect(h.frame()).toContain("milestone:MC2:archive");

    // The TUI consumes the same ordered graph as the browser client. The
    // confirmation gesture differs, but selected ids and operation order do
    // not: planned G2 needs its intermediate building write; building G1 does
    // not, and work/coordination archives remain distinct Q290 operations.
    const frame = h.frame();
    const operationIds = [
      "milestone:MW1:close",
      "goal:G2:to-building",
      "goal:G1:to-done",
      "goal:G2:to-done",
      "milestone:MC1:close",
      "milestone:MW1:archive",
      "milestone:MC1:archive",
      "milestone:MW2:archive",
      "milestone:MC2:archive",
    ];
    for (const [index, operationId] of operationIds.entries()) {
      expect(frame.indexOf(operationId)).toBeGreaterThan(index === 0 ? -1 : frame.indexOf(operationIds[index - 1]!));
    }

    await h.key(DOWN);
    expect(h.frame()).toContain("› [x] G2");
    await h.key(SPACE);
    expect(h.frame()).toContain("› [ ] G2");
    expect(h.frame()).not.toContain("goal:G2:to-building");
    expect(h.frame()).not.toContain("goal:G2:to-done");
    expect(h.frame()).not.toContain("milestone:MW2:archive");
    expect(h.frame()).not.toContain("milestone:MC2:archive");
    expect(h.frame()).toContain("milestone:MW1:close");
    expect(h.frame()).toContain("milestone:MC1:close");

    await h.key(UP);
    expect(h.frame()).toContain("› [x] G1");
    h.unmount();
  });

  it("matches the common representative selection, operation, and suppression contract", async () => {
    const client = new GoalsParityClient();
    const snapshot = buildFinalizeSnapshot(await Promise.all([
      client.fetchLedger("goals", "full"),
      client.fetchLedger("milestones", "full"),
      client.fetchLedger("tasks", "full"),
    ]));
    let executedPlan: GoalsFinalizePlan | null = null;
    const preview = await mountElement(
      <GoalsFinalizePreview
        snapshot={snapshot}
        onExecute={(plan) => {
          executedPlan = plan;
        }}
        onCancel={() => {
          throw new Error("preview unexpectedly cancelled");
        }}
      />,
    );

    let previousRowIndex = -1;
    for (const expected of GOALS_PARITY_FIXTURE.expected.eligibleGoalSelections) {
      const row = `[x] ${expected.id}`;
      expect(preview.frame()).toContain(row);
      expect(preview.frame().indexOf(row)).toBeGreaterThan(previousRowIndex);
      previousRowIndex = preview.frame().indexOf(row);
    }
    const deselectedIndex = GOALS_PARITY_FIXTURE.expected.eligibleGoalSelections.findIndex(
      ({ selected }) => !selected,
    );
    if (deselectedIndex < 0) throw new Error("parity fixture must contain a deselected goal");
    for (let index = 0; index < deselectedIndex; index += 1) await preview.key(DOWN);
    await preview.key(SPACE);

    previousRowIndex = -1;
    for (const expected of GOALS_PARITY_FIXTURE.expected.eligibleGoalSelections) {
      const row = `[${expected.selected ? "x" : " "}] ${expected.id}`;
      expect(preview.frame()).toContain(row);
      expect(preview.frame().indexOf(row)).toBeGreaterThan(previousRowIndex);
      previousRowIndex = preview.frame().indexOf(row);
    }
    let previousOperationIndex = -1;
    for (const operationId of GOALS_PARITY_FIXTURE.expected.operationIds) {
      expect(preview.frame()).toContain(operationId);
      expect(preview.frame().indexOf(operationId)).toBeGreaterThan(previousOperationIndex);
      previousOperationIndex = preview.frame().indexOf(operationId);
    }
    expect(preview.frame()).toContain(GOALS_PARITY_FIXTURE.expected.skippedGoalId);
    expect(preview.frame()).toContain(SKIP_INCOMPLETE_MILESTONE);

    await typeFinalize(preview);
    await preview.key(ENTER);
    await tick(50);
    if (executedPlan === null) throw new Error("typed confirmation did not emit a plan");
    preview.unmount();

    const results = await runGoalsFinalize(client, executedPlan);
    expect(client.calls).toEqual(GOALS_PARITY_FIXTURE.expected.attemptedOperationIds);
    const resultsView = await mountElement(
      <GoalsFinalizeResults
        results={results}
        onClose={() => {
          throw new Error("results unexpectedly closed");
        }}
      />,
    );

    previousOperationIndex = -1;
    for (const operationId of GOALS_PARITY_FIXTURE.expected.operationIds) {
      const marker = operationId === `goal:${GOALS_PARITY_FIXTURE.failure.goalId}:to-building`
        ? "failed"
        : GOALS_PARITY_FIXTURE.expected.suppressedOperationIds.includes(operationId)
          ? "suppressed"
          : "ok";
      const row = `${marker} ${operationId}`;
      expect(resultsView.frame()).toContain(row);
      expect(resultsView.frame().indexOf(row)).toBeGreaterThan(previousOperationIndex);
      previousOperationIndex = resultsView.frame().indexOf(row);
    }
    expect(resultsView.frame()).toContain(GOALS_PARITY_FIXTURE.failure.message);
    resultsView.unmount();
  });

  it("confirmation rejects bare, partial, and wrong-case input and resets after mismatch Enter", async () => {
    const client = new GoalsFinalizeClient();
    const h = await mount(client);
    await openGoalsFinalize(h);

    await h.key(ENTER);
    expect(h.frame()).toContain("confirmation did not match");
    expect(h.frame()).toContain("confirmation: ▌");
    expect(client.itemUpdates).toEqual([]);

    for (const character of "FIN") await h.key(character);
    await h.key(ENTER);
    expect(h.frame()).toContain("confirmation did not match");
    expect(h.frame()).toContain("confirmation: ▌");
    expect(client.itemUpdates).toEqual([]);

    for (const character of "finalize") await h.key(character);
    await h.key(ENTER);
    expect(h.frame()).toContain("confirmation did not match");
    expect(h.frame()).toContain("confirmation: ▌");
    expect(client.itemUpdates).toEqual([]);
    expect(client.milestoneUpdates).toEqual([]);
    expect(client.archives).toEqual([]);
    h.unmount();
  });

  it("FINALIZX, Backspace, E, Enter dispatches once; running ignores further input", async () => {
    const client = new GoalsFinalizeClient(null, true);
    const h = await mount(client);
    await openGoalsFinalize(h);

    for (const character of "FINALIZX") await h.key(character);
    await h.key(BACKSPACE);
    await h.key("E");
    expect(h.frame()).toContain("confirmation: FINALIZE▌");
    await h.key(ENTER);
    await waitFor(h, "executing…");
    await waitFor(h, "MW1");
    expect(client.milestoneUpdates).toEqual([["MW1", { status: "done" }]]);

    await typeFinalize(h);
    await h.key(ENTER);
    await h.key(ESC);
    expect(client.milestoneUpdates).toEqual([["MW1", { status: "done" }]]);
    expect(h.frame()).toContain("executing…");

    client.releaseFirstMilestone();
    await waitFor(h, "finalize · results");
    expect(client.itemUpdates.filter(([, itemId]) => itemId === "G1")).toHaveLength(1);
    h.unmount();
  });

  it("Esc and every Space selection change discard confirmation and mismatch state", async () => {
    const client = new GoalsFinalizeClient();
    const h = await mount(client);
    await openGoalsFinalize(h);

    for (const character of "FIN") await h.key(character);
    await h.key(ESC);
    await waitFor(h, "G1");
    expect(h.frame()).not.toContain("finalize · goals · preview");

    await h.key("F");
    await waitFor(h, "finalize · goals · preview");
    await tick(50);
    expect(h.frame()).toContain("confirmation: ▌");
    expect(h.frame()).not.toContain("confirmation did not match");

    await h.key(ENTER);
    expect(h.frame()).toContain("confirmation did not match");
    await typeFinalize(h);
    await h.key(SPACE);
    expect(h.frame()).toContain("confirmation: ▌");
    expect(h.frame()).not.toContain("confirmation did not match");
    await h.key(ENTER);
    expect(client.itemUpdates).toEqual([]);
    expect(client.milestoneUpdates).toEqual([]);
    expect(client.archives).toEqual([]);

    await typeFinalize(h);
    await h.key(ENTER);
    await waitFor(h, "finalize · results");
    expect(client.itemUpdates.length + client.milestoneUpdates.length + client.archives.length).toBeGreaterThan(0);
    h.unmount();
  });

  it("goals results distinguish attempted success, attempted failure, and suppressed operations by stable id", async () => {
    const client = new GoalsFinalizeClient("MW1");
    const h = await mount(client);
    await openGoalsFinalize(h);
    await confirmFinalize(h);
    await waitFor(h, "finalize · results");

    expect(h.frame()).toContain("failed milestone:MW1:close");
    expect(h.frame()).toContain("cannot close MW1");
    expect(h.frame()).toContain("ok goal:G1:to-done");
    expect(h.frame()).toContain("suppressed milestone:MW1:archive");
    expect(h.frame()).toContain("requires milestone:MW1:close");
    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// D121 — finalizePreview must re-enumerate ledgers (not trust cached state).
// ---------------------------------------------------------------------------

describe("TUI finalize re-enumerates ledgers (D121)", () => {
  it("finalizePreview calls enumerateLedgers after the initial mount enumeration", async () => {
    class CountingClient extends FakeClient {
      enumerateCalls = 0;
      override async enumerateLedgers(): Promise<LedgerSummary[]> {
        this.enumerateCalls += 1;
        return super.enumerateLedgers();
      }
    }
    const client = new CountingClient();
    const h = await mount(client);
    await openFakeMilestones(h);
    const afterNav = client.enumerateCalls;
    expect(afterNav).toBeGreaterThanOrEqual(1);
    await h.key("F");
    await waitFor(h, PICK_APPLY);
    await advance(h, PICK_APPLY, "nothing eligible"); // pick apply-done → loadFinalizeSnapshot
    // loadFinalizeSnapshot must have re-enumerated (D121).
    expect(client.enumerateCalls).toBeGreaterThan(afterNav);
    h.unmount();
  });
});
