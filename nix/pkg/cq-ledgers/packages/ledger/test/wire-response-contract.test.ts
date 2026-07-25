import { describe, expect, it } from "bun:test";
import type { FetchedLedger, Item, LedgerSchema } from "../src/types.js";
import type { ArchiveContent } from "../src/store/LedgerStore.js";
import type { ReadLogResult } from "../src/mcp/readLog.js";
import type { GetConfigResult } from "../src/mcp/configCapability.js";
import type { FetchPromptResult } from "../src/mcp/promptCatalogCapability.js";
import { InMemoryLedgerStore } from "../src/store/InMemoryLedgerStore.js";
import { LEDGER_TOOL_NAMES } from "../src/mcp/ledgerTools.js";
import {
  LEDGER_RESPONSE_CONTRACTS,
  isProducedWireDto,
  produceWireDto,
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
  type CompactItemFieldsDto,
  type CompactItemDto,
  type ItemMutationAckDto,
  type ItemProjection,
  type LedgerMutationAckDto,
  type MilestoneMutationAckDto,
  type ProducedWireDto,
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

function reloadWire(value: ProducedWireDto<object>): unknown {
  return JSON.parse(serializeWireDto(value));
}

function expectedItemAck(item: Item): ItemMutationAckDto {
  const fields: ItemMutationAckDto["fields"] = {};
  const dependsOn = item.fields["dependsOn"];
  const blockedBy = item.fields["blockedBy"];
  const ledgerRefs = item.fields["ledgerRefs"];
  if (Array.isArray(dependsOn)) fields.dependsOn = dependsOn;
  if (Array.isArray(blockedBy)) fields.blockedBy = blockedBy;
  if (Array.isArray(ledgerRefs)) fields.ledgerRefs = ledgerRefs;
  const acknowledgement: ItemMutationAckDto = {
    id: item.id,
    milestoneId: item.milestoneId,
    status: item.status,
    fields,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  if (item.author !== undefined) acknowledgement.author = item.author;
  if (item.session !== undefined) acknowledgement.session = item.session;
  return acknowledgement;
}

function expectedMilestoneAck(item: Item): MilestoneMutationAckDto {
  const fields: MilestoneMutationAckDto["fields"] = {};
  const dependsOn = item.fields["dependsOn"];
  const blockedBy = item.fields["blockedBy"];
  if (Array.isArray(dependsOn)) fields.dependsOn = dependsOn;
  if (Array.isArray(blockedBy)) fields.blockedBy = blockedBy;
  const acknowledgement: MilestoneMutationAckDto = {
    id: item.id,
    status: item.status,
    fields,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  if (item.author !== undefined) acknowledgement.author = item.author;
  if (item.session !== undefined) acknowledgement.session = item.session;
  return acknowledgement;
}

async function initializedStore(): Promise<InMemoryLedgerStore> {
  const store = new InMemoryLedgerStore();
  await store.init();
  return store;
}

describe("ledger response contract matrix", () => {
  it("covers all 27 tools exactly and classifies every response", () => {
    expect(Object.keys(LEDGER_RESPONSE_CONTRACTS)).toEqual([
      ...LEDGER_TOOL_NAMES,
    ]);
    expect(LEDGER_RESPONSE_CONTRACTS).toMatchObject({
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

  it("JSON round-trips every full item field and provenance", () => {
    const source = item({ author: "user", session: "session-full" });

    expect(reloadWire(projectFullItemDto(source))).toEqual(source);
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

    expect(
      reloadWire(projectFetchedLedgerDto(ledger, "compact")),
    ).toEqual({
      ...ledger,
      milestones: [
        {
          ...milestones[0]!,
          items: [projectCompactItemDto(source)],
        },
      ],
    });
    expect(
      reloadWire(
        projectPaginatedLedgerDto(
          {
            ledger: ledgerMetadata,
            items: [source],
            total: 41,
            offset: 20,
            limit: 1,
            nextOffset: 21,
          },
          "compact",
        ),
      ),
    ).toEqual({
      ledger: ledgerMetadata,
      items: [projectCompactItemDto(source)],
      total: 41,
      offset: 20,
      limit: 1,
      nextOffset: 21,
    });
    expect(
      reloadWire(
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
      reloadWire(
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
      reloadWire(
        projectMilestoneItemGroupsDto(
          { tasks: [source], defects: [item({ id: "D1" })] },
          "compact",
        ),
      ),
    ).toEqual({
      tasks: [projectCompactItemDto(source)],
      defects: [projectCompactItemDto(item({ id: "D1" }))],
    });
  });
});

describe("mutation acknowledgement projections", () => {
  it("matches authoritative create/update items, allocated ids, canonical refs, and provenance", async () => {
    const store = await initializedStore();
    const milestone = await store.createMilestone({ title: "Item writes" });
    const dependency = await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: { headline: "Dependency" },
    });
    const created = await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: {
        headline: "Projected item",
        description: "Narrative must not enter the acknowledgement",
        dependsOn: [dependency.id],
        blockedBy: [dependency.id],
        ledgerRefs: ["goals:G93"],
      },
      author: "gpt-5.6",
      session: "session-create",
    });

    expect(created.id).toMatch(/^T\d+$/);
    expect(created.fields.dependsOn).toEqual([`tasks:${dependency.id}`]);
    expect(created.fields.blockedBy).toEqual([`tasks:${dependency.id}`]);
    const authoritativeCreated = store.fetchItem("tasks", created.id);
    expect(reloadWire(projectItemMutationAckDto(created))).toEqual(
      expectedItemAck(authoritativeCreated),
    );

    const updated = await store.updateItem("tasks", created.id, {
      status: "wip",
      fields: {
        dependsOn: [dependency.id],
        blockedBy: [dependency.id],
        ledgerRefs: ["goals:G93"],
      },
      author: "user",
      session: "session-update",
    });
    const authoritativeUpdated = store.fetchItem("tasks", created.id);
    const updatedAck = projectItemMutationAckDto(updated);

    expect(reloadWire(updatedAck)).toEqual(
      expectedItemAck(authoritativeUpdated),
    );
    expect(updatedAck.status).toBe("wip");
    expect(updatedAck.updatedAt).toBe(authoritativeUpdated.updatedAt);
    expect(updatedAck.fields.dependsOn).toEqual([
      `tasks:${dependency.id}`,
    ]);
    expect(updatedAck.author).toBe("user");
    expect(updatedAck.session).toBe("session-update");

    const dependencyAck = projectItemMutationAckDto(
      store.fetchItem("tasks", dependency.id),
    );
    expect(Object.hasOwn(dependencyAck, "author")).toBe(false);
    expect(Object.hasOwn(dependencyAck, "session")).toBe(false);
  });

  it("matches authoritative reopen/unarchive items with present and absent provenance", async () => {
    const store = await initializedStore();
    const milestone = await store.createMilestone({ title: "Recovery" });
    const withProvenance = await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: { headline: "Authored" },
      author: "gpt-5.6",
      session: "session-recovery",
    });
    const withoutProvenance = await store.createItem(
      "tasks",
      milestone.id,
      {
        status: "planned",
        fields: { headline: "Unattributed" },
      },
    );

    for (const source of [withProvenance, withoutProvenance]) {
      await store.updateItem("tasks", source.id, { status: "wip" });
      await store.updateItem("tasks", source.id, { status: "done" });
      const reopened = await store.reopenItem("tasks", source.id, "planned");
      const authoritative = store.fetchItem("tasks", source.id);
      expect(reloadWire(projectItemMutationAckDto(reopened))).toEqual(
        expectedItemAck(authoritative),
      );
      expect(reopened.status).toBe("planned");
      await store.updateItem("tasks", source.id, { status: "wip" });
      await store.updateItem("tasks", source.id, { status: "done" });
    }

    await store.updateMilestone(milestone.id, { status: "done" });
    await store.archiveMilestone(milestone.id, "recovery fixture");

    for (const source of [withProvenance, withoutProvenance]) {
      const unarchived = await store.unarchiveItem(
        "tasks",
        milestone.id,
        source.id,
      );
      const authoritative = store.fetchItem("tasks", source.id);
      const acknowledgement = projectItemMutationAckDto(unarchived);
      expect(reloadWire(acknowledgement)).toEqual(
        expectedItemAck(authoritative),
      );
      expect(acknowledgement.updatedAt).toBe(authoritative.updatedAt);
    }

    const presentAck = projectItemMutationAckDto(
      store.fetchItem("tasks", withProvenance.id),
    );
    const absentAck = projectItemMutationAckDto(
      store.fetchItem("tasks", withoutProvenance.id),
    );
    expect(presentAck.author).toBe("gpt-5.6");
    expect(presentAck.session).toBe("session-recovery");
    expect(Object.hasOwn(absentAck, "author")).toBe(false);
    expect(Object.hasOwn(absentAck, "session")).toBe(false);
  });

  it("matches authoritative create/update milestones and preserves optional Item provenance", async () => {
    const store = await initializedStore();
    const dependency = await store.createMilestone({ title: "Dependency" });
    const created = await store.createMilestone({
      title: "Wire contract",
      description: "Narrative omitted from acknowledgement",
      dependsOn: [dependency.id],
      blockedBy: [dependency.id],
    });

    expect(created.id).toMatch(/^M\d+$/);
    expect(created.fields.dependsOn).toEqual([
      `milestones:${dependency.id}`,
    ]);
    const authoritativeCreated = store.fetchItem("milestones", created.id);
    expect(reloadWire(projectMilestoneMutationAckDto(created))).toEqual(
      expectedMilestoneAck(authoritativeCreated),
    );
    expect(Object.hasOwn(projectMilestoneMutationAckDto(created), "author")).toBe(
      false,
    );

    await store.updateItem("milestones", created.id, {
      author: "gpt-5.6",
      session: "session-milestone",
    });
    const updated = await store.updateMilestone(created.id, {
      status: "blocked",
      dependsOn: [dependency.id],
      blockedBy: [dependency.id],
    });
    const authoritativeUpdated = store.fetchItem("milestones", created.id);
    expect(reloadWire(projectMilestoneMutationAckDto(updated))).toEqual(
      expectedMilestoneAck(authoritativeUpdated),
    );
    expect(updated.status).toBe("blocked");
    expect(updated.updatedAt).toBe(authoritativeUpdated.updatedAt);
    expect(authoritativeUpdated.author).toBe("gpt-5.6");
    expect(authoritativeUpdated.session).toBe("session-milestone");
    expect(
      reloadWire(projectMilestoneMutationAckDto(authoritativeUpdated)),
    ).toEqual(expectedMilestoneAck(authoritativeUpdated));
  });

  it("projects the actual createLedger FetchedLedger result without invented provenance", async () => {
    const store = await initializedStore();
    const schema: LedgerSchema = {
      statusValues: ["open", "done"],
      terminalStatuses: ["done"],
      fields: {
        title: { type: "string", required: true },
      },
      idPrefix: "W",
    };
    const created = await store.createLedger("widgets", schema);
    const acknowledgement = projectLedgerMutationAckDto(created);

    expect(created.id).toBe("widgets");
    expect(reloadWire(acknowledgement)).toEqual({ id: "widgets" });
    expect(Object.hasOwn(acknowledgement, "author")).toBe(false);
    expect(Object.hasOwn(acknowledgement, "session")).toBe(false);
  });
});

describe("wire serialization", () => {
  it("uses minified JSON", () => {
    expect(
      serializeWireDto(produceWireDto({ id: "T1", status: "wip" })),
    ).toBe('{"id":"T1","status":"wip"}');
  });

  it("requires a produced marker and omits it from serialized JSON", () => {
    const projected = projectCompactItemDto(item());

    expect(isProducedWireDto(projected)).toBe(true);
    expect(
      Reflect.ownKeys(projected).some((key) => typeof key === "symbol"),
    ).toBe(true);
    const reloaded = JSON.parse(serializeWireDto(projected));
    expect(isProducedWireDto(reloaded)).toBe(false);
    expect(
      Reflect.ownKeys(reloaded).some((key) => typeof key === "symbol"),
    ).toBe(false);
    expect(() =>
      Reflect.apply(serializeWireDto, undefined, [{ id: "T1" }]),
    ).toThrow("serializeWireDto requires a produced wire DTO");
  });

  it("preserves every requested-full-content response exactly once", () => {
    const fullItem = item({
      author: "gpt-5.6",
      session: "session-full-content",
    });
    const archive: ArchiveContent = {
      kind: "group",
      milestone: {
        id: "M1",
        title: "Archived work",
        description: "Complete archive narrative",
        items: [fullItem],
      },
    };
    const log: ReadLogResult = {
      path: "raw/session.jsonl",
      content: '{"type":"result","body":"complete"}\n',
      truncated: false,
    };
    const config: GetConfigResult = {
      configured: true,
      aliases: {
        opus: {
          harness: "claude",
          model: "claude-opus-4-6",
          provider: null,
          effort: "max",
        },
      },
      reviewers: ["opus"],
      planners: ["opus"],
      tiers: {
        frontier: {
          harness: "claude",
          model: "claude-opus-4-6",
          provider: null,
          effort: "max",
        },
      },
      agentTiers: { "plan-reviewer": "frontier" },
      agentEfforts: { "plan-reviewer": "max" },
    };
    const prompt: FetchPromptResult = {
      roleId: "plan-reviewer",
      kind: "dispatched-subagent",
      dispatched: true,
      promptTemplate: "Review the complete plan body.",
      version: 1,
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { goalId: { type: "string" } },
        required: ["goalId"],
      },
      outputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { verdict: { enum: ["go-ahead", "revise"] } },
        required: ["verdict"],
      },
    };
    const payloads = {
      fetch_ledger_archive: { archive },
      read_log: log,
      get_config: config,
      fetch_prompt: prompt,
    } satisfies RequestedFullPayloads;
    const requestedFullToolNames = [
      "fetch_ledger_archive",
      "read_log",
      "get_config",
      "fetch_prompt",
    ] as const satisfies readonly RequestedFullToolName[];
    const matrixRequestedFullToolNames = Object.entries(
      LEDGER_RESPONSE_CONTRACTS,
    )
      .filter(([, contract]) => contract.kind === "requested-full-content")
      .map(([toolName]) => toolName);

    expect(matrixRequestedFullToolNames).toEqual([
      ...requestedFullToolNames,
    ]);
    expect(new Set(requestedFullToolNames).size).toBe(
      requestedFullToolNames.length,
    );
    for (const toolName of requestedFullToolNames) {
      const payload = payloads[toolName];
      const serialized = serializeWireDto(produceWireDto(payload));
      expect(JSON.parse(serialized), toolName).toEqual(payload);
      expect(serialized.includes("\n"), toolName).toBe(false);
    }
  });
});

type RequestedFullToolName = {
  [ToolName in keyof typeof LEDGER_RESPONSE_CONTRACTS]:
    (typeof LEDGER_RESPONSE_CONTRACTS)[ToolName] extends {
      kind: "requested-full-content";
    }
      ? ToolName
      : never;
}[keyof typeof LEDGER_RESPONSE_CONTRACTS];

interface RequestedFullPayloadByTool {
  fetch_ledger_archive: { archive: ArchiveContent };
  read_log: ReadLogResult;
  get_config: GetConfigResult;
  fetch_prompt: FetchPromptResult;
}

type RequestedFullPayloads = {
  [ToolName in RequestedFullToolName]:
    RequestedFullPayloadByTool[ToolName];
};

type Exact<Expected, Actual extends Expected> = Actual &
  Record<Exclude<keyof Actual, keyof Expected>, never>;

function exact<Expected>() {
  return <Actual extends Expected>(
    value: Exact<Expected, Actual>,
  ): Expected => value;
}

const structuralCompactDto = {
  id: "T1",
  milestoneId: "M1",
  status: "wip",
  fields: { headline: "Structural DTO" },
  createdAt,
  updatedAt,
  author: "user",
  session: "session-type",
} satisfies CompactItemDto;
void structuralCompactDto;

exact<CompactItemFieldsDto>()({
  headline: "Allowed",
  // @ts-expect-error description is not an approved compact field
  description: "Narrative",
});

exact<ItemMutationAckDto>()({
  id: "T1",
  milestoneId: "M1",
  status: "wip",
  fields: {},
  createdAt,
  updatedAt,
  // @ts-expect-error acknowledgements reject undocumented narrative properties
  description: "Narrative",
});

exact<LedgerMutationAckDto>()({
  id: "tasks",
  // @ts-expect-error ledger acknowledgements contain no provenance
  author: "invented",
});

const structuralMilestoneAck = {
  id: "M1",
  status: "open",
  fields: {},
  createdAt,
  updatedAt,
  author: "gpt-5.6",
  session: "session-milestone",
} satisfies MilestoneMutationAckDto;
void structuralMilestoneAck;

const widenedFullItem: Item = item();
// @ts-expect-error full Items have not passed through the compact projector
const invalidCompactProduction: ReturnType<
  typeof projectCompactItemDto
> = widenedFullItem;
// @ts-expect-error full Items have not passed through the item acknowledgement projector
const invalidItemAckProduction: ReturnType<
  typeof projectItemMutationAckDto
> = widenedFullItem;
void invalidCompactProduction;
void invalidItemAckProduction;

const widenedFetchedLedger: FetchedLedger = {
  id: "tasks",
  schema: {
    statusValues: ["wip"],
    terminalStatuses: [],
    fields: {},
  },
  counters: { milestone: 0, item: 0 },
  milestones: [],
  archivePointers: [],
};
// @ts-expect-error fetched ledgers have not passed through the ledger acknowledgement projector
const invalidLedgerAckProduction: ReturnType<
  typeof projectLedgerMutationAckDto
> = widenedFetchedLedger;
void invalidLedgerAckProduction;

// @ts-expect-error mandatory item reads accept only compact or full
const invalidProjection: ItemProjection = "summary";
void invalidProjection;
