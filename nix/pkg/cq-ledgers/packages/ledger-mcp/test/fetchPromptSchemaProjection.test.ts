/**
 * D269/T1993 — fetch_prompt schema-projection token-size regression over the
 * REAL source-tree prompt catalog (createLegacySourcePromptCatalogCapability).
 *
 * D269 measured plan-reviewer: the full typed entry serialised to 6,913
 * characters while { roleId, version, inputSchema, outputSchema } serialised
 * to 1,182 — 82.9% avoidable when only the dispatch contract is needed. This
 * suite pins:
 *
 *  - the response SHAPE exactly (key set) for both role kinds;
 *  - the schema projection's serialized size inside ±15% of the measured
 *    1,182 characters — a band that tolerates sidecar edits yet fails if
 *    promptTemplate (or any other role metadata) leaks back in, since the
 *    full entry is ~3.3k characters from the source tree (and was ~6.9k in
 *    D269's packaged-root measurement);
 *  - the deliberate full projection (Q312) byte-identical to the pre-change
 *    response (the capability output serialised).
 */

import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import { InMemoryLedgerStore, createLedgerMcpTools } from "@cq/ledger";
import { createLegacySourcePromptCatalogCapability } from "../src/promptCatalogCapability.js";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");

/** D269's measured schema-projection size for plan-reviewer, with a ±15% band. */
const D269_SCHEMA_SERIALIZED_CHARS = 1182;
const SCHEMA_SIZE_MIN = Math.floor(D269_SCHEMA_SERIALIZED_CHARS * 0.85);
const SCHEMA_SIZE_MAX = Math.ceil(D269_SCHEMA_SERIALIZED_CHARS * 1.15);

const catalog = createLegacySourcePromptCatalogCapability(REPO_ROOT);

async function fetchPromptText(args: Record<string, unknown>): Promise<string> {
  const store = new InMemoryLedgerStore();
  await store.init();
  const tools = createLedgerMcpTools(store, undefined, undefined, catalog);
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

describe("fetch_prompt schema projection over the real catalog (D269/T1993)", () => {
  it("schema projection for plan-reviewer returns exactly the four contract keys", async () => {
    const text = await fetchPromptText({ roleId: "plan-reviewer", projection: "schema" });
    const parsed = JSON.parse(text) as Record<string, unknown>;

    expect(Object.keys(parsed).sort()).toEqual([
      "inputSchema",
      "outputSchema",
      "roleId",
      "version",
    ]);
    expect(parsed["roleId"]).toBe("plan-reviewer");
    expect(typeof parsed["version"]).toBe("number");
    expect(text).not.toContain("promptTemplate");
  });

  it("pins the D269 token-size saving: schema projection ≈ 1,182 serialized characters", async () => {
    const schemaText = await fetchPromptText({ roleId: "plan-reviewer", projection: "schema" });
    const fullText = await fetchPromptText({ roleId: "plan-reviewer" });

    expect(schemaText.length).toBeGreaterThanOrEqual(SCHEMA_SIZE_MIN);
    expect(schemaText.length).toBeLessThanOrEqual(SCHEMA_SIZE_MAX);
    // The saving must remain decisive: D269 measured 82.9% (6,913 -> 1,182);
    // the full entry can never approach the schema band while promptTemplate
    // stays out of the schema projection.
    expect(schemaText.length * 2).toBeLessThan(fullText.length);
  });

  it("keeps the default projection byte-identical to the pre-change full response", async () => {
    const defaultText = await fetchPromptText({ roleId: "plan-reviewer" });
    const explicitFullText = await fetchPromptText({
      roleId: "plan-reviewer",
      projection: "full",
    });

    expect(defaultText).toBe(explicitFullText);
    expect(defaultText).toBe(JSON.stringify(catalog.fetchPrompt("plan-reviewer")));
  });

  it("returns { roleId } alone for an orchestrator-command role under the schema projection", async () => {
    const text = await fetchPromptText({ roleId: "advance", projection: "schema" });

    expect(JSON.parse(text)).toEqual({ roleId: "advance" });
  });
});
