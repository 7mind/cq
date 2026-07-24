import { AGENT_ROLE_TIERS } from "./agentRoster.js";
import { PROMPT_CATALOG_PROJECTION } from "./promptCatalog.gen.js";
import {
  PROMPT_SURFACES,
  PromptCatalogSchemaError,
  parseIntentionalDifferenceDeclaration,
  type IntentionalDifferenceDeclaration,
  type PromptSurface,
  type RoleKind,
} from "./promptCatalog.js";

/** The adapter-fragment vocabulary generated from the canonical Nix catalog. */
export type PromptFragmentSlot =
  (typeof PROMPT_CATALOG_PROJECTION.fragmentContracts)[number]["fragment"];
export const PROMPT_FRAGMENT_SLOTS: readonly PromptFragmentSlot[] =
  PROMPT_CATALOG_PROJECTION.fragmentContracts.map((contract) => contract.fragment);

export const PROMPT_BLOCK_CLASSIFICATIONS = ["shared-prose", "surface-fragment"] as const;
export type PromptBlockClassification = (typeof PROMPT_BLOCK_CLASSIFICATIONS)[number];

export const PROMPT_DISPATCH_EDGE_KINDS = ["dispatch", "recursion"] as const;
export type PromptDispatchEdgeKind = (typeof PROMPT_DISPATCH_EDGE_KINDS)[number];

export interface PromptDispatchEdge {
  readonly kind: PromptDispatchEdgeKind;
  readonly targetRoleId: string;
}

export interface SharedPromptSourceBlock {
  readonly sourceBlock: string;
  readonly classification: "shared-prose";
  readonly targetFragment: null;
}

export interface FragmentPromptSourceBlock {
  readonly sourceBlock: string;
  readonly classification: "surface-fragment";
  readonly targetFragment: PromptFragmentSlot;
}

export type PromptSourceBlock = SharedPromptSourceBlock | FragmentPromptSourceBlock;

export interface PromptRoleSourceInventoryEntry {
  readonly roleId: string;
  readonly roleKind: RoleKind;
  readonly source: string;
  readonly blocks: readonly PromptSourceBlock[];
  readonly dispatchEdges: readonly PromptDispatchEdge[];
}

export interface PromptFragmentSlotContract {
  readonly fragment: PromptFragmentSlot;
  readonly supportedSurfaces: readonly PromptSurface[];
  readonly forbiddenVocabulary: Readonly<Record<PromptSurface, readonly string[]>>;
  readonly intentionalDifference: IntentionalDifferenceDeclaration;
}

/** A fragment-bearing block joined to its single typed slot contract. */
export interface ResolvedPromptFragmentInventoryEntry {
  readonly source: string;
  readonly roleId: string;
  readonly roleKind: RoleKind;
  readonly sourceBlock: string;
  readonly targetFragment: PromptFragmentSlot;
  readonly supportedSurfaces: readonly PromptSurface[];
  readonly forbiddenVocabulary: Readonly<Record<PromptSurface, readonly string[]>>;
  readonly dispatchEdges: readonly PromptDispatchEdge[];
  readonly intentionalDifference: IntentionalDifferenceDeclaration;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFragmentSlot(value: unknown, path: string): PromptFragmentSlot {
  if (
    typeof value !== "string" ||
    !(PROMPT_FRAGMENT_SLOTS as readonly string[]).includes(value)
  ) {
    throw new PromptCatalogSchemaError(
      path,
      `expected one of ${PROMPT_FRAGMENT_SLOTS.join(", ")}`,
    );
  }
  return value as PromptFragmentSlot;
}

function parseContract(value: unknown, index: number): PromptFragmentSlotContract {
  const path = `fragmentContracts[${index}]`;
  if (!isRecord(value)) {
    throw new PromptCatalogSchemaError(path, "expected an object");
  }
  const fragment = parseFragmentSlot(value.fragment, `${path}.fragment`);
  const surfaces = value.supportedSurfaces;
  if (
    !Array.isArray(surfaces) ||
    surfaces.length !== PROMPT_SURFACES.length ||
    PROMPT_SURFACES.some((surface) => !surfaces.includes(surface))
  ) {
    throw new PromptCatalogSchemaError(
      `${path}.supportedSurfaces`,
      "expected each prompt surface exactly once",
    );
  }
  const vocabulary = value.forbiddenVocabulary;
  if (
    !isRecord(vocabulary) ||
    PROMPT_SURFACES.some(
      (surface) =>
        !Array.isArray(vocabulary[surface]) ||
        vocabulary[surface].some(
          (token: unknown) => typeof token !== "string" || token.length === 0,
        ),
    )
  ) {
    throw new PromptCatalogSchemaError(
      `${path}.forbiddenVocabulary`,
      "expected one non-empty-token array per prompt surface",
    );
  }
  return {
    fragment,
    supportedSurfaces: surfaces as unknown as readonly PromptSurface[],
    forbiddenVocabulary: vocabulary as unknown as Readonly<
      Record<PromptSurface, readonly string[]>
    >,
    intentionalDifference: parseIntentionalDifferenceDeclaration(value.intentionalDifference),
  };
}

function parseRoleSource(value: unknown, index: number): PromptRoleSourceInventoryEntry {
  const path = `roleSources[${index}]`;
  if (!isRecord(value)) {
    throw new PromptCatalogSchemaError(path, "expected an object");
  }
  if (typeof value.roleId !== "string" || typeof value.source !== "string") {
    throw new PromptCatalogSchemaError(path, "expected roleId and source strings");
  }
  if (value.roleKind !== "dispatched-subagent" && value.roleKind !== "orchestrator-command") {
    throw new PromptCatalogSchemaError(`${path}.roleKind`, "unknown role kind");
  }
  if (!Array.isArray(value.blocks)) {
    throw new PromptCatalogSchemaError(`${path}.blocks`, "expected an array");
  }
  const blocks = value.blocks.map((block, blockIndex): PromptSourceBlock => {
    const blockPath = `${path}.blocks[${blockIndex}]`;
    if (
      !isRecord(block) ||
      typeof block.sourceBlock !== "string" ||
      (block.classification !== "shared-prose" &&
        block.classification !== "surface-fragment")
    ) {
      throw new PromptCatalogSchemaError(`${blockPath}.classification`, "unclassified source block");
    }
    if (block.classification === "shared-prose") {
      if (block.targetFragment !== null) {
        throw new PromptCatalogSchemaError(
          `${blockPath}.targetFragment`,
          "shared prose must not target a fragment",
        );
      }
      return {
        sourceBlock: block.sourceBlock,
        classification: "shared-prose",
        targetFragment: null,
      };
    }
    return {
      sourceBlock: block.sourceBlock,
      classification: "surface-fragment",
      targetFragment: parseFragmentSlot(block.targetFragment, `${blockPath}.targetFragment`),
    };
  });
  if (!Array.isArray(value.dispatchEdges)) {
    throw new PromptCatalogSchemaError(`${path}.dispatchEdges`, "expected an array");
  }
  const dispatchEdges = value.dispatchEdges.map((edge, edgeIndex): PromptDispatchEdge => {
    const edgePath = `${path}.dispatchEdges[${edgeIndex}]`;
    if (
      !isRecord(edge) ||
      (edge.kind !== "dispatch" && edge.kind !== "recursion") ||
      typeof edge.targetRoleId !== "string"
    ) {
      throw new PromptCatalogSchemaError(edgePath, "expected a typed dispatch edge");
    }
    return { kind: edge.kind, targetRoleId: edge.targetRoleId };
  });
  return {
    roleId: value.roleId,
    roleKind: value.roleKind,
    source: value.source,
    blocks,
    dispatchEdges,
  };
}

/** Typed compile-time mirror of the fragment contracts authored in assets.nix. */
export const PROMPT_FRAGMENT_SLOT_CONTRACTS: readonly PromptFragmentSlotContract[] =
  PROMPT_CATALOG_PROJECTION.fragmentContracts.map(parseContract);

/**
 * Compatibility view of the canonical Nix role catalog in T660's public
 * source-inventory shape. No role, source, fragment, or relation is authored
 * here; the checked-in generated projection supplies every value.
 */
export const PROMPT_ROLE_SOURCE_INVENTORY: readonly PromptRoleSourceInventoryEntry[] =
  PROMPT_CATALOG_PROJECTION.catalog.map((role) => ({
    roleId: role.roleId,
    roleKind: role.roleKind,
    source: role.canonicalSource,
    blocks: [
      role.sharedSourceBlock,
      ...role.fragmentBindings.map(
        (binding): FragmentPromptSourceBlock => ({
          sourceBlock: binding.sourceBlock,
          classification: "surface-fragment",
          targetFragment: binding.fragment,
        }),
      ),
    ],
    dispatchEdges: role.dispatchRelations,
  }));

/**
 * Prove role/slot closure, then join each classified fragment block to its
 * exactly-one declaration. Shared prose remains canonical and unrendered here.
 */
export function validatePromptFragmentInventory(
  fragmentContractValues: readonly unknown[],
  roleSourceValues: readonly unknown[],
): readonly ResolvedPromptFragmentInventoryEntry[] {
  const contracts = fragmentContractValues.map(parseContract);
  const bySlot = new Map<PromptFragmentSlot, PromptFragmentSlotContract>();
  for (const [index, contract] of contracts.entries()) {
    if (bySlot.has(contract.fragment)) {
      throw new PromptCatalogSchemaError(
        `fragmentContracts[${index}].fragment`,
        `duplicate fragment declaration "${contract.fragment}"`,
      );
    }
    bySlot.set(contract.fragment, contract);
  }
  for (const slot of PROMPT_FRAGMENT_SLOTS) {
    if (!bySlot.has(slot)) {
      throw new PromptCatalogSchemaError(
        "fragmentContracts",
        `missing fragment declaration "${slot}"`,
      );
    }
  }

  const roleSources = roleSourceValues.map(parseRoleSource);
  const knownRoles = new Map(AGENT_ROLE_TIERS.map((role) => [role.id, role]));
  const seenRoles = new Set<string>();
  for (const [index, entry] of roleSources.entries()) {
    const role = knownRoles.get(entry.roleId);
    if (role === undefined) {
      throw new PromptCatalogSchemaError(
        `roleSources[${index}].roleId`,
        `unknown role "${entry.roleId}"`,
      );
    }
    if (seenRoles.has(entry.roleId)) {
      throw new PromptCatalogSchemaError(
        `roleSources[${index}].roleId`,
        `duplicate role "${entry.roleId}"`,
      );
    }
    seenRoles.add(entry.roleId);
    const expectedKind =
      role.agentTierKey === null ? "orchestrator-command" : "dispatched-subagent";
    if (entry.roleKind !== expectedKind) {
      throw new PromptCatalogSchemaError(
        `roleSources[${index}].roleKind`,
        `expected ${expectedKind} for "${entry.roleId}"`,
      );
    }
  }
  const missingRole = AGENT_ROLE_TIERS.find((role) => !seenRoles.has(role.id));
  if (missingRole !== undefined) {
    throw new PromptCatalogSchemaError("roleSources", `missing role "${missingRole.id}"`);
  }

  const consumed = new Set<PromptFragmentSlot>();
  const resolved: ResolvedPromptFragmentInventoryEntry[] = [];
  for (const entry of roleSources) {
    const seenBlocks = new Set<string>();
    for (const block of entry.blocks) {
      if (seenBlocks.has(block.sourceBlock)) {
        throw new PromptCatalogSchemaError(
          `roleSources.${entry.roleId}.blocks`,
          `duplicate source block "${block.sourceBlock}"`,
        );
      }
      seenBlocks.add(block.sourceBlock);
      if (block.classification === "shared-prose") {
        continue;
      }
      const contract = bySlot.get(block.targetFragment);
      if (contract === undefined) {
        throw new PromptCatalogSchemaError(
          `roleSources.${entry.roleId}.${block.sourceBlock}`,
          `unknown fragment "${block.targetFragment}"`,
        );
      }
      consumed.add(block.targetFragment);
      resolved.push({
        source: entry.source,
        roleId: entry.roleId,
        roleKind: entry.roleKind,
        sourceBlock: block.sourceBlock,
        targetFragment: block.targetFragment,
        supportedSurfaces: contract.supportedSurfaces,
        forbiddenVocabulary: contract.forbiddenVocabulary,
        dispatchEdges: entry.dispatchEdges,
        intentionalDifference: contract.intentionalDifference,
      });
    }
  }
  const unconsumed = PROMPT_FRAGMENT_SLOTS.find((slot) => !consumed.has(slot));
  if (unconsumed !== undefined) {
    throw new PromptCatalogSchemaError(
      "fragmentContracts",
      `unconsumed fragment declaration "${unconsumed}"`,
    );
  }
  for (const entry of roleSources) {
    for (const edge of entry.dispatchEdges) {
      if (!knownRoles.has(edge.targetRoleId)) {
        throw new PromptCatalogSchemaError(
          `roleSources.${entry.roleId}.dispatchEdges`,
          `unknown dispatch target "${edge.targetRoleId}"`,
        );
      }
    }
  }
  return resolved;
}

export const PROMPT_FRAGMENT_INVENTORY = validatePromptFragmentInventory(
  PROMPT_FRAGMENT_SLOT_CONTRACTS,
  PROMPT_ROLE_SOURCE_INVENTORY,
);
