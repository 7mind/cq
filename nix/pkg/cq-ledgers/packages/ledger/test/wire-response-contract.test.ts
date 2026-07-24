import { describe, expect, it } from "bun:test";
import type { FetchedLedger, Item, LedgerSchema } from "../src/types.js";
import { InMemoryLedgerStore } from "../src/store/InMemoryLedgerStore.js";
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
  type CompactItemFieldsDto,
  type CompactItemDto,
  type ItemMutationAckDto,
  type ItemProjection,
  type LedgerMutationAckDto,
  type MilestoneMutationAckDto,
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

function reloadWire(value: unknown): unknown {
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

    const attributedMilestone = {
      ...authoritativeUpdated,
      author: "gpt-5.6",
      session: "session-milestone",
    };
    expect(projectMilestoneMutationAckDto(attributedMilestone)).toEqual(
      expectedMilestoneAck(attributedMilestone),
    );
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
    expect(serializeWireDto({ id: "T1", status: "wip" })).toBe(
      '{"id":"T1","status":"wip"}',
    );
  });

  it("preserves every representative requested-full-content payload", () => {
    const fullItem = item({
      author: "gpt-5.6",
      session: "session-full-content",
    });
    const payloads = {
      archive: {
        archive: {
          milestone: {
            id: "M1",
            title: "Archived work",
            description: "Complete archive narrative",
            items: [fullItem],
          },
          pointer: {
            id: "M1",
            path: "./archive/tasks/M1.md",
            summary: "Archived",
            title: "Archived work",
            status: "done",
          },
        },
      },
      log: {
        path: "raw/session.jsonl",
        content: '{"type":"result","body":"complete"}\n',
        truncated: false,
      },
      config: {
        configured: true,
        aliases: {
          opus: {
            harness: "claude",
            model: "claude-opus-4-6",
            provider: null,
            effort: "max",
          },
        },
        tiers: {
          claude: {
            frontier: {
              harness: "claude",
              model: "claude-opus-4-6",
              provider: null,
              effort: "max",
            },
          },
        },
        agentEfforts: { "plan-reviewer": "max" },
      },
      models: {
        configured: true,
        agents: [
          {
            roleId: "implement-worker",
            status: "resolved",
            harness: "codex",
            model: "gpt-5.6",
            mappings: ["codex:gpt-5.6"],
          },
        ],
      },
      prompt: {
        roleId: "plan-reviewer",
        prompt: "Review the complete plan body.",
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
      },
      validation: {
        ok: false,
        errors: [
          {
            path: ["goalId"],
            keyword: "required",
            message: "goalId is required",
          },
        ],
      },
      projects: {
        projects: [
          {
            key: "project-key",
            displayName: "ledger-suite",
            createdAt: "2026-07-24T12:00:00.000Z",
          },
        ],
      },
    };

    for (const [name, payload] of Object.entries(payloads)) {
      const serialized = serializeWireDto(payload);
      expect(JSON.parse(serialized), name).toEqual(payload);
      expect(serialized.includes("\n"), name).toBe(false);
    }
  });
});

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

// @ts-expect-error mandatory item reads accept only compact or full
const invalidProjection: ItemProjection = "summary";
void invalidProjection;
