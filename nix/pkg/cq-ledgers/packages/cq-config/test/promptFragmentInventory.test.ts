import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  AGENT_ROLE_TIERS,
  PROMPT_FRAGMENT_INVENTORY,
  PROMPT_FRAGMENT_SLOT_CONTRACTS,
  PROMPT_FRAGMENT_SLOTS,
  PROMPT_ROLE_SOURCE_INVENTORY,
  PromptCatalogSchemaError,
  validatePromptFragmentInventory,
} from "@cq/config";

const ASSETS_ROOT = path.resolve(import.meta.dir, "../../../../cq-assets");

function cloneContracts(): unknown[] {
  return structuredClone(PROMPT_FRAGMENT_SLOT_CONTRACTS) as unknown[];
}

function cloneSources(): unknown[] {
  return structuredClone(PROMPT_ROLE_SOURCE_INVENTORY) as unknown[];
}

describe("prompt fragment inventory closure", () => {
  test("covers the complete ordered role roster and keeps cq:begin explicit", () => {
    expect(PROMPT_ROLE_SOURCE_INVENTORY.map((entry) => entry.roleId)).toEqual(
      AGENT_ROLE_TIERS.map((entry) => entry.id),
    );
    const begin = PROMPT_ROLE_SOURCE_INVENTORY.find((entry) => entry.roleId === "begin");
    expect(begin).toBeDefined();
    expect(begin!.source).toBe("commands/cq/begin.md");
    expect(
      begin!.blocks
        .filter((block) => block.classification === "surface-fragment")
        .map((block) => block.targetFragment),
    ).toEqual([
      "cq-command-invocation",
      "host-tool-vocabulary",
      "inline-command-recursion",
    ]);
    expect(begin!.dispatchEdges).toContainEqual({
      kind: "recursion",
      targetRoleId: "advance",
    });
  });

  test("every source exists and current surface-sensitive markers are classified", () => {
    for (const entry of PROMPT_ROLE_SOURCE_INVENTORY) {
      const source = readFileSync(path.join(ASSETS_ROOT, entry.source), "utf8");
      const slots = entry.blocks
        .filter((block) => block.classification === "surface-fragment")
        .map((block) => block.targetFragment);

      if (entry.roleKind === "orchestrator-command") {
        for (const slot of slots) {
          expect(source.match(new RegExp(`\\{\\{cq:fragment:${slot}\\}\\}`, "g"))).toHaveLength(
            1,
          );
        }
        expect(source).not.toContain("CQ_HARNESS");
        if (slots.includes("cq-command-invocation")) {
          expect(source).toContain("CQ::");
        }
        if (slots.includes("subagent-dispatch")) {
          expect(source).toContain("{{cq:fragment:subagent-dispatch}}");
        }
        if (slots.includes("inline-command-recursion")) {
          expect(source).toContain("{{cq:fragment:inline-command-recursion}}");
          expect(source).toMatch(/\b(?:INLINE|inline)\b/);
          expect(entry.dispatchEdges.some((edge) => edge.kind === "recursion")).toBe(true);
        }
      } else {
        for (const slot of slots) {
          expect(source.match(new RegExp(`\\{\\{cq:fragment:${slot}\\}\\}`, "g"))).toHaveLength(
            1,
          );
        }
        expect(source).not.toMatch(/^(?:allowed-tools|disallowedTools|isolation):/m);
        expect(source).not.toMatch(/\b(?:Claude|Codex|Pi)\b|\/cq:|\$cq-/);
        if (slots.includes("cq-command-invocation")) {
          expect(source).toContain("CQ::");
        }
      }
      for (const edge of entry.dispatchEdges) {
        expect(AGENT_ROLE_TIERS.some((role) => role.id === edge.targetRoleId)).toBe(true);
      }
    }

    const harnessBranchSources = PROMPT_ROLE_SOURCE_INVENTORY.filter((entry) =>
      readFileSync(path.join(ASSETS_ROOT, entry.source), "utf8").includes("CQ_HARNESS"),
    ).map((entry) => entry.roleId);
    expect(harnessBranchSources).toEqual([]);
  });

  test("joins each classified block to one complete typed slot contract", () => {
    expect(PROMPT_FRAGMENT_SLOT_CONTRACTS.map((contract) => contract.fragment)).toEqual(
      [...PROMPT_FRAGMENT_SLOTS],
    );
    expect(new Set(PROMPT_FRAGMENT_INVENTORY.map((entry) => entry.targetFragment))).toEqual(
      new Set(PROMPT_FRAGMENT_SLOTS),
    );
    for (const entry of PROMPT_FRAGMENT_INVENTORY) {
      expect(entry.supportedSurfaces).toEqual(["claude", "codex", "pi"]);
      expect(Object.keys(entry.forbiddenVocabulary)).toEqual(["claude", "codex", "pi"]);
      expect(entry.intentionalDifference.reason.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("prompt fragment inventory schema and closure failures", () => {
  test("rejects a duplicate fragment declaration", () => {
    const contracts = cloneContracts();
    contracts.push(structuredClone(PROMPT_FRAGMENT_SLOT_CONTRACTS[0]));
    expect(() => validatePromptFragmentInventory(contracts, cloneSources())).toThrow(
      'duplicate fragment declaration "cq-command-invocation"',
    );
  });

  test("rejects an unknown fragment declaration", () => {
    const contracts = cloneContracts() as Array<Record<string, unknown>>;
    contracts[0]!.fragment = "terminal-command";
    expect(() => validatePromptFragmentInventory(contracts, cloneSources())).toThrow(
      "expected one of cq-command-invocation, subagent-dispatch, implement-dispatch-workflow, inline-command-recursion, host-tool-vocabulary, operational-tool-vocabulary",
    );
  });

  test("rejects an unclassified source block", () => {
    const sources = cloneSources() as Array<Record<string, unknown>>;
    const first = sources[0]!;
    const blocks = first.blocks as Array<Record<string, unknown>>;
    blocks[0]!.classification = "conditional";
    expect(() => validatePromptFragmentInventory(cloneContracts(), sources)).toThrow(
      "unclassified source block",
    );
  });

  test("rejects an unconsumed fragment declaration", () => {
    const sources = cloneSources() as Array<Record<string, unknown>>;
    for (const source of sources) {
      source.blocks = (source.blocks as Array<Record<string, unknown>>).filter(
        (block) => block.targetFragment !== "inline-command-recursion",
      );
    }
    expect(() => validatePromptFragmentInventory(cloneContracts(), sources)).toThrow(
      'unconsumed fragment declaration "inline-command-recursion"',
    );
  });

  test("uses the catalog boundary error type", () => {
    expect(() => validatePromptFragmentInventory([], cloneSources())).toThrow(
      PromptCatalogSchemaError,
    );
  });
});
