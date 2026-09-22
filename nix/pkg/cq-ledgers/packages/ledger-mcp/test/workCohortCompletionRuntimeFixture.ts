import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_CORRELATION_SEPARATOR, InMemoryAttestationBackend, InMemoryAttestationStore,
  implementWorkerSidecar, implementReviewerSidecar, type DispatchJSONValue } from "@cq/config";
import { InMemoryLedgerStore, SqliteLedgerStore, cohortValueDigestV1 as digest,
  createInMemoryImplementationEvidenceStore, createCohortEffectEnvelopeV1, createCohortCommandBoundaryV1,
  createCohortCompletionBatchV1, createLedgerMcpToolSpecifications,
  createTrustedWorksetManagementAuthority, type CohortCompletionRuntimeResultV1, type CohortAdmissionPlanV1, type CohortEffectEnvelopeV1 } from "@cq/ledger";
import { prepareCohortPrimaryFixture } from "../../ledger/test/workCohortCompletionContract.js";
import { cohortBrokerGit as git, rawDigest } from "../../ledger/test/workCohortGitBrokerFixture.js";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import { createCohortCompletionRuntimeV1 } from "../src/workCohortCompletionRuntime.js";
import { createCohortAdvanceRuntimeV1 } from "../src/workCohortAdvanceRuntime.js";
import type { PromptArtifactStore, PromptArtifactRoleMetadata } from "../src/promptArtifactStore.js";

function artifacts(): PromptArtifactStore {
  const roles: PromptArtifactRoleMetadata[] = [implementWorkerSidecar, implementReviewerSidecar].map((schema, index) => {
    const roleId = index === 0 ? "implement-worker" : "implement-reviewer";
    return { roleId, roleKind: "dispatched-subagent", artifactPath: `roles/${roleId}.md`, sidecarSchemaRoleId: roleId,
      promptSurface: "codex", promptDigest: "a".repeat(64), schemaVersion: schema.version, schemaDigest: digest(schema) };
  });
  return { readManifest: () => ({ bytes: new Uint8Array(), roles, promptSurface: "codex", catalogHash: "b".repeat(64) }),
    readRole: (roleId) => { const metadata = roles.find((entry) => entry.roleId === roleId);
      if (metadata === undefined) throw new Error(`unknown fixture role ${roleId}`);
      return { metadata, bytes: new Uint8Array([1]) }; } };
}

export async function completionRuntimeFixture(adapter: "memory" | "sqlite", deployment: boolean) {
  const root = await mkdtemp(join(tmpdir(), "cq-completion-production-"));
  const ledger = adapter === "memory" ? new InMemoryLedgerStore() : new SqliteLedgerStore({ dbPath: join(root, ".state", "ledger.db") });
  await mkdir(join(root, ".state"));
  await ledger.init();
  const evidence = createInMemoryImplementationEvidenceStore();
  const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore({ backend: "xdg", projectKey: "completion-production" }));
  const close = async () => { await backend.close(); await ledger.dispose(); await rm(root, { recursive: true, force: true }); };
  try {
    await git(root, ["init", "-q", "-b", "main"]);
    await git(root, ["config", "user.name", "Cohort completion"]);
    await git(root, ["config", "user.email", "cohort@example.invalid"]);
    await git(root, ["config", "commit.gpgsign", "false"]);
    await writeFile(join(root, "a.txt"), "base a\n");
    const contract = "export interface CohortContract { readonly value: string }\n";
    await writeFile(join(root, "shared.ts"), contract);
    await writeFile(join(root, "bun.lock"), "{}\n");
    await writeFile(join(root, ".gitignore"), ".claude/\n.state/\n.cache/\nnode_modules/\n");
    await git(root, ["add", "."]); await git(root, ["commit", "-q", "-m", "seed"]);
    const baseCommit = await git(root, ["rev-parse", "HEAD"]);
    const { taskIds, provenance } = await prepareCohortPrimaryFixture(ledger);
    for (const id of taskIds) await ledger.updateItem("tasks", id, { fields: { sourceRefs: ["shared.ts"] } });
    await ledger.worksetStore().setRoots(["goals:G1"]);
    const sharedRegression = createCohortCommandBoundaryV1({ argv: ["bun", "test", "shared.test.ts"], cwd: "nix/pkg/cq-ledgers", environment: [] });
    const canonicalFullGate = createCohortCommandBoundaryV1({ argv: ["bun", "run", "check"], cwd: "nix/pkg/cq-ledgers", environment: [] });
    const boundary = (identity: string) => ({ identity, digest: digest(identity) });
    const admissionPlan: CohortAdmissionPlanV1 = { kind: "cq-cohort-admission-plan", version: 1,
      members: taskIds.map((id) => ({ memberRef: `tasks:${id}`, boundaryCandidates: [{
        witness: { kind: "repository-node", nodeKind: "versioned-contract", nodeIdentity: "shared.ts#CohortContract",
          sourcePath: "shared.ts", memberPath: ["shared.ts"] }, sharedRegression, canonicalFullGate,
        reviewerClass: boundary("reviewer:standard"), deploymentClass: boundary(`deployment:${deployment ? "standard" : "none"}`),
        finalizationClass: boundary("finalization:standard"), splitConditions: [], focusedCommand: {
          argv: ["bun", "test", `${id}.test.ts`], cwd: "nix/pkg/cq-ledgers", environment: {},
          provenance: { sourceRef: "shared.ts", sourceRevision: digest(contract) },
        },
      }] })) };
    const cohorts = ledger.workCohortStore();
    const deps = { stateDir: join(root, ".state", "registry"), cacheRoot: join(root, ".cache"), bunWorkspaceRoot: root, skipInstall: true };
    const promptArtifacts = artifacts();
    const resolved = { store: ledger, implementationEvidenceStore: evidence, backend: "xdg" as const, configRoot: root, branch: "cq-ledger" };
    const advance = await createCohortAdvanceRuntimeV1({ resolved, promptArtifacts, managedDeps: deps });
    if (advance === undefined) throw new Error("local admission runtime unavailable");
    const observed = await advance.observe({ plan: admissionPlan, operationId: "observe" });
    const definition = observed.definitions[0]!;
    const observation = (await cohorts.snapshot()).portable.observations.find((entry) => entry.observationDigest === observed.observationDigest)!;
    const admitted = await advance.prepare({ plan: admissionPlan, definitionDigest: definition.definitionDigest, operationId: "production-completion" });
    const envelope = admitted.cohort;
    const intent = envelope.intent;
    const managed = admitted.worktree;
    if (managed.status !== "prepared") throw new Error(JSON.stringify(managed));
    const commands: string[] = [];
    // Explicit command adapters exercise orchestration; these outputs are not acceptance evidence for this delivery.
    const dispatch = createDispatchCapability({ backend, promptArtifactStore: promptArtifacts, repositoryRoot: root,
      worktreeStateDir: deps.stateDir, ledgerStore: ledger, implementationEvidenceStore: evidence, cohortStore: cohorts,
      cohortCommandRunner: { run: async (request) => { commands.push(request.command.argv.join(" "));
        return { executionId: `fixture:${commands.length}`, outputDigest: digest(request.command), gateExitCode: 0,
          passCount: 1, failCount: 0, gateDurationMs: 1, capturedAt: new Date().toISOString(), outputTail: "1 pass" }; } },
      supervisedWorkerGateRunner: { run: async () => { commands.push("bun run check"); return { gateExitCode: 0,
        passCount: 3, failCount: 0, gateDurationMs: 1, capturedAt: new Date().toISOString(), outputTail: "3 pass" }; } } });
    const members = definition.members.map(({ memberRef }) => ({ memberRef, headline: memberRef, description: "delivery", acceptance: "complete" }));
    const worker = await dispatch.prepare({ roleId: "implement-worker", idempotencyKey: "worker", timeoutMs: 600_000,
      expectedChild: { childId: `implement-worker${CODEX_CORRELATION_SEPARATOR}worker-child`, runId: "worker-run" }, input: {
        cohort: envelope, members, branch: managed.handle.branch, worktreePath: managed.handle.absolutePath,
        baseCommit, startingCommit: baseCommit, round: 0, validationIntent: "final",
      } as unknown as DispatchJSONValue });
    if (!worker.accepted) throw new Error(JSON.stringify(worker));
    await dispatch.fetchInput({ ...worker.prepared, inputCapability: worker.prepared.inputCapability });
    if (dispatch.gitCommit === undefined || worker.prepared.gitChangeCapability === undefined) throw new Error("worker Git capability absent");
    await writeFile(join(managed.handle.absolutePath, "a.txt"), "cohort correction\n");
    const receipt = await dispatch.gitCommit({ ...worker.prepared, gitChangeCapability: worker.prepared.gitChangeCapability,
      operationId: "delivery", expectedHead: baseCommit, message: "cohort delivery", changes: [{ kind: "modify", path: "a.txt",
        oldState: { mode: "100644", digest: rawDigest("base a\n") }, newState: { mode: "100644", digest: rawDigest("cohort correction\n") } }] });
    const resultCommit = receipt.newHead;
    const stored = await dispatch.storeResult({ ...worker.prepared, resultCapability: worker.prepared.resultCapability, output: {
      cohort: envelope, memberObservations: members.map(({ memberRef }) => ({ memberRef, observation: "implemented" })),
      status: "pass", resultCommit, branch: managed.handle.branch, actualWorktreePath: managed.handle.absolutePath,
      filesTouched: receipt.paths, gitReceipts: [receipt], checkSummary: "awaiting ladder", summary: "all implemented",
      baseVerification: { status: "verified", relation: "descendant", baseCommit, headCommit: resultCommit },
    } as unknown as DispatchJSONValue });
    if (stored.state !== "gate-pending" || dispatch.qualifyImplementationCandidate === undefined ||
        dispatch.coordinateImplementationCandidate === undefined || worker.prepared.parentGateCapability === undefined) throw new Error("worker did not stage");
    const qualified = await dispatch.qualifyImplementationCandidate({ ...worker.prepared, roleId: "implement-worker", correlationId: "worker-child",
      childThreadId: "worker-thread", expectedRunId: "worker-run", outcome: "completed", exitStatus: 0,
      observedAt: new Date().toISOString(), promptDigest: "a".repeat(64) });
    if (qualified.state !== "queued") throw new Error(JSON.stringify(qualified));
    const coordinated = await dispatch.coordinateImplementationCandidate({ ...worker.prepared, holderId: "completion-front",
      parentGateCapability: worker.prepared.parentGateCapability });
    if (coordinated.state !== "completed") throw new Error(JSON.stringify(coordinated));
    const state = (await cohorts.snapshot()).portable;
    const sealed = createCohortEffectEnvelopeV1({ definition, observation, intent, evidenceSubject: state.evidenceSubjects[0]!,
      executionEpoch: (await cohorts.snapshot()).runtime.executionEpoch });
    if (sealed.state !== "sealed") throw new Error("candidate not sealed");
    const acceptance = state.completionReceipts.find((entry) => entry.evidenceSubjectDigest === sealed.evidenceSubject.evidenceSubjectDigest);
    if (acceptance === undefined) throw new Error("production ladder did not aggregate its acceptance receipt");
    const gate = state.commandEvidence.find((entry) => entry.evidenceKind === "full-gate")!.execution!.canonicalGate!.gate;
    const reviewChild = { childId: `implement-reviewer${CODEX_CORRELATION_SEPARATOR}review-child`, runId: "review-run" };
    const reviewer = await dispatch.prepare({ roleId: "implement-reviewer", idempotencyKey: "reviewer", timeoutMs: 600_000,
      expectedChild: reviewChild, input: { cohort: sealed, members, branch: managed.handle.branch, worktreePath: managed.handle.absolutePath,
        baseCommit, round: 1, supervisedGateEvidence: gate,
        workerResult: { status: "pass", resultCommit, checkSummary: "all green", filesTouched: receipt.paths },
      } as unknown as DispatchJSONValue });
    if (!reviewer.accepted) throw new Error(JSON.stringify(reviewer));
    await dispatch.fetchInput({ ...reviewer.prepared, inputCapability: reviewer.prepared.inputCapability });
    await dispatch.storeResult({ ...reviewer.prepared, resultCapability: reviewer.prepared.resultCapability, output: {
      cohort: sealed, memberObservations: members.map(({ memberRef }) => ({ memberRef, observation: "verified" })),
      verdict: "approve", criticism: [], questions: [], defects: [], rationale: "whole candidate checked", gateReRan: false,
      resultCommitVerified: true, resultCommitEvidence: { status: "verified", resultCommit, branchTip: resultCommit },
      baseAncestry: { status: "verified", relation: "descendant", baseCommit, mergeBase: baseCommit, resultCommit },
    } as unknown as DispatchJSONValue });
    const confirmed = await dispatch.confirmCompletion({ ...reviewer.prepared, expectedProvenance: reviewer.prepared.promptProvenance,
      nativeCompletion: { kind: "native-completion", actor: "trusted-parent", ...reviewChild, completedAt: new Date().toISOString() } });
    if (confirmed.state !== "consumed") throw new Error(JSON.stringify(confirmed));
    const runtimeWithArtifact = (artifact: string) => {
      const runtime = createCohortCompletionRuntimeV1({ resolved: { store: ledger, implementationEvidenceStore: evidence,
      backend: "xdg", configRoot: root, branch: "cq-ledger" }, backend, promptArtifacts, stateDir: deps.stateDir,
      trustedSourceWorkspaceBuildCommit: resultCommit, trustedSourceWorkspaceArtifactIdentity: artifact,
      cancellationSignal: new AbortController().signal });
      if (runtime === undefined) throw new Error("completion runtime unavailable");
      return runtime;
    };
    const runtime = runtimeWithArtifact("test-artifact-one");
    const tools = createLedgerMcpToolSpecifications(ledger, undefined, undefined, undefined, undefined, undefined,
      undefined, createTrustedWorksetManagementAuthority(), undefined, true, undefined, runtime);
    async function invoke<T>(name: string, args: Record<string, unknown>): Promise<T> {
      const tool = tools.find((entry) => entry.name === name);
      if (tool === undefined) throw new Error(`completion tool absent: ${name}`);
      const response = await tool.handler(args, null);
      const content = response.content[0];
      if (response.isError || content?.type !== "text") throw new Error(JSON.stringify(response));
      return JSON.parse(content.text) as T;
    }
    const review = await invoke<{ reviewRef: string }>("record_cohort_review", { reviewer_dispatch: reviewer.prepared, envelope: sealed,
      operation_id: "record-review", ...provenance });
    const atom = state.commonAtoms.find(({ atomDigest }) => atomDigest === definition.selectedAtomDigest)!;
    const batch = createCohortCompletionBatchV1({ operationId: "complete", envelope: sealed, acceptance,
      resultCommit, members: taskIds.map((id) => ({ taskRef: `tasks:${id}`, completion: `completed ${id}`, reviewAttemptRefs: [review.reviewRef], logPaths: ["logs/test-dispatch.jsonl"] })),
      deploymentPlan: deployment ? { kind: "cq-cohort-deployment-plan", version: 1, deploymentClass: atom.deploymentClass.digest,
        packagedBuildIdentity: { packageIdentity: "cq", sourceCommit: resultCommit },
        members: taskIds.map((id) => ({ taskRef: `tasks:${id}`, argv: [process.execPath, "-e", `console.log('${id} smoke passed')`], cwd: ".", environment: {} })) } : null,
      sweep: { archiveCompletedMembers: true, terminalItems: [], milestones: [], summary: "cohort complete" }, ...provenance });
    return { root, ledger, cohorts, evidence, backend, runtime, batch, commands, taskIds, close, runtimeWithArtifact,
      advance, admissionPlan, envelope: sealed as CohortEffectEnvelopeV1, worker: worker.prepared, managed, deps, dispatch, resolved, promptArtifacts,
      complete: () => invoke<CohortCompletionRuntimeResultV1>("complete_cohort", { batch }) };
  } catch (error) { await close(); throw error; }
}
