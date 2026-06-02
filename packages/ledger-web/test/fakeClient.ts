/**
 * In-memory LedgerClient fake for driving the web UI in tests (no network).
 * Models a milestones ledger + one data ledger with items.
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
const plainSchema: LedgerSchema = {
  statusValues: ["open", "closed"],
  terminalStatuses: ["closed"],
  fields: { headline: { type: "string", required: true } },
  idPrefix: "P",
  // No `transitions` map.
};
const questionsSchema: LedgerSchema = {
  statusValues: ["open", "answered", "withdrawn"],
  terminalStatuses: ["answered", "withdrawn"],
  idPrefix: "Q",
  transitions: { open: ["answered", "withdrawn"], answered: [], withdrawn: [] },
  fields: {
    question: { type: "string", required: true },
    context: { type: "string", required: false },
    recommendation: { type: "string", required: false },
    suggestions: { type: "string[]", required: false },
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

interface ArchiveEntry {
  pointer: { id: string; path: string; summary: string };
  content: ArchiveContent;
}

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

  /** Per-ledger archive entries (pointer list + content). */
  private archives: Record<string, ArchiveEntry[]> = {
    bugs: [
      {
        pointer: { id: "A1", path: "./archive/bugs/A1.md", summary: "initial bootstrap fixes" },
        content: {
          kind: "group",
          milestone: {
            id: "A1",
            title: "Bootstrap",
            description: "",
            items: [
              { id: "D99", milestoneId: "A1", status: "closed", fields: { headline: "archived bug", note: "" }, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" },
            ],
          },
        },
      },
    ],
  };
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
            { id: "D1", milestoneId: "M1", status: "open", fields: { headline: "warp leak", note: "**intermittent** glitch" }, createdAt: TS, updatedAt: TS },
          ],
        },
        {
          id: "M2",
          items: [
            { id: "D3", milestoneId: "M2", status: "open", fields: { headline: "ion drive misfire", note: "" }, createdAt: TS, updatedAt: TS },
          ],
        },
      ],
    },
    // A non-milestones ledger with NO `transitions` map (sorts last): exercises
    // the back-compat path where the quick-transition buttons must not render.
    plain: {
      schema: plainSchema,
      groups: [
        {
          id: "M1",
          items: [
            { id: "P1", milestoneId: "M1", status: "open", fields: { headline: "no guard" }, createdAt: TS, updatedAt: TS },
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
            { id: "Q1", milestoneId: "M1", status: "open", fields: { question: "Ship on Friday?", context: "release train context", recommendation: "yes, ship it" }, createdAt: TS, updatedAt: TS },
            { id: "Q2", milestoneId: "M1", status: "open", fields: { question: "Which approach?", suggestions: ["opt a", "opt b", "opt c"] }, createdAt: TS, updatedAt: TS },
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
    const entries = this.archives[ledgerId] ?? [];
    return {
      id: ledgerId,
      schema: d.schema,
      counters: { milestone: this.msCounter + 1, item: this.itemCounter + 1 },
      milestones: d.groups.map((g) => ({
        id: g.id,
        milestone: {
          id: g.id,
          status: "open",
          title: g.id === "active" ? "" : g.id === "M2" ? "Phase Two" : "Bootstrap",
          description: "",
        },
        items: g.items,
      })),
      archivePointers: entries.map((e) => e.pointer),
    };
  }
  async fetchLedgerArchive(ledgerId: string, archiveId: string): Promise<ArchiveContent> {
    const entries = this.archives[ledgerId] ?? [];
    const entry = entries.find((e) => e.pointer.id === archiveId);
    if (entry === undefined) throw new Error(`Archive not found: ${ledgerId}/${archiveId}`);
    return entry.content;
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
    if (!d.schema.statusValues.includes(init.status)) throw new Error(`Invalid status "${init.status}"`);
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
    if (patch.fields !== undefined) for (const [k, v] of Object.entries(patch.fields)) it.fields[k] = v as FieldValue;
    if (patch.author !== undefined) it.author = patch.author;
    if (patch.session !== undefined) it.session = patch.session;
    return it;
  }
  async ftsSearch(query: string, opts?: { ledger?: string }): Promise<FtsHit[]> {
    const q = query.toLowerCase();
    const hits: FtsHit[] = [];
    for (const [ledgerId, d] of Object.entries(this.data)) {
      if (opts?.ledger !== undefined && opts.ledger !== ledgerId) continue;
      for (const g of d.groups)
        for (const it of g.items) {
          const hay = (it.status + " " + Object.values(it.fields).flat().join(" ")).toLowerCase();
          if (hay.includes(q)) hits.push({ ledgerId, item: it, score: 1, matchedFields: [] });
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
