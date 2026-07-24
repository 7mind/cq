import { describe, expect, it } from "bun:test";
import type { FetchedLedger, Item, Ledger } from "../src/types.js";
import { LEDGER_TOOL_NAMES } from "../src/mcp/ledgerTools.js";
import {
  LEDGER_RESPONSE_CONTRACTS,
  projectCompactItemDto,
  projectFullItemDto,
  projectFetchedLedgerDto,
  projectPaginatedLedgerDto,
  projectFtsSearchResultsDto,
  projectFetchedMilestoneDto,
  projectMilestoneItemGroupsDto,
  projectItemMutationAckDto,
  projectLedgerMutationAckDto,
  projectMilestoneMutationAckDto,
  serializeWireDto,
  type CompactItemDto,
  type ItemMutationAckDto,
  type LedgerMutationAckDto,
} from "../src/mcp/wireResponseContract.js";

const createdAt = "2026-07-24T12:00:00.000Z";
const updatedAt = "2026-07-24T12:01:00.000Z";

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: "T1",
    milestoneId: "M1",
    status: "wip",
    fields: {
      headline: "Define the wire response contract",
      severity: "major",
      dependsOn: ["tasks:T2"],
      blockedBy: ["questions:Q1"],
      ledgerRefs: ["goals:G93"],
      description: "Narrative content must not enter a compact response.",
      acceptance: "This narrative field must also be omitted.",
      customField: "An unapproved schema field must be omitted.",
    },
    createdAt,
    updatedAt,
    ...overrides,
  };
}

describe("ledger response contract matrix", () => {
  it("covers all 27 tools exactly and classifies every response", () => {
    expect(Object.keys(LEDGER_RESPONSE_CONTRACTS)).toEqual([
      ...LEDGER_TOOL_NAMES,
    ]);
    expect(LEDGER_RESPONSE_CONTRACTS).toEqual({
      enumerate_ledgers: { kind: "purpose-built-small" },
      fetch_ledger: {
        kind: "mandatory-item-projection",
        projections: ["compact", "full"],
      },
      fetch_ledger_archive: { kind: "requested-full-content" },
      fetch_item: {
        kind: "mandatory-item-projection",
        projections: ["compact", "full"],
      },
      update_item: {
        kind: "fixed-acknowledgement",
        acknowledgement: "item",
      },
      create_item: {
        kind: "fixed-acknowledgement",
        acknowledgement: "item",
      },
      create_ledger: {
        kind: "fixed-acknowledgement",
        acknowledgement: "ledger",
      },
      search_items: {
        kind: "mandatory-item-projection",
        projections: ["compact", "full"],
      },
      fts_search: {
        kind: "mandatory-item-projection",
        projections: ["compact", "full"],
      },
      create_milestone: {
        kind: "fixed-acknowledgement",
        acknowledgement: "milestone",
      },
      update_milestone: {
        kind: "fixed-acknowledgement",
        acknowledgement: "milestone",
      },
      fetch_milestone: {
        kind: "mandatory-item-projection",
        projections: ["compact", "full"],
      },
      archive_milestone: { kind: "purpose-built-small" },
      list_milestone_items: {
        kind: "mandatory-item-projection",
        projections: ["compact", "full"],
      },
      snapshot: { kind: "purpose-built-small" },
      derive_predicates: { kind: "purpose-built-small" },
      reopen_item: {
        kind: "fixed-acknowledgement",
        acknowledgement: "item",
      },
      unarchive_item: {
        kind: "fixed-acknowledgement",
        acknowledgement: "item",
      },
      read_log: { kind: "requested-full-content" },
      get_reviewers: { kind: "purpose-built-small" },
      get_planners: { kind: "purpose-built-small" },
      get_config: { kind: "requested-full-content" },
      get_agent_models: { kind: "purpose-built-small" },
      fetch_prompt: { kind: "requested-full-content" },
      validate_input: { kind: "purpose-built-small" },
      validate_output: { kind: "purpose-built-small" },
      list_projects: { kind: "purpose-built-small" },
    });
  });
});

describe("item wire projections", () => {
  it("emits the compact allowlist and preserves present provenance", () => {
    const source = item({ author: "gpt-5.6", session: "session-1" });

    expect(projectCompactItemDto(source) as object).toEqual({
      id: "T1",
      milestoneId: "M1",
      status: "wip",
      fields: {
        headline: "Define the wire response contract",
        severity: "major",
        dependsOn: ["tasks:T2"],
        blockedBy: ["questions:Q1"],
        ledgerRefs: ["goals:G93"],
      },
      createdAt,
      updatedAt,
      author: "gpt-5.6",
      session: "session-1",
    });
  });

  it("preserves provenance absence across JSON reload", () => {
    const projected = projectCompactItemDto(item());
    const reloaded = JSON.parse(serializeWireDto(projected)) as CompactItemDto;

    expect(reloaded).toEqual(projected);
    expect("author" in reloaded).toBe(false);
    expect("session" in reloaded).toBe(false);
  });

  it("returns the complete item for a requested full projection", () => {
    const source = item({ author: "user" });

    expect(projectFullItemDto(source)).toEqual(source);
  });

  it("preserves ledger, pagination, search, milestone, and grouping metadata", () => {
    const source = item();
    const ledger: FetchedLedger = {
      id: "tasks",
      schema: {
        statusValues: ["wip"],
        terminalStatuses: [],
        fields: {},
      },
      counters: { milestone: 8, item: 12 },
      milestones: [
        {
          id: "M1",
          milestone: {
            id: "M1",
            status: "open",
            title: "Wire contract",
            description: "Milestone metadata",
          },
          items: [source],
        },
      ],
      archivePointers: [
        {
          id: "M0",
          path: "./archive/tasks/M0.md",
          summary: "Archived",
          title: "Earlier work",
          status: "done",
        },
      ],
    };
    const { milestones, ...ledgerMetadata } = ledger;

    expect(projectFetchedLedgerDto(ledger, "compact")).toEqual({
      ...ledger,
      milestones: [
        {
          ...milestones[0]!,
          items: [projectCompactItemDto(source)],
        },
      ],
    });
    expect(
      projectPaginatedLedgerDto(
        { ledger: ledgerMetadata, items: [source], total: 41 },
        "compact",
      ),
    ).toEqual({
      ledger: ledgerMetadata,
      items: [projectCompactItemDto(source)],
      total: 41,
    });
    expect(
      projectFtsSearchResultsDto(
        [
          {
            ledgerId: "tasks",
            item: source,
            score: 9.75,
            matchedFields: ["headline"],
          },
        ],
        "compact",
      ),
    ).toEqual([
      {
        ledgerId: "tasks",
        item: projectCompactItemDto(source),
        score: 9.75,
        matchedFields: ["headline"],
      },
    ]);
    expect(
      projectFetchedMilestoneDto(
        {
          milestone: source,
          resolved: {
            id: "M1",
            status: "open",
            title: "Wire contract",
            description: "Milestone metadata",
          },
          references: { tasks: 1, defects: 2 },
        },
        "compact",
      ),
    ).toEqual({
      milestone: projectCompactItemDto(source),
      resolved: {
        id: "M1",
        status: "open",
        title: "Wire contract",
        description: "Milestone metadata",
      },
      references: { tasks: 1, defects: 2 },
    });
    expect(
      projectMilestoneItemGroupsDto(
        { tasks: [source], defects: [item({ id: "D1" })] },
        "compact",
      ),
    ).toEqual({
      tasks: [projectCompactItemDto(source)],
      defects: [projectCompactItemDto(item({ id: "D1" }))],
    });
  });
});

describe("mutation acknowledgement projections", () => {
  it("retains authoritative item identity, status, timestamps, refs, and provenance", () => {
    const acknowledgement = projectItemMutationAckDto(
      item({ author: "gpt-5.6", session: "session-1" }),
    );

    expect(acknowledgement as object).toEqual({
      id: "T1",
      milestoneId: "M1",
      status: "wip",
      fields: {
        dependsOn: ["tasks:T2"],
        blockedBy: ["questions:Q1"],
        ledgerRefs: ["goals:G93"],
      },
      createdAt,
      updatedAt,
      author: "gpt-5.6",
      session: "session-1",
    });
  });

  it("preserves absent item provenance across JSON reload", () => {
    const projected = projectItemMutationAckDto(item());
    const reloaded = JSON.parse(
      serializeWireDto(projected),
    ) as ItemMutationAckDto;

    expect(reloaded).toEqual(projected);
    expect("author" in reloaded).toBe(false);
    expect("session" in reloaded).toBe(false);
  });

  it("emits ledger and milestone acknowledgements without invented provenance", () => {
    const ledger: Ledger = {
      id: "tasks",
      schema: {
        statusValues: ["planned"],
        terminalStatuses: [],
        fields: {},
      },
      counters: { milestone: 0, item: 0 },
      milestones: [],
      archivePointers: [],
    };

    expect(projectLedgerMutationAckDto(ledger) as object).toEqual({
      id: "tasks",
    });
    expect(
      projectMilestoneMutationAckDto(
        item({
          id: "M7",
          milestoneId: "active",
          fields: {
            title: "Contract",
            description: "Narrative",
            dependsOn: ["milestones:M6"],
            blockedBy: ["milestones:M8"],
          },
          author: "must-not-leak",
          session: "must-not-leak",
        }),
      ) as object,
    ).toEqual({
      id: "M7",
      status: "wip",
      fields: {
        dependsOn: ["milestones:M6"],
        blockedBy: ["milestones:M8"],
      },
      createdAt,
      updatedAt,
    });
  });
});

describe("wire serialization", () => {
  it("uses minified JSON", () => {
    expect(serializeWireDto({ id: "T1", status: "wip" })).toBe(
      '{"id":"T1","status":"wip"}',
    );
  });
});

// Compile-time negative coverage: a full store object cannot accidentally
// cross a compact or acknowledgement wire boundary.
const fullItemTypeBoundary = item();
// @ts-expect-error a full Item is not a projected compact DTO
const compactTypeBoundary: CompactItemDto = fullItemTypeBoundary;
void compactTypeBoundary;

// @ts-expect-error a full Item is not an item acknowledgement DTO
const itemAckTypeBoundary: ItemMutationAckDto = fullItemTypeBoundary;
void itemAckTypeBoundary;

const fullLedgerTypeBoundary: Ledger = {
  id: "tasks",
  schema: {
    statusValues: ["wip"],
    terminalStatuses: [],
    fields: {},
  },
  counters: { milestone: 1, item: 1 },
  milestones: [],
  archivePointers: [],
};
// @ts-expect-error a full Ledger is not a ledger acknowledgement DTO
const ledgerAckTypeBoundary: LedgerMutationAckDto = fullLedgerTypeBoundary;
void ledgerAckTypeBoundary;
