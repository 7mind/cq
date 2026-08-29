import type { RoleKind } from "./promptCatalog.js";
import { PROMPT_CATALOG_PROJECTION } from "./promptCatalog.gen.js";

/**
 * The ledger MCP tool vocabulary observed at T1325's dispatch boundary.
 *
 * `@cq/config` cannot import `@cq/ledger` because the dependency runs in the
 * other direction. `roleToolProfiles.test.ts` therefore guards this inventory
 * against the prompt catalogue and the maintained 54-tool domain/control surface. T1327 owns
 * moving tool specifications behind one canonical filtered registry.
 */
export const LEDGER_CAPABILITY_TOOL_NAMES = [
  "enumerate_ledgers",
  "fetch_ledger",
  "fetch_ledger_archive",
  "fetch_item",
  "update_item",
  "create_item",
  "create_ledger",
  "search_items",
  "fts_search",
  "archive_milestone",
  "list_milestone_items",
  "snapshot",
  "workset",
  "derive_predicates",
  "materialize_operator_action",
  "acknowledge_operator_action",
  "record_operator_action_evidence",
  "revise_operator_action",
  "complete_operator_action",
  "reopen_item",
  "unarchive_item",
  "read_log",
  "get_config",
  "get_usage_stats",
  "prepare_dispatch",
  "fetch_dispatch_input",
  "store_result",
  "confirm_dispatch_completion",
  "abort_dispatch",
  "fetch_dispatch_result",
  "fetch_prompt",
  "list_projects",
  "claim_plan",
  "publish_plan_draft",
  "release_plan_claim",
  "finalize_plan",
  "worktree_manage",
  "git_commit",
  "git_resolve_continue",
  "prepare_implementation_review_panel",
  "prepare_implementation_review_attempt",
  "execute_external_implementation_review_attempt",
  "finalize_implementation_review_attempt",
  "prepare_implementation_review_fallback",
  "prepare_implementation_audit_panel",
  "prepare_implementation_audit_attempt",
  "execute_external_implementation_audit_attempt",
  "finalize_implementation_audit_attempt",
  "prepare_implementation_audit_fallback",
  "advance_implementation_evidence_bootstrap",
  "arm_implementation_evidence_activation",
  "apply_implementation_audit_manifest",
  "get_implementation_evidence_activation_status",
  "get_implementation_evidence_service_status",
  "prepare_implementation_completion",
  "record_implementation_completion",
] as const;

export type LedgerCapabilityToolName = (typeof LEDGER_CAPABILITY_TOOL_NAMES)[number];

export const DISPATCH_RESULT_PLUMBING_TOOL_NAMES = [
  "fetch_dispatch_input",
  "store_result",
] as const satisfies readonly LedgerCapabilityToolName[];

const NON_DOMAIN_LEDGER_TOOL_NAMES = new Set<LedgerCapabilityToolName>([
  "read_log",
  "get_config",
  "get_usage_stats",
  "prepare_dispatch",
  "fetch_dispatch_input",
  "store_result",
  "confirm_dispatch_completion",
  "abort_dispatch",
  "fetch_dispatch_result",
  "fetch_prompt",
  "list_projects",
  "git_commit",
  "git_resolve_continue",
]);

/** Tools that read or mutate ledger domain state, excluding config/catalog/transport plumbing. */
export const DOMAIN_LEDGER_TOOL_NAMES = LEDGER_CAPABILITY_TOOL_NAMES.filter(
  (tool) => !NON_DOMAIN_LEDGER_TOOL_NAMES.has(tool),
);

export const ROLE_CAPABILITY_CLASSES = [
  "full-parent-access",
  "planning-reads",
  "config-read",
  "dispatch-result-plumbing",
  "no-domain-ledger",
  "git-change-broker",
  "git-conflict-broker",
] as const;

export type RoleCapabilityClass = (typeof ROLE_CAPABILITY_CLASSES)[number];

const PLANNING_READ_TOOL_NAMES = [
  "fetch_item",
  "fts_search",
  "list_milestone_items",
] as const satisfies readonly LedgerCapabilityToolName[];

export const ROLE_CAPABILITY_TOOLS: Readonly<
  Record<RoleCapabilityClass, readonly LedgerCapabilityToolName[]>
> = Object.freeze({
  "full-parent-access": LEDGER_CAPABILITY_TOOL_NAMES,
  "planning-reads": PLANNING_READ_TOOL_NAMES,
  "config-read": ["get_config"],
  "dispatch-result-plumbing": DISPATCH_RESULT_PLUMBING_TOOL_NAMES,
  "no-domain-ledger": [],
  "git-change-broker": ["git_commit"],
  "git-conflict-broker": ["git_resolve_continue"],
});

export interface RoleToolCapabilityProfile {
  readonly roleId: string;
  readonly roleKind: RoleKind;
  readonly capabilities: readonly RoleCapabilityClass[];
  /** Calls required by the current prompt/dispatch contract but not always spelled as tool names. */
  readonly contractRequiredTools: readonly LedgerCapabilityToolName[];
  /** True when the profile exposes no tool that reads or mutates ledger domain state. */
  readonly zeroDomainCalls: boolean;
  readonly evidence: readonly string[];
}

const FULL_PARENT_EVIDENCE = [
  "prompt-catalogue canonical command body",
  "packages/ledger/test/cq-parent-dispatch-inventory.test.ts",
] as const;
const DISPATCH_CHILD_EVIDENCE = [
  "prompt-catalogue dispatched role body and schema sidecar",
  "packages/cq-config/test/claudeDispatchBridge.test.ts",
  "packages/cq-config/test/packagedPiPromptRoot.test.ts",
] as const;

function role(
  roleId: string,
  roleKind: RoleKind,
  capabilities: readonly RoleCapabilityClass[],
  contractRequiredTools: readonly LedgerCapabilityToolName[],
  evidence: readonly string[],
): RoleToolCapabilityProfile {
  const exposed = new Set(capabilities.flatMap((capability) => ROLE_CAPABILITY_TOOLS[capability]));
  const zeroDomainCalls = DOMAIN_LEDGER_TOOL_NAMES.every((tool) => !exposed.has(tool));
  return Object.freeze({
    roleId,
    roleKind,
    capabilities: Object.freeze([...capabilities]),
    contractRequiredTools: Object.freeze([...contractRequiredTools]),
    zeroDomainCalls,
    evidence,
  });
}

function profileForCatalogRole({
  roleId,
  roleKind,
}: {
  readonly roleId: string;
  readonly roleKind: RoleKind;
}): RoleToolCapabilityProfile {
  if (roleId === "plan-advance") {
    return role(
      roleId,
      roleKind,
      ["planning-reads", "dispatch-result-plumbing"],
      ["fetch_item", "list_milestone_items", "fetch_dispatch_input", "store_result"],
      DISPATCH_CHILD_EVIDENCE,
    );
  }
  if (roleId === "plan-reviewer") {
    return role(
      roleId,
      roleKind,
      ["planning-reads", "dispatch-result-plumbing"],
      ["fetch_item", "fetch_dispatch_input", "store_result"],
      DISPATCH_CHILD_EVIDENCE,
    );
  }
  if (roleId === "implement-worker") {
    return role(
      roleId,
      roleKind,
      ["no-domain-ledger", "dispatch-result-plumbing", "git-change-broker"],
      ["fetch_dispatch_input", "git_commit", "store_result"],
      DISPATCH_CHILD_EVIDENCE,
    );
  }
  if (roleId === "implement-conflict-resolver") {
    return role(
      roleId,
      roleKind,
      ["no-domain-ledger", "dispatch-result-plumbing", "git-conflict-broker"],
      ["fetch_dispatch_input", "git_resolve_continue", "store_result"],
      DISPATCH_CHILD_EVIDENCE,
    );
  }
  if (roleKind === "dispatched-subagent") {
    return role(
      roleId,
      roleKind,
      ["no-domain-ledger", "dispatch-result-plumbing"],
      ["fetch_dispatch_input", "store_result"],
      DISPATCH_CHILD_EVIDENCE,
    );
  }
  if (roleId === "plan-review" || roleId === "implement-review") {
    return role(
      roleId,
      roleKind,
      ["no-domain-ledger"],
      [],
      [`commands/cq/${roleId}.md: write nothing`],
    );
  }
  if (roleId === "planners" || roleId === "reviewers") {
    return role(
      roleId,
      roleKind,
      ["config-read"],
      ["get_config"],
      [`commands/cq/${roleId}.md and Claude allowed-tools frontmatter`],
    );
  }
  return role(roleId, roleKind, ["full-parent-access"], [], FULL_PARENT_EVIDENCE);
}

const entries = PROMPT_CATALOG_PROJECTION.catalog.map(profileForCatalogRole);

/** One total, fail-closed role-to-capability matrix for the 26-role prompt catalogue. */
export const ROLE_TOOL_CAPABILITY_MATRIX: Readonly<Record<string, RoleToolCapabilityProfile>> =
  Object.freeze(Object.fromEntries(entries.map((entry) => [entry.roleId, entry])));

export function exposedLedgerToolsForRole(roleId: string): readonly LedgerCapabilityToolName[] {
  // Object.hasOwn: bare index admits Object.prototype names (D169 / T684 class).
  if (!Object.hasOwn(ROLE_TOOL_CAPABILITY_MATRIX, roleId)) {
    throw new Error(`unknown role tool profile "${roleId}"`);
  }
  const profile = ROLE_TOOL_CAPABILITY_MATRIX[roleId]!;
  const exposed = new Set<LedgerCapabilityToolName>();
  for (const capability of profile.capabilities) {
    for (const tool of ROLE_CAPABILITY_TOOLS[capability]) exposed.add(tool);
  }
  return Object.freeze(LEDGER_CAPABILITY_TOOL_NAMES.filter((tool) => exposed.has(tool)));
}

export type LedgerToolProfileDecision = "exposed" | "excluded";

/** Resolve one role/tool cell of the total matrix, rejecting either unknown axis. */
export function ledgerToolDecisionForRole(
  roleId: string,
  toolName: string,
): LedgerToolProfileDecision {
  const exposed = exposedLedgerToolsForRole(roleId);
  if (!(LEDGER_CAPABILITY_TOOL_NAMES as readonly string[]).includes(toolName)) {
    throw new Error(`unknown ledger capability tool "${toolName}"`);
  }
  return exposed.includes(toolName as LedgerCapabilityToolName) ? "exposed" : "excluded";
}

/** The complement sent to deny-list based child launchers such as Pi. */
export function excludedLedgerToolsForRole(roleId: string): readonly LedgerCapabilityToolName[] {
  return Object.freeze(
    LEDGER_CAPABILITY_TOOL_NAMES.filter(
      (tool) => ledgerToolDecisionForRole(roleId, tool) === "excluded",
    ),
  );
}

export const PI_ROLE_TOOL_PROFILE_MANIFEST_PATH = "role-tool-profiles.json";

export interface PiRoleToolDecision {
  /** Role-specific ledger tools, excluding dispatch input/result transport. */
  readonly roleTools: readonly LedgerCapabilityToolName[];
  /** Process-boundary transport tools reported separately from domain access. */
  readonly transportTools: readonly LedgerCapabilityToolName[];
  /** The complete complement removed before Pi constructs the child prompt. */
  readonly excludedTools: readonly LedgerCapabilityToolName[];
}

export interface PiRoleToolProfileManifest {
  readonly schemaVersion: 1;
  readonly ledgerToolNames: readonly LedgerCapabilityToolName[];
  readonly roles: Readonly<Record<string, PiRoleToolDecision>>;
}

/** Build the Pi process-boundary manifest from the authoritative role matrix. */
export function buildPiRoleToolProfileManifest(): PiRoleToolProfileManifest {
  const transportTools = new Set<LedgerCapabilityToolName>(DISPATCH_RESULT_PLUMBING_TOOL_NAMES);
  const roleEntries = Object.values(ROLE_TOOL_CAPABILITY_MATRIX)
    .filter(({ roleKind }) => roleKind === "dispatched-subagent")
    .map(({ roleId }) => {
      const exposed = exposedLedgerToolsForRole(roleId);
      const decision: PiRoleToolDecision = Object.freeze({
        roleTools: Object.freeze(exposed.filter((tool) => !transportTools.has(tool))),
        transportTools: Object.freeze(exposed.filter((tool) => transportTools.has(tool))),
        excludedTools: excludedLedgerToolsForRole(roleId),
      });
      return [roleId, decision] as const;
    });
  return Object.freeze({
    schemaVersion: 1 as const,
    ledgerToolNames: LEDGER_CAPABILITY_TOOL_NAMES,
    roles: Object.freeze(Object.fromEntries(roleEntries)),
  });
}

export function serializePiRoleToolProfileManifest(): string {
  return JSON.stringify(buildPiRoleToolProfileManifest());
}

export interface RoleCorpusObservation {
  readonly transcripts: number;
  readonly zeroLedgerTranscripts: number;
  readonly currentLedgerCalls: Readonly<Partial<Record<LedgerCapabilityToolName, number>>>;
  readonly retiredCalls: Readonly<Record<string, number>>;
  /**
   * Historical calls denied by the current prompt contract. The corpus predates
   * the read-only planner and ledger-free worker cuts, so these observations
   * remain evidence, not ambient authority.
   */
  readonly supersededCalls: readonly string[];
}

function corpusRole(
  observation: Omit<RoleCorpusObservation, "supersededCalls">,
  supersededCalls: readonly string[],
): RoleCorpusObservation {
  return Object.freeze({
    ...observation,
    currentLedgerCalls: Object.freeze({ ...observation.currentLedgerCalls }),
    retiredCalls: Object.freeze({ ...observation.retiredCalls }),
    supersededCalls: Object.freeze([...supersededCalls]),
  });
}

/**
 * T679's pinned 357-transcript corpus, re-aggregated by the raw record's single
 * `attributionAgent` and native `mcp__ledger__*` tool-use blocks. All 357
 * carried exactly one role identity.
 */
export const ROLE_IDENTIFIED_CORPUS = Object.freeze({
  manifest: "docs/drafts/20260725-2130-t679-rs3-remeasure/corpus-manifest.json",
  transcripts: 357,
  unclassifiedTranscripts: 0,
  roles: Object.freeze({
    "plan-advance": corpusRole(
      {
        transcripts: 51,
        zeroLedgerTranscripts: 3,
        currentLedgerCalls: {
          fetch_item: 100,
          list_milestone_items: 19,
          create_item: 71,
          derive_predicates: 1,
          update_item: 26,
          get_config: 1,
          fts_search: 4,
        },
        retiredCalls: { get_agent_models: 1 },
      },
      ["create_item", "derive_predicates", "update_item", "get_config"],
    ),
    "plan-reviewer": corpusRole(
      {
        transcripts: 42,
        zeroLedgerTranscripts: 0,
        currentLedgerCalls: {
          fetch_item: 117,
          list_milestone_items: 130,
          derive_predicates: 1,
          fts_search: 3,
          fetch_prompt: 1,
        },
        retiredCalls: { get_reviewers: 21 },
      },
      ["derive_predicates", "fetch_prompt"],
    ),
    "implement-worker": corpusRole(
      {
        transcripts: 97,
        zeroLedgerTranscripts: 66,
        currentLedgerCalls: {
          derive_predicates: 1,
          fetch_item: 50,
          fts_search: 3,
          get_config: 1,
          enumerate_ledgers: 1,
          create_item: 3,
          fetch_ledger: 4,
          fetch_ledger_archive: 2,
          list_milestone_items: 4,
        },
        retiredCalls: {},
      },
      [
        "derive_predicates",
        "fetch_item",
        "fts_search",
        "get_config",
        "enumerate_ledgers",
        "create_item",
        "fetch_ledger",
        "fetch_ledger_archive",
        "list_milestone_items",
      ],
    ),
    "implement-reviewer": corpusRole(
      {
        transcripts: 142,
        zeroLedgerTranscripts: 68,
        currentLedgerCalls: {
          fetch_item: 121,
          fts_search: 6,
          get_config: 2,
          fetch_ledger: 2,
          list_milestone_items: 2,
        },
        retiredCalls: { get_reviewers: 1 },
      },
      ["fetch_item", "fts_search", "get_config", "fetch_ledger", "list_milestone_items"],
    ),
    "implementation-auditor": corpusRole(
      {
        transcripts: 0,
        zeroLedgerTranscripts: 0,
        currentLedgerCalls: {},
        retiredCalls: {},
      },
      [],
    ),
    "investigate-explorer": corpusRole(
      {
        transcripts: 23,
        zeroLedgerTranscripts: 20,
        currentLedgerCalls: { fts_search: 5, fetch_item: 4, get_config: 1 },
        retiredCalls: { get_agent_models: 1 },
      },
      ["fts_search", "fetch_item", "get_config"],
    ),
    "investigate-prober": corpusRole(
      {
        transcripts: 2,
        zeroLedgerTranscripts: 2,
        currentLedgerCalls: {},
        retiredCalls: {},
      },
      [],
    ),
  }),
});

export const HARNESS_ROLE_TOOL_ENFORCEMENT = Object.freeze({
  claude: Object.freeze({
    measuredVersion: "2.1.220",
    childBoundary: "process",
    filteringStage: "before-model-context",
    mechanism: "strict-per-dispatch-mcp",
    evidence:
      "claudeDispatchBridge.test.ts records --tools '', role-derived --allowedTools, --strict-mcp-config, and the role-profiled one-server --mcp-config at the spawned child boundary",
  }),
  pi: Object.freeze({
    measuredVersion: "0.82.1",
    childBoundary: "process",
    filteringStage: "before-model-context",
    mechanism: "--exclude-tools",
    evidence:
      "packagedPiPromptRoot.test.ts captures the spawned child's initialize/tool list after applying the generated authoritative profile complement through --exclude-tools",
  }),
  codex: Object.freeze({
    measuredVersion: "0.146.0",
    childBoundary: "repository-owned-process",
    filteringStage: "before-model-context",
    mechanism: "mcp-server-enabled-tools",
    nativePerAgentFiltering: false,
    evidence:
      "the executable probe captures the real Codex Responses request after MCP discovery and " +
      "asserts the denied definition never reaches its tools array, native role instructions do " +
      "reach model context, and child dispatch tools stay absent",
  }),
});

export const CODEX_ROLE_TOOL_PROFILE_PROBE = Object.freeze({
  script: "packages/cq-config/scripts/probe-codex-role-tool-profile.ts",
  allowTool: "fetch_item",
  denyTool: "create_item",
});
