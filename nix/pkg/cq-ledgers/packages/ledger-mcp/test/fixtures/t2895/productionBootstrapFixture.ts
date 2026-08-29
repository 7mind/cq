import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  FsAttestationBackend,
  implementReviewerSidecar,
  implementWorkerSidecar,
  sequentialDispatchRandomBytes,
  serializeWipArtifact,
  type AttestationNamespace,
} from "@cq/config";
import {
  D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE,
  GOALS_LEDGER,
  HANDOFFS_LEDGER,
  MILESTONES_AMBIENT_ID,
  OPERATOR_ACTIONS_LEDGER,
  PLAN_REVIEW_DRAFT_FIELD,
  REVIEWS_LEDGER,
  TASKS_LEDGER,
  createLedgerStore,
  createWorktreeManageCapability,
  derivePredicates,
  fsAttestationProductionRoot,
  listManagedLiveWorktrees,
  resolveImplementationEvidenceActivationTaskMappings,
  type DispatchCapability,
  type ManagedWorktreeHandle,
  type PlanLifecycleStore,
  type SupervisedWorkerGateRunRequest,
  type SupervisedWorkerGateRunResult,
  type SupervisedWorkerGateRunner,
} from "@cq/ledger";
import { createDispatchCapability } from "../../../src/dispatchCapability.js";
import { createProductionImplementationEvidenceService } from "../../../src/implementationEvidenceRuntime.js";
import { createManagementLedgerMcpServer } from "../../../src/main.js";
import type {
  PromptArtifactStore,
  PromptArtifactRoleMetadata,
} from "../../../src/promptArtifactStore.js";

const FIXTURE_URL = new URL("./production-bootstrap-v1.json", import.meta.url);
const FULL_SHA = /^[0-9a-f]{40}$/u;

interface FixtureManifest {
  readonly version: 1;
  readonly baselineCommit: string;
  readonly goalRef: "goals:G176";
  readonly taskKeys: readonly ["t-evidence", "t-historical-evidence", "t-activate-evidence"];
  readonly knownCriticism: string;
  readonly baselineArtifacts: readonly {
    readonly kind: string;
    readonly path: string;
    readonly sha256: string;
  }[];
}

interface ToolResult {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly isError?: boolean;
}

interface WorkerDispatch {
  readonly accepted: true;
  readonly prepared: {
    readonly attestationId: string;
    readonly generation: number;
    readonly inputCapability: { readonly scope: "fetch-input"; readonly token: string };
    readonly resultCapability: { readonly scope: "store-result"; readonly token: string };
    readonly gitChangeCapability: { readonly scope: "git-change"; readonly token: string };
    readonly parentGateCapability: { readonly scope: "parent-gate"; readonly token: string };
    readonly promptProvenance: {
      readonly roleId: string;
      readonly version: number;
      readonly promptDigest: string;
      readonly inputDigest: string;
    };
  };
}

interface GitReceipt {
  readonly kind: "cq-git-change-receipt";
  readonly newHead: string;
  readonly paths: readonly string[];
}

class ObservedGreenGateRunner implements SupervisedWorkerGateRunner {
  readonly requests: SupervisedWorkerGateRunRequest[] = [];

  async run(request: SupervisedWorkerGateRunRequest): Promise<SupervisedWorkerGateRunResult> {
    this.requests.push(request);
    return {
      gateExitCode: 0,
      passCount: 29,
      failCount: 0,
      gateDurationMs: 173,
      capturedAt: "2026-08-29T18:00:00.000Z",
      outputTail: "29 pass\n0 fail",
    };
  }
}

function invariant(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`T2895 production fixture invariant: ${detail}`);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function command(
  cwd: string,
  executable: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number }> {
  const child = Bun.spawn([executable, ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "T2895 production fixture",
      GIT_AUTHOR_EMAIL: "t2895@example.invalid",
      GIT_COMMITTER_NAME: "T2895 production fixture",
      GIT_COMMITTER_EMAIL: "t2895@example.invalid",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await command(cwd, "git", args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function resultText(result: ToolResult): string {
  return (result.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text ?? "")
    .join("");
}

async function callOk<T>(
  client: Client,
  calls: string[],
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<T> {
  calls.push(name);
  let result: ToolResult;
  try {
    result = (await client.callTool({ name, arguments: args }, undefined, {
      timeout: 120_000,
    })) as ToolResult;
  } catch (error) {
    throw new Error(`${name} transport failed: ${String(error)}`);
  }
  invariant(!(result.isError ?? false), `${name} rejected: ${resultText(result)}`);
  return JSON.parse(resultText(result)) as T;
}

async function callRejected(
  client: Client,
  calls: string[],
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<string> {
  calls.push(name);
  const result = (await client.callTool({ name, arguments: args }, undefined, {
    timeout: 120_000,
  })) as ToolResult;
  invariant(result.isError === true, `${name} unexpectedly succeeded`);
  return resultText(result);
}

function promptArtifactStore(): PromptArtifactStore {
  const encoder = new TextEncoder();
  const roles = [
    {
      roleId: "implement-worker",
      roleKind: "dispatched-subagent",
      artifactPath: "roles/implement-worker.md",
      sidecarSchemaRoleId: "implement-worker",
      promptSurface: "codex",
      schemaVersion: implementWorkerSidecar.version,
      bytes: encoder.encode("T2895 baseline-selected implement worker\n"),
    },
    {
      roleId: "implement-reviewer",
      roleKind: "dispatched-subagent",
      artifactPath: "roles/implement-reviewer.md",
      sidecarSchemaRoleId: "implement-reviewer",
      promptSurface: "codex",
      schemaVersion: implementReviewerSidecar.version,
      bytes: encoder.encode("T2895 protected implementation reviewer\n"),
    },
  ] as const;
  const metadata: PromptArtifactRoleMetadata[] = roles.map(({ bytes, ...role }) => ({
    ...role,
    promptDigest: sha256(bytes),
  }));
  return {
    readManifest: () => ({
      bytes: new Uint8Array(),
      roles: metadata,
      promptSurface: "codex",
      catalogHash: sha256("T2895 prompt fixture"),
    }),
    readRole: (roleId) => {
      const index = roles.findIndex((role) => role.roleId === roleId);
      invariant(index >= 0, `unexpected dispatched role ${roleId}`);
      return { metadata: metadata[index]!, bytes: roles[index]!.bytes };
    },
  };
}

function ledgerItemIds(
  store: Awaited<ReturnType<typeof createLedgerStore>>["store"],
  ledgerId: string,
): readonly string[] {
  return store
    .fetch(ledgerId)
    .milestones.flatMap((milestone) => milestone.items.map((item) => item.id));
}

async function connect(options: Parameters<typeof createManagementLedgerMcpServer>[0]): Promise<{
  readonly client: Client;
  close(): Promise<void>;
}> {
  const server = createManagementLedgerMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "t2895-production-bootstrap", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function workerInput(
  taskId: string,
  handle: ManagedWorktreeHandle,
  baseCommit: string,
  round: number,
  startingCommit: string,
  priorCriticism: readonly string[],
) {
  return {
    taskId,
    headline: "Install deployable replacement evidence",
    description: "Run only the freshly mapped evidence task from the finalized G176 manifest.",
    acceptance: "the production bootstrap is protected through merge and release",
    worktreePath: handle.absolutePath,
    branch: handle.branch,
    baseCommit,
    round,
    startingCommit,
    ...(round === 0 ? {} : { priorResultCommit: startingCommit, priorCriticism }),
  };
}

async function completeWorker(
  client: Client,
  calls: string[],
  dispatchCapability: DispatchCapability,
  dispatch: WorkerDispatch,
  expectedChild: { readonly childId: string; readonly runId: string },
  handle: ManagedWorktreeHandle,
  baseCommit: string,
  startingCommit: string,
  changes: readonly {
    readonly kind: "add" | "modify";
    readonly path: string;
    readonly oldBody?: string;
    readonly newBody: string;
  }[],
  operationId: string,
): Promise<{ readonly receipt: GitReceipt; readonly resultCommit: string }> {
  for (const change of changes) {
    await writeFile(path.join(handle.absolutePath, change.path), change.newBody);
  }
  const receipt = await callOk<GitReceipt>(client, calls, "git_commit", {
    attestationId: dispatch.prepared.attestationId,
    generation: dispatch.prepared.generation,
    gitChangeCapability: dispatch.prepared.gitChangeCapability,
    operationId,
    expectedHead: startingCommit,
    message: `T2895 replacement evidence ${operationId}`,
    changes: changes.map((change) =>
      change.kind === "add"
        ? {
            kind: "add",
            path: change.path,
            newState: { mode: "100644", digest: sha256(change.newBody) },
          }
        : {
            kind: "modify",
            path: change.path,
            oldState: { mode: "100644", digest: sha256(change.oldBody!) },
            newState: { mode: "100644", digest: sha256(change.newBody) },
          },
    ),
  });
  invariant(FULL_SHA.test(receipt.newHead), "Git broker returned a malformed result commit");
  const output = {
    taskId: handle.taskId,
    status: "pass",
    resultCommit: receipt.newHead,
    branch: handle.branch,
    actualWorktreePath: handle.absolutePath,
    filesTouched: [...receipt.paths],
    gitReceipts: [receipt],
    checkSummary: "trusted gate delegated to result storage",
    baseVerification: {
      status: "verified",
      relation: "descendant",
      baseCommit,
      headCommit: receipt.newHead,
    },
    summary: `T2895 worker round ${String(dispatch.prepared.generation - 1)}`,
  };
  const stored = await callOk<{ readonly state: string }>(client, calls, "store_result", {
    resultCapability: dispatch.prepared.resultCapability,
    output,
  });
  invariant(stored.state === "gate-pending", "worker result bypassed supervised gate storage");
  invariant(dispatchCapability.finalizeParentGate !== undefined, "parent gate finalizer is absent");
  const finalized = await dispatchCapability.finalizeParentGate({
    attestationId: dispatch.prepared.attestationId,
    generation: dispatch.prepared.generation,
    parentGateCapability: dispatch.prepared.parentGateCapability,
  });
  invariant(finalized.state === "result-stored", "supervised worker gate did not store the result");
  await callOk(client, calls, "confirm_dispatch_completion", {
    attestationId: dispatch.prepared.attestationId,
    generation: dispatch.prepared.generation,
    nativeCompletion: {
      kind: "native-completion",
      actor: "trusted-parent",
      ...expectedChild,
      completedAt: "2026-08-29T18:00:01.000Z",
    },
    expectedProvenance: {
      roleId: dispatch.prepared.promptProvenance.roleId,
      version: dispatch.prepared.promptProvenance.version,
      promptDigest: dispatch.prepared.promptProvenance.promptDigest,
      inputDigest: dispatch.prepared.promptProvenance.inputDigest,
    },
  });
  return { receipt, resultCommit: receipt.newHead };
}

async function protectedReview(
  client: Client,
  calls: string[],
  taskRef: string,
  resultCommit: string,
  worker: WorkerDispatch["prepared"],
  operationSuffix: string,
) {
  const panel = await callOk<{
    readonly panelRef: string;
    readonly attemptRefs: readonly string[];
  }>(client, calls, "prepare_implementation_review_panel", {
    task_ref: taskRef,
    result_commit: resultCommit,
    worker_dispatch: {
      attestationId: worker.attestationId,
      generation: worker.generation,
    },
    operation_id: `t2895-panel-${operationSuffix}`,
    author: "t2895-parent",
  });
  invariant(
    panel.attemptRefs.length === 1,
    "production review roster was not bounded to one attempt",
  );
  const attemptRef = panel.attemptRefs[0]!;
  const prepared = await callOk<{ readonly launch: string }>(
    client,
    calls,
    "prepare_implementation_review_attempt",
    {
      panel_ref: panel.panelRef,
      attempt_ref: attemptRef,
      operation_id: `t2895-attempt-${operationSuffix}`,
      author: "t2895-parent",
    },
  );
  invariant(
    prepared.launch === "adapter",
    "fixture expected the configured protected adapter path",
  );
  await callOk(client, calls, "execute_external_implementation_review_attempt", {
    attempt_ref: attemptRef,
    operation_id: `t2895-execute-${operationSuffix}`,
    author: "t2895-parent",
  });
  const finalized = await callOk<{
    readonly status: string;
    readonly terminalState: string;
    readonly outcome: {
      readonly kind: string;
      readonly verdict?: { readonly verdict: string; readonly criticism: readonly string[] };
    };
  }>(client, calls, "finalize_implementation_review_attempt", {
    attempt_ref: attemptRef,
    operation_id: `t2895-finalize-${operationSuffix}`,
    author: "t2895-parent",
  });
  return { panel, attemptRef, finalized };
}

export interface ProductionBootstrapFixtureObservation {
  readonly baselineCommit: string;
  readonly exactBaselineArtifacts: boolean;
  readonly baselineSourceSelectedOnlyEvidence: boolean;
  readonly baselineManagementProfileUsed: boolean;
  readonly ledgerBackend: string;
  readonly attestationBackend: string;
  readonly workerDispatches: number;
  readonly workerTaskIdsMatchFreshMapping: boolean;
  readonly workerGenerations: readonly number[];
  readonly firstReviewState: string;
  readonly firstReviewCriticism: readonly string[];
  readonly firstReviewExcludedRawDiagnostics: boolean;
  readonly correctionConsumedFinalizedOutcome: boolean;
  readonly supervisedGateRuns: number;
  readonly secondReviewState: string;
  readonly mergeAcknowledged: boolean;
  readonly recordedStatus: string;
  readonly releaseStatus: string;
  readonly worktreesAfterRelease: number;
  readonly deploymentHandoffStatus: string;
  readonly bootstrapStatus: string;
  readonly bootstrapReplayStatus: string;
  readonly bootstrapTaskRefsMatchFreshMapping: boolean;
  readonly bootstrapRefValid: boolean;
  readonly bootstrapExpectedServiceCommitMatches: boolean;
  readonly wrongHeadRejected: boolean;
  readonly wrongManifestRejected: boolean;
  readonly resultCommitIsFullSha: boolean;
  readonly resultDescendsBaseline: boolean;
  readonly historicalTaskDispatches: number;
  readonly operatorActions: number;
}

export async function runProductionBootstrapFixture(): Promise<ProductionBootstrapFixtureObservation> {
  const manifest = JSON.parse(await readFile(FIXTURE_URL, "utf8")) as FixtureManifest;
  invariant(manifest.version === 1, "fixture version is unsupported");
  invariant(FULL_SHA.test(manifest.baselineCommit), "baseline commit is malformed");
  const scratch = await mkdtemp(path.join(tmpdir(), "t2895-production-bootstrap-"));
  const stateHome = path.join(scratch, "xdg-state");
  const repositoryRoot = path.join(scratch, "repository");
  const previousStateHome = process.env["XDG_STATE_HOME"];
  const previousHarness = process.env["CQ_HARNESS"];
  let resolved: Awaited<ReturnType<typeof createLedgerStore>> | undefined;
  let backend: FsAttestationBackend | undefined;
  let firstConnection: Awaited<ReturnType<typeof connect>> | undefined;
  let deployedConnection: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    process.env["XDG_STATE_HOME"] = stateHome;
    process.env["CQ_HARNESS"] = "codex";
    await mkdir(stateHome, { recursive: true });
    const sourceRoot = await git(process.cwd(), ["rev-parse", "--show-toplevel"]);
    const cloned = await command(scratch, "git", [
      "clone",
      "-q",
      "--no-checkout",
      sourceRoot,
      repositoryRoot,
    ]);
    invariant(cloned.code === 0, `baseline clone failed: ${cloned.stderr}`);
    await git(repositoryRoot, ["checkout", "-q", "-B", "main", manifest.baselineCommit]);
    await git(repositoryRoot, ["config", "user.name", "T2895 production fixture"]);
    await git(repositoryRoot, ["config", "user.email", "t2895@example.invalid"]);
    await git(repositoryRoot, ["config", "commit.gpgsign", "false"]);
    await writeFile(
      path.join(repositoryRoot, ".git", "info", "exclude"),
      "\n.claude/worktrees/\n.cq/attestations/\n",
      { flag: "a" },
    );
    invariant(
      (await git(repositoryRoot, ["rev-parse", "HEAD"])) === manifest.baselineCommit,
      "temporary production repository did not start at the exact baseline",
    );

    const artifactBytes = await Promise.all(
      manifest.baselineArtifacts.map(async (artifact) => ({
        ...artifact,
        bytes: await readFile(path.join(repositoryRoot, artifact.path)),
      })),
    );
    const exactBaselineArtifacts = artifactBytes.every(
      (artifact) => sha256(artifact.bytes) === artifact.sha256,
    );
    invariant(exactBaselineArtifacts, "baseline source/generated/profile bytes changed");
    const sourceCommand = new TextDecoder().decode(
      artifactBytes.find((artifact) => artifact.kind === "source-command")!.bytes,
    );
    const managementProfile = new TextDecoder().decode(
      artifactBytes.find((artifact) => artifact.kind === "management-profile")!.bytes,
    );
    invariant(
      sourceCommand.includes("manifest-derived bootstrap mode"),
      "baseline bootstrap branch is absent",
    );
    invariant(
      !sourceCommand.includes("advance_implementation_evidence_bootstrap"),
      "baseline source was silently upgraded",
    );
    invariant(
      !managementProfile.includes('"advance_implementation_evidence_bootstrap"'),
      "baseline management profile was silently upgraded",
    );

    resolved = await createLedgerStore(repositoryRoot);
    invariant(resolved.backend === "xdg", "fixture did not select the production XDG backend");
    invariant(
      resolved.implementationEvidenceStore !== undefined,
      "XDG implementation-evidence journal is unavailable",
    );
    const lifecycle = resolved.store as typeof resolved.store & PlanLifecycleStore;
    const goalId = manifest.goalRef.slice("goals:".length);
    await resolved.store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: goalId,
      status: "clarifying",
      fields: {
        title: "Deploy replacement implementation evidence",
        description: "Exercise the exact finalized G176 production bootstrap.",
      },
    });
    const claim = await lifecycle.claimPlan({
      goalId,
      purpose: "initial",
      claimRequestId: "t2895-plan-claim-v1",
      ownerFenceToken: "T".repeat(22),
      expectedGeneration: null,
      author: "t2895-planner",
      session: "t2895-production-bootstrap",
    });
    invariant(claim.ok, "fresh G176 plan claim failed");
    const publishedResult = await lifecycle.publishPlanDraft({
      goalId,
      claimId: claim.acknowledgement.claimId,
      generation: claim.acknowledgement.generation,
      operationId: "t2895-plan-publish-v1",
      ownerFenceToken: claim.acknowledgement.ownerFenceToken,
      author: "t2895-planner",
      session: "t2895-production-bootstrap",
      manifest: {
        milestones: [{ key: "m-replacement-evidence", title: "Replacement evidence" }],
        tasks: [
          {
            key: manifest.taskKeys[0],
            milestoneKey: "m-replacement-evidence",
            headline: "Install replacement evidence service",
            description: "Install the deployable replacement-evidence state machine.",
            acceptance: "the protected production bootstrap reaches its deployment handoff",
            suggestedModel: "frontier",
            ledgerRefs: [manifest.goalRef],
          },
          {
            key: manifest.taskKeys[1],
            milestoneKey: "m-replacement-evidence",
            headline: "Record historical implementation evidence",
            description: "Record the protected historical implementation cohort.",
            acceptance: "the exact protected historical record is terminal",
            suggestedModel: "frontier",
            ledgerRefs: [manifest.goalRef],
            dependsOn: [{ kind: "draft-task", key: manifest.taskKeys[0] }],
          },
          {
            key: manifest.taskKeys[2],
            milestoneKey: "m-replacement-evidence",
            headline: "Activate replacement implementation evidence",
            description:
              "CQ-OPERATOR-ACTION v1 activate-implementation-evidence. Deploy the historical result and verify service status.",
            acceptance: "authenticated status reports the exact deployed service commit",
            suggestedModel: "frontier",
            ledgerRefs: [manifest.goalRef],
            dependsOn: [{ kind: "draft-task", key: manifest.taskKeys[1] }],
          },
        ],
      },
    });
    invariant(publishedResult.ok, "fresh G176 manifest publication failed");
    const published = publishedResult.acknowledgement.manifest;
    const reviewId = "R2895";
    await resolved.store.createItem(REVIEWS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: reviewId,
      status: "go-ahead",
      fields: {
        summary: "approve the exact replacement-evidence manifest",
        [PLAN_REVIEW_DRAFT_FIELD]: JSON.stringify({
          goalId,
          claimId: claim.acknowledgement.claimId,
          generation: claim.acknowledgement.generation,
          revision: published.revision,
        }),
        ledgerRefs: [manifest.goalRef],
      },
      author: "t2895-plan-reviewer",
      session: "t2895-production-bootstrap",
    });
    const finalizedResult = await lifecycle.finalizePlan({
      goalId,
      claimId: claim.acknowledgement.claimId,
      generation: claim.acknowledgement.generation,
      operationId: "t2895-plan-finalize-v1",
      ownerFenceToken: claim.acknowledgement.ownerFenceToken,
      reviewId,
      draftRevision: published.revision,
      decision: { headline: "Ship replacement evidence" },
      author: "t2895-planner",
      session: "t2895-production-bootstrap",
    });
    invariant(finalizedResult.ok, "fresh G176 manifest finalization failed");
    const finalizedManifest = resolved.store.fetchItem(GOALS_LEDGER, goalId).fields[
      "planFinalizedManifest"
    ];
    invariant(typeof finalizedManifest === "string", "finalized G176 manifest bytes are absent");
    const finalizedManifestDigest = sha256(finalizedManifest);
    const milestoneId = published.milestones.find(
      ({ key }) => key === "m-replacement-evidence",
    )?.id;
    const taskId = (key: string) => published.tasks.find((task) => task.key === key)?.id;
    const evidenceTaskId = taskId(manifest.taskKeys[0]);
    const historicalTaskId = taskId(manifest.taskKeys[1]);
    const activationTaskId = taskId(manifest.taskKeys[2]);
    invariant(milestoneId !== undefined, "fresh finalized milestone mapping is absent");
    invariant(evidenceTaskId !== undefined, "fresh t-evidence mapping is absent");
    invariant(historicalTaskId !== undefined, "fresh t-historical-evidence mapping is absent");
    invariant(activationTaskId !== undefined, "fresh t-activate-evidence mapping is absent");
    const mappings = resolveImplementationEvidenceActivationTaskMappings(
      published,
      D347_IMPLEMENTATION_EVIDENCE_ACTIVATION_RULE,
    );
    const predicates = derivePredicates(resolved.store);
    const baselineSelection = predicates.pImplement.items;
    const baselineSourceSelectedOnlyEvidence =
      mappings.evidenceTaskRef === `tasks:${evidenceTaskId}` &&
      JSON.stringify(baselineSelection) === JSON.stringify([evidenceTaskId]);
    invariant(
      baselineSourceSelectedOnlyEvidence,
      "baseline selected an omitted, predecessor, or surplus task",
    );
    invariant(
      (await listManagedLiveWorktrees(repositoryRoot, evidenceTaskId)).length === 0,
      "worktree existed before selection",
    );

    const namespace: AttestationNamespace = {
      backend: "fs",
      projectKey: resolved.projectKey ?? `t2895-${crypto.randomUUID()}`,
    };
    backend = new FsAttestationBackend({
      namespace,
      root: fsAttestationProductionRoot(repositoryRoot),
    });
    const gateRunner = new ObservedGreenGateRunner();
    const dispatchCapability = createDispatchCapability({
      backend,
      promptArtifactStore: promptArtifactStore(),
      repositoryRoot,
      supervisedWorkerGateRunner: gateRunner,
      randomBytes: sequentialDispatchRandomBytes(2895),
    });
    const reviewResults: string[] = [];
    const reviewRunner = async ({
      identity,
      prompt,
    }: {
      readonly identity: { readonly adapterId: string };
      readonly prompt: string;
    }) => {
      const resultCommit = /Result commit: ([0-9a-f]{40})/u.exec(prompt)?.[1];
      invariant(resultCommit !== undefined, "protected reviewer prompt omitted result commit");
      const verdict = reviewResults.length === 0 ? "disapprove" : "approve";
      const output = {
        taskId: evidenceTaskId,
        verdict,
        criticism: verdict === "disapprove" ? [manifest.knownCriticism] : [],
        questions: [],
        defects: [],
        rationale: verdict === "disapprove" ? "bounded correction required" : "correction verified",
        gateReRan: false,
        gateReRanReason: "sandbox-denied-primitives",
        resultCommitVerified: true,
        resultCommitEvidence: { status: "verified", resultCommit, branchTip: resultCommit },
        baseAncestry: {
          status: "verified",
          relation: "descendant",
          baseCommit: manifest.baselineCommit,
          resultCommit,
          mergeBase: manifest.baselineCommit,
        },
      };
      reviewResults.push(verdict);
      return {
        adapterIdentity: identity.adapterId,
        stdout: JSON.stringify(output),
        stderr: "PRIVATE_ADAPTER_DIAGNOSTIC_MUST_NOT_ESCAPE",
        exitCode: verdict === "disapprove" ? 17 : 0,
      };
    };
    const implementationEvidence = createProductionImplementationEvidenceService({
      resolved,
      dispatchCapability,
      repositoryRoot,
      environment: { ...process.env, CQ_HARNESS: "codex" },
      externalReviewRunner: reviewRunner,
    });
    const worktreeManage = createWorktreeManageCapability(repositoryRoot, {
      ...(dispatchCapability.resolveContinuation === undefined
        ? {}
        : { resolveDispatchContinuation: dispatchCapability.resolveContinuation }),
      deps: { skipInstall: true },
    });
    const serverOptions = {
      store: resolved.store,
      displayName: "T2895 production bootstrap fixture",
      configRoot: resolved.configRoot,
      ...(resolved.projectKey === undefined ? {} : { projectKey: resolved.projectKey }),
      repositoryRoot,
      dispatchCapability,
      worktreeManage,
      implementationEvidence,
    };
    firstConnection = await connect(serverOptions);
    const calls: string[] = [];
    const baseCommit = manifest.baselineCommit;
    const prepared = await callOk<{
      readonly status: string;
      readonly handle: ManagedWorktreeHandle;
    }>(firstConnection.client, calls, "worktree_manage", {
      operation: "prepare",
      taskId: evidenceTaskId,
      baseCommit,
    });
    invariant(prepared.status === "prepared", "evidence worktree was not prepared");
    await callOk(firstConnection.client, calls, "update_item", {
      ledger_id: TASKS_LEDGER,
      item_id: evidenceTaskId,
      status: "wip",
    });

    const workerTaskIds: string[] = [];
    const workerGenerations: number[] = [];
    const firstChild = { childId: "t2895-evidence-r0", runId: "t2895-evidence-r0-run" };
    const firstDispatch = await callOk<WorkerDispatch>(
      firstConnection.client,
      calls,
      "prepare_dispatch",
      {
        roleId: "implement-worker",
        input: workerInput(evidenceTaskId, prepared.handle, baseCommit, 0, baseCommit, []),
        idempotencyKey: "t2895-evidence-r0",
        timeoutMs: 600_000,
        expectedChild: firstChild,
      },
    );
    invariant(firstDispatch.accepted, "initial evidence dispatch was rejected");
    const firstInput = await callOk<{ readonly input: { readonly taskId: string } }>(
      firstConnection.client,
      calls,
      "fetch_dispatch_input",
      {
        attestationId: firstDispatch.prepared.attestationId,
        generation: firstDispatch.prepared.generation,
        inputCapability: firstDispatch.prepared.inputCapability,
      },
    );
    workerTaskIds.push(firstInput.input.taskId);
    workerGenerations.push(firstDispatch.prepared.generation);
    const firstWip = serializeWipArtifact({
      id: evidenceTaskId,
      role: "implement-worker",
      baseCommit,
      startedAt: "2026-08-29T18:00:00.000Z",
      checkpoints: [
        { name: "replacement evidence", status: "done", body: "Initial candidate.\n" },
        { name: "trusted full gate", status: "unmeasured", body: "Delegated.\n" },
      ],
      complete: false,
      openCheckpoints: ["trusted full gate"],
    });
    const firstEvidence = "export const replacementEvidence = 'candidate';\n";
    const firstWorker = await completeWorker(
      firstConnection.client,
      calls,
      dispatchCapability,
      firstDispatch,
      firstChild,
      prepared.handle,
      baseCommit,
      baseCommit,
      [
        { kind: "add", path: `WIP-${evidenceTaskId}.md`, newBody: firstWip },
        { kind: "add", path: "replacement-evidence.ts", newBody: firstEvidence },
      ],
      "t2895-evidence-r0-change",
    );
    const firstReview = await protectedReview(
      firstConnection.client,
      calls,
      `tasks:${evidenceTaskId}`,
      firstWorker.resultCommit,
      firstDispatch.prepared,
      "r0",
    );
    invariant(
      firstReview.finalized.terminalState === "disapproved",
      "first review assumed approval",
    );
    invariant(
      firstReview.finalized.outcome.kind === "verdict",
      "first review lost its bounded verdict",
    );
    const firstCriticism = firstReview.finalized.outcome.verdict?.criticism ?? [];
    invariant(
      JSON.stringify(firstCriticism) === JSON.stringify([manifest.knownCriticism]),
      "first finalizer did not return the exact criticism",
    );
    const firstReviewExcludedRawDiagnostics = !JSON.stringify(firstReview.finalized).includes(
      "PRIVATE_ADAPTER_DIAGNOSTIC_MUST_NOT_ESCAPE",
    );
    invariant(firstReviewExcludedRawDiagnostics, "finalizer exposed raw adapter diagnostics");

    const continuation = await callOk<{
      readonly status: string;
      readonly liveTip: string;
      readonly continuationReference: string;
    }>(firstConnection.client, calls, "worktree_manage", {
      operation: "resolve-dispatch-continuation",
      handle: prepared.handle,
    });
    invariant(
      continuation.liveTip === firstWorker.resultCommit,
      "continuation observed a stale tip",
    );
    const secondChild = { childId: "t2895-evidence-r1", runId: "t2895-evidence-r1-run" };
    const secondDispatch = await callOk<WorkerDispatch>(
      firstConnection.client,
      calls,
      "prepare_dispatch",
      {
        roleId: "implement-worker",
        input: workerInput(
          evidenceTaskId,
          prepared.handle,
          baseCommit,
          1,
          firstWorker.resultCommit,
          firstCriticism,
        ),
        idempotencyKey: "t2895-evidence-r1",
        timeoutMs: 600_000,
        expectedChild: secondChild,
        continuation: continuation.continuationReference,
      },
    );
    invariant(
      secondDispatch.prepared.attestationId === firstDispatch.prepared.attestationId &&
        secondDispatch.prepared.generation === firstDispatch.prepared.generation + 1,
      "correction did not retain the consumed-worker continuation",
    );
    const secondInput = await callOk<{
      readonly input: { readonly taskId: string; readonly priorCriticism: readonly string[] };
    }>(firstConnection.client, calls, "fetch_dispatch_input", {
      attestationId: secondDispatch.prepared.attestationId,
      generation: secondDispatch.prepared.generation,
      inputCapability: secondDispatch.prepared.inputCapability,
    });
    workerTaskIds.push(secondInput.input.taskId);
    workerGenerations.push(secondDispatch.prepared.generation);
    const correctionConsumedFinalizedOutcome =
      JSON.stringify(secondInput.input.priorCriticism) === JSON.stringify(firstCriticism);
    invariant(correctionConsumedFinalizedOutcome, "correction substituted non-finalized criticism");
    const secondWip = firstWip.replace("Initial candidate.", "Corrected candidate.");
    const secondEvidence = "export const replacementEvidence = 'corrected';\n";
    const secondWorker = await completeWorker(
      firstConnection.client,
      calls,
      dispatchCapability,
      secondDispatch,
      secondChild,
      prepared.handle,
      baseCommit,
      firstWorker.resultCommit,
      [
        {
          kind: "modify",
          path: `WIP-${evidenceTaskId}.md`,
          oldBody: firstWip,
          newBody: secondWip,
        },
        {
          kind: "modify",
          path: "replacement-evidence.ts",
          oldBody: firstEvidence,
          newBody: secondEvidence,
        },
      ],
      "t2895-evidence-r1-change",
    );
    const secondReview = await protectedReview(
      firstConnection.client,
      calls,
      `tasks:${evidenceTaskId}`,
      secondWorker.resultCommit,
      secondDispatch.prepared,
      "r1",
    );
    invariant(
      secondReview.finalized.terminalState === "approved",
      "corrected candidate was not approved",
    );
    const mergeOperationId = "t2895-evidence-merge-v1";
    const completion = await callOk<{
      readonly completionRef: string;
      readonly evidenceFingerprint: string;
    }>(firstConnection.client, calls, "prepare_implementation_completion", {
      task_ref: `tasks:${evidenceTaskId}`,
      expected_repository_head: baseCommit,
      result_commit: secondWorker.resultCommit,
      worker_dispatch: {
        attestationId: secondDispatch.prepared.attestationId,
        generation: secondDispatch.prepared.generation,
      },
      review_attempt_refs: [secondReview.attemptRef],
      completion: "Deployable replacement evidence installed",
      log_paths: [".cq/logs/t2895-worker.md", ".cq/logs/t2895-review.md"],
      merge_operation_id: mergeOperationId,
      operation_id: "t2895-evidence-completion-v1",
      author: "t2895-parent",
    });
    const cqCli = new URL("../../../../cq-cli/src/main.ts", import.meta.url).pathname;
    const merged = await command(repositoryRoot, process.execPath, [
      cqCli,
      "gate",
      "git-effect",
      "--operation",
      "merge",
      "--cwd",
      repositoryRoot,
      "--task-id",
      evidenceTaskId,
      "--commit",
      secondWorker.resultCommit,
      "--completion-ref",
      completion.completionRef,
      "--operation-id",
      mergeOperationId,
    ]);
    invariant(merged.code === 0, `protected merge failed: ${merged.stderr}`);
    const mergePrefix = "CQ_IMPLEMENTATION_COMPLETION_MERGE=";
    invariant(merged.stdout.startsWith(mergePrefix), "protected merge acknowledgement is absent");
    const mergeAcknowledgement = JSON.parse(merged.stdout.slice(mergePrefix.length)) as {
      readonly status: string;
      readonly resultCommit: string;
      readonly evidenceFingerprint: string;
    };
    const mergeAcknowledged =
      ["merged", "existing"].includes(mergeAcknowledgement.status) &&
      mergeAcknowledgement.resultCommit === secondWorker.resultCommit &&
      mergeAcknowledgement.evidenceFingerprint === completion.evidenceFingerprint;
    invariant(mergeAcknowledged, "protected merge acknowledgement was mismatched");
    const recorded = await callOk<{ readonly status: string; readonly resultCommit: string }>(
      firstConnection.client,
      calls,
      "record_implementation_completion",
      {
        task_ref: `tasks:${evidenceTaskId}`,
        expected_repository_head: secondWorker.resultCommit,
        operation_id: "t2895-evidence-record-v1",
        author: "t2895-parent",
      },
    );
    invariant(
      recorded.resultCommit === secondWorker.resultCommit,
      "terminal recording changed result commit",
    );
    const deploymentHandoff = await resolved.store.createItem(HANDOFFS_LEDGER, milestoneId, {
      status: "user-action-required",
      fields: {
        summary: "Deploy and restart the evidence service at the exact replacement result.",
        flow: "implement",
        ledgerRefs: [manifest.goalRef, `tasks:${evidenceTaskId}`],
        handoffReasons: [`deploy ${secondWorker.resultCommit}`],
      },
    });
    const released = await callOk<{ readonly status: string }>(
      firstConnection.client,
      calls,
      "worktree_manage",
      {
        operation: "release",
        handle: prepared.handle,
        terminalDisposition: "done",
        resultCommit: secondWorker.resultCommit,
        deleteBranch: true,
      },
    );
    const worktreesAfterRelease = (await listManagedLiveWorktrees(repositoryRoot, evidenceTaskId))
      .length;
    invariant(worktreesAfterRelease === 0, "guarded release retained the evidence worktree");
    invariant(
      !(await stat(prepared.handle.absolutePath)
        .then(() => true)
        .catch(() => false)),
      "released evidence worktree remains on disk",
    );
    const firstPhaseCalls = [...calls];
    const baselineManagementProfileUsed = firstPhaseCalls.every((name) =>
      managementProfile.includes(`"${name}"`),
    );
    invariant(
      baselineManagementProfileUsed,
      "first phase used a tool absent from the baseline profile",
    );
    await firstConnection.close();
    firstConnection = undefined;

    const deployedEvidence = createProductionImplementationEvidenceService({
      resolved,
      dispatchCapability,
      repositoryRoot,
      environment: { ...process.env, CQ_HARNESS: "codex" },
      externalReviewRunner: reviewRunner,
    });
    deployedConnection = await connect({
      ...serverOptions,
      implementationEvidence: deployedEvidence,
    });
    const deployedCalls: string[] = [];
    const bootstrapInput = {
      goal_ref: manifest.goalRef,
      finalized_manifest_digest: finalizedManifestDigest,
      expected_repository_head: secondWorker.resultCommit,
      expected_phase: "historical-dispatch",
      operation_id: "t2895-bootstrap-historical-v1",
      author: "t2895-parent",
    };
    const bootstrap = await callOk<{
      readonly status: string;
      readonly bootstrapRef: string;
      readonly taskRefs: readonly string[];
      readonly expectedServiceCommit: string;
    }>(
      deployedConnection.client,
      deployedCalls,
      "advance_implementation_evidence_bootstrap",
      bootstrapInput,
    );
    const replay = await callOk<{ readonly status: string }>(
      deployedConnection.client,
      deployedCalls,
      "advance_implementation_evidence_bootstrap",
      bootstrapInput,
    );
    const wrongHead = await callRejected(
      deployedConnection.client,
      deployedCalls,
      "advance_implementation_evidence_bootstrap",
      {
        ...bootstrapInput,
        expected_repository_head: baseCommit,
        operation_id: "t2895-bootstrap-wrong-head",
      },
    );
    const wrongManifest = await callRejected(
      deployedConnection.client,
      deployedCalls,
      "advance_implementation_evidence_bootstrap",
      {
        ...bootstrapInput,
        finalized_manifest_digest: sha256("wrong finalized manifest"),
        operation_id: "t2895-bootstrap-wrong-manifest",
      },
    );
    const resultDescendsBaseline =
      (
        await command(repositoryRoot, "git", [
          "merge-base",
          "--is-ancestor",
          baseCommit,
          secondWorker.resultCommit,
        ])
      ).code === 0;
    const historicalTaskDispatches = workerTaskIds.filter((id) => id === historicalTaskId).length;
    return {
      baselineCommit: manifest.baselineCommit,
      exactBaselineArtifacts,
      baselineSourceSelectedOnlyEvidence,
      baselineManagementProfileUsed,
      ledgerBackend: resolved.backend,
      attestationBackend: "fs",
      workerDispatches: workerTaskIds.length,
      workerTaskIdsMatchFreshMapping: workerTaskIds.every((id) => id === evidenceTaskId),
      workerGenerations,
      firstReviewState: firstReview.finalized.terminalState,
      firstReviewCriticism: firstCriticism,
      firstReviewExcludedRawDiagnostics,
      correctionConsumedFinalizedOutcome,
      supervisedGateRuns: gateRunner.requests.length,
      secondReviewState: secondReview.finalized.terminalState,
      mergeAcknowledged,
      recordedStatus: recorded.status,
      releaseStatus: released.status,
      worktreesAfterRelease,
      deploymentHandoffStatus: deploymentHandoff.status,
      bootstrapStatus: bootstrap.status,
      bootstrapReplayStatus: replay.status,
      bootstrapTaskRefsMatchFreshMapping:
        JSON.stringify(bootstrap.taskRefs) === JSON.stringify([`tasks:${historicalTaskId}`]),
      bootstrapRefValid: /^cq-implementation-evidence-bootstrap:v1:[0-9a-f]{64}$/u.test(
        bootstrap.bootstrapRef,
      ),
      bootstrapExpectedServiceCommitMatches:
        bootstrap.expectedServiceCommit === secondWorker.resultCommit,
      wrongHeadRejected: /repository head/u.test(wrongHead),
      wrongManifestRejected: /finalized manifest/u.test(wrongManifest),
      resultCommitIsFullSha: FULL_SHA.test(secondWorker.resultCommit),
      resultDescendsBaseline,
      historicalTaskDispatches,
      operatorActions: ledgerItemIds(resolved.store, OPERATOR_ACTIONS_LEDGER).length,
    };
  } finally {
    if (deployedConnection !== undefined) await deployedConnection.close();
    if (firstConnection !== undefined) await firstConnection.close();
    if (backend !== undefined) await backend.close();
    if (resolved !== undefined) await resolved.store.dispose();
    if (previousStateHome === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = previousStateHome;
    if (previousHarness === undefined) delete process.env["CQ_HARNESS"];
    else process.env["CQ_HARNESS"] = previousHarness;
    await rm(scratch, { recursive: true, force: true });
  }
}
