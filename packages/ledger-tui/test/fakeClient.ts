/**
 * In-memory LedgerClient fake for driving the Ink UI in tests without a
 * network or server. Models just enough of the ledger semantics the UI
 * exercises: a milestones ledger + one data ledger with items.
 */

import type {
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

const questionsSchema: LedgerSchema = {
  statusValues: ["open", "answered", "withdrawn"],
  terminalStatuses: ["answered", "withdrawn"],
  idPrefix: "Q",
  transitions: { open: ["answered", "withdrawn"], answered: [], withdrawn: [] },
  fields: {
    question: { type: "string", required: true },
    recommendation: { type: "string", required: false },
    answer: { type: "string", required: false },
  },
};

export class FakeClient implements LedgerClient {
  closed = false;
  private msCounter = 1;
  private itemCounter = 1;
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
