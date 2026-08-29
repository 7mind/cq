import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { exposedLedgerToolsForRole } from "@cq/config";
import {
  createLedgerMcpTools,
  createInMemoryImplementationEvidenceStore,
  createLedgerSdkMcpServer,
  createManagementLedgerMcpTools,
  GOALS_LEDGER,
  InMemoryLedgerStore,
  ImplementationEvidenceService,
  implementationAuditManifestDigest,
  MANAGEMENT_LEDGER_TOOL_NAMES,
  ledgerToolInputJsonSchema,
  MILESTONES_AMBIENT_ID,
  registerLedgerStdioManagementTools,
  registerLedgerStdioTools,
  type ConfigCapability,
  type DispatchCapability,
  type LedgerStore,
  type LedgerToolProfileName,
  type LedgerToolSpecification,
  type LedgerToolName,
  type ListProjectsCapability,
  type PromptCatalogCapability,
  type ReadLogCapability,
  type WorktreeManageCapability,
  type ImplementationReviewerIdentity,
  type ImplementationAuditPanelRecord,
  type PackagedImplementationAuditManifest,
} from "../src/index.js";
import { POST_TARGET_ADDITIONS } from "./toolSurfaceTarget.js";

const FIXED_NOW = "2026-07-24T12:00:00.000Z";
const PREFIXES = ["", "mirror"] as const;

const READ_LOG_RESULT = {
  path: "raw/session.jsonl",
  content: '{"type":"result","result":"full transcript"}\n',
  truncated: false,
};
const CONFIG_RESULT = {
  configured: true,
  aliases: {
    frontier: {
      harness: "codex",
      model: "gpt-5.6",
      provider: null,
      effort: "high",
    },
  },
  reviewers: ["frontier"],
  planners: ["frontier"],
  tiers: {
    frontier: {
      harness: "codex",
      model: "gpt-5.6",
      provider: null,
      effort: "high",
    },
  },
  agentTiers: { "plan-reviewer": "frontier" },
  agentEfforts: { "plan-reviewer": "high" },
  dispatch: {
    forceShellout: false,
    unsafeDisableCodexReadOnlySandbox: false,
  },
  upstream: {
    filing: "enabled",
    recheck: "enabled",
  },
} as const;
const PROMPT_RESULT = {
  roleId: "plan-reviewer",
  kind: "dispatched-subagent" as const,
  dispatched: true,
  promptTemplate: "Full prompt catalog content.",
  version: 1,
  inputSchema: { type: "object", required: ["goalId"] },
  outputSchema: { type: "object", required: ["verdict"] },
};
// A caller-generated owner fence token (base64url, >=22 chars) and the plan
// identities the in-memory lifecycle allocates deterministically for G1's
// first claim. Hardcoding them keeps the matrix static; the publish/release
// assertions below fail loudly if the allocation ever stops matching.
const PARITY_OWNER_FENCE_TOKEN = "parity_owner_fence_token_0";
const PARITY_GOAL_ID = "G1";
const PARITY_CLAIM_ID = `claim_${PARITY_GOAL_ID}_1`;
const PARITY_GENERATION = 1;
const PARITY_PROVENANCE = {
  author: "parity-owner",
  session: "parity-owner-session",
} as const;
const PARITY_IMPLEMENTATION_TASK_REF = "tasks:T9001";
const PARITY_IMPLEMENTATION_BASE = "a".repeat(40);
const PARITY_IMPLEMENTATION_RESULT = "b".repeat(40);
const PARITY_AUDIT_HEAD = PARITY_IMPLEMENTATION_BASE;
const PARITY_AUDIT_MANIFEST_ID = "stdio-parity-audit-v1";
const PARITY_AUDIT_FINALIZED_MANIFEST_DIGEST = "e".repeat(64);
const PARITY_IMPLEMENTATION_WORKER = {
  attestationId: "att_parity_worker",
  generation: 1,
} as const;

const PARITY_ADAPTER_REVIEWER: ImplementationReviewerIdentity = {
  alias: "parity-adapter",
  harness: "pi",
  model: "frontier",
  provider: null,
  launch: "adapter",
  adapterId: "pi:parity-adapter",
};
const PARITY_NATIVE_FALLBACK: ImplementationReviewerIdentity = {
  alias: "parity-native",
  harness: "codex",
  model: "frontier",
  provider: null,
  launch: "native",
  adapterId: "codex:parity-native",
};

const PROJECTS_RESULT = {
  projects: [
    {
      key: "parity-project",
      displayName: "Parity project",
      createdAt: FIXED_NOW,
    },
  ],
};

const readLog: ReadLogCapability = async (path) => {
  expect(path).toBe(READ_LOG_RESULT.path);
  return READ_LOG_RESULT;
};

const configCapability: ConfigCapability = {
  computeReviewers: () => ({
    configured: true,
    source: "cq.toml",
    reviewers: [
      {
        harness: "codex",
        model: "gpt-5.6",
        provider: null,
        alias: "frontier",
        effort: "high",
      },
    ],
  }),
  computePlanners: () => ({
    configured: true,
    source: "cq.toml",
    planners: [
      {
        harness: "codex",
        model: "gpt-5.6",
        provider: null,
        alias: "frontier",
        effort: "high",
      },
    ],
  }),
  computeConfig: () => CONFIG_RESULT,
  computeAgentModels: () => ({
    configured: true,
    agents: [
      {
        id: "plan-reviewer",
        status: "resolved",
        modelClass: "frontier",
        modelMappings: { claude: [], pi: ["openai-codex/gpt-5.6"] },
      },
    ],
  }),
};

const promptCatalog: PromptCatalogCapability = {
  fetchPrompt: (roleId) => {
    expect(roleId).toBe(PROMPT_RESULT.roleId);
    return PROMPT_RESULT;
  },
  validateInput: (roleId, input) => {
    expect(roleId).toBe(PROMPT_RESULT.roleId);
    expect(input).toEqual({ goalId: "G1" });
    return { ok: true };
  },
  validateOutput: (roleId, output) => {
    expect(roleId).toBe(PROMPT_RESULT.roleId);
    expect(output).toEqual({});
    return {
      ok: false,
      errors: [
        {
          path: "/verdict",
          message: "must have required property 'verdict'",
          keyword: "required",
          schemaPath: "#/required",
          params: { missingProperty: "verdict" },
        },
      ],
    };
  },
};

const listProjects: ListProjectsCapability = () => PROJECTS_RESULT;

const dispatchCapability: DispatchCapability = {
  prepare: async () => ({ operation: "prepare_dispatch" }) as never,
  fetchInput: async () => ({ operation: "fetch_dispatch_input" }) as never,
  storeResult: async () => ({ operation: "store_result" }) as never,
  confirmCompletion: async () => ({ operation: "confirm_dispatch_completion" }) as never,
  abort: async () => ({ operation: "abort_dispatch" }) as never,
  fetch: async () => ({ operation: "fetch_dispatch_result" }) as never,
  gitCommit: async () => ({ operation: "git_commit" }) as never,
  gitResolveContinue: async () => ({ operation: "git_resolve_continue" }) as never,
};

const WORKTREE_MANAGE_PARITY_ACK = {
  status: "refused",
  reason: "task-id-invalid",
  detail: "parity-stub",
} as const;

const worktreeManageCapability: WorktreeManageCapability = {
  repositoryRoot: "/tmp/parity-worktree-root",
  prepare: async () => WORKTREE_MANAGE_PARITY_ACK,
  release: async () => ({
    status: "refused",
    reason: "handle-invalid",
    detail: "parity-stub",
  }),
};

type DirectTools = ReturnType<typeof createLedgerMcpTools>;

interface ToolCapabilities {
  readLog: ReadLogCapability | undefined;
  config: ConfigCapability | undefined;
  promptCatalog: PromptCatalogCapability | undefined;
  listProjects: ListProjectsCapability | undefined;
  dispatch: DispatchCapability | undefined;
  worktreeManage: WorktreeManageCapability | undefined;
}

const AVAILABLE_CAPABILITIES: ToolCapabilities = {
  readLog,
  config: configCapability,
  promptCatalog,
  listProjects,
  dispatch: dispatchCapability,
  worktreeManage: worktreeManageCapability,
};

const UNAVAILABLE_CAPABILITIES: ToolCapabilities = {
  readLog: undefined,
  config: undefined,
  promptCatalog: undefined,
  listProjects: undefined,
  dispatch: undefined,
  worktreeManage: undefined,
};

interface TextToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

type ToolOutcome =
  | { kind: "success"; payload: unknown }
  | {
      kind: "error";
      error: { category: "validation"; issues: unknown } | { category: "handler"; message: string };
    };

interface ComparableToolDefinition {
  name: string;
  description: string;
  schema: unknown;
}

interface Fixture {
  store: InMemoryLedgerStore;
  implementationEvidence: ImplementationEvidenceService;
  implementationEvidenceRefs: {
    panelRef: string;
    attemptRef: string;
    fallbackAttemptRef: string;
    auditManifestDigest: string;
    auditPanelRef: string;
    auditAttemptRef: string;
    auditFallbackPanelRef: string;
    auditAttemptRefs: readonly string[];
  };
  ids: {
    activeMilestone: string;
    archivedMilestone: string;
    archivableMilestone: string;
    dependencyItem: string;
    targetItem: string;
    terminalItem: string;
    archivedItem: string;
    operatorActionTask: string;
  };
}

interface StdioConnection {
  client: Client;
  definitions: ComparableToolDefinition[];
  close(): Promise<void>;
}

interface Invocation {
  name: LedgerToolName;
  args: Record<string, unknown>;
}

function parityApprovedVerdict() {
  return {
    taskId: PARITY_IMPLEMENTATION_TASK_REF.slice("tasks:".length),
    verdict: "approve",
    criticism: [],
    questions: [],
    defects: [],
    rationale: "stdio parity",
    gateReRan: true,
    gateDurationMs: 1,
    resultCommitVerified: true,
    resultCommitEvidence: {
      status: "verified",
      resultCommit: PARITY_IMPLEMENTATION_RESULT,
      branchTip: PARITY_IMPLEMENTATION_RESULT,
    },
    baseAncestry: {
      status: "verified",
      relation: "descendant",
      baseCommit: PARITY_IMPLEMENTATION_BASE,
      resultCommit: PARITY_IMPLEMENTATION_RESULT,
      mergeBase: PARITY_IMPLEMENTATION_BASE,
    },
  } as const;
}

function parityAuditRecord(recordKey: string, taskRef: string, resultCommit: string) {
  return {
    recordKey,
    taskRef,
    ownerGoalRef: `goals:${PARITY_GOAL_ID}`,
    finalizedManifest: "stdio parity audit finalized manifest",
    historicalReview: null,
    baseCommit: PARITY_IMPLEMENTATION_BASE,
    resultCommit,
    repositoryHead: PARITY_AUDIT_HEAD,
    diff: `diff for ${taskRef}`,
    acceptance: { clauses: ["stdio parity audit"] },
    gateObservations: { exitCode: 0, passCount: 1, failCount: 0 },
    requiredObservations: ["commit-retained", "gate-green"],
  } as const;
}

const parityAuditInputSchema = z.object({
  baseCommit: z.string().regex(/^[0-9a-f]{40}$/u),
  resultCommit: z.string().regex(/^[0-9a-f]{40}$/u),
  requiredObservations: z.array(z.string().min(1)).min(1),
});

function parityAuditVerdict(panel: ImplementationAuditPanelRecord) {
  const input = parityAuditInputSchema.parse(panel.auditInput);
  return {
    taskId: panel.taskRef.slice("tasks:".length),
    verdict: "approve" as const,
    criticism: [],
    questions: [],
    observations: input.requiredObservations.map((name) => ({
      name,
      status: "verified" as const,
      detail: `${name} checked`,
    })),
    rationale: "stdio parity audit",
    manifestDigest: panel.manifestDigest,
    baseCommit: input.baseCommit,
    resultCommit: input.resultCommit,
    repositoryHead: panel.repositoryHead,
  };
}

async function buildImplementationEvidenceFixture() {
  const auditManifest: PackagedImplementationAuditManifest = {
    version: 1,
    manifestId: PARITY_AUDIT_MANIFEST_ID,
    sourceDigest: "f".repeat(64),
    records: [
      parityAuditRecord("audit-one", "tasks:T9101", "1".repeat(40)),
      parityAuditRecord("audit-two", "tasks:T9102", "2".repeat(40)),
      parityAuditRecord("audit-fallback", "tasks:T9103", "3".repeat(40)),
    ],
    activation: {
      goalRef: `goals:${PARITY_GOAL_ID}`,
      finalizedManifestDigest: PARITY_AUDIT_FINALIZED_MANIFEST_DIGEST,
      evidenceTaskKey: "t-evidence",
      auditTaskKey: "t-historical-evidence",
      activationTaskKey: "t-activate-evidence",
    },
  };
  const nativeAuditPanels = new Map<string, ImplementationAuditPanelRecord>();
  const implementationEvidence = new ImplementationEvidenceService({
    store: createInMemoryImplementationEvidenceStore(),
    resolveReviewerRoster: () => [PARITY_ADAPTER_REVIEWER],
    nativeFallback: PARITY_NATIVE_FALLBACK,
    now: () => FIXED_NOW,
    prepareNativeReview: async ({ attemptRef }) => ({
      attestationId: `att_${attemptRef.slice(-12)}`,
      generation: 1,
      responseStoreNow: FIXED_NOW,
      childCancelAt: "2026-07-24T12:02:00.000Z",
      launchDeadline: "2026-07-24T12:01:00.000Z",
      promptProvenance: {
        roleId: "implement-reviewer",
        version: 7,
        surface: "codex",
        promptDigest: "c".repeat(64),
        catalogHash: "d".repeat(64),
        inputDigest: "e".repeat(64),
      },
      inputCapability: { scope: "fetch-input", token: "parity-input" },
      resultCapability: { scope: "store-result", token: "parity-result" },
    }),
    fetchNativeReview: async (dispatch) => ({
      state: "consumed",
      output: parityApprovedVerdict(),
      retainedAttestation: dispatch.attestationId,
    }),
    executeExternalReview: async () => ({
      adapterIdentity: PARITY_ADAPTER_REVIEWER.adapterId,
      stdout: "",
      stderr: "parity adapter unavailable",
      exitCode: 1,
    }),
    fetchWorker: async (dispatch) => ({
      state:
        dispatch.attestationId === PARITY_IMPLEMENTATION_WORKER.attestationId &&
        dispatch.generation === PARITY_IMPLEMENTATION_WORKER.generation
          ? "consumed"
          : "missing",
      input: {
        taskId: PARITY_IMPLEMENTATION_TASK_REF.slice("tasks:".length),
        baseCommit: PARITY_IMPLEMENTATION_BASE,
      },
      output: {
        taskId: PARITY_IMPLEMENTATION_TASK_REF.slice("tasks:".length),
        status: "pass",
        resultCommit: PARITY_IMPLEMENTATION_RESULT,
        branch: "implement/T9001",
        actualWorktreePath: "/tmp/parity/T9001",
        baseVerification: {
          status: "verified",
          relation: "descendant",
          baseCommit: PARITY_IMPLEMENTATION_BASE,
          headCommit: PARITY_IMPLEMENTATION_RESULT,
        },
        gitReceipts: [
          { oldHead: PARITY_IMPLEMENTATION_BASE, newHead: PARITY_IMPLEMENTATION_RESULT },
        ],
        filesTouched: ["parity.txt"],
        supervisedGateEvidence: { gateExitCode: 0, passCount: 1, failCount: 0 },
      },
    }),
    readTaskAuthority: async (taskRef) => ({
      taskRef,
      ownerGoalRef: `goals:${PARITY_GOAL_ID}`,
      status:
        taskRef === "tasks:T9104"
          ? "planned"
          : taskRef.startsWith("tasks:T910")
            ? "done"
            : "wip",
      finalizedManifest: "stdio parity manifest\n",
    }),
    repositoryHead: async () => PARITY_IMPLEMENTATION_BASE,
    verifyImplementation: async () => ({
      baseCommit: PARITY_IMPLEMENTATION_BASE,
      startingCommit: PARITY_IMPLEMENTATION_BASE,
      clean: true,
      ancestryVerified: true,
      receiptsVerified: true,
      acceptanceVerified: true,
      gateVerified: true,
      details: { parity: true },
    }),
    recordLedgerCompletion: async () => ({ reviewRef: "reviews:R9001" }),
    resolveAuditRoster: () => [PARITY_ADAPTER_REVIEWER],
    readAuditManifest: async (manifestId) => {
      if (manifestId !== auditManifest.manifestId) throw new Error("missing parity audit manifest");
      return structuredClone(auditManifest);
    },
    prepareNativeAudit: async ({ attemptRef, panel }) => {
      const dispatch = {
        attestationId: `att_${attemptRef.slice(-12)}`,
        generation: 1,
        responseStoreNow: FIXED_NOW,
        childCancelAt: "2026-07-24T12:02:00.000Z",
        launchDeadline: "2026-07-24T12:01:00.000Z",
        promptProvenance: {
          roleId: "implementation-auditor" as const,
          version: 1,
          surface: "codex" as const,
          promptDigest: "c".repeat(64),
          catalogHash: "d".repeat(64),
          inputDigest: "e".repeat(64),
        },
        inputCapability: { scope: "fetch-input" as const, token: "parity-audit-input" },
        resultCapability: { scope: "store-result" as const, token: "parity-audit-result" },
      };
      nativeAuditPanels.set(dispatch.attestationId, panel);
      return dispatch;
    },
    fetchNativeAudit: async (dispatch) => {
      const panel = nativeAuditPanels.get(dispatch.attestationId);
      if (panel === undefined) return { state: "missing" as const };
      return {
        state: "consumed" as const,
        input: panel.auditInput,
        output: parityAuditVerdict(panel),
        retainedAttestation: dispatch.attestationId,
      };
    },
    executeExternalAudit: async ({ panel, identity }) => ({
      adapterIdentity: identity.adapterId,
      stdout:
        panel.taskRef === "tasks:T9103" ? "" : JSON.stringify(parityAuditVerdict(panel)),
      stderr: panel.taskRef === "tasks:T9103" ? "parity audit adapter unavailable" : "",
      exitCode: panel.taskRef === "tasks:T9103" ? 1 : 0,
    }),
    startupBuildCommit: PARITY_IMPLEMENTATION_BASE,
    implementationEvidenceProtocolVersion: 2,
    packagedManifestInventory: [PARITY_AUDIT_MANIFEST_ID],
    readBootstrapAuthority: async () => ({
      goalRef: `goals:${PARITY_GOAL_ID}`,
      finalizedManifestDigest: PARITY_AUDIT_FINALIZED_MANIFEST_DIGEST,
      mappings: {
        evidenceTaskRef: "tasks:T9101",
        historicalTaskRef: "tasks:T9102",
        activationTaskRef: "tasks:T9104",
      },
      evidenceTask: {
        taskRef: "tasks:T9101",
        status: "done",
        resultCommit: PARITY_IMPLEMENTATION_BASE,
        ready: false,
      },
      historicalTask: {
        taskRef: "tasks:T9102",
        status: "planned",
        resultCommit: null,
        ready: true,
      },
      activationTask: {
        taskRef: "tasks:T9104",
        status: "planned",
        resultCommit: null,
        ready: false,
        actionKey: "activate-implementation-evidence",
      },
    }),
    resolveActivationCohort: async () => ({
      finalizedManifestDigest: PARITY_AUDIT_FINALIZED_MANIFEST_DIGEST,
      evidenceTaskRef: "tasks:T9101",
      auditTaskRef: "tasks:T9102",
      activationTaskRef: "tasks:T9104",
      boundaryCommit: PARITY_AUDIT_HEAD,
      taskRefs: ["tasks:T9101", "tasks:T9102", "tasks:T9103"],
    }),
    isCommitRetained: async () => true,
  });
  const panel = await implementationEvidence.prepareReviewPanel({
    taskRef: PARITY_IMPLEMENTATION_TASK_REF,
    resultCommit: PARITY_IMPLEMENTATION_RESULT,
    workerDispatch: PARITY_IMPLEMENTATION_WORKER,
    operationId: "parity_evidence_panel",
    ...PARITY_PROVENANCE,
  });
  const attemptRef = panel.attemptRefs[0]!;
  await implementationEvidence.prepareReviewAttempt({
    panelRef: panel.panelRef,
    attemptRef,
    operationId: "parity_evidence_attempt",
    ...PARITY_PROVENANCE,
  });
  await implementationEvidence.executeExternalReviewAttempt({
    attemptRef,
    operationId: "parity_evidence_execute",
    ...PARITY_PROVENANCE,
  });
  await implementationEvidence.finalizeReviewAttempt({
    attemptRef,
    operationId: "parity_evidence_finalize",
    ...PARITY_PROVENANCE,
  });
  const fallback = await implementationEvidence.prepareReviewFallback({
    panelRef: panel.panelRef,
    operationId: "parity_evidence_fallback",
    ...PARITY_PROVENANCE,
  });
  await implementationEvidence.finalizeReviewAttempt({
    attemptRef: fallback.attemptRef,
    operationId: "parity_evidence_finalize_fallback",
    ...PARITY_PROVENANCE,
  });
  const auditManifestDigest = implementationAuditManifestDigest(auditManifest);
  const auditPanels = await Promise.all(
    auditManifest.records.map((record) =>
      implementationEvidence.prepareAuditPanel({
        manifestId: auditManifest.manifestId,
        manifestDigest: auditManifestDigest,
        recordKey: record.recordKey,
        expectedRepositoryHead: PARITY_AUDIT_HEAD,
        operationId: `parity_audit_panel_${record.recordKey}`,
        ...PARITY_PROVENANCE,
      }),
    ),
  );
  const auditAttemptRefs = auditPanels.map((panel) => panel.attemptRefs[0]!);
  for (const [index, panel] of auditPanels.entries()) {
    await implementationEvidence.prepareAuditAttempt({
      panelRef: panel.panelRef,
      attemptRef: auditAttemptRefs[index]!,
      operationId: `parity_audit_prepare_${auditManifest.records[index]!.recordKey}`,
      ...PARITY_PROVENANCE,
    });
  }
  for (const index of [1, 2]) {
    await implementationEvidence.executeExternalAuditAttempt({
      attemptRef: auditAttemptRefs[index]!,
      operationId: `parity_audit_execute_${auditManifest.records[index]!.recordKey}`,
      ...PARITY_PROVENANCE,
    });
    await implementationEvidence.finalizeAuditAttempt({
      attemptRef: auditAttemptRefs[index]!,
      operationId: `parity_audit_finalize_${auditManifest.records[index]!.recordKey}`,
      ...PARITY_PROVENANCE,
    });
  }
  const auditFallback = await implementationEvidence.prepareAuditFallback({
    panelRef: auditPanels[2]!.panelRef,
    operationId: "parity_audit_fallback",
    ...PARITY_PROVENANCE,
  });
  await implementationEvidence.finalizeAuditAttempt({
    attemptRef: auditFallback.attemptRef,
    operationId: "parity_audit_finalize_fallback",
    ...PARITY_PROVENANCE,
  });
  return {
    implementationEvidence,
    implementationEvidenceRefs: {
      panelRef: panel.panelRef,
      attemptRef,
      fallbackAttemptRef: fallback.attemptRef,
      auditManifestDigest,
      auditPanelRef: auditPanels[0]!.panelRef,
      auditAttemptRef: auditAttemptRefs[0]!,
      auditFallbackPanelRef: auditPanels[2]!.panelRef,
      auditAttemptRefs: [
        auditAttemptRefs[0]!,
        auditAttemptRefs[1]!,
        auditAttemptRefs[2]!,
        auditFallback.attemptRef,
      ],
    },
  };
}

async function buildFixture(): Promise<Fixture> {
  const store = new InMemoryLedgerStore({ now: () => FIXED_NOW });
  await store.init();
  const evidence = await buildImplementationEvidenceFixture();

  const activeMilestone = await store.createMilestone({
    title: "Transport parity milestone",
    description: "active milestone full narrative",
  });
  const dependencyItem = await store.createItem("tasks", activeMilestone.id, {
    status: "planned",
    fields: { headline: "Dependency target" },
  });
  const targetItem = await store.createItem("tasks", activeMilestone.id, {
    status: "planned",
    fields: {
      headline: "Transport parity target",
      description: "transport-parity-needle full narrative",
      tags: ["wire"],
      dependsOn: [dependencyItem.id],
    },
    author: "gpt-5.6",
    session: "parity-session",
  });
  const terminalItem = await store.createItem("tasks", activeMilestone.id, {
    status: "done",
    fields: { headline: "Recovery target" },
  });

  const archivedMilestone = await store.createMilestone({
    title: "Pre-archived milestone",
  });
  const archivedItem = await store.createItem("tasks", archivedMilestone.id, {
    status: "done",
    fields: {
      headline: "Archived target",
      description: "archived full narrative",
    },
  });
  await store.updateMilestone(archivedMilestone.id, { status: "done" });
  await store.archiveMilestone(archivedMilestone.id, "pre-seeded archive");

  // A clarifying goal so the four guarded plan-lifecycle tools have a subject.
  await store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: PARITY_GOAL_ID,
    status: "clarifying",
    fields: {
      title: "Transport parity goal",
      description: "goal full narrative",
    },
    ...PARITY_PROVENANCE,
  });
  const operatorActionTask = await store.createItem("tasks", activeMilestone.id, {
    status: "planned",
    fields: {
      headline: "Operator deployment",
      description: "CQ-OPERATOR-ACTION v1 parity-deployment. User deploys; parent measures.",
      ledgerRefs: [`goals:${PARITY_GOAL_ID}`],
    },
  });

  const archivableMilestone = await store.createMilestone({
    title: "Archive through tool",
  });
  await store.createItem("tasks", archivableMilestone.id, {
    status: "done",
    fields: { headline: "Archive-ready target" },
  });
  await store.updateMilestone(archivableMilestone.id, { status: "done" });

  return {
    store,
    ...evidence,
    ids: {
      activeMilestone: activeMilestone.id,
      archivedMilestone: archivedMilestone.id,
      archivableMilestone: archivableMilestone.id,
      dependencyItem: dependencyItem.id,
      targetItem: targetItem.id,
      terminalItem: terminalItem.id,
      archivedItem: archivedItem.id,
      operatorActionTask: operatorActionTask.id,
    },
  };
}

function directTools(
  store: LedgerStore,
  prefix: string,
  capabilities: ToolCapabilities,
  profileName: LedgerToolProfileName = "full",
  implementationEvidence?: ImplementationEvidenceService,
  management = false,
): DirectTools {
  if (management) return createManagementLedgerMcpTools(
    store,
    capabilities.readLog,
    capabilities.config,
    capabilities.promptCatalog,
    prefix,
    capabilities.listProjects,
    capabilities.dispatch,
    profileName,
    capabilities.worktreeManage,
    implementationEvidence,
  );
  return createLedgerMcpTools(
    store,
    capabilities.readLog,
    capabilities.config,
    capabilities.promptCatalog,
    prefix,
    capabilities.listProjects,
    capabilities.dispatch,
    profileName,
    capabilities.worktreeManage,
    undefined,
    implementationEvidence,
  );
}

function prefixed(prefix: string, name: string): string {
  return prefix === "" ? name : `${prefix}_${name}`;
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value === null || typeof value !== "object") return value;

  const normalized = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalizeJson(nested)]),
  );
  if (
    normalized["type"] === "object" &&
    normalized["properties"] !== undefined &&
    normalized["additionalProperties"] === undefined
  ) {
    normalized["additionalProperties"] = false;
  }
  return Object.fromEntries(
    Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function comparableDefinition(
  name: string,
  description: string,
  schema: unknown,
): ComparableToolDefinition {
  return {
    name,
    description,
    schema: normalizeJson(schema),
  };
}

function directDefinitions(tools: DirectTools): ComparableToolDefinition[] {
  return tools
    .map((tool) => {
      const schema = ledgerToolInputJsonSchema(tool as LedgerToolSpecification);
      return comparableDefinition(tool.name, tool.description, schema);
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function refOnlyAllOfWrapperCount(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((count, nested) => count + refOnlyAllOfWrapperCount(nested), 0);
  }
  if (value === null || typeof value !== "object") return 0;
  const object = value as Record<string, unknown>;
  const allOf = object["allOf"];
  const current =
    Object.keys(object).length === 1 &&
    Array.isArray(allOf) &&
    allOf.length === 1 &&
    typeof (allOf[0] as Record<string, unknown> | undefined)?.["$ref"] === "string"
      ? 1
      : 0;
  return (
    current +
    Object.values(object).reduce<number>(
      (count, nested) => count + refOnlyAllOfWrapperCount(nested),
      0,
    )
  );
}

function booleanPropertySchemaPaths(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((nested, index) =>
      booleanPropertySchemaPaths(nested, `${path}[${index}]`),
    );
  }
  if (value === null || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const properties = object["properties"];
  const current =
    properties !== null && typeof properties === "object" && !Array.isArray(properties)
      ? Object.entries(properties as Record<string, unknown>)
          .filter(([, schema]) => typeof schema === "boolean")
          .map(([name]) => `${path}.properties.${name}`)
      : [];
  return [
    ...current,
    ...Object.entries(object).flatMap(([name, nested]) =>
      booleanPropertySchemaPaths(nested, `${path}.${name}`),
    ),
  ];
}

function schemaDescriptionAnnotationCount(value: unknown, propertyMap: boolean = false): number {
  if (Array.isArray(value)) {
    return value.reduce((count, nested) => count + schemaDescriptionAnnotationCount(nested), 0);
  }
  if (value === null || typeof value !== "object") return 0;
  let count = 0;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === "description" && !propertyMap) count += 1;
    count += schemaDescriptionAnnotationCount(
      nested,
      !propertyMap &&
        (key === "properties" ||
          key === "$defs" ||
          key === "definitions" ||
          key === "patternProperties" ||
          key === "dependentSchemas"),
    );
  }
  return count;
}

async function connectStdio(
  store: LedgerStore,
  prefix: string,
  capabilities: ToolCapabilities,
  profileName: LedgerToolProfileName = "full",
  implementationEvidence?: ImplementationEvidenceService,
  management = false,
): Promise<StdioConnection> {
  const server = new McpServer(
    { name: "stdio-parity-test", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  if (management) {
    registerLedgerStdioManagementTools(
      server,
      store,
      capabilities.readLog,
      capabilities.config,
      capabilities.promptCatalog,
      prefix,
      capabilities.listProjects,
      capabilities.dispatch,
      profileName,
      capabilities.worktreeManage,
      implementationEvidence,
    );
  } else {
    registerLedgerStdioTools(
      server,
      store,
      capabilities.readLog,
      capabilities.config,
      capabilities.promptCatalog,
      prefix,
      capabilities.listProjects,
      capabilities.dispatch,
      profileName,
      capabilities.worktreeManage,
      undefined,
      implementationEvidence,
    );
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "stdio-parity-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  const listed = await client.listTools();
  const definitions = listed.tools
    .map((tool) => comparableDefinition(tool.name, tool.description ?? "", tool.inputSchema))
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    client,
    definitions,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function connectAnthropicDirect(
  store: LedgerStore,
  prefix: string,
  capabilities: ToolCapabilities,
  profileName: LedgerToolProfileName = "full",
  implementationEvidence?: ImplementationEvidenceService,
): Promise<StdioConnection> {
  const server = createLedgerSdkMcpServer({
    name: "direct-parity-test",
    store,
    toolPrefix: prefix,
    profileName,
    ...(capabilities.readLog === undefined ? {} : { readLog: capabilities.readLog }),
    ...(capabilities.config === undefined ? {} : { configCapability: capabilities.config }),
    ...(capabilities.promptCatalog === undefined
      ? {}
      : { promptCatalog: capabilities.promptCatalog }),
    ...(capabilities.listProjects === undefined ? {} : { listProjects: capabilities.listProjects }),
    ...(capabilities.dispatch === undefined ? {} : { dispatchCapability: capabilities.dispatch }),
    ...(capabilities.worktreeManage === undefined
      ? {}
      : { worktreeManage: capabilities.worktreeManage }),
    ...(implementationEvidence === undefined ? {} : { implementationEvidence }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client(
    { name: "direct-parity-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  const listed = await client.listTools();
  const definitions = listed.tools
    .map((tool) => comparableDefinition(tool.name, tool.description ?? "", tool.inputSchema))
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    client,
    definitions,
    close: async () => {
      await client.close();
      await server.instance.close();
    },
  };
}

function resultText(result: TextToolResult): string {
  const first = result.content[0];
  if (first === undefined || first.type !== "text" || first.text === undefined) {
    throw new Error("expected one text tool result");
  }
  return first.text;
}

function normalizedValidationError(issues: unknown): ToolOutcome {
  return {
    kind: "error",
    error: {
      category: "validation",
      issues: normalizeJson(issues),
    },
  };
}

function normalizedHandlerError(message: string): ToolOutcome {
  return {
    kind: "error",
    error: { category: "handler", message },
  };
}

function normalizeResult(result: TextToolResult): ToolOutcome {
  const text = resultText(result);
  if (result.isError !== true) {
    return { kind: "success", payload: normalizeJson(JSON.parse(text)) };
  }

  const validationMarker = "Invalid arguments for tool ";
  const markerIndex = text.indexOf(validationMarker);
  if (markerIndex >= 0) {
    const issuesIndex = text.indexOf("[", markerIndex);
    if (issuesIndex < 0) {
      throw new Error(`validation error carried no issue array: ${text}`);
    }
    return normalizedValidationError(JSON.parse(text.slice(issuesIndex)));
  }
  return normalizedHandlerError(text);
}

async function invokeDirect(
  tools: DirectTools,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`direct tool not found: ${name}`);
  const input = z.object(tool.inputSchema as Record<string, z.ZodType>);
  const parsed = input.safeParse(args);
  if (!parsed.success) {
    return normalizedValidationError(parsed.error.issues);
  }
  try {
    const result = await (tool.handler(parsed.data as never, null) as Promise<TextToolResult>);
    return normalizeResult(result);
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    return normalizedHandlerError(error.message);
  }
}

async function invokeStdio(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const result = (await client.callTool({
    name,
    arguments: args,
  })) as TextToolResult;
  return normalizeResult(result);
}

function decode(outcome: ToolOutcome): unknown {
  expect(outcome.kind).toBe("success");
  if (outcome.kind !== "success") {
    throw new Error("expected successful tool outcome");
  }
  return outcome.payload;
}

function invocationMatrix(fixture: Fixture): Invocation[] {
  const { ids } = fixture;
  const {
    panelRef,
    attemptRef,
    fallbackAttemptRef,
    auditManifestDigest,
    auditPanelRef,
    auditAttemptRef,
    auditFallbackPanelRef,
    auditAttemptRefs,
  } = fixture.implementationEvidenceRefs;
  return [
    { name: "enumerate_ledgers", args: {} },
    {
      name: "fetch_ledger",
      args: {
        ledger_id: "tasks",
        projection: "compact",
        offset: 0,
        limit: 1,
      },
    },
    {
      name: "fetch_ledger_archive",
      args: {
        ledger_id: "tasks",
        archive_id: ids.archivedMilestone,
      },
    },
    {
      name: "fetch_item",
      args: {
        ledger_id: "milestones",
        item_id: ids.activeMilestone,
        projection: "compact",
      },
    },
    {
      name: "update_item",
      args: {
        ledger_id: "tasks",
        item_id: ids.targetItem,
        status: "wip",
        fields: {
          dependsOn: [ids.dependencyItem],
          blockedBy: ["external:E1"],
          ledgerRefs: [`tasks:${ids.dependencyItem}`],
        },
        author: "gpt-5.6",
        session: "updated-session",
      },
    },
    {
      name: "create_item",
      args: {
        ledger_id: "milestones",
        status: "open",
        fields: {
          title: "Created through tool",
          description: "created root narrative",
        },
      },
    },
    {
      name: "create_ledger",
      args: {
        name: "widgets",
        schema: {
          statusValues: ["open", "done"],
          terminalStatuses: ["done"],
          idPrefix: "W",
          fields: {
            headline: { type: "string", required: true },
          },
        },
      },
    },
    {
      name: "search_items",
      args: {
        ledger_id: "tasks",
        query: "transport-parity-needle",
        projection: "full",
      },
    },
    {
      name: "fts_search",
      args: {
        query: "transport-parity-needle",
        ledger: "tasks",
        projection: "compact",
        limit: 5,
      },
    },
    {
      name: "archive_milestone",
      args: {
        milestone_id: ids.archivableMilestone,
        summary: "archive through differential suite",
      },
    },
    {
      name: "list_milestone_items",
      args: {
        milestone_id: ids.activeMilestone,
        projection: "compact",
      },
    },
    { name: "snapshot", args: { include_archived: false } },
    { name: "workset", args: { op: "get", projection: "id" } },
    { name: "derive_predicates", args: {} },
    {
      name: "materialize_operator_action",
      args: {
        task_id: ids.operatorActionTask,
        expected_output_identity: "/nix/store/parity-cq",
        expected_evidence: ["cq --version"],
        author: "parity-parent",
      },
    },
    {
      name: "revise_operator_action",
      args: {
        action_id: `OA${ids.operatorActionTask.slice(1)}`,
        expected_revision: 1,
        expected_output_identity: "/nix/store/parity-cq",
        expected_evidence: ["cq --version"],
        revised_at: FIXED_NOW,
        author: "parity-parent",
      },
    },
    {
      name: "acknowledge_operator_action",
      args: {
        action_id: `OA${ids.operatorActionTask.slice(1)}`,
        expected_revision: 2,
        output_identity: "/nix/store/parity-cq",
        acknowledged_at: FIXED_NOW,
      },
    },
    {
      name: "record_operator_action_evidence",
      args: {
        action_id: `OA${ids.operatorActionTask.slice(1)}`,
        expected_revision: 2,
        command: "cq --version",
        stdout: "cq parity",
        stderr: "",
        exit_code: 0,
        output_identity: "/nix/store/parity-cq",
        observed_at: FIXED_NOW,
        author: "parity-parent",
      },
    },
    {
      name: "complete_operator_action",
      args: {
        action_id: `OA${ids.operatorActionTask.slice(1)}`,
        expected_revision: 2,
        completion: "parity probe verified",
        author: "parity-parent",
      },
    },
    {
      name: "reopen_item",
      args: {
        ledger_id: "tasks",
        item_id: ids.terminalItem,
        to_status: "planned",
      },
    },
    {
      name: "unarchive_item",
      args: {
        ledger_id: "tasks",
        milestone_id: ids.archivedMilestone,
        item_id: ids.archivedItem,
      },
    },
    { name: "read_log", args: { path: READ_LOG_RESULT.path } },
    { name: "get_config", args: { section: "all" } },
    { name: "get_usage_stats", args: {} },
    {
      name: "prepare_dispatch",
      args: {
        roleId: "implement-worker",
        input: { taskId: "T695" },
        idempotencyKey: "T695-parity",
        timeoutMs: 120000,
        expectedChild: { childId: "child-1", runId: "run-1" },
      },
    },
    {
      name: "fetch_dispatch_input",
      args: {
        attestationId: `att_${"a".repeat(32)}`,
        generation: 1,
        inputCapability: {
          scope: "fetch-input",
          token: `cq_input_${"a".repeat(43)}`,
        },
      },
    },
    {
      name: "store_result",
      args: {
        resultCapability: {
          scope: "store-result",
          token: `cq_result_${"a".repeat(43)}`,
        },
        output: { status: "pass" },
      },
    },
    {
      name: "git_commit",
      args: {
        attestationId: `att_${"a".repeat(32)}`,
        generation: 1,
        gitChangeCapability: {
          scope: "git-change",
          token: `cq_git_${"a".repeat(43)}`,
        },
        operationId: "T2042_parity_commit",
        expectedHead: "a".repeat(40),
        message: "parity broker commit",
        changes: [
          {
            kind: "add",
            path: "parity.txt",
            newState: { mode: "100644", digest: "b".repeat(64) },
          },
        ],
      },
    },
    {
      name: "git_resolve_continue",
      args: {
        attestationId: `att_${"a".repeat(32)}`,
        generation: 1,
        gitConflictCapability: {
          scope: "git-conflict",
          token: `cq_conflict_${"a".repeat(43)}`,
        },
        operationId: "T2043_parity_continue",
        expectedState: {
          baseCommit: "a".repeat(40),
          currentHead: "b".repeat(40),
          expectedAncestry: [],
          sequencer: {
            kind: "rebase-merge",
            identity: "c".repeat(64),
            headName: "refs/heads/implement/T2043",
            originalTip: "d".repeat(40),
            onto: "e".repeat(40),
            stoppedCommit: "f".repeat(40),
            currentCommand: `pick ${"f".repeat(40)} change`,
            todoDigest: "1".repeat(64),
            doneDigest: "2".repeat(64),
          },
          conflicts: [{ path: "parity.txt", stage: 2, mode: "100644", oid: "3".repeat(40) }],
        },
        resolutions: [
          {
            kind: "regular",
            path: "parity.txt",
            newState: { mode: "100644", digest: "4".repeat(64) },
          },
        ],
      },
    },
    {
      name: "confirm_dispatch_completion",
      args: {
        attestationId: `att_${"a".repeat(32)}`,
        generation: 1,
        nativeCompletion: {
          kind: "native-completion",
          actor: "trusted-parent",
          childId: "child-1",
          runId: "run-1",
          completedAt: FIXED_NOW,
        },
        expectedProvenance: {
          roleId: "implement-worker",
          version: 1,
          promptDigest: "a".repeat(64),
          inputDigest: "b".repeat(64),
        },
      },
    },
    {
      name: "abort_dispatch",
      args: {
        attestationId: `att_${"a".repeat(32)}`,
        generation: 1,
        reason: "cancelled",
      },
    },
    {
      name: "fetch_dispatch_result",
      args: {
        attestationId: `att_${"a".repeat(32)}`,
        generation: 1,
      },
    },
    { name: "fetch_prompt", args: { roleId: PROMPT_RESULT.roleId } },
    { name: "list_projects", args: {} },
    {
      name: "claim_plan",
      args: {
        goalId: PARITY_GOAL_ID,
        purpose: "initial",
        claimRequestId: "parity_claim_request",
        ownerFenceToken: PARITY_OWNER_FENCE_TOKEN,
        expectedGeneration: null,
        ...PARITY_PROVENANCE,
      },
    },
    {
      name: "publish_plan_draft",
      args: {
        goalId: PARITY_GOAL_ID,
        claimId: PARITY_CLAIM_ID,
        generation: PARITY_GENERATION,
        operationId: "parity_publish",
        ownerFenceToken: PARITY_OWNER_FENCE_TOKEN,
        ...PARITY_PROVENANCE,
        manifest: {
          milestones: [{ key: "delivery", title: "Delivery" }],
          tasks: [
            {
              key: "implementation",
              milestoneKey: "delivery",
              headline: "Implementation",
            },
          ],
        },
      },
    },
    {
      // No review exists, so this exercises the conflict channel of finalize
      // (a conflict is a SUCCESSFUL tool call carrying `{ ok: false }`).
      name: "finalize_plan",
      args: {
        goalId: PARITY_GOAL_ID,
        claimId: PARITY_CLAIM_ID,
        generation: PARITY_GENERATION,
        operationId: "parity_finalize",
        ownerFenceToken: PARITY_OWNER_FENCE_TOKEN,
        ...PARITY_PROVENANCE,
        reviewId: "R1",
        draftRevision: 1,
        decision: { headline: "Approve the parity draft" },
      },
    },
    {
      name: "release_plan_claim",
      args: {
        kind: "abandon",
        goalId: PARITY_GOAL_ID,
        claimId: PARITY_CLAIM_ID,
        generation: PARITY_GENERATION,
        operationId: "parity_release",
        reason: "recover the parity claim",
        ...PARITY_PROVENANCE,
      },
    },
    {
      name: "prepare_implementation_review_panel",
      args: {
        task_ref: PARITY_IMPLEMENTATION_TASK_REF,
        result_commit: PARITY_IMPLEMENTATION_RESULT,
        worker_dispatch: PARITY_IMPLEMENTATION_WORKER,
        operation_id: "parity_evidence_panel",
        ...PARITY_PROVENANCE,
      },
    },
    {
      name: "prepare_implementation_review_attempt",
      args: {
        panel_ref: panelRef,
        attempt_ref: attemptRef,
        operation_id: "parity_evidence_attempt",
        ...PARITY_PROVENANCE,
      },
    },
    {
      name: "execute_external_implementation_review_attempt",
      args: {
        attempt_ref: attemptRef,
        operation_id: "parity_evidence_execute",
        ...PARITY_PROVENANCE,
      },
    },
    {
      name: "finalize_implementation_review_attempt",
      args: {
        attempt_ref: attemptRef,
        operation_id: "parity_evidence_finalize",
        ...PARITY_PROVENANCE,
      },
    },
    {
      name: "prepare_implementation_review_fallback",
      args: {
        panel_ref: panelRef,
        operation_id: "parity_evidence_fallback",
        ...PARITY_PROVENANCE,
      },
    },
    {
      name: "prepare_implementation_audit_panel",
      args: {
        manifest_id: PARITY_AUDIT_MANIFEST_ID,
        manifest_digest: auditManifestDigest,
        record_key: "audit-one",
        expected_repository_head: PARITY_AUDIT_HEAD,
        operation_id: "parity_audit_panel_audit-one",
        ...PARITY_PROVENANCE,
      },
    },
    {
      name: "prepare_implementation_audit_attempt",
      args: {
        panel_ref: auditPanelRef,
        attempt_ref: auditAttemptRef,
        operation_id: "parity_audit_prepare_audit-one",
        ...PARITY_PROVENANCE,
      },
    },
    {
      name: "execute_external_implementation_audit_attempt",
      args: {
        attempt_ref: auditAttemptRef,
        operation_id: "parity_audit_execute_audit-one",
        ...PARITY_PROVENANCE,
      },
    },
    {
      name: "finalize_implementation_audit_attempt",
      args: {
        attempt_ref: auditAttemptRef,
        operation_id: "parity_audit_finalize_audit-one",
        ...PARITY_PROVENANCE,
      },
    },
    {
      name: "prepare_implementation_audit_fallback",
      args: {
        panel_ref: auditFallbackPanelRef,
        operation_id: "parity_audit_fallback",
        ...PARITY_PROVENANCE,
      },
    },
    {
      name: "advance_implementation_evidence_bootstrap",
      args: {
        goal_ref: `goals:${PARITY_GOAL_ID}`,
        finalized_manifest_digest: PARITY_AUDIT_FINALIZED_MANIFEST_DIGEST,
        expected_repository_head: PARITY_IMPLEMENTATION_BASE,
        expected_phase: "historical-dispatch",
        operation_id: "parity_bootstrap_historical",
        ...PARITY_PROVENANCE,
      },
    },
    {
      name: "arm_implementation_evidence_activation",
      args: {
        goal_ref: `goals:${PARITY_GOAL_ID}`,
        manifest_id: PARITY_AUDIT_MANIFEST_ID,
        expected_repository_head: PARITY_AUDIT_HEAD,
        operation_id: "parity_audit_arm",
        ...PARITY_PROVENANCE,
      },
    },
    {
      name: "apply_implementation_audit_manifest",
      args: {
        manifest_id: PARITY_AUDIT_MANIFEST_ID,
        manifest_digest: auditManifestDigest,
        expected_repository_head: PARITY_AUDIT_HEAD,
        audit_attempt_refs: auditAttemptRefs,
        operation_id: "parity_audit_apply",
        ...PARITY_PROVENANCE,
      },
    },
    {
      name: "get_implementation_evidence_activation_status",
      args: {
        goal_ref: `goals:${PARITY_GOAL_ID}`,
        manifest_id: PARITY_AUDIT_MANIFEST_ID,
        expected_repository_head: PARITY_AUDIT_HEAD,
      },
    },
    {
      name: "continue_implementation_evidence_activation",
      args: {
        goal_ref: `goals:${PARITY_GOAL_ID}`,
        manifest_id: "d347-implementation-evidence-activation-v2",
        prior_requirement_ref:
          `cq-implementation-evidence-activation-requirement:v1:${"1".repeat(64)}`,
        completed_task_ref: PARITY_IMPLEMENTATION_TASK_REF,
        completion_ref: `cq-implementation-completion:v1:${"2".repeat(64)}`,
        expected_from_head: PARITY_IMPLEMENTATION_BASE,
        expected_repository_head: PARITY_IMPLEMENTATION_RESULT,
        operation_id: "parity_activation_continue",
        ...PARITY_PROVENANCE,
      },
    },
    {
      name: "get_implementation_evidence_service_status",
      args: {},
    },
    {
      name: "prepare_implementation_completion",
      args: {
        task_ref: PARITY_IMPLEMENTATION_TASK_REF,
        expected_repository_head: PARITY_IMPLEMENTATION_BASE,
        result_commit: PARITY_IMPLEMENTATION_RESULT,
        worker_dispatch: PARITY_IMPLEMENTATION_WORKER,
        review_attempt_refs: [attemptRef, fallbackAttemptRef],
        completion: "stdio parity completion",
        log_paths: [".cq/logs/parity.md"],
        merge_operation_id: "parity_evidence_merge",
        operation_id: "parity_evidence_completion",
        ...PARITY_PROVENANCE,
      },
    },
    {
      name: "record_implementation_completion",
      args: {
        task_ref: PARITY_IMPLEMENTATION_TASK_REF,
        expected_repository_head: PARITY_IMPLEMENTATION_BASE,
        operation_id: "parity_evidence_record",
        ...PARITY_PROVENANCE,
      },
    },
    {
      name: "worktree_manage",
      args: {
        operation: "prepare",
        taskId: "T1",
        baseCommit: "a".repeat(40),
      },
    },
  ];
}

function assertRepresentativeContracts(
  responses: Map<LedgerToolName, unknown>,
  fixture: Fixture,
): void {
  const page = responses.get("fetch_ledger") as {
    items: Array<{ fields: Record<string, unknown> }>;
    total: number;
    offset: number;
    limit: number;
    nextOffset: number;
  };
  expect(page.items).toHaveLength(1);
  expect(page.total).toBeGreaterThan(1);
  expect({
    offset: page.offset,
    limit: page.limit,
    nextOffset: page.nextOffset,
  }).toEqual({ offset: 0, limit: 1, nextOffset: 1 });

  const archive = responses.get("fetch_ledger_archive") as {
    archive: { kind: string; milestone: { id: string } };
  };
  expect(archive.archive.kind).toBe("group");
  expect(archive.archive.milestone.id).toBe(fixture.ids.archivedMilestone);
  expect(responses.get("archive_milestone")).toMatchObject({
    pointer: { id: fixture.ids.archivableMilestone },
  });

  const updated = responses.get("update_item") as {
    item: { fields: Record<string, unknown> };
  };
  expect(updated.item.fields).toEqual({
    dependsOn: [`tasks:${fixture.ids.dependencyItem}`],
    blockedBy: ["external:E1"],
    ledgerRefs: [`tasks:${fixture.ids.dependencyItem}`],
  });
  expect(updated.item.fields).not.toHaveProperty("headline");
  expect(updated.item.fields).not.toHaveProperty("description");

  const fixedAcknowledgements = [
    ["create_item", "item"],
    ["reopen_item", "item"],
    ["unarchive_item", "item"],
  ] as const;
  for (const [toolName, envelope] of fixedAcknowledgements) {
    const response = responses.get(toolName) as Record<string, { fields: Record<string, unknown> }>;
    expect(response[envelope]?.fields, toolName).toBeDefined();
    expect(response[envelope]?.fields, toolName).not.toHaveProperty("headline");
    expect(response[envelope]?.fields, toolName).not.toHaveProperty("description");
  }
  expect(responses.get("create_ledger")).toEqual({
    ledger: { id: "widgets" },
  });
  expect(responses.get("snapshot")).toMatchObject({
    ledger: {
      tasks: {
        planned: { count: 2 },
        wip: { count: 1 },
        done: { count: 1 },
      },
    },
  });
  expect(responses.get("workset")).toEqual({
    op: "get",
    graph: {
      roots: [],
      inactiveRoots: [],
      nodes: [],
      edges: [],
      restrictive: false,
      projection: "id",
    },
  });
  expect(responses.get("finalize_implementation_review_attempt")).toEqual({
    status: "existing",
    attemptRef: fixture.implementationEvidenceRefs.attemptRef,
    terminalState: "operational-abstention",
    outcome: { kind: "operational-abstention" },
  });
  const predicates = responses.get("derive_predicates") as Record<string, unknown>;
  expect(Object.keys(predicates).sort()).toEqual(
    [
      "belowFloor",
      "goalDrift",
      "openQuestionGate",
      "pImplement",
      "pInvestigate",
      "pOperatorAction",
      "pPlan",
      "pResearch",
      "pSeed",
      "planBusy",
      "upstreamBlocked",
    ].sort(),
  );
  expect(predicates).toMatchObject({
    pInvestigate: { value: false },
    pResearch: { value: false },
    openQuestionGate: { value: false },
  });
  expect(responses.get("materialize_operator_action")).toMatchObject({
    state: "created",
    action: { status: "pending" },
    handoff: { status: "user-action-required" },
  });
  expect(responses.get("revise_operator_action")).toMatchObject({
    action: { status: "pending", fields: { revision: "2" } },
    task: { status: "planned" },
    handoff: { status: "user-action-required" },
  });
  expect(responses.get("acknowledge_operator_action")).toMatchObject({
    state: "acknowledged",
    action: { status: "acknowledged" },
  });
  expect(responses.get("record_operator_action_evidence")).toMatchObject({
    state: "verified",
    action: { status: "verified" },
  });
  expect(responses.get("complete_operator_action")).toMatchObject({
    task: { status: "done" },
  });
  expect(responses.get("reopen_item")).toMatchObject({
    item: { id: fixture.ids.terminalItem, status: "planned" },
  });
  expect(responses.get("unarchive_item")).toMatchObject({
    item: { id: fixture.ids.archivedItem, status: "done" },
  });

  // Guarded plan lifecycle: the winning claim is the ONLY response that may
  // carry the owner token, and it must actually be the WINNER — otherwise the
  // three owner operations below would be exercising conflict paths only.
  expect(responses.get("claim_plan")).toMatchObject({
    ok: true,
    replayed: false,
    acknowledgement: {
      goalId: PARITY_GOAL_ID,
      claimId: PARITY_CLAIM_ID,
      generation: PARITY_GENERATION,
      ownerFenceToken: PARITY_OWNER_FENCE_TOKEN,
      goalPhase: "planning",
    },
  });
  const published = responses.get("publish_plan_draft") as {
    ok: boolean;
    acknowledgement: { manifest: { revision: number; tasks: unknown[] } };
  };
  expect(published.ok).toBe(true);
  expect(published.acknowledgement.manifest.revision).toBe(1);
  expect(published.acknowledgement.manifest.tasks).toHaveLength(1);
  expect(responses.get("finalize_plan")).toMatchObject({
    ok: false,
    conflict: { code: "review-not-found", reviewId: "R1" },
  });
  expect(responses.get("release_plan_claim")).toMatchObject({
    ok: true,
    acknowledgement: { kind: "abandon", goalPhase: "planning" },
  });
  for (const toolName of ["publish_plan_draft", "release_plan_claim", "finalize_plan"] as const) {
    expect(JSON.stringify(responses.get(toolName)), toolName).not.toContain("ownerFenceToken");
    expect(JSON.stringify(responses.get(toolName)), toolName).not.toContain(
      PARITY_OWNER_FENCE_TOKEN,
    );
  }

  expect(responses.get("read_log")).toEqual(READ_LOG_RESULT);
  expect(responses.get("get_config")).toEqual(CONFIG_RESULT);
  expect(responses.get("fetch_prompt")).toEqual(PROMPT_RESULT);
  expect(responses.get("list_projects")).toEqual(PROJECTS_RESULT);
  expect(responses.get("worktree_manage")).toEqual(WORKTREE_MANAGE_PARITY_ACK);
}

// BG, specified-origin: both registrations expose one canonical contract per profile.
describe("stdio/direct ledger tool differential contract", () => {
  it("matches the actual Anthropic direct-server tools/list wire to stdio", async () => {
    const cases: Array<{ prefix: string; profileName: LedgerToolProfileName }> = [
      { prefix: "", profileName: "full" },
      { prefix: "mirror", profileName: "full" },
      { prefix: "planner", profileName: "plan-advance" },
    ];
    for (const { prefix, profileName } of cases) {
      const directFixture = await buildFixture();
      const stdioFixture = await buildFixture();
      const direct = await connectAnthropicDirect(
        directFixture.store,
        prefix,
        AVAILABLE_CAPABILITIES,
        profileName,
        directFixture.implementationEvidence,
      );
      const stdio = await connectStdio(
        stdioFixture.store,
        prefix,
        AVAILABLE_CAPABILITIES,
        profileName,
        stdioFixture.implementationEvidence,
      );
      try {
        expect(direct.definitions, `${profileName}:${prefix}`).toEqual(stdio.definitions);
        if (profileName === "full") {
          const publishPlan = direct.definitions.find(
            ({ name }) => name === prefixed(prefix, "publish_plan_draft"),
          );
          expect(
            publishPlan?.schema,
            `${profileName}:${prefix}:description property`,
          ).toMatchObject({
            properties: {
              manifest: {
                properties: {
                  milestones: {
                    items: {
                      properties: {
                        description: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          });
        }
        const invalid = await direct.client.callTool({
          name: prefixed(prefix, "fetch_item"),
          arguments: {
            ledger_id: "tasks",
            item_id: directFixture.ids.targetItem,
          },
        });
        expect(invalid.isError, `${profileName}:${prefix}`).toBe(true);
        expect(resultText(invalid as TextToolResult), `${profileName}:${prefix}`).toContain(
          "Input validation error",
        );
      } finally {
        await direct.close();
        await stdio.close();
        await directFixture.store.dispose();
        await stdioFixture.store.dispose();
      }
    }
  });

  it("publishes minimal schemas with explicit generic-root conditions", async () => {
    const fixture = await buildFixture();
    try {
      const observeDefinitions = directDefinitions(
        directTools(
          fixture.store,
          "",
          AVAILABLE_CAPABILITIES,
          "full",
          fixture.implementationEvidence,
        ),
      );
      const managementDefinitions = directDefinitions(
        createManagementLedgerMcpTools(
          fixture.store,
          AVAILABLE_CAPABILITIES.readLog,
          AVAILABLE_CAPABILITIES.config,
          AVAILABLE_CAPABILITIES.promptCatalog,
          "",
          AVAILABLE_CAPABILITIES.listProjects,
          AVAILABLE_CAPABILITIES.dispatch,
          "full",
          AVAILABLE_CAPABILITIES.worktreeManage,
        ),
      );
      const definitions = [...observeDefinitions, ...managementDefinitions];
      const serializedSchemas = JSON.stringify(definitions.map(({ schema }) => schema));
      expect(serializedSchemas).not.toContain('"$schema"');
      expect(schemaDescriptionAnnotationCount(definitions.map(({ schema }) => schema))).toBe(0);
      expect(refOnlyAllOfWrapperCount(definitions.map(({ schema }) => schema))).toBe(0);
      // Regression: D329 — Grok rejects boolean schemas beneath `properties`.
      expect(
        definitions.flatMap(({ name, schema }) =>
          booleanPropertySchemaPaths(schema).map((path) => `${name}:${path}`),
        ),
      ).toEqual([]);

      expect(observeDefinitions.find(({ name }) => name === "workset")?.schema).toMatchObject({
        allOf: [
          {
            then: { required: ["projection"], not: { required: ["roots"] } },
            else: { required: ["roots", "projection"] },
          },
        ],
      });
      expect(managementDefinitions.find(({ name }) => name === "workset")?.schema).toMatchObject({
        allOf: [
          {
            then: { required: ["projection"], not: { required: ["roots"] } },
            else: {
              then: { required: ["roots"], not: { required: ["projection"] } },
              else: { required: ["roots", "projection"] },
            },
          },
        ],
      });

      const createItem = definitions.find(({ name }) => name === "create_item");
      expect(createItem?.schema).toMatchObject({
        required: ["ledger_id", "status", "fields"],
        dependencies: {
          owner_ref: ["creation_kind"],
          creation_kind: ["owner_ref"],
        },
        allOf: [
          {
            if: {
              properties: { ledger_id: { const: "milestones" } },
              required: ["ledger_id"],
            },
            then: {
              not: { required: ["milestone_id"] },
              properties: {
                status: { const: "open" },
                fields: { required: ["title"] },
              },
            },
            else: {
              if: {
                properties: {
                  creation_kind: { enum: ["idea-to-goal", "fix-goal"] },
                },
                required: ["creation_kind"],
              },
              then: {
                not: {
                  anyOf: [{ required: ["milestone_id"] }, { required: ["id"] }],
                },
              },
              else: {
                if: {
                  properties: { ledger_id: { const: "ideas" } },
                  required: ["ledger_id"],
                },
                then: {},
                else: { required: ["milestone_id"] },
              },
            },
          },
        ],
      });
    } finally {
      await fixture.store.dispose();
    }
  });

  it("derives profiled definitions from the same canonical specifications", async () => {
    const directFixture = await buildFixture();
    const stdioFixture = await buildFixture();
    const profileName = "plan-advance";
    const prefix = "planner";
    const direct = directTools(
      directFixture.store,
      prefix,
      AVAILABLE_CAPABILITIES,
      profileName,
      directFixture.implementationEvidence,
      true,
    );
    const stdio = await connectStdio(
      stdioFixture.store,
      prefix,
      AVAILABLE_CAPABILITIES,
      profileName,
      stdioFixture.implementationEvidence,
      true,
    );
    try {
      const expectedNames = exposedLedgerToolsForRole(profileName)
        .map((name) => prefixed(prefix, name))
        .sort();
      expect(direct.map((tool) => tool.name).sort()).toEqual(expectedNames);
      expect(stdio.definitions).toEqual(directDefinitions(direct));
    } finally {
      await stdio.close();
      await directFixture.store.dispose();
      await stdioFixture.store.dispose();
    }
  });

  for (const prefix of PREFIXES) {
    it(`matches complete definitions for prefix ${JSON.stringify(prefix)}`, async () => {
      const directFixture = await buildFixture();
      const stdioFixture = await buildFixture();
      const direct = directTools(
        directFixture.store,
        prefix,
        AVAILABLE_CAPABILITIES,
        "full",
        directFixture.implementationEvidence,
        true,
      );
      const stdio = await connectStdio(
        stdioFixture.store,
        prefix,
        AVAILABLE_CAPABILITIES,
        "full",
        stdioFixture.implementationEvidence,
        true,
      );
      try {
        const directDefinitionList = directDefinitions(direct);
        const expectedNames = MANAGEMENT_LEDGER_TOOL_NAMES.map((name) =>
          prefixed(prefix, name),
        ).sort();
        expect(expectedNames).not.toContain(prefixed(prefix, "validate_input"));
        expect(directDefinitionList.map((tool) => tool.name)).toEqual(expectedNames);
        expect(stdio.definitions).toEqual(directDefinitionList);
        const reviseName = prefixed(prefix, "revise_operator_action");
        const directDescription = directDefinitionList.find(
          ({ name }) => name === reviseName,
        )?.description;
        const stdioDescription = stdio.definitions.find(
          ({ name }) => name === reviseName,
        )?.description;
        expect(stdioDescription).toBe(directDescription);
        expect(directDescription).toContain("validated terminal failure");
        expect(directDescription).toContain("current revision and acknowledgement epoch");
        expect(directDescription).toContain("Reject stale or other evidence");
        expect(directDescription).not.toContain("pre-evidence operator-action manifest");
        expect(
          POST_TARGET_ADDITIONS.filter(({ name }) => name === "revise_operator_action").map(
            ({ description }) => description,
          ),
        ).toEqual([directDescription?.split("\n\n", 1)[0]]);
      } finally {
        await stdio.close();
        await directFixture.store.dispose();
        await stdioFixture.store.dispose();
      }
    });

    it(`invokes all 56 tools against independent stores for prefix ${JSON.stringify(prefix)}`, async () => {
      const directFixture = await buildFixture();
      const stdioFixture = await buildFixture();
      expect(directFixture.store).not.toBe(stdioFixture.store);
      expect(directFixture.ids).toEqual(stdioFixture.ids);
      expect(directFixture.store.snapshot()).toEqual(stdioFixture.store.snapshot());

      const direct = directTools(
        directFixture.store,
        prefix,
        AVAILABLE_CAPABILITIES,
        "full",
        directFixture.implementationEvidence,
        true,
      );
      const stdio = await connectStdio(
        stdioFixture.store,
        prefix,
        AVAILABLE_CAPABILITIES,
        "full",
        stdioFixture.implementationEvidence,
        true,
      );
      const invocations = invocationMatrix(directFixture);
      expect(invocations.map((invocation) => invocation.name).sort()).toEqual(
        [...MANAGEMENT_LEDGER_TOOL_NAMES].sort(),
      );

      const responses = new Map<LedgerToolName, unknown>();
      try {
        for (const invocation of invocations) {
          const name = prefixed(prefix, invocation.name);
          const directOutcome = await invokeDirect(direct, name, invocation.args);
          const stdioOutcome = await invokeStdio(stdio.client, name, invocation.args);
          expect(stdioOutcome, invocation.name).toEqual(directOutcome);
          expect(directOutcome.kind, invocation.name).toBe("success");
          responses.set(invocation.name, decode(directOutcome));
        }

        const compactArgs = {
          ledger_id: "tasks",
          item_id: directFixture.ids.targetItem,
          projection: "compact",
        };
        const fullArgs = { ...compactArgs, projection: "full" };
        const compactDirect = await invokeDirect(
          direct,
          prefixed(prefix, "fetch_item"),
          compactArgs,
        );
        const compactStdio = await invokeStdio(
          stdio.client,
          prefixed(prefix, "fetch_item"),
          compactArgs,
        );
        const fullDirect = await invokeDirect(direct, prefixed(prefix, "fetch_item"), fullArgs);
        const fullStdio = await invokeStdio(stdio.client, prefixed(prefix, "fetch_item"), fullArgs);
        expect(compactStdio).toEqual(compactDirect);
        expect(fullStdio).toEqual(fullDirect);
        const compact = decode(compactDirect) as {
          item: { fields: Record<string, unknown> };
        };
        const full = decode(fullDirect) as {
          item: { fields: Record<string, unknown> };
        };
        expect(compact.item.fields).not.toHaveProperty("description");
        expect(full.item.fields["description"]).toBe("transport-parity-needle full narrative");

        assertRepresentativeContracts(responses, directFixture);
        expect(directFixture.store.snapshot()).toEqual(stdioFixture.store.snapshot());
      } finally {
        await stdio.close();
        await directFixture.store.dispose();
        await stdioFixture.store.dispose();
      }
    });

    // BG over the direct handler and stdio MCP transport; regression-origin: R1317.
    it(`revises failed operator-action evidence and fences reopen for prefix ${JSON.stringify(prefix)}`, async () => {
      const directFixture = await buildFixture();
      const stdioFixture = await buildFixture();
      const direct = directTools(
        directFixture.store,
        prefix,
        AVAILABLE_CAPABILITIES,
        "full",
        directFixture.implementationEvidence,
        true,
      );
      const stdio = await connectStdio(
        stdioFixture.store,
        prefix,
        AVAILABLE_CAPABILITIES,
        "full",
        stdioFixture.implementationEvidence,
        true,
      );
      const invokeBoth = async (invocation: Invocation): Promise<ToolOutcome> => {
        const name = prefixed(prefix, invocation.name);
        const directOutcome = await invokeDirect(direct, name, invocation.args);
        const stdioOutcome = await invokeStdio(stdio.client, name, invocation.args);
        expect(stdioOutcome, invocation.name).toEqual(directOutcome);
        return directOutcome;
      };
      const actionId = `OA${directFixture.ids.operatorActionTask.slice(1)}`;
      const identity = "/nix/store/parity-epoch";
      const evidenceArgs = (
        expectedRevision: number,
        command: string,
        exitCode: number,
        observedAt: string,
      ): Record<string, unknown> => ({
        action_id: actionId,
        expected_revision: expectedRevision,
        command,
        stdout: exitCode === 0 ? "ok" : "",
        stderr: exitCode === 0 ? "" : "failed",
        exit_code: exitCode,
        output_identity: identity,
        observed_at: observedAt,
        author: "parity-parent",
      });

      try {
        expect(
          decode(
            await invokeBoth({
              name: "materialize_operator_action",
              args: {
                task_id: directFixture.ids.operatorActionTask,
                expected_output_identity: identity,
                expected_evidence: ["probe-a", "probe-b"],
                author: "parity-parent",
              },
            }),
          ),
        ).toMatchObject({ state: "created", action: { status: "pending" } });
        await invokeBoth({
          name: "acknowledge_operator_action",
          args: {
            action_id: actionId,
            expected_revision: 1,
            output_identity: identity,
            acknowledged_at: "2026-08-11T08:00:00.000Z",
          },
        });
        expect(
          decode(
            await invokeBoth({
              name: "record_operator_action_evidence",
              args: evidenceArgs(1, "probe-a", 0, "2026-08-11T08:01:00.000Z"),
            }),
          ),
        ).toMatchObject({ state: "acknowledged" });
        expect(
          decode(
            await invokeBoth({
              name: "record_operator_action_evidence",
              args: evidenceArgs(1, "probe-b", 1, "2026-08-11T08:02:00.000Z"),
            }),
          ),
        ).toMatchObject({ state: "pending" });
        const revised = decode(
          await invokeBoth({
            name: "revise_operator_action",
            args: {
              action_id: actionId,
              expected_revision: 1,
              expected_output_identity: "/nix/store/parity-epoch-v2",
              expected_evidence: ["probe-v2"],
              revised_at: "2026-08-11T08:02:30.000Z",
              author: "parity-parent",
            },
          }),
        ) as { action: { fields: Record<string, unknown> } };
        expect(revised).toMatchObject({
          action: { status: "pending", fields: { revision: "2" } },
          task: { status: "planned" },
          handoff: { status: "user-action-required" },
        });
        expect(revised.action.fields["evidence"]).toBeUndefined();
        expect(revised.action.fields["lastFailure"]).toBeUndefined();
        const history = JSON.parse((revised.action.fields["revisionHistory"] as string[])[0]!) as {
          action: { fields: Record<string, unknown> };
        };
        expect(history.action.fields).toMatchObject({
          acknowledgementEpoch: "1",
          evidence: [expect.any(String), expect.any(String)],
          lastFailure: expect.any(String),
        });
        await invokeBoth({
          name: "acknowledge_operator_action",
          args: {
            action_id: actionId,
            expected_revision: 2,
            output_identity: "/nix/store/parity-epoch-v2",
            acknowledged_at: "2026-08-11T08:03:00.000Z",
          },
        });
        expect(
          decode(
            await invokeBoth({
              name: "record_operator_action_evidence",
              args: {
                ...evidenceArgs(2, "probe-v2", 0, "2026-08-11T08:04:00.000Z"),
                output_identity: "/nix/store/parity-epoch-v2",
              },
            }),
          ),
        ).toMatchObject({ state: "verified", action: { status: "verified" } });
        expect(
          decode(
            await invokeBoth({
              name: "complete_operator_action",
              args: {
                action_id: actionId,
                expected_revision: 2,
                completion: "latest epoch verified",
                author: "parity-parent",
              },
            }),
          ),
        ).toMatchObject({ task: { status: "done" } });

        for (const [ledgerId, itemId, toStatus] of [
          ["operatorActions", actionId, "pending"],
          ["tasks", directFixture.ids.operatorActionTask, "planned"],
        ] as const) {
          const outcome = await invokeBoth({
            name: "reopen_item",
            args: { ledger_id: ledgerId, item_id: itemId, to_status: toStatus },
          });
          expect(outcome).toMatchObject({
            kind: "error",
            error: {
              category: "handler",
              message: expect.stringMatching(/typed operator-action lifecycle/),
            },
          });
        }
        expect(directFixture.store.fetchItem("operatorActions", actionId).status).toBe("verified");
        expect(stdioFixture.store.fetchItem("operatorActions", actionId).status).toBe("verified");
        expect(
          directFixture.store.fetchItem("tasks", directFixture.ids.operatorActionTask).status,
        ).toBe("done");
        expect(
          stdioFixture.store.fetchItem("tasks", stdioFixture.ids.operatorActionTask).status,
        ).toBe("done");
      } finally {
        await stdio.close();
        await directFixture.store.dispose();
        await stdioFixture.store.dispose();
      }
    });
  }

  for (const prefix of PREFIXES) {
    it(`normalizes validation, handler, and unavailable-capability failures for prefix ${JSON.stringify(prefix)}`, async () => {
      const directFixture = await buildFixture();
      const stdioFixture = await buildFixture();
      const direct = directTools(
        directFixture.store,
        prefix,
        UNAVAILABLE_CAPABILITIES,
        "full",
        directFixture.implementationEvidence,
        true,
      );
      const stdio = await connectStdio(
        stdioFixture.store,
        prefix,
        UNAVAILABLE_CAPABILITIES,
        "full",
        stdioFixture.implementationEvidence,
        true,
      );
      const failures: Invocation[] = [
        {
          name: "fetch_item",
          args: {
            ledger_id: "tasks",
            item_id: directFixture.ids.targetItem,
          },
        },
        {
          name: "fetch_item",
          args: {
            ledger_id: "tasks",
            item_id: directFixture.ids.targetItem,
            projection: "summary",
          },
        },
        {
          name: "fetch_item",
          args: {
            ledger_id: "tasks",
            item_id: "T999",
            projection: "full",
          },
        },
        { name: "read_log", args: { path: READ_LOG_RESULT.path } },
        { name: "get_config", args: { section: "all" } },
        { name: "fetch_prompt", args: { roleId: PROMPT_RESULT.roleId } },
        { name: "list_projects", args: {} },
        {
          name: "worktree_manage",
          args: { operation: "prepare", taskId: "T1", baseCommit: "a".repeat(40) },
        },
      ];

      try {
        for (const failure of failures) {
          const name = prefixed(prefix, failure.name);
          const directOutcome = await invokeDirect(direct, name, failure.args);
          const stdioOutcome = await invokeStdio(stdio.client, name, failure.args);
          expect(stdioOutcome, failure.name).toEqual(directOutcome);
          expect(directOutcome.kind, failure.name).toBe("error");
        }

        expect(
          await invokeDirect(direct, prefixed(prefix, "fetch_item"), {
            ledger_id: "tasks",
            item_id: "T999",
            projection: "full",
          }),
        ).toEqual({
          kind: "error",
          error: {
            category: "handler",
            message: "Item not found in ledger tasks: T999",
          },
        });
      } finally {
        await stdio.close();
        await directFixture.store.dispose();
        await stdioFixture.store.dispose();
      }
    });
  }
});
