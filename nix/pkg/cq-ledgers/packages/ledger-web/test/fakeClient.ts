/**
 * In-memory LedgerClient fake for driving the web UI in tests (no network).
 * Models a milestones ledger + one data ledger with items.
 */

import type {
  AgentModelEntry,
  AgentModelsResult,
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
  ReadLogResult,
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
// `tasks` ledger: exercises the column selector. `description` is on the
// LONG_FIELD_DENYLIST (never eligible); `headline`/`suggestedModel`/`acceptance`
// are eligible. defaultColumns("tasks") seeds `suggestedModel`.
const tasksSchema: LedgerSchema = {
  statusValues: ["planned", "wip", "done"],
  terminalStatuses: ["done"],
  idPrefix: "T",
  // `wip -> wip` is a self-loop: exercises the elk renderer keeping self-loops
  // that the old computeDagLayout-based state-machine model dropped (T203).
  transitions: { planned: ["wip"], wip: ["done", "planned", "wip"], done: [] },
  fields: {
    headline: { type: "string", required: true },
    description: { type: "string", required: false },
    suggestedModel: { type: "string", required: false },
    acceptance: { type: "string", required: false },
  },
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
  pointer: { id: string; path: string; summary: string; title: string; status: string };
  content: ArchiveContent;
}

/**
 * Controls which Q157 state {@link FakeClient.getAgentModels} emits.
 *
 * - `'resolved'`               — synthetic LIVE overlay with distinct modelClass/tokens vs
 *                                build-time catalogue values for implement-worker and
 *                                plan-reviewer; the full agent roster gets entries.
 * - `'no-live-token'`          — configured:true but every model-configurable role carries
 *                                status:'no-live-token' and modelClass:null.
 * - `'not-configured'`         — configured:false, agents:[]; mirrors a repo with no cq.toml.
 * - `'not-model-configurable'` — configured:true, but ALL entries carry
 *                                status:'not-model-configurable' (exercises the orchestrator-
 *                                command role path).
 * - `'throw'`                  — getAgentModels rejects with a synthetic Error (exercises
 *                                the catch-any-error -> distinguished offline path, Q155).
 */
export type AgentModelsMode =
  | "resolved"
  | "no-live-token"
  | "not-configured"
  | "not-model-configurable"
  | "throw";

/** Roles with model≠N/A (the agent-subagents that ARE model-configurable). */
const MODEL_CONFIGURABLE_ROLE_IDS = [
  "plan-advance",
  "plan-reviewer",
  "implement-worker",
  "implement-reviewer",
  "implement-conflict-resolver",
  "investigate-explorer",
  "investigate-prober",
] as const;

/** Roles with model=N/A (orchestrator commands that are NOT model-configurable). */
const NOT_MODEL_CONFIGURABLE_ROLE_IDS = [
  "advance",
  "plan",
  "plan/advance",
  "plan/follow-up",
  "investigate",
  "investigate/advance",
  "implement/start",
  "implement/advance",
  "plan-review",
  "implement-review",
  "planners",
  "reviewers",
] as const;

/**
 * Synthetic LIVE resolved entries used by the 'resolved' mode. Values
 * intentionally differ from the build-time catalogue (agentsCatalogue.gen.ts):
 *
 * - implement-worker build-time: model=standard, mappings={pi:["grok-build/grok-build"]}
 *   => live override: modelClass=standard, mappings={claude:["sonnet-4.6"]}
 * - plan-reviewer build-time:   model=frontier, mappings={claude:["opus-4.8[1m]"]}
 *   => live override: modelClass=frontier, mappings={claude:["opus-4.8[2m]"]}
 *
 * The DISTINCT tokens ensure T297 can assert that the overlay DIFFERS from any
 * build-time value in the catalogue (per R341 requirement).
 */
const RESOLVED_LIVE_ENTRIES: readonly AgentModelEntry[] = [
  { id: "plan-advance",                  status: "resolved", modelClass: "frontier", modelMappings: { claude: ["sonnet-4.7"]           } },
  { id: "plan-reviewer",                 status: "resolved", modelClass: "frontier", modelMappings: { claude: ["opus-4.8[2m]"]          } },
  { id: "implement-worker",              status: "resolved", modelClass: "standard", modelMappings: { claude: ["sonnet-4.6"]            } },
  { id: "implement-reviewer",            status: "resolved", modelClass: "frontier", modelMappings: { claude: ["sonnet-4.7"]            } },
  { id: "implement-conflict-resolver",   status: "resolved", modelClass: "standard", modelMappings: { claude: ["sonnet-4.6"]            } },
  { id: "investigate-explorer",          status: "resolved", modelClass: "frontier", modelMappings: { claude: ["sonnet-4.7"]            } },
  { id: "investigate-prober",            status: "resolved", modelClass: "standard", modelMappings: { claude: ["sonnet-4.6"]            } },
  ...NOT_MODEL_CONFIGURABLE_ROLE_IDS.map(
    (id): AgentModelEntry => ({ id, status: "not-model-configurable", modelClass: null, modelMappings: {} }),
  ),
];

export class FakeClient implements LedgerClient {
  closed = false;
  /** Per-`<ledger>/<archiveId>` count of fetchLedgerArchive calls (lazy-fetch assertions). */
  readonly archiveFetches: Record<string, number> = {};
  /** `<ledger>/<archiveId>` keys whose fetchLedgerArchive must reject (error-path assertions). */
  readonly failArchiveFetch: Set<string> = new Set();
  /**
   * Per-path readLog overrides. Map a repo-relative path to:
   * - a `ReadLogResult` to return that content (possibly truncated)
   * - an `Error` to simulate a read_log tool error
   * If the path is not present, a default stub result is returned.
   */
  readonly readLogResults: Map<string, ReadLogResult | Error> = new Map();
  /**
   * Controls which Q157 state {@link getAgentModels} emits. Defaults to
   * `'not-configured'`: returns `configured:false` with a populated `agents[]`
   * — model-configurable roles carry `status:'not-configured'`, orchestrator-
   * command roles carry `status:'not-model-configurable'` — mirroring
   * `computeAgentModels` when `config===null`. Tests that exercise the live
   * overlay (T297) set this to `'resolved'` or another mode explicitly.
   */
  agentModelsMode: AgentModelsMode = "not-configured";
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
    milestones: [
      {
        pointer: { id: "MA1", path: "./archive/milestones/MA1.md", summary: "archived milestone group", title: "Old Phase", status: "done" },
        content: {
          kind: "group",
          milestone: {
            id: "MA1",
            title: "Old Phase",
            description: "",
            items: [
              { id: "MA1-item", milestoneId: "MA1", status: "done", fields: { title: "Archived Milestone" }, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" },
            ],
          },
        },
      },
    ],
    bugs: [
      {
        pointer: { id: "A1", path: "./archive/bugs/A1.md", summary: "initial bootstrap fixes", title: "Bootstrap Fixes", status: "done" },
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
      {
        pointer: { id: "A2", path: "./archive/bugs/A2.md", summary: "second pass fixes", title: "Phase Two Fixes", status: "done" },
        content: {
          kind: "group",
          milestone: {
            id: "A2",
            title: "Phase Two",
            description: "",
            items: [
              { id: "D98", milestoneId: "A2", status: "closed", fields: { headline: "another archived bug", note: "" }, createdAt: "2025-01-02T00:00:00.000Z", updatedAt: "2025-01-02T00:00:00.000Z" },
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
    tasks: {
      schema: tasksSchema,
      groups: [
        {
          id: "M1",
          items: [
            { id: "T1", milestoneId: "M1", status: "planned", fields: { headline: "wire toolbar", description: "long narrative", suggestedModel: "opus", acceptance: "renders" }, createdAt: TS, updatedAt: TS },
          ],
        },
        {
          id: "M2",
          items: [
            { id: "T2", milestoneId: "M2", status: "wip", fields: { headline: "persist columns", suggestedModel: "sonnet" }, createdAt: TS, updatedAt: TS },
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
            { id: "Q3", milestoneId: "M1", status: "open", author: "opus-4.8[1m]", session: "sess-1", fields: { question: "Full question?", context: "full context", suggestions: ["s1", "s2"], recommendation: "do s1", answer: "" }, createdAt: TS, updatedAt: TS },
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
    const key = `${ledgerId}/${archiveId}`;
    this.archiveFetches[key] = (this.archiveFetches[key] ?? 0) + 1;
    if (this.failArchiveFetch.has(key)) throw new Error(`archive fetch failed: ${key}`);
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
  async getAgentModels(): Promise<AgentModelsResult> {
    switch (this.agentModelsMode) {
      case "throw":
        throw new Error("FakeClient: getAgentModels simulated failure (agentModelsMode='throw')");
      case "not-configured":
        // Mirror computeAgentModels(repoRoot) when config===null: model-configurable
        // roles get status:'not-configured'; orchestrator-command roles get
        // status:'not-model-configurable'. agents[] is non-empty so the web
        // client can render the 'not configured (no cq.toml)' label per-role.
        return {
          configured: false,
          agents: [
            ...MODEL_CONFIGURABLE_ROLE_IDS.map(
              (id): AgentModelEntry => ({ id, status: "not-configured", modelClass: null, modelMappings: {} }),
            ),
            ...NOT_MODEL_CONFIGURABLE_ROLE_IDS.map(
              (id): AgentModelEntry => ({ id, status: "not-model-configurable", modelClass: null, modelMappings: {} }),
            ),
          ],
        };
      case "resolved":
        return { configured: true, agents: RESOLVED_LIVE_ENTRIES };
      case "no-live-token":
        return {
          configured: true,
          agents: [
            ...MODEL_CONFIGURABLE_ROLE_IDS.map(
              (id): AgentModelEntry => ({ id, status: "no-live-token", modelClass: null, modelMappings: {} }),
            ),
            ...NOT_MODEL_CONFIGURABLE_ROLE_IDS.map(
              (id): AgentModelEntry => ({ id, status: "not-model-configurable", modelClass: null, modelMappings: {} }),
            ),
          ],
        };
      case "not-model-configurable":
        return {
          configured: true,
          agents: [
            ...MODEL_CONFIGURABLE_ROLE_IDS.map(
              (id): AgentModelEntry => ({ id, status: "not-model-configurable", modelClass: null, modelMappings: {} }),
            ),
            ...NOT_MODEL_CONFIGURABLE_ROLE_IDS.map(
              (id): AgentModelEntry => ({ id, status: "not-model-configurable", modelClass: null, modelMappings: {} }),
            ),
          ],
        };
    }
  }
  async readLog(path: string): Promise<ReadLogResult> {
    const override = this.readLogResults.get(path);
    if (override instanceof Error) throw override;
    if (override !== undefined) return override;
    // Default stub: return synthetic content for any path not explicitly configured.
    return { path, content: `stub content for ${path}` };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}
