/**
 * D269/T1993 — fetch_prompt explicit projection ("full" default | "schema"),
 * under G93's answered policy (Q312: the deliberate full-detail projection is
 * retained as the default; Q313: the schema projection applies to every
 * structurally eligible method — here fetch_prompt).
 *
 * Wire-level pins through the tool factory with an injected stub capability:
 *
 *  - the default (argument omitted) is BYTE-IDENTICAL to `projection: "full"`
 *    and to the pre-change full entry (the capability output serialised);
 *  - `projection: "schema"` returns EXACTLY { roleId, version, inputSchema,
 *    outputSchema } for a dispatched-subagent role — no promptTemplate and no
 *    other role metadata;
 *  - an orchestrator-command role returns `{ roleId }` alone: the
 *    version/inputSchema/outputSchema keys are ABSENT (never null);
 *  - an unknown projection value fails validation.
 */

import { describe, it, expect } from "bun:test";
import {
  InMemoryLedgerStore,
  createLedgerMcpTools,
  type FetchPromptResult,
  type PromptCatalogCapability,
} from "../src/index.js";

const DISPATCHED_ENTRY: FetchPromptResult = {
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

const ORCHESTRATOR_ENTRY: FetchPromptResult = {
  roleId: "advance",
  kind: "orchestrator-command",
  dispatched: false,
  promptTemplate: "Run every flow to quiescence.",
};

const stubCatalog: PromptCatalogCapability = {
  fetchPrompt: (roleId) => (roleId === "advance" ? ORCHESTRATOR_ENTRY : DISPATCHED_ENTRY),
  validateInput: () => {
    throw new Error("projection test does not exercise validateInput");
  },
  validateOutput: () => {
    throw new Error("projection test does not exercise validateOutput");
  },
};

async function buildTools(): Promise<ReturnType<typeof createLedgerMcpTools>> {
  const store = new InMemoryLedgerStore();
  await store.init();
  return createLedgerMcpTools(store, undefined, undefined, stubCatalog);
}

async function fetchPromptText(args: Record<string, unknown>): Promise<string> {
  const tools = await buildTools();
  const tool = tools.find((candidate) => candidate.name === "fetch_prompt");
  if (tool === undefined) throw new Error("fetch_prompt not registered");
  const result = (await tool.handler(args as never, null)) as {
    content: Array<{ type: string; text: string }>;
  };
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

describe("fetch_prompt projection (D269/T1993)", () => {
  it("defaults to the deliberate full projection, byte-identical to the pre-change response", async () => {
    const defaultText = await fetchPromptText({ roleId: "plan-reviewer" });
    const explicitFullText = await fetchPromptText({
      roleId: "plan-reviewer",
      projection: "full",
    });

    expect(defaultText).toBe(explicitFullText);
    // Byte-identity against the pre-change response: the capability output
    // serialised with no key added, dropped, or reordered.
    expect(defaultText).toBe(JSON.stringify(DISPATCHED_ENTRY));
  });

  it("schema projection returns exactly { roleId, version, inputSchema, outputSchema }", async () => {
    const text = await fetchPromptText({ roleId: "plan-reviewer", projection: "schema" });
    const parsed = JSON.parse(text) as Record<string, unknown>;

    expect(Object.keys(parsed).sort()).toEqual([
      "inputSchema",
      "outputSchema",
      "roleId",
      "version",
    ]);
    expect(parsed).toEqual({
      roleId: DISPATCHED_ENTRY.roleId,
      version: DISPATCHED_ENTRY.version,
      inputSchema: DISPATCHED_ENTRY.inputSchema,
      outputSchema: DISPATCHED_ENTRY.outputSchema,
    });
    expect(text).not.toContain("promptTemplate");
  });

  it("schema projection returns { roleId } alone for an orchestrator-command role", async () => {
    const text = await fetchPromptText({ roleId: "advance", projection: "schema" });
    const parsed = JSON.parse(text) as Record<string, unknown>;

    expect(parsed).toEqual({ roleId: "advance" });
    expect("version" in parsed).toBe(false);
    expect("inputSchema" in parsed).toBe(false);
    expect("outputSchema" in parsed).toBe(false);
  });

  it("full projection leaves the orchestrator-command entry untouched", async () => {
    const text = await fetchPromptText({ roleId: "advance", projection: "full" });
    expect(text).toBe(JSON.stringify(ORCHESTRATOR_ENTRY));
  });

  it("rejects an unknown projection value", async () => {
    const tools = await buildTools();
    const tool = tools.find((candidate) => candidate.name === "fetch_prompt");
    if (tool === undefined) throw new Error("fetch_prompt not registered");
    await expect(
      tool.handler({ roleId: "plan-reviewer", projection: "bogus" } as never, null),
    ).rejects.toThrow();
  });
});
