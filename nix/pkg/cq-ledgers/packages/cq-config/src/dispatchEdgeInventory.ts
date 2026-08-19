/**
 * T721 / G94: the checked ref-first dispatch-edge inventory.
 *
 * Edges come from the generated catalog's `dispatchRelations`. Lifecycle
 * ownership is derived from role kind + surface, not re-authored per edge.
 * fetch_prompt / validate_output / store_result sites are classified from
 * canonical sources so an unclassified occurrence fails the suite.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PROMPT_CATALOG_PROJECTION } from "./promptCatalog.gen.js";
import { PROMPT_SURFACES, type PromptSurface } from "./promptCatalog.js";

export const DISPATCH_FLOW_FAMILIES = [
  "plan-review",
  "investigate-research",
  "implement",
  "sequencer",
] as const;
export type DispatchFlowFamily = (typeof DISPATCH_FLOW_FAMILIES)[number];

export const DISPATCH_EDGE_KINDS = ["dispatch", "recursion"] as const;
export type InventoryDispatchEdgeKind = (typeof DISPATCH_EDGE_KINDS)[number];

export const PROMPT_SITE_KINDS = [
  "fetch_prompt",
  "validate_output",
  "validate_input",
  "store_result",
] as const;
export type PromptSiteKind = (typeof PROMPT_SITE_KINDS)[number];

export const PROMPT_SITE_CLASSES = [
  "recursion-load",
  "inspection",
  "capability-scoped-store",
] as const;
export type PromptSiteClass = (typeof PROMPT_SITE_CLASSES)[number];

export class RefFirstInventoryError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`${path}: ${detail}`);
    this.name = "RefFirstInventoryError";
  }
}

export interface CatalogDispatchRelation {
  readonly kind: InventoryDispatchEdgeKind;
  readonly targetRoleId: string;
}

export interface CatalogInventoryRole {
  readonly roleId: string;
  readonly roleKind: "dispatched-subagent" | "orchestrator-command";
  readonly canonicalSource: string;
  readonly dispatchRelations: readonly CatalogDispatchRelation[];
  readonly sidecar: { readonly schemaRoleId: string } | null;
}

export interface SurfaceLifecycle {
  readonly surface: PromptSurface;
  readonly prepare: "parent-prepare_dispatch";
  readonly submit:
    | "claude-native-compact-launch"
    | "pi-dispatch_agent"
    | "codex-role-boundary";
  readonly intercept: "trusted-parent-bridge" | "pi-extension" | "codex-parent-gate";
  readonly resultCapabilityOwner: "child";
  readonly nativeCompletionConfirmer: "parent";
  readonly aborter: "parent";
  readonly fetcher: "parent-fetch_dispatch_result";
  readonly handleVisibility: "handle-only";
}

export interface DispatchEdgeRecord {
  readonly id: string;
  readonly kind: "dispatch";
  readonly flowFamily: Exclude<DispatchFlowFamily, "sequencer">;
  readonly sourceRoleId: string;
  readonly roleId: string;
  readonly sourceKind: "orchestrator-command";
  readonly targetKind: "dispatched-subagent";
  readonly inputSidecar: string;
  readonly outputSidecar: string;
  readonly generatedArtifacts: readonly string[];
  readonly lifecycle: readonly SurfaceLifecycle[];
}

export interface RecursionEdgeRecord {
  readonly id: string;
  readonly kind: "recursion";
  readonly flowFamily: DispatchFlowFamily;
  readonly sourceRoleId: string;
  readonly roleId: string;
  readonly sourceKind: "orchestrator-command";
  readonly targetKind: "orchestrator-command";
  readonly inputSidecar: null;
  readonly outputSidecar: null;
  readonly mechanism: "inline-command-recursion";
  readonly piInline: true;
}

export type InventoryEdge = DispatchEdgeRecord | RecursionEdgeRecord;

export interface ClassifiedPromptSite {
  readonly kind: PromptSiteKind;
  readonly classification: PromptSiteClass;
  readonly source: string;
  readonly surface: PromptSurface | "canonical";
}

export interface DispatchEdgeInventory {
  readonly edges: readonly InventoryEdge[];
  readonly sites: readonly ClassifiedPromptSite[];
}

const ASSETS_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../cq-assets");

const SITE_PATTERNS: Readonly<Record<PromptSiteKind, RegExp>> = {
  fetch_prompt: /fetch_prompt|mcp__ledger__fetch_prompt/,
  validate_output: /validate_output/,
  validate_input: /validate_input/,
  store_result: /store_result/,
};

function fail(pathName: string, detail: string): never {
  throw new RefFirstInventoryError(pathName, detail);
}

function edgeId(
  sourceRoleId: string,
  kind: InventoryDispatchEdgeKind,
  targetRoleId: string,
): string {
  return `${sourceRoleId}::${kind}::${targetRoleId}`;
}

function flowFamilyOf(sourceRoleId: string, targetRoleId: string): DispatchFlowFamily {
  const token = `${sourceRoleId} ${targetRoleId}`;
  if (/\bimplement\b/.test(token)) return "implement";
  if (/\b(?:investigate|research)\b/.test(token)) return "investigate-research";
  if (/\bplan\b/.test(token)) return "plan-review";
  return "sequencer";
}

function surfaceLifecycle(surface: PromptSurface): SurfaceLifecycle {
  if (surface === "claude") {
    return {
      surface,
      prepare: "parent-prepare_dispatch",
      submit: "claude-native-compact-launch",
      intercept: "trusted-parent-bridge",
      resultCapabilityOwner: "child",
      nativeCompletionConfirmer: "parent",
      aborter: "parent",
      fetcher: "parent-fetch_dispatch_result",
      handleVisibility: "handle-only",
    };
  }
  if (surface === "pi") {
    return {
      surface,
      prepare: "parent-prepare_dispatch",
      submit: "pi-dispatch_agent",
      intercept: "pi-extension",
      resultCapabilityOwner: "child",
      nativeCompletionConfirmer: "parent",
      aborter: "parent",
      fetcher: "parent-fetch_dispatch_result",
      handleVisibility: "handle-only",
    };
  }
  return {
    surface,
    prepare: "parent-prepare_dispatch",
    submit: "codex-role-boundary",
    intercept: "codex-parent-gate",
    resultCapabilityOwner: "child",
    nativeCompletionConfirmer: "parent",
    aborter: "parent",
    fetcher: "parent-fetch_dispatch_result",
    handleVisibility: "handle-only",
  };
}

function classifyFetchPromptSite(source: string): PromptSiteClass {
  if (source.includes("inline-command-recursion")) return "recursion-load";
  if (source.includes("operational-tool-vocabulary")) return "inspection";
  return fail(`sites.${source}`, "unclassified fetch_prompt");
}

function classifyStoreResultSite(source: string, text: string): PromptSiteClass {
  if (/resultCapability/.test(text) || /capability-scoped/.test(text) || /dispatch-scoped/.test(text)) {
    return "capability-scoped-store";
  }
  return fail(`sites.${source}`, "unscoped store_result");
}

function scanSource(source: string, text: string, surface: PromptSurface | "canonical"): ClassifiedPromptSite[] {
  const sites: ClassifiedPromptSite[] = [];
  for (const kind of PROMPT_SITE_KINDS) {
    if (!SITE_PATTERNS[kind].test(text)) continue;
    if (kind === "validate_output" || kind === "validate_input") {
      fail(`sites.${source}`, `ordinary workflow ${kind}`);
    }
    if (kind === "fetch_prompt") {
      sites.push({
        kind,
        classification: classifyFetchPromptSite(source),
        source,
        surface,
      });
      continue;
    }
    sites.push({
      kind,
      classification: classifyStoreResultSite(source, text),
      source,
      surface,
    });
  }
  return sites;
}

function collectSources(catalog: readonly CatalogInventoryRole[]): readonly {
  readonly source: string;
  readonly surface: PromptSurface | "canonical";
}[] {
  const seen = new Set<string>();
  const out: { source: string; surface: PromptSurface | "canonical" }[] = [];
  const add = (source: string, surface: PromptSurface | "canonical"): void => {
    const key = `${surface}:${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ source, surface });
  };
  for (const role of catalog) {
    add(role.canonicalSource, "canonical");
  }
  for (const surface of PROMPT_SURFACES) {
    add(`fragments/${surface}/operational-tool-vocabulary.md`, surface);
    add(`fragments/${surface}/inline-command-recursion.md`, surface);
    add(`fragments/${surface}/dispatch-result-delivery.md`, surface);
    add(`fragments/${surface}/subagent-dispatch.md`, surface);
    add(`fragments/${surface}/implement-dispatch-workflow.md`, surface);
  }
  return out;
}

export function buildDispatchEdgeInventory(
  catalog: readonly CatalogInventoryRole[] = PROMPT_CATALOG_PROJECTION.catalog,
): DispatchEdgeInventory {
  const byId = new Map(catalog.map((role) => [role.roleId, role]));
  const edges: InventoryEdge[] = [];
  const seen = new Set<string>();

  for (const role of catalog) {
    for (const relation of role.dispatchRelations) {
      const id = edgeId(role.roleId, relation.kind, relation.targetRoleId);
      if (seen.has(id)) fail(`edges.${id}`, "duplicate edge");
      seen.add(id);
      const target = byId.get(relation.targetRoleId);
      if (target === undefined) {
        fail(`edges.${id}`, `unknown target "${relation.targetRoleId}"`);
      }
      if (role.roleKind !== "orchestrator-command") {
        fail(`edges.${id}`, `source "${role.roleId}" is ${role.roleKind}, expected orchestrator-command`);
      }
      if (relation.kind === "dispatch") {
        if (target.roleKind !== "dispatched-subagent") {
          fail(`edges.${id}`, `dispatch target "${target.roleId}" is ${target.roleKind}`);
        }
        if (target.sidecar === null || target.sidecar.schemaRoleId !== target.roleId) {
          fail(`edges.${id}`, `sidecar mismatch for "${target.roleId}"`);
        }
        const family = flowFamilyOf(role.roleId, target.roleId);
        if (family === "sequencer") {
          fail(`edges.${id}`, "dispatch edge has no flow family");
        }
        edges.push({
          id,
          kind: "dispatch",
          flowFamily: family,
          sourceRoleId: role.roleId,
          roleId: target.roleId,
          sourceKind: "orchestrator-command",
          targetKind: "dispatched-subagent",
          inputSidecar: `schemas/${target.roleId}.ts#inputSchema`,
          outputSidecar: `schemas/${target.roleId}.ts#outputSchema`,
          generatedArtifacts: [
            target.canonicalSource,
            ...PROMPT_SURFACES.map((surface) => `packaged/${surface}/roles/${target.roleId}.md`),
          ],
          lifecycle: PROMPT_SURFACES.map(surfaceLifecycle),
        });
        continue;
      }
      if (target.roleKind !== "orchestrator-command") {
        fail(`edges.${id}`, `recursion target "${target.roleId}" is ${target.roleKind}`);
      }
      if (target.sidecar !== null) {
        fail(`edges.${id}`, `recursion target "${target.roleId}" must not carry a sidecar`);
      }
      edges.push({
        id,
        kind: "recursion",
        flowFamily: flowFamilyOf(role.roleId, target.roleId),
        sourceRoleId: role.roleId,
        roleId: target.roleId,
        sourceKind: "orchestrator-command",
        targetKind: "orchestrator-command",
        inputSidecar: null,
        outputSidecar: null,
        mechanism: "inline-command-recursion",
        piInline: true,
      });
    }
  }

  const sites = collectSources(catalog).flatMap(({ source, surface }) => {
    const absolute = path.join(ASSETS_ROOT, source);
    let text: string;
    try {
      text = readFileSync(absolute, "utf8");
    } catch {
      return [];
    }
    return scanSource(source, text, surface);
  });

  return { edges, sites };
}

export const DISPATCH_EDGE_INVENTORY = buildDispatchEdgeInventory();

export function planReviewDispatchEdges(
  inventory: DispatchEdgeInventory = DISPATCH_EDGE_INVENTORY,
): readonly DispatchEdgeRecord[] {
  return inventory.edges.filter(
    (edge): edge is DispatchEdgeRecord =>
      edge.kind === "dispatch" && edge.flowFamily === "plan-review",
  );
}

export function investigateResearchDispatchEdges(
  inventory: DispatchEdgeInventory = DISPATCH_EDGE_INVENTORY,
): readonly DispatchEdgeRecord[] {
  return inventory.edges.filter(
    (edge): edge is DispatchEdgeRecord =>
      edge.kind === "dispatch" && edge.flowFamily === "investigate-research",
  );
}

export function implementDispatchEdges(
  inventory: DispatchEdgeInventory = DISPATCH_EDGE_INVENTORY,
): readonly DispatchEdgeRecord[] {
  return inventory.edges.filter(
    (edge): edge is DispatchEdgeRecord =>
      edge.kind === "dispatch" && edge.flowFamily === "implement",
  );
}

export function recursionEdges(
  inventory: DispatchEdgeInventory = DISPATCH_EDGE_INVENTORY,
): readonly RecursionEdgeRecord[] {
  return inventory.edges.filter((edge): edge is RecursionEdgeRecord => edge.kind === "recursion");
}

export function inspectionSites(
  inventory: DispatchEdgeInventory = DISPATCH_EDGE_INVENTORY,
): readonly ClassifiedPromptSite[] {
  return inventory.sites.filter((site) => site.classification === "inspection");
}
