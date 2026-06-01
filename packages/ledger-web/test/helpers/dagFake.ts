/**
 * A LedgerClient fake with a real milestone dependency graph for DAG tests:
 *   M1 (Foundations, open) ──▶ M2 (Build, open) ──▶ M3 (Ship, blocked)
 *   via M2.dependsOn=[M1] and M3.blockedBy=[M2].
 * A `bugs` ledger references M1 (2 items) and M2 (1 item); M3 has none.
 * Methods not exercised by the DAG paths throw.
 */

import type {
  FetchedLedger,
  Item,
  LedgerClient,
  LedgerSchema,
  LedgerSummary,
} from "../../src/types.js";

const TS = "2026-01-01T00:00:00.000Z";

const milestonesSchema: LedgerSchema = {
  statusValues: ["open", "done", "postponed", "blocked"],
  terminalStatuses: ["done", "postponed"],
  fields: {
    title: { type: "string", required: true },
    description: { type: "string", required: false },
    blockedBy: { type: "id[]", required: false },
    dependsOn: { type: "id[]", required: false },
  },
  idPrefix: "M",
};
const bugsSchema: LedgerSchema = {
  statusValues: ["open", "closed"],
  terminalStatuses: ["closed"],
  fields: { headline: { type: "string", required: true } },
  idPrefix: "D",
};

function mItem(id: string, title: string, status: string, extra: Record<string, string[]>): Item {
  return {
    id,
    milestoneId: "active",
    status,
    fields: { title, ...extra },
    createdAt: TS,
    updatedAt: TS,
  };
}
function bug(id: string, milestoneId: string): Item {
  return { id, milestoneId, status: "open", fields: { headline: `bug ${id}` }, createdAt: TS, updatedAt: TS };
}

export class DagFakeClient implements LedgerClient {
  updatedMilestones: Array<{ id: string; status: string | undefined }> = [];

  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [
      { name: "bugs", itemCount: 3 },
      { name: "milestones", itemCount: 3 },
    ];
  }

  async fetchLedger(ledgerId: string): Promise<FetchedLedger> {
    if (ledgerId === "milestones") {
      return {
        id: "milestones",
        schema: milestonesSchema,
        counters: { milestone: 4, item: 1 },
        milestones: [
          {
            id: "active",
            milestone: { id: "active", status: "open", title: "", description: "" },
            items: [
              mItem("M1", "Foundations", "open", {}),
              mItem("M2", "Build", "open", { dependsOn: ["M1"] }),
              mItem("M3", "Ship", "blocked", { blockedBy: ["M2"] }),
            ],
          },
        ],
        archivePointers: [],
      };
    }
    if (ledgerId === "bugs") {
      return {
        id: "bugs",
        schema: bugsSchema,
        counters: { milestone: 1, item: 4 },
        milestones: [
          {
            id: "M1",
            milestone: { id: "M1", status: "open", title: "Foundations", description: "" },
            // D2 depends on D1 → an intra-ledger edge D1→D2 in the bugs graph.
            items: [bug("D1", "M1"), { ...bug("D2", "M1"), fields: { headline: "bug D2", dependsOn: ["D1"] } }],
          },
          {
            id: "M2",
            milestone: { id: "M2", status: "open", title: "Build", description: "" },
            items: [bug("D3", "M2")],
          },
        ],
        archivePointers: [],
      };
    }
    throw new Error(`Ledger not found: ${ledgerId}`);
  }

  async updateMilestone(milestoneId: string, patch: { status?: string }): Promise<Item> {
    this.updatedMilestones.push({ id: milestoneId, status: patch.status });
    const ms = await this.fetchLedger("milestones");
    const it = ms.milestones[0]!.items.find((i) => i.id === milestoneId)!;
    return { ...it, status: patch.status ?? it.status };
  }

  async fetchItem(): Promise<Item> {
    throw new Error("not used in DAG tests");
  }
  async createItem(): Promise<Item> {
    throw new Error("not used in DAG tests");
  }
  async updateItem(): Promise<Item> {
    throw new Error("not used in DAG tests");
  }
  async ftsSearch(): Promise<never[]> {
    return [];
  }
  async createMilestone(): Promise<Item> {
    throw new Error("not used in DAG tests");
  }
  async close(): Promise<void> {
    /* no-op */
  }
}
