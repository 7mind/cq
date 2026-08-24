/**
 * MCP tool factory tests (msunify shape).
 *
 * We invoke each tool's handler directly (no SDK transport) and assert that
 * the returned CallToolResult has `content[0].text` that JSON-decodes to the
 * expected shape.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { validateAgainstSchema } from "@cq/config";
import {
  BootstrapViolationError,
  InMemoryLedgerStore,
  IDEAS_LEDGER,
  LEDGER_TOOL_NAMES,
  MILESTONES_AMBIENT_ID,
  NON_DISPATCH_LEDGER_TOOL_NAMES,
  CANONICAL_LEDGERS,
  createLedgerMcpTools,
  derivePredicates,
  deriveWorksetPredicates,
  ledgerToolInputJsonSchema,
  requireWorksetStore,
  type DerivedPredicates,
  type DispatchCapability,
  type Item,
  type ItemProjection,
  type LedgerSchema,
  type LedgerToolSpecification,
  type PromptCatalogCapability,
} from "../src/index.js";

const BOOTSTRAPPED = CANONICAL_LEDGERS.map((c) => c.name);

const schema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: {
    note: { type: "string", required: false },
  },
};

async function buildStore() {
  const store = new InMemoryLedgerStore({ seed: [{ name: "xenos", schema }] });
  await store.init();
  return store;
}

function callTool(
  tools: ReturnType<typeof createLedgerMcpTools>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const t = tools.find((x) => x.name === name);
  if (t === undefined) throw new Error(`tool not found: ${name}`);
  return t.handler(args as never, null) as Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
}

function createRoot(
  tools: ReturnType<typeof createLedgerMcpTools>,
  init: {
    title: string;
    description?: string;
    blockedBy?: string[];
    dependsOn?: string[];
    id?: string;
    author?: string;
    session?: string;
  },
) {
  const fields: Record<string, string | string[]> = { title: init.title };
  if (init.description !== undefined) fields["description"] = init.description;
  if (init.blockedBy !== undefined) fields["blockedBy"] = init.blockedBy;
  if (init.dependsOn !== undefined) fields["dependsOn"] = init.dependsOn;
  return callTool(tools, "create_item", {
    ledger_id: "milestones",
    status: "open",
    fields,
    ...(init.id === undefined ? {} : { id: init.id }),
    ...(init.author === undefined ? {} : { author: init.author }),
    ...(init.session === undefined ? {} : { session: init.session }),
  });
}

function updateRoot(
  tools: ReturnType<typeof createLedgerMcpTools>,
  patch: {
    milestone_id: string;
    status?: string;
    title?: string;
    description?: string;
    blockedBy?: string[];
    dependsOn?: string[];
    author?: string;
    session?: string;
  },
) {
  const fields: Record<string, string | string[]> = {};
  if (patch.title !== undefined) fields["title"] = patch.title;
  if (patch.description !== undefined) fields["description"] = patch.description;
  if (patch.blockedBy !== undefined) fields["blockedBy"] = patch.blockedBy;
  if (patch.dependsOn !== undefined) fields["dependsOn"] = patch.dependsOn;
  return callTool(tools, "update_item", {
    ledger_id: "milestones",
    item_id: patch.milestone_id,
    ...(patch.status === undefined ? {} : { status: patch.status }),
    ...(Object.keys(fields).length === 0 ? {} : { fields }),
    ...(patch.author === undefined ? {} : { author: patch.author }),
    ...(patch.session === undefined ? {} : { session: patch.session }),
  });
}

function fetchRoot(
  tools: ReturnType<typeof createLedgerMcpTools>,
  input: { milestone_id: string; projection: ItemProjection },
) {
  return callTool(tools, "fetch_item", {
    ledger_id: "milestones",
    item_id: input.milestone_id,
    projection: input.projection,
  });
}

function decode<T>(result: { content: Array<{ type: string; text: string }> }): T {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected single text content block");
  }
  return JSON.parse(first.text) as T;
}

it("create_item defaults an omitted milestone only for ideas", async () => {
  const store = await buildStore();
  try {
    const tools = createLedgerMcpTools(store);
    const createItem = tools.find((candidate) => candidate.name === "create_item");
    if (createItem === undefined) throw new Error("create_item tool not found");
    const inputSchema = ledgerToolInputJsonSchema(
      createItem as LedgerToolSpecification,
    ) as Parameters<typeof validateAgainstSchema>[0];
    const ideaInput = {
      ledger_id: IDEAS_LEDGER,
      status: "open",
      fields: { title: "Ambient by omission" },
    };
    const ownedIdeaGoalInput = {
      ledger_id: "goals",
      status: "clarifying",
      fields: { title: "Owned goal", description: "Atomic bundle" },
      owner_ref: "ideas:I1",
      creation_kind: "idea-to-goal",
    };

    expect(validateAgainstSchema(inputSchema, ideaInput).ok).toBe(true);
    expect(validateAgainstSchema(inputSchema, ownedIdeaGoalInput).ok).toBe(true);
    expect(
      validateAgainstSchema(inputSchema, {
        ...ownedIdeaGoalInput,
        milestone_id: "M900",
      }).ok,
    ).toBe(false);
    expect(validateAgainstSchema(inputSchema, { ...ownedIdeaGoalInput, id: "G900" }).ok).toBe(
      false,
    );
    expect(
      validateAgainstSchema(inputSchema, {
        ledger_id: "goals",
        status: "clarifying",
        fields: ownedIdeaGoalInput.fields,
        owner_ref: "ideas:I1",
      }).ok,
    ).toBe(false);
    expect(
      validateAgainstSchema(inputSchema, {
        ledger_id: "goals",
        status: "clarifying",
        fields: ownedIdeaGoalInput.fields,
        creation_kind: "idea-to-goal",
      }).ok,
    ).toBe(false);
    expect(
      validateAgainstSchema(inputSchema, {
        ledger_id: "tasks",
        status: "planned",
        fields: { headline: "Missing milestone" },
      }).ok,
    ).toBe(false);
    expect(createItem.description).toContain("ideas may omit milestone_id for M-AMBIENT");

    const created = decode<{ item: { id: string; milestoneId: string } }>(
      await callTool(tools, "create_item", ideaInput),
    );
    expect(created.item.milestoneId).toBe(MILESTONES_AMBIENT_ID);

    await createRoot(tools, { id: "M900", title: "Work milestone" });
    await expect(
      callTool(tools, "create_item", {
        ...ideaInput,
        milestone_id: "M900",
      }),
    ).rejects.toBeInstanceOf(BootstrapViolationError);
    await expect(
      callTool(tools, "create_item", {
        ledger_id: "tasks",
        status: "planned",
        fields: { headline: "Missing milestone" },
      }),
    ).rejects.toThrow("milestone_id is required outside the milestones ledger");
  } finally {
    await store.dispose();
  }
});

function expectedItemAcknowledgement(item: Item): Record<string, unknown> {
  const fields: Record<string, string[]> = {};
  for (const name of ["dependsOn", "blockedBy", "ledgerRefs"] as const) {
    const value = item.fields[name];
    if (Array.isArray(value)) fields[name] = value;
  }
  const acknowledgement: Record<string, unknown> = {
    id: item.id,
    milestoneId: item.milestoneId,
    status: item.status,
    fields,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  if (item.author !== undefined) acknowledgement["author"] = item.author;
  if (item.session !== undefined) acknowledgement["session"] = item.session;
  return acknowledgement;
}

describe("ledger MCP tools", () => {
  it("exports 46 canonical names and hides both validators", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);
    expect(tools.map((t) => t.name).sort()).toEqual([...NON_DISPATCH_LEDGER_TOOL_NAMES].sort());
    expect(LEDGER_TOOL_NAMES.length).toBe(46);
    expect(LEDGER_TOOL_NAMES).toContain("fts_search");
    expect(LEDGER_TOOL_NAMES).toContain("snapshot");
    expect(LEDGER_TOOL_NAMES).toContain("derive_predicates");
    expect(LEDGER_TOOL_NAMES).toContain("acknowledge_operator_action");
    expect(LEDGER_TOOL_NAMES).toContain("revise_operator_action");
    expect(LEDGER_TOOL_NAMES).toContain("reopen_item");
    expect(LEDGER_TOOL_NAMES).toContain("unarchive_item");
    expect(LEDGER_TOOL_NAMES).toContain("read_log");
    expect(LEDGER_TOOL_NAMES).toContain("get_config");
    expect(LEDGER_TOOL_NAMES).not.toContain("get_reviewers");
    expect(LEDGER_TOOL_NAMES).not.toContain("get_planners");
    expect(LEDGER_TOOL_NAMES).not.toContain("get_agent_models");
    expect(LEDGER_TOOL_NAMES).toContain("prepare_dispatch");
    expect(LEDGER_TOOL_NAMES).toContain("fetch_dispatch_input");
    expect(LEDGER_TOOL_NAMES).toContain("store_result");
    expect(LEDGER_TOOL_NAMES).toContain("confirm_dispatch_completion");
    expect(LEDGER_TOOL_NAMES).toContain("abort_dispatch");
    expect(LEDGER_TOOL_NAMES).toContain("fetch_dispatch_result");
    expect(LEDGER_TOOL_NAMES).toContain("fetch_prompt");
    expect(LEDGER_TOOL_NAMES).not.toContain("validate_input" as never);
    expect(LEDGER_TOOL_NAMES).not.toContain("validate_output" as never);
    expect(LEDGER_TOOL_NAMES).toContain("list_projects");
    expect(LEDGER_TOOL_NAMES).toContain("claim_plan");
    expect(LEDGER_TOOL_NAMES).toContain("publish_plan_draft");
    expect(LEDGER_TOOL_NAMES).toContain("release_plan_claim");
    expect(LEDGER_TOOL_NAMES).toContain("finalize_plan");
    expect(LEDGER_TOOL_NAMES).toContain("worktree_manage");
  });

  it("prefixes every registered non-dispatch tool", async () => {
    const store = await buildStore();
    const prefix = "myproj";
    const tools = createLedgerMcpTools(store, undefined, undefined, undefined, prefix);
    expect(tools.map((t) => t.name).sort()).toEqual(
      NON_DISPATCH_LEDGER_TOOL_NAMES.map((name) => `${prefix}_${name}`).sort(),
    );
  });

  it("read_log against the in-memory store throws the documented not-implemented error", async () => {
    const store = await buildStore();
    // No readLog capability supplied -> the in-memory dummy has no filesystem.
    const tools = createLedgerMcpTools(store);
    await expect(callTool(tools, "read_log", { path: "anything.md" })).rejects.toThrow(
      /not implemented/i,
    );
  });

  it("list_projects with no capability supplied throws the documented not-implemented error", async () => {
    const store = await buildStore();
    // No listProjects capability supplied at the raw factory level -> the
    // documented not-implemented error (the public createLedgerMcpServer
    // builder never leaves it undefined; see listProjects.ts's doc).
    const tools = createLedgerMcpTools(store);
    await expect(callTool(tools, "list_projects", {})).rejects.toThrow(/not implemented/i);
  });

  it("list_projects dispatches to an injected capability (multi-tenant shape)", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store, undefined, undefined, undefined, "", () => ({
      projects: [
        { key: "proj-a", displayName: "Project A", createdAt: "2026-01-01T00:00:00.000Z" },
        { key: "proj-b", displayName: "Project B" },
      ],
    }));
    const result = decode<{
      projects: Array<{ key: string; displayName: string; createdAt?: string }>;
    }>(await callTool(tools, "list_projects", {}));
    expect(result.projects).toEqual([
      { key: "proj-a", displayName: "Project A", createdAt: "2026-01-01T00:00:00.000Z" },
      { key: "proj-b", displayName: "Project B" },
    ]);
  });

  it("fetch_prompt without a catalog capability throws not-implemented", async () => {
    const store = await buildStore();
    // No promptCatalog capability supplied -> the in-memory wiring has no catalog.
    const tools = createLedgerMcpTools(store);
    await expect(callTool(tools, "fetch_prompt", { roleId: "plan-advance" })).rejects.toThrow(
      /not implemented/i,
    );
  });

  it("ordinary MCP dispatches fetch_prompt while both validators stay direct", async () => {
    const store = await buildStore();
    const calls: string[] = [];
    const promptCatalog: PromptCatalogCapability = {
      fetchPrompt: (roleId) => {
        calls.push(`fetch:${roleId}`);
        return {
          roleId,
          kind: "dispatched-subagent",
          dispatched: true,
          promptTemplate: "body",
          version: 1,
          inputSchema: { $schema: "x" },
          outputSchema: { $schema: "x" },
        };
      },
      validateInput: (roleId) => {
        calls.push(`vin:${roleId}`);
        return { ok: true };
      },
      validateOutput: (roleId) => {
        calls.push(`vout:${roleId}`);
        return {
          ok: false,
          errors: [{ path: "/x", message: "bad", keyword: "type", schemaPath: "#/x", params: {} }],
        };
      },
    };
    const tools = createLedgerMcpTools(store, undefined, undefined, promptCatalog);

    const fetched = decode<{ roleId: string; dispatched: boolean }>(
      await callTool(tools, "fetch_prompt", { roleId: "plan-advance" }),
    );
    expect(fetched.roleId).toBe("plan-advance");
    expect(fetched.dispatched).toBe(true);

    expect(tools.map((tool) => tool.name)).not.toContain("validate_input");
    const vin = promptCatalog.validateInput("plan-advance", { goalId: "G1" });
    expect(vin.ok).toBe(true);

    expect(tools.map((tool) => tool.name)).not.toContain("validate_output");
    const vout = promptCatalog.validateOutput("plan-advance", {});
    expect(vout.ok).toBe(false);
    if (vout.ok) throw new Error("expected direct output validation to fail");
    expect(vout.errors[0]?.path).toBe("/x");

    expect(calls).toEqual(["fetch:plan-advance", "vin:plan-advance", "vout:plan-advance"]);
  });

  it("enumerate_ledgers + create_ledger + fetch_ledger round-trip (includes bootstrapped milestones)", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    const enum1 = decode<{ ledgers: string[] }>(await callTool(tools, "enumerate_ledgers", {}));
    expect(enum1.ledgers).toEqual([...BOOTSTRAPPED, "xenos"].sort());

    await callTool(tools, "create_ledger", {
      name: "alpha",
      schema: {
        statusValues: ["open", "done"],
        terminalStatuses: ["done"],
        fields: { tag: { type: "string", required: false } },
      },
    });
    const enum2 = decode<{ ledgers: string[] }>(await callTool(tools, "enumerate_ledgers", {}));
    expect(enum2.ledgers).toEqual([...BOOTSTRAPPED, "alpha", "xenos"].sort());

    const fetched = decode<{
      ledger: { id: string; counters: { milestone: number; item: number } };
    }>(
      await callTool(tools, "fetch_ledger", {
        ledger_id: "alpha",
        projection: "full",
      }),
    );
    expect(fetched.ledger.id).toBe("alpha");
    expect(fetched.ledger.counters).toEqual({ milestone: 0, item: 0 });
  });

  it("generic root creation + ordinary item flow", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    const m = decode<{ item: { id: string; fields: Record<string, unknown> } }>(
      await createRoot(tools, {
        title: "first",
        description: "the first milestone",
      }),
    );
    expect(m.item.id).toBe("M1");
    expect(m.item.fields).toEqual({});

    const it = decode<{ item: { id: string; status: string; milestoneId: string } }>(
      await callTool(tools, "create_item", {
        ledger_id: "xenos",
        milestone_id: "M1",
        status: "open",
        fields: { note: "buy milk" },
      }),
    );
    expect(it.item.id).toBe("X1");
    expect(it.item.status).toBe("open");
    expect(it.item.milestoneId).toBe("M1");

    // enumerate_ledgers reports the active-item count per ledger: xenos now
    // holds X1, and milestones holds the just-created M1 (≥ 1).
    const counted = decode<{ counts: Record<string, number> }>(
      await callTool(tools, "enumerate_ledgers", {}),
    );
    expect(counted.counts["xenos"]).toBe(1);
    expect(counted.counts["milestones"]).toBeGreaterThanOrEqual(1);

    const fetched = decode<{ item: { fields: Record<string, string> } }>(
      await callTool(tools, "fetch_item", {
        ledger_id: "xenos",
        item_id: "X1",
        projection: "full",
      }),
    );
    expect(fetched.item.fields["note"]).toBe("buy milk");

    const updated = decode<{
      item: { status: string; fields: Record<string, string> };
    }>(
      await callTool(tools, "update_item", {
        ledger_id: "xenos",
        item_id: "X1",
        status: "done",
        fields: { note: "bought milk" },
      }),
    );
    expect(updated.item.status).toBe("done");
    expect(updated.item.fields).toEqual({});

    const reloaded = decode<{ item: { fields: Record<string, string> } }>(
      await callTool(tools, "fetch_item", {
        ledger_id: "xenos",
        item_id: "X1",
        projection: "full",
      }),
    );
    expect(reloaded.item.fields["note"]).toBe("bought milk");
  });

  it("create_item accepts an empty serialized defects list for reviews", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);
    await createRoot(tools, { title: "review schema" });

    const created = decode<{ item: { id: string } }>(
      await callTool(tools, "create_item", {
        ledger_id: "reviews",
        milestone_id: "M1",
        status: "go-ahead",
        fields: { defects: [] },
      }),
    );

    const fetched = decode<{ item: { fields: Record<string, unknown> } }>(
      await callTool(tools, "fetch_item", {
        ledger_id: "reviews",
        item_id: created.item.id,
        projection: "full",
      }),
    );
    expect(fetched.item.fields["defects"]).toEqual([]);
  });

  it("create_item round-trips serialized review defects byte-for-byte", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);
    await createRoot(tools, { title: "serialized defects" });
    const serialized = [
      JSON.stringify({
        headline: "Both optionals",
        severity: "high",
        rootCause: "confirmed cause",
        suggestedFix: "apply the fix",
      }),
      JSON.stringify({
        headline: "Omitted optionals",
        severity: "low",
      }),
      JSON.stringify({
        headline: 'Quoted "headline" \\ path\nline',
        severity: "critical",
        rootCause: "café 根因",
        suggestedFix: 'replace \\ with "slash"\n次',
      }),
    ];
    const expected = [
      '{"headline":"Both optionals","severity":"high","rootCause":"confirmed cause","suggestedFix":"apply the fix"}',
      '{"headline":"Omitted optionals","severity":"low"}',
      '{"headline":"Quoted \\"headline\\" \\\\ path\\nline","severity":"critical","rootCause":"café 根因","suggestedFix":"replace \\\\ with \\"slash\\"\\n次"}',
    ];
    expect(serialized).toEqual(expected);

    const created = decode<{ item: { id: string } }>(
      await callTool(tools, "create_item", {
        ledger_id: "reviews",
        milestone_id: "M1",
        status: "revise",
        fields: { defects: serialized },
      }),
    );
    const fetched = decode<{ item: { fields: Record<string, unknown> } }>(
      await callTool(tools, "fetch_item", {
        ledger_id: "reviews",
        item_id: created.item.id,
        projection: "full",
      }),
    );
    expect(fetched.item.fields["defects"]).toEqual(expected);
  });

  it("create_item rejects object arrays for reviews.defects", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);
    await createRoot(tools, { title: "invalid defects" });

    await expect(
      callTool(tools, "create_item", {
        ledger_id: "reviews",
        milestone_id: "M1",
        status: "revise",
        fields: {
          defects: [{ headline: "not serialized", severity: "high" }],
        },
      }),
    ).rejects.toThrow('field "defects" must be a string[]');
  });

  it("create_item / update_item thread author + session provenance", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);
    await createRoot(tools, { title: "first" });

    const created = decode<{ item: { id: string; author?: string; session?: string } }>(
      await callTool(tools, "create_item", {
        ledger_id: "xenos",
        milestone_id: "M1",
        status: "open",
        fields: { note: "n" },
        author: "opus-4.8[1m]",
        session: "sess-1",
      }),
    );
    expect(created.item.author).toBe("opus-4.8[1m]");
    expect(created.item.session).toBe("sess-1");

    const updated = decode<{ item: { author?: string; session?: string } }>(
      await callTool(tools, "update_item", {
        ledger_id: "xenos",
        item_id: created.item.id,
        status: "done",
        author: "user",
        session: "sess-2",
      }),
    );
    expect(updated.item.author).toBe("user");
    expect(updated.item.session).toBe("sess-2");
  });

  // BG, specified-origin: mutation responses expose fixed wire acknowledgements.
  it("create_item and update_item emit authoritative fixed acknowledgements", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);
    await createRoot(tools, { title: "acknowledgement" });
    await callTool(tools, "create_item", {
      ledger_id: "tasks",
      milestone_id: "M1",
      status: "planned",
      fields: { headline: "Dependency" },
    });

    const createResult = await callTool(tools, "create_item", {
      ledger_id: "tasks",
      milestone_id: "M1",
      status: "planned",
      fields: {
        headline: "Wire acknowledgement",
        description: "must not enter the mutation response",
        dependsOn: ["T1"],
        blockedBy: ["T1"],
        ledgerRefs: ["goals:G93"],
      },
      author: "gpt-5.6",
      session: "session-create",
    });
    const createResponse = decode<{ item: Record<string, unknown> }>(createResult);
    const created = store.fetchItem("tasks", createResponse.item["id"] as string);

    expect(createResponse).toEqual({
      item: expectedItemAcknowledgement(created),
    });
    expect(created.fields["dependsOn"]).toEqual(["tasks:T1"]);
    expect(created.fields["blockedBy"]).toEqual(["tasks:T1"]);
    expect(createResult.content[0]?.text).toBe(JSON.stringify(createResponse));

    const updateResult = await callTool(tools, "update_item", {
      ledger_id: "tasks",
      item_id: created.id,
      status: "wip",
      fields: {
        description: "updated narrative must remain omitted",
        dependsOn: ["T1"],
        blockedBy: ["T1"],
        ledgerRefs: ["goals:G93"],
      },
      author: "user",
      session: "session-update",
    });
    const updateResponse = decode<{ item: Record<string, unknown> }>(updateResult);
    const updated = store.fetchItem("tasks", created.id);

    expect(updateResponse).toEqual({
      item: expectedItemAcknowledgement(updated),
    });
    expect(updateResult.content[0]?.text).toBe(JSON.stringify(updateResponse));
    expect(updated.author).toBe("user");
    expect(updated.session).toBe("session-update");

    const absentResult = await callTool(tools, "create_item", {
      ledger_id: "tasks",
      milestone_id: "M1",
      status: "planned",
      fields: { headline: "No provenance" },
    });
    const absentResponse = decode<{ item: Record<string, unknown> }>(absentResult);
    const absentCreated = store.fetchItem("tasks", absentResponse.item["id"] as string);
    expect(absentResponse).toEqual({
      item: expectedItemAcknowledgement(absentCreated),
    });
    expect(Object.hasOwn(absentResponse.item, "author")).toBe(false);
    expect(Object.hasOwn(absentResponse.item, "session")).toBe(false);

    const absentUpdateResult = await callTool(tools, "update_item", {
      ledger_id: "tasks",
      item_id: absentCreated.id,
      status: "wip",
    });
    const absentUpdateResponse = decode<{ item: Record<string, unknown> }>(absentUpdateResult);
    const absentUpdated = store.fetchItem("tasks", absentCreated.id);
    expect(absentUpdateResponse).toEqual({
      item: expectedItemAcknowledgement(absentUpdated),
    });
    expect(Object.hasOwn(absentUpdateResponse.item, "author")).toBe(false);
    expect(Object.hasOwn(absentUpdateResponse.item, "session")).toBe(false);
  });

  // BG, specified-origin: ledger and milestone writes expose fixed DTOs.
  it("create_ledger and milestone mutations omit full content and preserve authoritative values", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    const ledgerResult = await callTool(tools, "create_ledger", {
      name: "ackledger",
      schema: {
        statusValues: ["open", "done"],
        terminalStatuses: ["done"],
        fields: { narrative: { type: "string", required: false } },
      },
    });
    const ledgerResponse = decode<{ ledger: Record<string, unknown> }>(ledgerResult);
    expect(ledgerResponse).toEqual({ ledger: { id: "ackledger" } });
    expect(Object.hasOwn(ledgerResponse.ledger, "schema")).toBe(false);
    expect(Object.hasOwn(ledgerResponse.ledger, "author")).toBe(false);
    expect(Object.hasOwn(ledgerResponse.ledger, "session")).toBe(false);
    expect(ledgerResult.content[0]?.text).toBe(JSON.stringify(ledgerResponse));

    await createRoot(tools, { title: "Dependency" });
    const createResult = await createRoot(tools, {
      title: "Acknowledged milestone",
      description: "narrative must be omitted",
      dependsOn: ["M1"],
      blockedBy: ["M1"],
    });
    const createResponse = decode<{ item: Record<string, unknown> }>(createResult);
    const created = store.fetchItem("milestones", createResponse.item["id"] as string);

    expect(createResponse).toEqual({
      item: expectedItemAcknowledgement(created),
    });
    expect(created.fields["dependsOn"]).toEqual(["milestones:M1"]);
    expect(created.fields["blockedBy"]).toEqual(["milestones:M1"]);
    expect(Object.hasOwn(createResponse.item, "author")).toBe(false);
    expect(Object.hasOwn(createResponse.item, "session")).toBe(false);

    await store.updateItem("milestones", created.id, {
      author: "gpt-5.6",
      session: "session-milestone",
    });
    const updateResult = await updateRoot(tools, {
      milestone_id: created.id,
      status: "blocked",
      title: "updated narrative must be omitted",
      dependsOn: ["M1"],
      blockedBy: ["M1"],
    });
    const updateResponse = decode<{ item: Record<string, unknown> }>(updateResult);
    const updated = store.fetchItem("milestones", created.id);

    expect(updateResponse).toEqual({
      item: expectedItemAcknowledgement(updated),
    });
    expect(updateResponse.item["author"]).toBe("gpt-5.6");
    expect(updateResponse.item["session"]).toBe("session-milestone");
    expect(updateResult.content[0]?.text).toBe(JSON.stringify(updateResponse));
  });

  // BG, specified-origin: recovery acknowledgements retain stored provenance.
  it("reopen_item and unarchive_item preserve present and absent provenance", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    await createRoot(tools, { title: "Reopen" });
    const authoredCreate = decode<{ item: { id: string } }>(
      await callTool(tools, "create_item", {
        ledger_id: "tasks",
        milestone_id: "M1",
        status: "done",
        fields: { headline: "Reopen me" },
        author: "gpt-5.6",
        session: "session-reopen",
      }),
    );
    const reopenResult = await callTool(tools, "reopen_item", {
      ledger_id: "tasks",
      item_id: authoredCreate.item.id,
      to_status: "planned",
    });
    const reopenResponse = decode<{ item: Record<string, unknown> }>(reopenResult);
    const reopened = store.fetchItem("tasks", authoredCreate.item.id);
    expect(reopenResponse).toEqual({
      item: expectedItemAcknowledgement(reopened),
    });
    expect(reopenResponse.item["author"]).toBe("gpt-5.6");
    expect(reopenResponse.item["session"]).toBe("session-reopen");

    const unattributedReopenCreate = decode<{ item: { id: string } }>(
      await callTool(tools, "create_item", {
        ledger_id: "tasks",
        milestone_id: "M1",
        status: "done",
        fields: { headline: "Reopen without provenance" },
      }),
    );
    const unattributedReopenResult = await callTool(tools, "reopen_item", {
      ledger_id: "tasks",
      item_id: unattributedReopenCreate.item.id,
      to_status: "planned",
    });
    const unattributedReopenResponse = decode<{
      item: Record<string, unknown>;
    }>(unattributedReopenResult);
    const unattributedReopened = store.fetchItem("tasks", unattributedReopenCreate.item.id);
    expect(unattributedReopenResponse).toEqual({
      item: expectedItemAcknowledgement(unattributedReopened),
    });
    expect(Object.hasOwn(unattributedReopenResponse.item, "author")).toBe(false);
    expect(Object.hasOwn(unattributedReopenResponse.item, "session")).toBe(false);

    await createRoot(tools, { title: "Unarchive" });
    const attributed = decode<{ item: { id: string } }>(
      await callTool(tools, "create_item", {
        ledger_id: "xenos",
        milestone_id: "M2",
        status: "done",
        fields: { note: "attributed narrative" },
        author: "user",
        session: "session-unarchive",
      }),
    );
    const unattributed = decode<{ item: { id: string } }>(
      await callTool(tools, "create_item", {
        ledger_id: "xenos",
        milestone_id: "M2",
        status: "done",
        fields: { note: "unattributed narrative" },
      }),
    );
    await updateRoot(tools, {
      milestone_id: "M2",
      status: "done",
    });
    await callTool(tools, "archive_milestone", {
      milestone_id: "M2",
      summary: "recovery fixture",
    });

    for (const expected of [
      { id: attributed.item.id, author: "user", session: "session-unarchive" },
      { id: unattributed.item.id },
    ]) {
      const result = await callTool(tools, "unarchive_item", {
        ledger_id: "xenos",
        milestone_id: "M2",
        item_id: expected.id,
      });
      const response = decode<{ item: Record<string, unknown> }>(result);
      const authoritative = store.fetchItem("xenos", expected.id);
      expect(response).toEqual({
        item: expectedItemAcknowledgement(authoritative),
      });
      expect(Object.hasOwn(response.item, "author")).toBe(Object.hasOwn(expected, "author"));
      expect(Object.hasOwn(response.item, "session")).toBe(Object.hasOwn(expected, "session"));
      expect(result.content[0]?.text).toBe(JSON.stringify(response));
    }
  });

  it("create_item refuses absent / terminal milestone (strict existence Q5)", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    await expect(
      callTool(tools, "create_item", {
        ledger_id: "xenos",
        milestone_id: "M99",
        status: "open",
        fields: {},
      }),
    ).rejects.toThrow(/does not exist/);

    await createRoot(tools, { title: "done-already" });
    await updateRoot(tools, { milestone_id: "M1", status: "done" });
    await expect(
      callTool(tools, "create_item", {
        ledger_id: "xenos",
        milestone_id: "M1",
        status: "open",
        fields: {},
      }),
    ).rejects.toThrow(/terminal status/);
  });

  it("generic root update and fetch plus list_milestone_items", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    await createRoot(tools, { title: "x", description: "the x" });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "open",
      fields: { note: "t1" },
    });

    const fm = decode<{
      item: { id: string };
      resolved: { id: string; title: string };
      references: Record<string, number>;
    }>(
      await fetchRoot(tools, {
        milestone_id: "M1",
        projection: "full",
      }),
    );
    expect(fm.item.id).toBe("M1");
    expect(fm.resolved.title).toBe("x");
    expect(fm.references).toEqual({ xenos: 1 });

    await updateRoot(tools, {
      milestone_id: "M1",
      title: "renamed",
    });
    const fm2 = decode<{ resolved: { title: string } }>(
      await fetchRoot(tools, {
        milestone_id: "M1",
        projection: "full",
      }),
    );
    expect(fm2.resolved.title).toBe("renamed");

    const list = decode<{ items: Record<string, Array<{ id: string }>> }>(
      await callTool(tools, "list_milestone_items", {
        milestone_id: "M1",
        projection: "full",
      }),
    );
    expect(list.items["xenos"]?.[0]?.id).toBe("X1");
  });

  it("archive_milestone (global, 2-level): refuses non-terminal items, succeeds when all terminal", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    await createRoot(tools, { title: "x" });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "open",
      fields: {},
    });
    await expect(
      callTool(tools, "archive_milestone", { milestone_id: "M1", summary: "no" }),
    ).rejects.toThrow(/not in terminal status/);
    await callTool(tools, "update_item", {
      ledger_id: "xenos",
      item_id: "X1",
      status: "done",
    });
    await updateRoot(tools, { milestone_id: "M1", status: "done" });
    const archiveResult = await callTool(tools, "archive_milestone", {
      milestone_id: "M1",
      summary: "done!",
    });
    const ptr = decode<{
      pointer: {
        id: string;
        path: string;
        summary: string;
        title: string;
        status: string;
      };
    }>(archiveResult);
    expect(ptr).toEqual({
      pointer: {
        id: "M1",
        path: "./archive/milestones/M1.md",
        summary: "done!",
        title: "x",
        status: "done",
      },
    });
    expect(archiveResult.content[0]?.text).toBe(JSON.stringify(ptr));
  });

  // D-LED-02 — Zod-layer rejection of invalid schemas at create_ledger.
  describe("D-LED-02 — Zod schema validation in create_ledger", () => {
    function parseCreateLedger(
      tools: ReturnType<typeof createLedgerMcpTools>,
      args: Record<string, unknown>,
    ): { success: boolean } {
      const t = tools.find((x) => x.name === "create_ledger");
      if (t === undefined) throw new Error("create_ledger not found");
      return z.object(t.inputSchema).safeParse(args);
    }

    it("rejects terminalStatuses not in statusValues", async () => {
      const store = await buildStore();
      const tools = createLedgerMcpTools(store);
      expect(
        parseCreateLedger(tools, {
          name: "x",
          schema: {
            statusValues: ["open"],
            terminalStatuses: ["done"],
            fields: {},
          },
        }).success,
      ).toBe(false);
    });

    it("rejects status values containing em-dash", async () => {
      const store = await buildStore();
      const tools = createLedgerMcpTools(store);
      expect(
        parseCreateLedger(tools, {
          name: "x",
          schema: {
            statusValues: ["open", "in—progress"],
            terminalStatuses: [],
            fields: {},
          },
        }).success,
      ).toBe(false);
    });

    it("rejects reserved field names createdAt/updatedAt", async () => {
      const store = await buildStore();
      const tools = createLedgerMcpTools(store);
      for (const name of ["createdAt", "updatedAt"]) {
        expect(
          parseCreateLedger(tools, {
            name: "x",
            schema: {
              statusValues: ["open"],
              terminalStatuses: [],
              fields: { [name]: { type: "timestamp", required: false } },
            },
          }).success,
        ).toBe(false);
      }
    });

    it("rejects field names with spaces or leading digits", async () => {
      const store = await buildStore();
      const tools = createLedgerMcpTools(store);
      for (const name of ["bad name", "1bad", "with:colon"]) {
        expect(
          parseCreateLedger(tools, {
            name: "x",
            schema: {
              statusValues: ["open"],
              terminalStatuses: [],
              fields: { [name]: { type: "string", required: false } },
            },
          }).success,
        ).toBe(false);
      }
    });

    it("accepts a clean schema (positive control)", async () => {
      const store = await buildStore();
      const tools = createLedgerMcpTools(store);
      expect(
        parseCreateLedger(tools, {
          name: "x",
          schema: {
            statusValues: ["open", "done"],
            terminalStatuses: ["done"],
            fields: { note: { type: "string", required: false } },
          },
        }).success,
      ).toBe(true);
    });
  });

  // D-LED-01 — Zod-layer rejection of unsafe ids.
  describe("D-LED-01 — Zod id validation", () => {
    const badIds = ["../etc/passwd", "a/b", "a b", "a.b"];
    function parseInput(
      tools: ReturnType<typeof createLedgerMcpTools>,
      name: string,
      args: Record<string, unknown>,
    ): { success: boolean } {
      const t = tools.find((x) => x.name === name);
      if (t === undefined) throw new Error(`tool not found: ${name}`);
      return z.object(t.inputSchema).safeParse(args);
    }

    it("generic root creation rejects unsafe explicit ids at the Zod boundary", async () => {
      const store = await buildStore();
      const tools = createLedgerMcpTools(store);
      for (const badId of badIds) {
        const r = parseInput(tools, "create_item", {
          ledger_id: "milestones",
          status: "open",
          fields: { title: "x" },
          id: badId,
        });
        expect(r.success).toBe(false);
      }
    });

    it("create_item rejects unsafe ids (item id and milestone_id)", async () => {
      const store = await buildStore();
      const tools = createLedgerMcpTools(store);
      for (const badId of badIds) {
        const rItem = parseInput(tools, "create_item", {
          ledger_id: "xenos",
          milestone_id: "M1",
          status: "open",
          fields: {},
          id: badId,
        });
        expect(rItem.success).toBe(false);
        const rMile = parseInput(tools, "create_item", {
          ledger_id: "xenos",
          milestone_id: badId,
          status: "open",
          fields: {},
        });
        expect(rMile.success).toBe(false);
      }
    });

    it("archive_milestone rejects unsafe milestone_id", async () => {
      const store = await buildStore();
      const tools = createLedgerMcpTools(store);
      for (const badId of badIds) {
        expect(
          parseInput(tools, "archive_milestone", {
            milestone_id: badId,
            summary: "x",
          }).success,
        ).toBe(false);
      }
    });

    it("safe ids parse cleanly (positive control)", async () => {
      const store = await buildStore();
      const tools = createLedgerMcpTools(store);
      const r = parseInput(tools, "create_item", {
        ledger_id: "milestones",
        status: "open",
        fields: { title: "x" },
        id: "M-ok_1",
      });
      expect(r.success).toBe(true);
    });
  });

  it("search_items returns items matching fields", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);
    await createRoot(tools, { title: "x" });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "open",
      fields: { note: "buy milk" },
    });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "open",
      fields: { note: "wash car" },
    });
    const hits = decode<{ items: Array<{ id: string }> }>(
      await callTool(tools, "search_items", {
        ledger_id: "xenos",
        query: "milk",
        projection: "full",
      }),
    );
    expect(hits.items.map((i) => i.id)).toEqual(["X1"]);
  });

  it("fts_search returns the documented ranked JSON shape", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);
    await createRoot(tools, { title: "x" });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "open",
      fields: { note: "buy oat milk today" },
    });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "open",
      fields: { note: "wash the car" },
    });
    const out = decode<{
      results: Array<{
        ledgerId: string;
        item: { id: string; fields: Record<string, string> };
        score: number;
        matchedFields: string[];
      }>;
    }>(
      await callTool(tools, "fts_search", {
        query: "milk",
        projection: "full",
      }),
    );
    expect(out.results.length).toBe(1);
    const hit = out.results[0]!;
    expect(hit.ledgerId).toBe("xenos");
    expect(hit.item.id).toBe("X1");
    expect(hit.score > 0).toBe(true);
    expect(Array.isArray(hit.matchedFields)).toBe(true);
  });

  it("fts_search includes archived items only when include_archived=true", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);
    await createRoot(tools, { title: "x" });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "done",
      fields: { note: "quokka note" },
    });
    await updateRoot(tools, { milestone_id: "M1", status: "done" });
    await callTool(tools, "archive_milestone", { milestone_id: "M1", summary: "s" });
    const def = decode<{ results: unknown[] }>(
      await callTool(tools, "fts_search", {
        query: "quokka",
        projection: "full",
      }),
    );
    expect(def.results.length).toBe(0);
    const incl = decode<{ results: Array<{ item: { id: string } }> }>(
      await callTool(tools, "fts_search", {
        query: "quokka",
        projection: "full",
        include_archived: true,
      }),
    );
    expect(incl.results.map((r) => r.item.id)).toEqual(["X1"]);
  });

  it("snapshot returns W1 grouping: { ledger: { [ledgerId]: { [status]: { count, items } } } }", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    await createRoot(tools, { title: "snap-test" });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "open",
      fields: { note: "first item" },
    });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "open",
      fields: { note: "second item" },
    });

    const out = decode<{
      ledger: Record<
        string,
        Record<
          string,
          { count: number; items: Array<{ id: string; status: string; summary: string }> }
        >
      >;
    }>(await callTool(tools, "snapshot", {}));

    expect(typeof out.ledger).toBe("object");

    const xenosOpen = out.ledger["xenos"]?.["open"];
    expect(xenosOpen).toBeDefined();
    expect(xenosOpen!.count).toBe(2);
    expect(xenosOpen!.items.length).toBe(2);

    // each stub carries exactly { id, status, summary } — no long fields
    const stub = xenosOpen!.items[0]!;
    expect(typeof stub.id).toBe("string");
    expect(stub.status).toBe("open");
    expect(typeof stub.summary).toBe("string");
    expect(Object.keys(stub).sort()).toEqual(["id", "status", "summary"]);

    // milestones ledger is also active (holds M1 at status open).
    expect(out.ledger["milestones"]).toBeDefined();

    // include_archived is a no-op; tool accepts it without error
    const out2 = decode<{ ledger: Record<string, unknown> }>(
      await callTool(tools, "snapshot", { include_archived: true }),
    );
    expect(typeof out2.ledger).toBe("object");
  });

  it("derive_predicates returns derivePredicates(store) for a seeded store", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    // Seed a goal in `building` plus a DAG-ready `planned` task linked to it,
    // so pImplement is TRUE-and-unblocked (a non-trivial verdict to compare).
    await createRoot(tools, { title: "pred-test" });
    const goal = decode<{ item: { id: string } }>(
      await callTool(tools, "create_item", {
        ledger_id: "goals",
        milestone_id: "M1",
        status: "building",
        fields: { title: "ship it", description: "the goal" },
      }),
    );
    await callTool(tools, "create_item", {
      ledger_id: "tasks",
      milestone_id: "M1",
      status: "planned",
      fields: { headline: "do the work", ledgerRefs: [`goals:${goal.item.id}`] },
    });
    // Seed an open research too, so pResearch is also TRUE-and-unblocked.
    const research = decode<{ item: { id: string } }>(
      await callTool(tools, "create_item", {
        ledger_id: "researches",
        milestone_id: "M1",
        status: "open",
        fields: { question: "does this need a research?" },
      }),
    );

    // The tool's output must equal the shared derivePredicates(store) directly.
    const expected = derivePredicates(store);
    const actual = decode<DerivedPredicates>(await callTool(tools, "derive_predicates", {}));
    expect(actual).toEqual(expected);

    // And the seeded task makes pImplement TRUE, naming that task id.
    expect(actual.pImplement.value).toBe(true);
    expect(actual.pImplement.items.length).toBe(1);
    // And the seeded research makes pResearch TRUE, naming that research id.
    expect(actual.pResearch.value).toBe(true);
    expect(actual.pResearch.items).toEqual([research.item.id]);
  });

  it("derive_predicates returns only closed workset members when roots are restrictive", async () => {
    const store = await buildStore();
    try {
      const tools = createLedgerMcpTools(store);
      const milestone = await store.createMilestone({ title: "workset MCP predicates" });
      const included = await store.createItem("defects", milestone.id, {
        status: "open",
        fields: { headline: "included", severity: "high" },
      });
      await store.createItem("defects", milestone.id, {
        status: "open",
        fields: { headline: "unrelated", severity: "high" },
      });
      await requireWorksetStore(store).setRoots([`defects:${included.id}`]);

      const actual = decode<DerivedPredicates>(await callTool(tools, "derive_predicates", {}));
      expect(actual).toEqual(await deriveWorksetPredicates(store));
      expect(actual.pInvestigate).toEqual({ value: true, items: [included.id] });
    } finally {
      await store.dispose();
    }
  });

  it("reopen_item moves a terminal item to a non-terminal status", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    await createRoot(tools, { title: "r" });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "done",
      fields: { note: "accidentally done" },
    });

    const reopened = decode<{ item: { id: string; status: string } }>(
      await callTool(tools, "reopen_item", {
        ledger_id: "xenos",
        item_id: "X1",
        to_status: "open",
      }),
    );
    expect(reopened.item.status).toBe("open");
    expect(reopened.item.id).toBe("X1");
  });

  it("reopen_item rejects an invalid (terminal) target status", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    await createRoot(tools, { title: "r" });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "done",
      fields: {},
    });

    await expect(
      callTool(tools, "reopen_item", {
        ledger_id: "xenos",
        item_id: "X1",
        to_status: "done",
      }),
    ).rejects.toThrow();
  });

  it("unarchive_item restores a single item from a milestone-group archive", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    await createRoot(tools, { title: "arch" });
    await callTool(tools, "create_item", {
      ledger_id: "xenos",
      milestone_id: "M1",
      status: "done",
      fields: { note: "to be archived" },
    });
    await updateRoot(tools, { milestone_id: "M1", status: "done" });
    await callTool(tools, "archive_milestone", { milestone_id: "M1", summary: "archived" });

    // Item is gone from active ledger after archiving.
    const snap = decode<{ ledger: Record<string, unknown> }>(await callTool(tools, "snapshot", {}));
    expect(snap.ledger["xenos"]).toBeUndefined();

    const restored = decode<{ item: { id: string; status: string } }>(
      await callTool(tools, "unarchive_item", {
        ledger_id: "xenos",
        milestone_id: "M1",
        item_id: "X1",
      }),
    );
    expect(restored.item.id).toBe("X1");
    expect(restored.item.status).toBe("done");
  });

  it("unarchive_item rejects an unknown archive group", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    await expect(
      callTool(tools, "unarchive_item", {
        ledger_id: "xenos",
        milestone_id: "M99",
        item_id: "X1",
      }),
    ).rejects.toThrow();
  });

  it("reopen_item and unarchive_item do not declare author/session params", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    for (const name of ["reopen_item", "unarchive_item"]) {
      const t = tools.find((x) => x.name === name);
      if (t === undefined) throw new Error(`tool not found: ${name}`);
      expect(Object.keys(t.inputSchema)).not.toContain("author");
      expect(Object.keys(t.inputSchema)).not.toContain("session");
    }
  });

  it("get_agent_models without config capability throws the documented not-implemented error", async () => {
    const store = await buildStore();
    // No configCapability supplied -> the in-memory store has no cq.toml-capable root.
    const tools = createLedgerMcpTools(store);
    await expect(callTool(tools, "get_config", { section: "agent_models" })).rejects.toThrow(
      /not implemented/i,
    );
  });

  it("routes all eight dispatch tools through scoped capabilities with handle-only result fetch", async () => {
    const store = await buildStore();
    const calls: Array<{ operation: string; input: unknown }> = [];
    const record = (operation: string, input: unknown): never => {
      calls.push({ operation, input });
      return { operation } as never;
    };
    const dispatchCapability: DispatchCapability = {
      prepare: async (input) => record("prepare_dispatch", input),
      fetchInput: async (input) => record("fetch_dispatch_input", input),
      storeResult: async (input) => record("store_result", input),
      confirmCompletion: async (input) => record("confirm_dispatch_completion", input),
      abort: async (input) => record("abort_dispatch", input),
      fetch: async (input) => record("fetch_dispatch_result", input),
      gitCommit: async (input) => record("git_commit", input),
      gitResolveContinue: async (input) => record("git_resolve_continue", input),
    };
    const tools = createLedgerMcpTools(
      store,
      undefined,
      undefined,
      undefined,
      "",
      undefined,
      dispatchCapability,
    );
    const handle = {
      attestationId: `att_${"a".repeat(32)}`,
      generation: 1,
    };
    await callTool(tools, "prepare_dispatch", {
      roleId: "implement-worker",
      input: { taskId: "T695" },
      idempotencyKey: "T695-r1",
      timeoutMs: 120_000,
      expectedChild: { childId: "child-1", runId: "run-1" },
      overlays: [{ overlayId: "fixture-focus", data: { note: "validate before allocate" } }],
    });
    await callTool(tools, "fetch_dispatch_input", {
      ...handle,
      inputCapability: {
        scope: "fetch-input",
        token: `cq_input_${"c".repeat(43)}`,
      },
    });
    await callTool(tools, "store_result", {
      resultCapability: {
        scope: "store-result",
        token: `cq_result_${"b".repeat(43)}`,
      },
      output: { status: "pass" },
    });
    await callTool(tools, "confirm_dispatch_completion", {
      ...handle,
      nativeCompletion: {
        kind: "native-completion",
        actor: "trusted-parent",
        childId: "child-1",
        runId: "run-1",
        completedAt: "2026-07-29T12:00:00.000Z",
      },
      expectedProvenance: {
        roleId: "implement-worker",
        version: 1,
        promptDigest: "a".repeat(64),
        inputDigest: "b".repeat(64),
      },
    });
    await callTool(tools, "abort_dispatch", { ...handle, reason: "cancelled" });
    await callTool(tools, "fetch_dispatch_result", handle);
    await callTool(tools, "git_commit", {
      ...handle,
      gitChangeCapability: { scope: "git-change", token: `cq_git_${"d".repeat(43)}` },
      operationId: "T695-commit-1",
      expectedHead: "a".repeat(40),
      message: "brokered change",
      changes: [
        {
          kind: "add",
          path: "new.txt",
          newState: { mode: "100644", digest: "e".repeat(64) },
        },
      ],
    });
    await callTool(tools, "git_resolve_continue", {
      ...handle,
      gitConflictCapability: {
        scope: "git-conflict",
        token: `cq_conflict_${"f".repeat(43)}`,
      },
      operationId: "T695-conflict-1",
      expectedState: {
        baseCommit: "a".repeat(40),
        currentHead: "b".repeat(40),
        expectedAncestry: [],
        sequencer: {
          kind: "rebase-merge",
          identity: "c".repeat(64),
          headName: "refs/heads/implement/T695",
          originalTip: "d".repeat(40),
          onto: "e".repeat(40),
          stoppedCommit: "f".repeat(40),
          currentCommand: `pick ${"f".repeat(40)} change`,
          todoDigest: "1".repeat(64),
          doneDigest: "2".repeat(64),
        },
        conflicts: [{ path: "new.txt", stage: 2, mode: "100644", oid: "3".repeat(40) }],
      },
      resolutions: [
        {
          kind: "regular",
          path: "new.txt",
          newState: { mode: "100644", digest: "4".repeat(64) },
        },
      ],
    });

    expect(calls.map((entry) => entry.operation)).toEqual([
      "prepare_dispatch",
      "fetch_dispatch_input",
      "store_result",
      "confirm_dispatch_completion",
      "abort_dispatch",
      "fetch_dispatch_result",
      "git_commit",
      "git_resolve_continue",
    ]);
    expect(calls[0]!.input).toEqual({
      roleId: "implement-worker",
      input: { taskId: "T695" },
      idempotencyKey: "T695-r1",
      timeoutMs: 120_000,
      expectedChild: { childId: "child-1", runId: "run-1" },
      overlays: [{ overlayId: "fixture-focus", data: { note: "validate before allocate" } }],
    });
    expect(calls[2]!.input).toEqual({
      resultCapability: {
        scope: "store-result",
        token: `cq_result_${"b".repeat(43)}`,
      },
      output: { status: "pass" },
    });
    expect(calls[5]!.input).toEqual(handle);
  });
});
