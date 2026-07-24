import { AGENT_ROLE_TIERS } from "./agentRoster.js";
import {
  PROMPT_SURFACES,
  PromptCatalogSchemaError,
  parseIntentionalDifferenceDeclaration,
  type IntentionalDifferenceDeclaration,
  type PromptSurface,
  type RoleKind,
} from "./promptCatalog.js";

/** The only adapter-fragment slots accepted by the prompt-source contract. */
export const PROMPT_FRAGMENT_SLOTS = [
  "cq-command-invocation",
  "subagent-dispatch",
  "inline-command-recursion",
  "host-tool-vocabulary",
] as const;
export type PromptFragmentSlot = (typeof PROMPT_FRAGMENT_SLOTS)[number];

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

const ALL_SURFACES: readonly PromptSurface[] = PROMPT_SURFACES;

/** One semantic contract per reusable slot; role sources bind these by name. */
export const PROMPT_FRAGMENT_SLOT_CONTRACTS: readonly PromptFragmentSlotContract[] = [
  {
    fragment: "cq-command-invocation",
    supportedSurfaces: ALL_SURFACES,
    forbiddenVocabulary: { claude: ["$cq-"], codex: ["/cq:"], pi: ["$cq-"] },
    intentionalDifference: {
      kind: "invocation-syntax",
      reason:
        "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
      surfaces: ALL_SURFACES,
    },
  },
  {
    fragment: "subagent-dispatch",
    supportedSurfaces: ALL_SURFACES,
    forbiddenVocabulary: {
      claude: ["dispatch_agent("],
      codex: ["Agent(", "dispatch_agent("],
      pi: ["Agent("],
    },
    intentionalDifference: {
      kind: "dispatch-protocol",
      reason:
        "Each host exposes a distinct subagent-dispatch transport and argument vocabulary.",
      surfaces: ALL_SURFACES,
    },
  },
  {
    fragment: "inline-command-recursion",
    supportedSurfaces: ALL_SURFACES,
    forbiddenVocabulary: {
      claude: ["fetch_prompt(", "$cq-"],
      codex: ["/cq:", "fetch_prompt("],
      pi: ["$cq-"],
    },
    intentionalDifference: {
      kind: "recursion-protocol",
      reason:
        "Claude chains native commands, Codex follows skill references, and Pi loads nested prompts through fetch_prompt.",
      surfaces: ALL_SURFACES,
    },
  },
  {
    fragment: "host-tool-vocabulary",
    supportedSurfaces: ALL_SURFACES,
    forbiddenVocabulary: {
      claude: ["dispatch_agent(", "$cq-"],
      codex: ["allowed-tools:", "disallowedTools:", "mcp__ledger__", "Agent"],
      pi: ["Agent", "$cq-"],
    },
    intentionalDifference: {
      kind: "tool-vocabulary",
      reason:
        "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
      surfaces: ALL_SURFACES,
    },
  },
];

const SHARED_BLOCK: SharedPromptSourceBlock = {
  sourceBlock: "all prose outside the classified surface-sensitive blocks",
  classification: "shared-prose",
  targetFragment: null,
};

const SOURCE_BLOCK_BY_FRAGMENT: Readonly<Record<PromptFragmentSlot, string>> = {
  "cq-command-invocation": "frontmatter and body CQ command references",
  "subagent-dispatch": "subagent dispatch instructions and host transport branch",
  "inline-command-recursion": "inline chained-command execution instructions",
  "host-tool-vocabulary": "frontmatter host tool and isolation capabilities",
};

function source(
  roleId: string,
  sourcePath: string,
  fragments: readonly PromptFragmentSlot[],
  dispatchEdges: readonly PromptDispatchEdge[],
): PromptRoleSourceInventoryEntry {
  const rosterRole = AGENT_ROLE_TIERS.find((role) => role.id === roleId);
  if (rosterRole === undefined) {
    throw new PromptCatalogSchemaError("promptRoleSource.roleId", `unknown role "${roleId}"`);
  }
  return {
    roleId,
    roleKind:
      rosterRole.agentTierKey === null ? "orchestrator-command" : "dispatched-subagent",
    source: sourcePath,
    blocks: [
      SHARED_BLOCK,
      ...fragments.map(
        (fragment): FragmentPromptSourceBlock => ({
          sourceBlock: SOURCE_BLOCK_BY_FRAGMENT[fragment],
          classification: "surface-fragment",
          targetFragment: fragment,
        }),
      ),
    ],
    dispatchEdges,
  };
}

const dispatch = (targetRoleId: string): PromptDispatchEdge => ({
  kind: "dispatch",
  targetRoleId,
});
const recursion = (targetRoleId: string): PromptDispatchEdge => ({
  kind: "recursion",
  targetRoleId,
});

const I: PromptFragmentSlot = "cq-command-invocation";
const D: PromptFragmentSlot = "subagent-dispatch";
const R: PromptFragmentSlot = "inline-command-recursion";
const T: PromptFragmentSlot = "host-tool-vocabulary";

/**
 * Authoritative ordered inventory: nine dispatched roles, then fifteen
 * orchestrator commands. `begin` remains explicit and binds invocation,
 * recursion, and tool-vocabulary fragments.
 */
export const PROMPT_ROLE_SOURCE_INVENTORY: readonly PromptRoleSourceInventoryEntry[] = [
  source("plan-advance", "agents/plan-advance.md", [I, T], []),
  source("plan-reviewer", "agents/plan-reviewer.md", [I, T], []),
  source("implement-worker", "agents/implement-worker.md", [I, T], []),
  source("implement-reviewer", "agents/implement-reviewer.md", [I, T], []),
  source("implement-conflict-resolver", "agents/implement-conflict-resolver.md", [I, T], []),
  source("investigate-explorer", "agents/investigate-explorer.md", [I, T], []),
  source("investigate-prober", "agents/investigate-prober.md", [I, T], []),
  source("research-explorer", "agents/research-explorer.md", [I, T], []),
  source("research-experimenter", "agents/research-experimenter.md", [T], []),
  source("begin", "commands/cq/begin.md", [I, T, R], [
    recursion("plan"),
    recursion("plan/follow-up"),
    recursion("investigate"),
    recursion("research"),
    recursion("advance"),
  ]),
  source("advance", "commands/cq/advance.md", [I, T, R], [
    recursion("investigate/advance"),
    recursion("plan/advance"),
    recursion("research/advance"),
    recursion("implement/advance"),
  ]),
  source("plan", "commands/cq/plan.md", [I, T, D, R], [
    dispatch("plan-advance"),
    recursion("investigate/advance"),
  ]),
  source("plan/advance", "commands/cq/plan/advance.md", [I, T, D, R], [
    dispatch("plan-advance"),
    dispatch("plan-reviewer"),
    recursion("investigate/advance"),
  ]),
  source("plan/follow-up", "commands/cq/plan/follow-up.md", [I, T, D, R], [
    dispatch("plan-advance"),
    recursion("investigate/advance"),
  ]),
  source("investigate", "commands/cq/investigate.md", [I, T, R], [
    recursion("investigate/advance"),
  ]),
  source("investigate/advance", "commands/cq/investigate/advance.md", [I, T, D], [
    dispatch("investigate-explorer"),
    dispatch("investigate-prober"),
  ]),
  source("research", "commands/cq/research.md", [I, T, R], [
    recursion("research/advance"),
  ]),
  source("research/advance", "commands/cq/research/advance.md", [I, T, D], [
    dispatch("research-explorer"),
    dispatch("research-experimenter"),
  ]),
  source("implement/start", "commands/cq/implement/start.md", [I, T, R], [
    recursion("implement/advance"),
  ]),
  source("implement/advance", "commands/cq/implement/advance.md", [I, T, D], [
    dispatch("implement-worker"),
    dispatch("implement-reviewer"),
    dispatch("implement-conflict-resolver"),
  ]),
  source("plan-review", "commands/cq/plan-review.md", [T], []),
  source("implement-review", "commands/cq/implement-review.md", [I], []),
  source("planners", "commands/cq/planners.md", [I, T], []),
  source("reviewers", "commands/cq/reviewers.md", [I, T], []),
];

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
