import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import {
  CANONICAL_LEDGERS,
  createLedgerMcpTools,
  FsLedgerStore,
  GOALS_LEDGER,
  InMemoryLedgerStore,
  PLAN_MANAGED_GOAL_FIELD_NAMES,
  PLAN_REVIEW_DRAFT_FIELD,
  REVIEWS_LEDGER,
  TASKS_LEDGER,
  UPSTREAM_LEDGER,
  UPSTREAM_SCHEMA,
  type FieldValue,
  type LedgerSchema,
  type LedgerStore,
} from "../src/index.js";

interface StoreFactory {
  name: string;
  build(): Promise<LedgerStore>;
}

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
});

const factories: StoreFactory[] = [
  {
    name: "InMemoryLedgerStore",
    async build() {
      const store = new InMemoryLedgerStore({});
      await store.init();
      return store;
    },
  },
  {
    name: "FsLedgerStore",
    async build() {
      const root = await mkdtemp(join(tmpdir(), "ledger-upstream-"));
      roots.push(root);
      const store = new FsLedgerStore({ root });
      await store.init();
      return store;
    },
  },
];

const OPTIONAL_FIELDS: Record<string, FieldValue> = {
  affectedVersions: ["1.2.3", "1.2.4"],
  fixedVersion: "1.2.5",
  environment: "linux-x64",
  reproduction: "Run the minimal reproducer",
  observed: "The dependency exits with code 1",
  expected: "The dependency exits with code 0",
  priorArt: ["https://example.invalid/prior-art"],
  reportUrls: ["https://example.invalid/issues/17"],
  trackingUrl: "https://example.invalid/issues/17",
  trackerKind: "github",
  reportingClassification: "public",
  workaround: "Pin version 1.2.2",
  severity: "high",
  description: "The upstream package rejects valid input",
  lastCheckedAt: "2026-07-25T04:00:00.000Z",
  lastCheckOutcome: "still reproducible",
  filingOperationId: "filing-op-17",
  filingState: "filed",
  filingClaimedAt: "2026-07-25T03:59:00.000Z",
  sessionLogs: ["logs/upstream-session.md"],
  rawLogs: ["logs/raw/upstream-session.jsonl"],
  sourceRefs: ["packages/ledger/src/index.ts:1"],
  blockedBy: ["external-approval"],
  dependsOn: ["vendor-release"],
  ledgerRefs: ["tasks:T17"],
  tags: ["third-party"],
  suggestedModel: "frontier",
};

for (const factory of factories) {
  describe(`upstream canonical ledger (${factory.name})`, () => {
    it("creates an item with only headline and package", async () => {
      const store = await factory.build();
      try {
        const milestone = await store.createMilestone({ title: "upstream minimum" });
        const created = await store.createItem(UPSTREAM_LEDGER, milestone.id, {
          status: "open",
          fields: { headline: "Dependency failure", package: "@vendor/dependency" },
        });

        expect(created.fields).toEqual({
          headline: "Dependency failure",
          package: "@vendor/dependency",
        });
      } finally {
        await store.dispose();
      }
    });

    it("round-trips every optional field", async () => {
      const store = await factory.build();
      try {
        const milestone = await store.createMilestone({ title: "upstream full shape" });
        const fields = {
          headline: "Dependency failure",
          package: "@vendor/dependency",
          ...OPTIONAL_FIELDS,
        };
        const created = await store.createItem(UPSTREAM_LEDGER, milestone.id, {
          status: "reported",
          fields,
        });

        expect(store.fetchItem(UPSTREAM_LEDGER, created.id).fields).toEqual(fields);
      } finally {
        await store.dispose();
      }
    });
  });
}

interface FrozenClientFixture {
  version: number;
  knownLedgers: Array<{ name: string; schemaSha256: string }>;
}

interface FrozenEnumerateResponse {
  ledgers: string[];
  counts: Record<string, number>;
}

function decode(result: { content: Array<{ type: string; text: string }> }): unknown {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected one text content block");
  }
  return JSON.parse(first.text) as unknown;
}

function callTool(
  tools: ReturnType<typeof createLedgerMcpTools>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`tool not found: ${name}`);
  return tool.handler(args as never, null) as Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
}

function createRoot(tools: ReturnType<typeof createLedgerMcpTools>, init: { title: string }) {
  return callTool(tools, "create_item", {
    ledger_id: "milestones",
    status: "open",
    fields: { title: init.title },
  });
}

function schemaSha256(schema: LedgerSchema): string {
  return createHash("sha256").update(JSON.stringify(schema)).digest("hex");
}

function prePlanLifecycleSchema(ledgerName: string, schema: LedgerSchema): LedgerSchema {
  const compatible = structuredClone(schema);
  if (ledgerName === GOALS_LEDGER) {
    for (const field of PLAN_MANAGED_GOAL_FIELD_NAMES) delete compatible.fields[field];
  }
  if (ledgerName === REVIEWS_LEDGER) delete compatible.fields[PLAN_REVIEW_DRAFT_FIELD];
  return compatible;
}

describe("frozen pre-upstream MCP client compatibility", () => {
  it("ignores additive response fields and continues to fetch every known ledger", async () => {
    const fixture = JSON.parse(
      await readFile(new URL("./fixtures/pre-upstream-client.json", import.meta.url), "utf8"),
    ) as FrozenClientFixture;
    const store = new InMemoryLedgerStore({});
    await store.init();
    try {
      expect(fixture.version).toBe(1);
      const tools = createLedgerMcpTools(store);
      const currentResponse = decode(await callTool(tools, "enumerate_ledgers", {})) as Record<
        string,
        unknown
      >;
      expect(currentResponse["ledgerSummaries"]).toBeArray();

      const frozenView = currentResponse as unknown as FrozenEnumerateResponse;
      expect(frozenView.ledgers).toContain(UPSTREAM_LEDGER);
      for (const known of fixture.knownLedgers) {
        expect(frozenView.ledgers).toContain(known.name);
        const response = decode(
          await callTool(tools, "fetch_ledger", {
            ledger_id: known.name,
            projection: "full",
          }),
        ) as { ledger: { id: string; schema: LedgerSchema } };
        expect(response.ledger.id).toBe(known.name);
        expect(schemaSha256(prePlanLifecycleSchema(known.name, response.ledger.schema))).toBe(
          known.schemaSha256,
        );
      }

      const milestoneResponse = decode(await createRoot(tools, { title: "frozen client" })) as {
        item: { id: string };
      };
      const taskResponse = decode(
        await callTool(tools, "create_item", {
          ledger_id: TASKS_LEDGER,
          milestone_id: milestoneResponse.item.id,
          status: "planned",
          fields: { headline: "Old-client task" },
        }),
      ) as { item: { id: string } };
      const fetched = decode(
        await callTool(tools, "fetch_item", {
          ledger_id: TASKS_LEDGER,
          item_id: taskResponse.item.id,
          projection: "full",
        }),
      ) as { item: { fields: Record<string, FieldValue> } };
      expect(fetched.item.fields["headline"]).toBe("Old-client task");
    } finally {
      await store.dispose();
    }
  });

  it("exports the authoritative schema and appends it to the canonical registry", () => {
    expect(CANONICAL_LEDGERS.at(-1)).toEqual({
      name: UPSTREAM_LEDGER,
      schema: UPSTREAM_SCHEMA,
    });
    expect(Object.keys(OPTIONAL_FIELDS).sort()).toEqual(
      Object.entries(UPSTREAM_SCHEMA.fields)
        .filter(([, field]) => !field.required)
        .map(([name]) => name)
        .sort(),
    );
  });
});
