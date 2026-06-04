/**
 * In-memory LedgerClient fake for driving the Ink UI in tests without a
 * network or server. Models just enough of the ledger semantics the UI
 * exercises: a milestones ledger + one data ledger with items.
 */

import type {
  ArchiveContent,
  FetchedLedger,
  FieldValue,
  FtsHit,
  Item,
  ItemInit,
  ItemPatch,
  LedgerClient,
  LedgerSchema,
  LedgerSummary,
  MilestonePatch,
} from "../src/types.js";

const TS = "2026-01-01T00:00:00.000Z";

// A field whose rendered detail is far taller than any test terminal — exercises
// the windowed content pane (header/metadata must stay visible at the top; the
// pane must scroll). Each "Line N:" is its own paragraph (blank-separated) so it
// renders on its own row and is individually findable in a frame.
export const HUGE_NOTE = Array.from(
  { length: 40 },
  (_, i) => `- Line ${i + 1}: marker **b** \`c\`.`,
).join("\n");

interface Group {
  id: string;
  items: Item[];
}
interface LedgerData {
  schema: LedgerSchema;
  groups: Group[];
}

const milestonesSchema: LedgerSchema = {
  statusValues: ["open", "done", "postponed", "blocked"],
  terminalStatuses: ["done", "postponed"],
  fields: { title: { type: "string", required: true }, description: { type: "string", required: false } },
  idPrefix: "M",
};

const bugsSchema: LedgerSchema = {
  statusValues: ["open", "wip", "closed"],
  terminalStatuses: ["closed"],
  fields: { headline: { type: "string", required: true }, note: { type: "string", required: false } },
  idPrefix: "D",
  // Declarative status-transition guard (F1): drives the quick-transition UI.
  transitions: { open: ["wip", "closed"], wip: ["closed", "open"], closed: [] },
};

const tasksSchema: LedgerSchema = {
  statusValues: ["planned", "wip", "done"],
  terminalStatuses: ["done"],
  idPrefix: "T",
  transitions: { planned: ["wip", "done"], wip: ["done"], done: [] },
  fields: {
    headline: { type: "string", required: true },
    // `description` is on the long-field denylist → never a column.
    description: { type: "string", required: false },
    // `suggestedModel` is column-eligible and is the tasks-ledger default.
    suggestedModel: { type: "string", required: false },
    // `tags` is column-eligible (string[]) but not a default column.
    tags: { type: "string[]", required: false },
  },
};

const questionsSchema: LedgerSchema = {
  statusValues: ["open", "answered", "withdrawn"],
  terminalStatuses: ["answered", "withdrawn"],
  idPrefix: "Q",
  transitions: { open: ["answered", "withdrawn"], answered: [], withdrawn: [] },
  fields: {
    question: { type: "string", required: true },
    suggestions: { type: "string[]", required: false },
    recommendation: { type: "string", required: false },
    answer: { type: "string", required: false },
  },
};
const reviewsSchema: LedgerSchema = {
  statusValues: ["go-ahead", "revise"],
  terminalStatuses: ["go-ahead", "revise"],
  idPrefix: "R",
  transitions: { "go-ahead": [], revise: [] },
  fields: {
    summary: { type: "string", required: false },
    criticism: { type: "string[]", required: false },
  },
};

export class FakeClient implements LedgerClient {
  closed = false;
  private readonly _displayName: string;
  private msCounter = 1;
  private itemCounter = 1;

  constructor(displayName = "cq1") {
    this._displayName = displayName;
  }

  displayName(): string {
    return this._displayName;
  }

  private data: Record<string, LedgerData> = {
    milestones: {
      schema: milestonesSchema,
      groups: [
        {
          id: "active",
          items: [
            { id: "M1", milestoneId: "active", status: "open", fields: { title: "Bootstrap" }, createdAt: TS, updatedAt: TS },
          ],
        },
      ],
    },
    bugs: {
      schema: bugsSchema,
      groups: [
        {
          id: "M1",
          items: [
            { id: "D1", milestoneId: "M1", status: "open", fields: { headline: "warp leak", note: "intermittent" }, createdAt: TS, updatedAt: TS },
            { id: "D2", milestoneId: "M1", status: "open", fields: { headline: "huge item", note: HUGE_NOTE }, createdAt: TS, updatedAt: TS },
          ],
        },
      ],
    },
    tasks: {
      schema: tasksSchema,
      groups: [
        {
          id: "M1",
          items: [
            { id: "T1", milestoneId: "M1", status: "planned", fields: { headline: "wire mcp", suggestedModel: "opus", tags: ["backend"] }, createdAt: TS, updatedAt: TS },
            { id: "T2", milestoneId: "M1", status: "wip", fields: { headline: "tui columns", suggestedModel: "sonnet", tags: ["ui", "tui"] }, createdAt: TS, updatedAt: TS },
          ],
        },
      ],
    },
    questions: {
      schema: questionsSchema,
      groups: [
        {
          id: "M1",
          items: [
            { id: "Q1", milestoneId: "M1", status: "open", fields: { question: "Ship on Friday?", recommendation: "yes, ship it" }, createdAt: TS, updatedAt: TS },
            { id: "Q2", milestoneId: "M1", status: "open", fields: { question: "Which option?", suggestions: ["opt a", "opt b"] }, createdAt: TS, updatedAt: TS },
            { id: "Q3", milestoneId: "M1", status: "open", fields: { question: "Full narrative?", context: "the why", suggestions: ["s1", "s2"], recommendation: "do s1", answer: "picked s1" }, createdAt: TS, updatedAt: TS, author: "opus-4.8[1m]" },
          ],
        },
      ],
    },
    reviews: {
      schema: reviewsSchema,
      groups: [
        {
          id: "M1",
          items: [
            // Legacy review: no summary field, only criticism (string[]).
            { id: "R1", milestoneId: "M1", status: "revise", fields: { criticism: ["The plan lacks detail on error handling", "Missing rollback strategy"] }, createdAt: TS, updatedAt: TS },
            // Modern review: has a summary field.
            { id: "R2", milestoneId: "M1", status: "go-ahead", fields: { summary: "Looks good overall", criticism: ["Minor nit only"] }, createdAt: TS, updatedAt: TS },
          ],
        },
      ],
    },
  };

  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return Object.keys(this.data)
      .sort()
      .map((name) => ({
        name,
        itemCount: this.data[name]!.groups.reduce((n, g) => n + g.items.length, 0),
      }));
  }

  async fetchLedger(ledgerId: string): Promise<FetchedLedger> {
    const d = this.data[ledgerId];
    if (d === undefined) throw new Error(`Ledger not found: ${ledgerId}`);
    return {
      id: ledgerId,
      schema: d.schema,
      counters: { milestone: this.msCounter + 1, item: this.itemCounter + 1 },
      milestones: d.groups.map((g) => ({
        id: g.id,
        milestone: { id: g.id, status: "open", title: g.id === "active" ? "" : "Bootstrap", description: "" },
        items: g.items,
      })),
      archivePointers: [],
    };
  }

  async fetchLedgerArchive(_ledgerId: string, _archiveId: string): Promise<ArchiveContent> {
    throw new Error("fetchLedgerArchive not implemented in FakeClient");
  }

  private find(ledgerId: string, itemId: string): Item {
    const d = this.data[ledgerId];
    if (d === undefined) throw new Error(`Ledger not found: ${ledgerId}`);
    for (const g of d.groups) {
      const it = g.items.find((i) => i.id === itemId);
      if (it !== undefined) return it;
    }
    throw new Error(`Item not found: ${itemId}`);
  }

  async fetchItem(ledgerId: string, itemId: string): Promise<Item> {
    return this.find(ledgerId, itemId);
  }

  async createItem(ledgerId: string, milestoneId: string, init: ItemInit): Promise<Item> {
    const d = this.data[ledgerId];
    if (d === undefined) throw new Error(`Ledger not found: ${ledgerId}`);
    if (!d.schema.statusValues.includes(init.status)) {
      throw new Error(`Invalid status "${init.status}"`);
    }
    this.itemCounter += 1;
    const item: Item = {
      id: `${d.schema.idPrefix ?? "X"}${this.itemCounter}`,
      milestoneId,
      status: init.status,
      fields: init.fields,
      createdAt: TS,
      updatedAt: TS,
    };
    if (init.author !== undefined) item.author = init.author;
    if (init.session !== undefined) item.session = init.session;
    let group = d.groups.find((g) => g.id === milestoneId);
    if (group === undefined) {
      group = { id: milestoneId, items: [] };
      d.groups.push(group);
    }
    group.items.push(item);
    return item;
  }

  async updateItem(ledgerId: string, itemId: string, patch: ItemPatch): Promise<Item> {
    const it = this.find(ledgerId, itemId);
    if (patch.status !== undefined) it.status = patch.status;
    if (patch.fields !== undefined) {
      for (const [k, v] of Object.entries(patch.fields)) it.fields[k] = v as FieldValue;
    }
    if (patch.author !== undefined) it.author = patch.author;
    if (patch.session !== undefined) it.session = patch.session;
    return it;
  }

  async ftsSearch(query: string, opts?: { ledger?: string }): Promise<FtsHit[]> {
    const q = query.toLowerCase();
    const hits: FtsHit[] = [];
    for (const [ledgerId, d] of Object.entries(this.data)) {
      if (opts?.ledger !== undefined && opts.ledger !== ledgerId) continue;
      for (const g of d.groups) {
        for (const it of g.items) {
          const hay = (it.status + " " + Object.values(it.fields).flat().join(" ")).toLowerCase();
          if (hay.includes(q)) hits.push({ ledgerId, item: it, score: 1, matchedFields: [] });
        }
      }
    }
    return hits;
  }

  async createMilestone(init: { title: string; description?: string; id?: string }): Promise<Item> {
    this.msCounter += 1;
    const item: Item = {
      id: init.id ?? `M${this.msCounter}`,
      milestoneId: "active",
      status: "open",
      fields: { title: init.title, ...(init.description !== undefined ? { description: init.description } : {}) },
      createdAt: TS,
      updatedAt: TS,
    };
    this.data["milestones"]!.groups[0]!.items.push(item);
    return item;
  }

  async updateMilestone(milestoneId: string, patch: MilestonePatch): Promise<Item> {
    const it = this.find("milestones", milestoneId);
    if (patch.status !== undefined) it.status = patch.status;
    if (patch.title !== undefined) it.fields["title"] = patch.title;
    if (patch.description !== undefined) it.fields["description"] = patch.description;
    return it;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
