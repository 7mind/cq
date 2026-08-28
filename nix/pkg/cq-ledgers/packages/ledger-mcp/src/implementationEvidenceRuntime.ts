import {
  IMPLEMENT_REVIEWER_SYNTHESIS_STORE_RESERVE_MS,
  defaultPanelFor,
  implementReviewerSidecar,
  implementationAuditorSidecar,
  implementWorkerSidecar,
  implementWorkerSupervisedGateEvidenceSchema,
  loadConfig,
  resolveActiveHarness,
  routeDispatchTransport,
  validateAgainstSchema,
  type DispatchJSONValue,
} from "@cq/config";
import {
  GOALS_LEDGER,
  ImplementationEvidenceService,
  PLAN_FINALIZED_MANIFEST_FIELD,
  PlanPublishedManifestSchema,
  SUPERVISED_WORKER_GATE_EXECUTION_TIMEOUT_MS,
  TASKS_LEDGER,
  nodeGitRunner,
  readCanonicalOwnership,
  operatorActionDirectiveForTask,
  readPackagedImplementationAuditManifest,
  deriveImplementationEvidenceActivationCohort,
  resolveImplementationEvidenceActivationTaskMappings,
  recordProtectedImplementationCompletion,
  type DispatchCapability,
  type ImplementationEvidenceServiceDependencies,
  type ImplementationReviewerIdentity,
  type PackagedImplementationAuditManifest,
  type ExternalReviewProcessObservation,
  type ResolvedLedgerStore,
} from "@cq/ledger";
import { computeReviewers } from "./configCapability.js";

const FULL_SHA = /^[0-9a-f]{40}$/u;

const PRODUCTION_IMPLEMENTATION_REVIEWER_TIMEOUT_MS =
  SUPERVISED_WORKER_GATE_EXECUTION_TIMEOUT_MS + IMPLEMENT_REVIEWER_SYNTHESIS_STORE_RESERVE_MS;

type ExternalReviewRunner = (input: {
  readonly identity: ImplementationReviewerIdentity;
  readonly prompt: string;
  readonly repositoryRoot: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}) => Promise<ExternalReviewProcessObservation>;

function object(value: unknown): value is Record<string, DispatchJSONValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : [];
}

function reviewerCommand(
  identity: ImplementationReviewerIdentity,
  repositoryRoot: string,
  prompt: string,
): readonly string[] {
  if (identity.harness === "codex") {
    return [
      "codex",
      "exec",
      "--ephemeral",
      "--color",
      "never",
      "-C",
      repositoryRoot,
      "-m",
      identity.model,
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      "features.multi_agent=false",
      "-",
    ];
  }
  if (identity.harness === "claude") {
    return [
      "claude",
      "--print",
      "--no-session-persistence",
      "--model",
      identity.model,
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "text",
      ...(identity.effort === null || identity.effort === undefined
        ? []
        : ["--effort", identity.effort]),
    ];
  }
  const piModel = identity.provider === null
    ? identity.model
    : `${identity.provider}/${identity.model}`;
  return [
    "pi",
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--mode",
    "text",
    "--model",
    piModel,
    ...(identity.effort === null || identity.effort === undefined
      ? []
      : ["--thinking", identity.effort]),
    prompt,
  ];
}

async function runExternalReviewer(input: {
  readonly identity: ImplementationReviewerIdentity;
  readonly prompt: string;
  readonly repositoryRoot: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): Promise<ExternalReviewProcessObservation> {
  const command = [...reviewerCommand(input.identity, input.repositoryRoot, input.prompt)];
  const process = Bun.spawn(command, {
    cwd: input.repositoryRoot,
    env: input.environment,
    stdin: input.identity.harness === "pi" ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input.identity.harness !== "pi") {
    const stdin = process.stdin;
    if (stdin === undefined) throw new Error("external reviewer process has no stdin pipe");
    stdin.write(input.prompt);
    stdin.end();
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      process.kill();
      reject(
        new Error(
          `external implementation reviewer timed out after ${PRODUCTION_IMPLEMENTATION_REVIEWER_TIMEOUT_MS}ms`,
        ),
      );
    }, PRODUCTION_IMPLEMENTATION_REVIEWER_TIMEOUT_MS);
  });
  let settled: [string, string, number];
  try {
    settled = await Promise.race([
      Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]),
      timedOut,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  const [stdout, stderr, exitCode] = settled;
  return {
    adapterIdentity: input.identity.adapterId,
    stdout,
    stderr,
    exitCode,
  };
}

function externalReviewPrompt(
  panel: { readonly taskRef: string; readonly resultCommit: string },
  workerInput: Record<string, DispatchJSONValue>,
  workerOutput: Record<string, DispatchJSONValue>,
): string {
  return [
    "Act as the CQ implement-reviewer for the bound implementation below.",
    "Inspect the repository and exact result commit, rerun the canonical full gate, and return only one JSON object matching the supplied output schema.",
    "Do not modify the repository. Approval requires an empty criticism and questions array.",
    `Task ref: ${panel.taskRef}`,
    `Result commit: ${panel.resultCommit}`,
    `Acceptance: ${typeof workerInput["acceptance"] === "string" ? workerInput["acceptance"] : ""}`,
    `Worker result: ${JSON.stringify(workerOutput)}`,
    `Output JSON Schema: ${JSON.stringify(implementReviewerSidecar.outputSchema)}`,
  ].join("\n\n");
}

function externalAuditPrompt(panel: {
  readonly auditInput: DispatchJSONValue;
}): string {
  return [
    "Act as the CQ implementation-auditor for the trusted packaged historical record below.",
    "This is read-only historical verification, not an implement-reviewer worktree review.",
    "Return only one JSON object matching the supplied output schema.",
    `Audit input: ${JSON.stringify(panel.auditInput)}`,
    `Output JSON Schema: ${JSON.stringify(implementationAuditorSidecar.outputSchema)}`,
  ].join("\n\n");
}

function reviewerIdentity(
  reviewer: {
    readonly alias: string;
    readonly harness: string;
    readonly model: string;
    readonly provider: string | null;
    readonly effort?: string | null;
  },
  activeHarness: ReturnType<typeof resolveActiveHarness>,
  forceShellout: boolean,
): ImplementationReviewerIdentity {
  if (reviewer.harness !== "claude" && reviewer.harness !== "codex" && reviewer.harness !== "pi") {
    throw new Error(`configured implementation reviewer harness ${reviewer.harness} is unsupported`);
  }
  const route = routeDispatchTransport({
    activeHarness,
    targetHarness: reviewer.harness,
    forceShellout,
  });
  return {
    alias: reviewer.alias,
    harness: reviewer.harness,
    model: reviewer.model,
    provider: reviewer.provider,
    effort: reviewer.effort ?? null,
    launch: route.transport === "native" ? "native" : "adapter",
    adapterId: route.adapterId,
  };
}

function nativeFallbackIdentity(
  activeHarness: ReturnType<typeof resolveActiveHarness>,
): ImplementationReviewerIdentity {
  const fallback = defaultPanelFor(activeHarness).reviewers[0];
  if (fallback === undefined) throw new Error("active harness has no native reviewer fallback");
  return {
    alias: fallback.alias,
    harness: activeHarness,
    model: fallback.token.model,
    provider: activeHarness === "pi" ? fallback.token.provider : null,
    effort: fallback.token.effort ?? null,
    launch: "native",
    adapterId: `${activeHarness}:native`,
  };
}

async function gitOutput(
  repositoryRoot: string,
  args: readonly string[],
  label: string,
): Promise<string> {
  const result = await nodeGitRunner(repositoryRoot)(args);
  if (result.code !== 0) throw new Error(`${label} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export async function verifyProductionImplementation(
  repositoryRoot: string,
  resultCommit: string,
  workerInput: Record<string, DispatchJSONValue>,
  workerOutput: Record<string, DispatchJSONValue>,
) {
  if (!validateAgainstSchema(implementWorkerSidecar.outputSchema, workerOutput).ok) {
    throw new Error("worker result does not match the implement-worker output contract");
  }
  const baseVerification = workerOutput["baseVerification"];
  if (!object(baseVerification) || baseVerification["status"] !== "verified") {
    throw new Error("worker result lacks verified base evidence");
  }
  const baseCommit = baseVerification["baseCommit"];
  if (typeof baseCommit !== "string" || !FULL_SHA.test(baseCommit)) {
    throw new Error("worker result base commit is malformed");
  }
  const startingCommitValue = workerOutput["gitLineage"];
  const dispatchedStartingCommit = workerInput["startingCommit"];
  const startingCommit =
    object(startingCommitValue) &&
    typeof startingCommitValue["rebasedStartCommit"] === "string" &&
    FULL_SHA.test(startingCommitValue["rebasedStartCommit"])
      ? startingCommitValue["rebasedStartCommit"]
      : typeof dispatchedStartingCommit === "string" && FULL_SHA.test(dispatchedStartingCommit)
        ? dispatchedStartingCommit
        : baseCommit;
  if ((await gitOutput(repositoryRoot, ["cat-file", "-t", resultCommit], "result object")) !== "commit") {
    throw new Error("worker resultCommit is not a commit object");
  }
  const branch = workerOutput["branch"];
  if (
    typeof branch !== "string" ||
    (await gitOutput(repositoryRoot, ["rev-parse", `refs/heads/${branch}`], "worker branch")) !==
      resultCommit
  ) {
    throw new Error("worker branch tip does not equal resultCommit");
  }
  await gitOutput(
    repositoryRoot,
    ["merge-base", "--is-ancestor", baseCommit, resultCommit],
    "base ancestry",
  );
  await gitOutput(
    repositoryRoot,
    ["merge-base", "--is-ancestor", startingCommit, resultCommit],
    "starting ancestry",
  );
  const actualWorktreePath = workerOutput["actualWorktreePath"];
  if (typeof actualWorktreePath !== "string") {
    throw new Error("worker result actualWorktreePath is malformed");
  }
  if (
    (await gitOutput(actualWorktreePath, ["rev-parse", "--show-toplevel"], "worker worktree")) !==
    actualWorktreePath
  ) {
    throw new Error("worker result actualWorktreePath does not name its Git toplevel");
  }
  const clean =
    (await gitOutput(actualWorktreePath, ["status", "--porcelain", "--untracked-files=all"], "worker status")) ===
    "";
  const changed = strings(
    (await gitOutput(repositoryRoot, ["diff", "--name-only", `${baseCommit}..${resultCommit}`], "result diff"))
      .split("\n")
      .filter((entry) => entry !== ""),
  ).slice().sort();
  const filesTouched = strings(workerOutput["filesTouched"]).slice().sort();
  const receipts = workerOutput["gitReceipts"];
  const workerTaskId = workerInput["taskId"];
  let receiptsVerified = false;
  if (Array.isArray(receipts)) {
    const receiptPaths = new Set<string>();
    let previousHead: string | undefined;
    receiptsVerified = receipts.length > 0 ||
      (object(startingCommitValue) && startingCommitValue["exactTip"] === true);
    for (const value of receipts) {
      if (!object(value)) {
        receiptsVerified = false;
        break;
      }
      const oldHead = value["oldHead"];
      const newHead = value["newHead"];
      const tree = value["tree"];
      const paths = strings(value["paths"]).slice().sort();
      const objectOids = strings(value["objectOids"]);
      if (
        value["kind"] !== "cq-git-change-receipt" ||
        value["version"] !== 1 ||
        typeof workerTaskId !== "string" ||
        value["taskId"] !== workerTaskId ||
        typeof value["operationId"] !== "string" ||
        typeof value["requestDigest"] !== "string" ||
        !/^[0-9a-f]{64}$/u.test(value["requestDigest"]) ||
        paths.length === 0 ||
        objectOids.length < 2 ||
        typeof oldHead !== "string" ||
        typeof newHead !== "string" ||
        typeof tree !== "string" ||
        !FULL_SHA.test(oldHead) ||
        !FULL_SHA.test(newHead) ||
        !FULL_SHA.test(tree) ||
        (previousHead !== undefined && oldHead !== previousHead) ||
        JSON.stringify(paths) !== JSON.stringify(strings(value["paths"])) ||
        !objectOids.includes(newHead) ||
        !objectOids.includes(tree) ||
        (await gitOutput(repositoryRoot, ["rev-parse", `${newHead}^`], "receipt parent")) !== oldHead ||
        (await gitOutput(repositoryRoot, ["rev-parse", `${newHead}^{tree}`], "receipt tree")) !== tree
      ) {
        receiptsVerified = false;
        break;
      }
      const commitPaths = strings(
        (await gitOutput(repositoryRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", oldHead, newHead], "receipt diff"))
          .split("\n")
          .filter((entry) => entry !== ""),
      ).slice().sort();
      if (JSON.stringify(commitPaths) !== JSON.stringify(paths)) {
        receiptsVerified = false;
        break;
      }
      for (const path of paths) receiptPaths.add(path);
      for (const oid of objectOids) {
        if (!FULL_SHA.test(oid)) {
          receiptsVerified = false;
          break;
        }
        await gitOutput(repositoryRoot, ["cat-file", "-e", oid], "receipt object");
      }
      previousHead = newHead;
    }
    if (
      receipts.length > 0 &&
      (previousHead !== resultCommit ||
        JSON.stringify([...receiptPaths].sort()) !== JSON.stringify(filesTouched))
    ) {
      receiptsVerified = false;
    }
  }
  const gate = workerOutput["supervisedGateEvidence"];
  const trustedGate =
    object(gate) &&
    validateAgainstSchema(implementWorkerSupervisedGateEvidenceSchema, gate).ok &&
    gate["taskId"] === workerTaskId &&
    gate["worktreePath"] === actualWorktreePath &&
    gate["branch"] === branch &&
    gate["baseCommit"] === baseCommit &&
    gate["startingCommit"] === startingCommit &&
    gate["resultCommit"] === resultCommit;
  const legacyGate =
    typeof workerOutput["checkSummary"] === "string" &&
    workerOutput["checkSummary"].includes("REAL_CHECK_EXIT=0");
  return {
    baseCommit,
    startingCommit,
    clean,
    ancestryVerified: true,
    receiptsVerified,
    acceptanceVerified: workerOutput["status"] === "pass" &&
      JSON.stringify(changed) === JSON.stringify(filesTouched),
    gateVerified: trustedGate || legacyGate,
    details: {
      resultCommit,
      branch,
      actualWorktreePath,
      changedFiles: changed,
      filesTouched,
      receiptCount: Array.isArray(receipts) ? receipts.length : 0,
      trustedGate,
      legacyGate,
    },
  } satisfies Awaited<
    ReturnType<ImplementationEvidenceServiceDependencies["verifyImplementation"]>
  >;
}

export interface CreateProductionImplementationEvidenceServiceOptions {
  readonly resolved: ResolvedLedgerStore;
  readonly dispatchCapability: DispatchCapability;
  readonly repositoryRoot: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Trusted process seam; production defaults to the selected harness executable. */
  readonly externalReviewRunner?: ExternalReviewRunner;
  /** Trusted packaged registry seam; production packaging supplies canonical manifests. */
  readonly readAuditManifest?: (
    manifestId: string,
  ) => Promise<PackagedImplementationAuditManifest>;
}

/** Bind the protected journal to the same local store and durable dispatch runtime as MCP. */
export function createProductionImplementationEvidenceService(
  options: CreateProductionImplementationEvidenceServiceOptions,
): ImplementationEvidenceService {
  if (options.resolved.implementationEvidenceStore === undefined) {
    throw new Error("protected implementation evidence store is unavailable");
  }
  if (options.dispatchCapability.observeEvidence === undefined) {
    throw new Error("dispatch runtime cannot re-resolve protected implementation evidence");
  }
  const observe = options.dispatchCapability.observeEvidence.bind(options.dispatchCapability);
  const activeHarness = resolveActiveHarness(options.environment ?? process.env);
  const config = loadConfig(options.repositoryRoot);
  const forceShellout = config?.dispatch.forceShellout ?? false;
  const environment = options.environment ?? process.env;
  const externalReviewRunner = options.externalReviewRunner ?? runExternalReviewer;
  const store = options.resolved.store;
  const readAuditManifest =
    options.readAuditManifest ??
    (async (manifestId: string) =>
      await readPackagedImplementationAuditManifest({
        store,
        manifestId,
        repository: {
          repositoryHead: async () =>
            await gitOutput(options.repositoryRoot, ["rev-parse", "HEAD"], "integration HEAD"),
          readCommitFile: async (commit, path) => {
            const result = await nodeGitRunner(options.repositoryRoot)(["show", `${commit}:${path}`]);
            if (result.code !== 0)
              throw new Error(`packaged audit source ${commit}:${path} is unavailable`);
            return result.stdout;
          },
          diff: async (baseCommit, resultCommit) => {
            const result = await nodeGitRunner(options.repositoryRoot)([
              "diff",
              "--no-ext-diff",
              `${baseCommit}..${resultCommit}`,
            ]);
            if (result.code !== 0)
              throw new Error(`packaged audit diff ${baseCommit}..${resultCommit} is unavailable`);
            return result.stdout;
          },
          isAncestor: async (ancestor, descendant) =>
            (await nodeGitRunner(options.repositoryRoot)([
              "merge-base",
              "--is-ancestor",
              ancestor,
              descendant,
            ])).code === 0,
        },
      }));
  return new ImplementationEvidenceService({
    store: options.resolved.implementationEvidenceStore,
    resolveReviewerRoster: () =>
      computeReviewers(options.repositoryRoot, activeHarness).reviewers.map((reviewer) =>
        reviewerIdentity(reviewer, activeHarness, forceShellout),
      ),
    resolveAuditRoster: () =>
      computeReviewers(options.repositoryRoot, activeHarness).reviewers.map((reviewer) =>
        reviewerIdentity(reviewer, activeHarness, forceShellout),
      ),
    nativeFallback: nativeFallbackIdentity(activeHarness),
    prepareNativeReview: async ({ attemptRef, panel, identity, operationId }) => {
      const worker = await observe(panel.workerDispatch);
      if (worker.state !== "consumed" || !object(worker.input) || !object(worker.output)) {
        throw new Error("worker dispatch is not a consumed evidence source");
      }
      const taskId = panel.taskRef.slice("tasks:".length);
      const input: Record<string, DispatchJSONValue> = {
        taskId,
        acceptance: typeof worker.input["acceptance"] === "string" ? worker.input["acceptance"] : "",
        branch: typeof worker.output["branch"] === "string" ? worker.output["branch"] : "",
        baseCommit:
          object(worker.output["baseVerification"]) &&
          typeof worker.output["baseVerification"]["baseCommit"] === "string"
            ? worker.output["baseVerification"]["baseCommit"]
            : "",
        workerResult: worker.output,
        round:
          typeof worker.input["round"] === "number"
            ? Math.max(1, worker.input["round"])
            : 1,
        priorCriticism: strings(worker.input["priorCriticism"]),
      };
      for (const key of ["headline", "description", "worktreePath"] as const) {
        const value = worker.input[key];
        if (typeof value === "string") input[key] = value;
      }
      if (worker.output["supervisedGateEvidence"] !== undefined) {
        input["supervisedGateEvidence"] = worker.output["supervisedGateEvidence"]!;
      }
      const prepared = await options.dispatchCapability.prepare({
        roleId: "implement-reviewer",
        input,
        idempotencyKey: `implementation-review-${operationId}-${attemptRef.slice(-16)}`,
        timeoutMs: PRODUCTION_IMPLEMENTATION_REVIEWER_TIMEOUT_MS,
        expectedChild: {
          childId: `implementation-review-${attemptRef.slice(-12)}`,
          runId: `implementation-review-${attemptRef.slice(-12)}-${identity.alias}`,
        },
      });
      if (!prepared.accepted) {
        throw new Error(`implementation reviewer dispatch was rejected: ${prepared.reason}`);
      }
      return prepared.prepared;
    },
    fetchNativeReview: async (dispatch) => {
      const observation = await observe({
        attestationId: dispatch.attestationId,
        generation: dispatch.generation,
      });
      if (observation.state === "consumed") {
        return {
          state: "consumed",
          input: observation.input,
          output: observation.output,
          retainedAttestation: observation.retainedAttestation,
        };
      }
      if (observation.state === "nonterminal") {
        throw new Error("implementation reviewer dispatch is not terminal");
      }
      return { state: observation.state === "aborted" ? "aborted" : "missing" };
    },
    readAuditManifest,
    prepareNativeAudit: async ({ attemptRef, panel, identity, operationId }) => {
      const prepared = await options.dispatchCapability.prepare({
        roleId: "implementation-auditor",
        input: panel.auditInput,
        idempotencyKey: `implementation-audit-${operationId}-${attemptRef.slice(-16)}`,
        timeoutMs: PRODUCTION_IMPLEMENTATION_REVIEWER_TIMEOUT_MS,
        expectedChild: {
          childId: `implementation-audit-${attemptRef.slice(-12)}`,
          runId: `implementation-audit-${attemptRef.slice(-12)}-${identity.alias}`,
        },
      });
      if (!prepared.accepted) {
        throw new Error(`implementation auditor dispatch was rejected: ${prepared.reason}`);
      }
      return prepared.prepared;
    },
    fetchNativeAudit: async (dispatch) => {
      const observation = await observe({
        attestationId: dispatch.attestationId,
        generation: dispatch.generation,
      });
      if (observation.state === "consumed") {
        return {
          state: "consumed",
          input: observation.input,
          output: observation.output,
          retainedAttestation: observation.retainedAttestation,
        };
      }
      if (observation.state === "nonterminal")
        throw new Error("implementation auditor dispatch is not terminal");
      return { state: observation.state === "aborted" ? "aborted" : "missing" };
    },
    executeExternalAudit: async ({ panel, identity }) =>
      await externalReviewRunner({
        identity,
        prompt: externalAuditPrompt(panel),
        repositoryRoot: options.repositoryRoot,
        environment,
      }),
    executeExternalReview: async ({ panel, identity }) => {
      const worker = await observe(panel.workerDispatch);
      if (worker.state !== "consumed" || !object(worker.input) || !object(worker.output)) {
        throw new Error("worker dispatch is not a consumed external-review evidence source");
      }
      return await externalReviewRunner({
        identity,
        prompt: externalReviewPrompt(panel, worker.input, worker.output),
        repositoryRoot: options.repositoryRoot,
        environment,
      });
    },
    fetchWorker: async (dispatch) => {
      const observation = await observe(dispatch);
      if (observation.state === "consumed") {
        return { state: "consumed", input: observation.input, output: observation.output };
      }
      return { state: observation.state === "aborted" ? "aborted" : "missing" };
    },
    readTaskAuthority: async (taskRef) => {
      const taskId = taskRef.slice("tasks:".length);
      const task = store.fetchItem(TASKS_LEDGER, taskId);
      const ownership = readCanonicalOwnership(task);
      if (ownership === null || !ownership.ownerRef.startsWith(`${GOALS_LEDGER}:`)) {
        throw new Error(`implementation task ${taskRef} has no sealed owning goal`);
      }
      const goal = store.fetchItem(GOALS_LEDGER, ownership.ownerRef.slice(`${GOALS_LEDGER}:`.length));
      const manifest = goal.fields[PLAN_FINALIZED_MANIFEST_FIELD];
      if (typeof manifest !== "string") {
        throw new Error(`owning goal ${ownership.ownerRef} has no finalized manifest`);
      }
      return {
        taskRef,
        ownerGoalRef: ownership.ownerRef,
        status: task.status,
        finalizedManifest: manifest,
      };
    },
    repositoryHead: async () =>
      await gitOutput(options.repositoryRoot, ["rev-parse", "HEAD"], "integration HEAD"),
    isResultDescendantOfRepositoryHead: async ({ repositoryHead, resultCommit }) => {
      const result = await nodeGitRunner(options.repositoryRoot)([
        "merge-base",
        "--is-ancestor",
        repositoryHead,
        resultCommit,
      ]);
      return result.code === 0;
    },
    isCommitRetained: async ({ repositoryHead, resultCommit }) => {
      const result = await nodeGitRunner(options.repositoryRoot)([
        "merge-base",
        "--is-ancestor",
        resultCommit,
        repositoryHead,
      ]);
      return result.code === 0;
    },
    resolveActivationCohort: async ({ goalRef, manifest, repositoryHead }) => {
      if (manifest.activation === null || manifest.activation.goalRef !== goalRef)
        throw new Error("activation manifest does not bind the requested goal");
      const goal = store.fetchItem(GOALS_LEDGER, goalRef.slice(`${GOALS_LEDGER}:`.length));
      const finalized = goal.fields[PLAN_FINALIZED_MANIFEST_FIELD];
      if (typeof finalized !== "string") throw new Error("goal has no exact finalized manifest");
      let parsed: unknown;
      try {
        parsed = JSON.parse(finalized);
      } catch {
        throw new Error("goal finalized manifest is not canonical JSON");
      }
      const published = PlanPublishedManifestSchema.parse(parsed);
      const mappings = resolveImplementationEvidenceActivationTaskMappings(
        published,
        manifest.activation,
      );
      const activationTaskId = mappings.activationTaskRef.slice(`${TASKS_LEDGER}:`.length);
      const activationTask = store.fetchItem(TASKS_LEDGER, activationTaskId);
      if (operatorActionDirectiveForTask(activationTask)?.actionKey !== "implementation-evidence-activation")
        throw new Error("activation task lacks the strict implementation-evidence operator envelope");
      const observations = [];
      for (const { id } of published.tasks) {
        const task = store.fetchItem(TASKS_LEDGER, id);
        const ownership = readCanonicalOwnership(task);
        const resultCommit = task.fields["resultCommit"];
        const retainedAtBoundary = typeof resultCommit === "string" && FULL_SHA.test(resultCommit)
          ? (await nodeGitRunner(options.repositoryRoot)([
              "merge-base",
              "--is-ancestor",
              resultCommit,
              repositoryHead,
            ])).code === 0
          : false;
        observations.push({
          taskRef: `${TASKS_LEDGER}:${id}`,
          ownerGoalRef: ownership?.ownerRef ?? null,
          ownerEdgeKind: ownership?.edgeKind ?? null,
          status: task.status,
          resultCommit: typeof resultCommit === "string" ? resultCommit : null,
          retainedAtBoundary,
        });
      }
      const cohort = deriveImplementationEvidenceActivationCohort(
        published,
        manifest.activation,
        observations,
      );
      const finalizedManifestDigest = new Bun.CryptoHasher("sha256").update(finalized).digest("hex");
      if (finalizedManifestDigest !== manifest.activation.finalizedManifestDigest)
        throw new Error("packaged activation rule does not match the finalized manifest digest");
      return {
        finalizedManifestDigest,
        evidenceTaskRef: cohort.evidenceTaskRef,
        auditTaskRef: cohort.auditTaskRef,
        activationTaskRef: cohort.activationTaskRef,
        boundaryCommit: repositoryHead,
        taskRefs: cohort.taskRefs,
      };
    },
    verifyImplementation: async ({ resultCommit, worker }) => {
      if (worker.state !== "consumed" || !object(worker.input) || !object(worker.output)) {
        throw new Error("worker evidence is not consumed");
      }
      return await verifyProductionImplementation(
        options.repositoryRoot,
        resultCommit,
        worker.input,
        worker.output,
      );
    },
    recordLedgerCompletion: async ({ task, completion, author, session }) =>
      await recordProtectedImplementationCompletion(store, task, completion, {
        author,
        ...(session === undefined ? {} : { session }),
      }),
  });
}
