import { InMemoryAttestationStore, implementReviewerSidecar, type AttestationEnvelope, type DispatchJSONValue, type ImplementWorkerSupervisedGateEvidence } from "@cq/config";
import { cohortValueDigestV1 as digest } from "../src/workCohort.js";
import { CohortReviewAuthenticatorV1, type CohortReviewRoleContractV1, type AuthorizedCohortReviewV1 } from "../src/workCohortCompletionEvidence.js";
import type { prepareCohortCompletionFixture } from "./workCohortCompletionContract.js";

interface CohortReviewFixture {
  readonly store: InMemoryAttestationStore;
  readonly input: DispatchJSONValue;
  readonly output: Record<string, unknown> & { readonly resultCommitEvidence: { readonly status: string; readonly resultCommit: string; readonly branchTip: string } };
  readonly replaceOutput: (value: Record<string, unknown>) => void;
  readonly authenticate: () => AuthorizedCohortReviewV1;
}

export async function cohortReviewFixture(f: Awaited<ReturnType<typeof prepareCohortCompletionFixture>>): Promise<CohortReviewFixture> {
  const store = new InMemoryAttestationStore({ backend: "xdg", projectKey: "completion-review" });
  const { taskId: _task, ...baseGate } = (await f.cohorts.snapshot()).portable.commandEvidence.find((entry) => entry.evidenceKind === "full-gate")!.execution!.canonicalGate!.gate;
  const gate = { ...baseGate, version: 2, evidenceSubject: f.batch.envelope.evidenceSubject,
    branch: `implement/cohort-${f.batch.envelope.intent.intentDigest}` };
  const handle = { attestationId: "cohort-review", generation: 1 };
  const role: CohortReviewRoleContractV1 = { version: implementReviewerSidecar.version, surface: "codex",
    promptDigest: "a".repeat(64), catalogHash: "b".repeat(64), schemaDigest: digest(implementReviewerSidecar) };
  const input = { cohort: f.batch.envelope, members: f.batch.members.map(({ taskRef }) => ({ memberRef: taskRef,
    headline: "member", description: "delivery", acceptance: "complete" })), worktreePath: gate.worktreePath,
    branch: gate.branch, baseCommit: gate.baseCommit,
    workerResult: { status: "pass", resultCommit: f.batch.resultCommit, checkSummary: "green", filesTouched: [] },
    round: 1, responseStoreNow: "2026-09-22T10:02:00.000Z", gateCompleteBy: "2026-09-22T10:01:00.000Z",
    synthesisStoreReserveMs: 60_000, supervisedGateEvidence: gate };
  const output = { cohort: f.batch.envelope, memberObservations: f.batch.members.map(({ taskRef }) => ({ memberRef: taskRef, observation: "verified" })),
    verdict: "approve", criticism: [], questions: [], defects: [], rationale: "exact whole candidate reviewed", gateReRan: false,
    resultCommitVerified: true, resultCommitEvidence: { status: "verified", resultCommit: f.batch.resultCommit, branchTip: f.batch.resultCommit },
    baseAncestry: { status: "verified", relation: "descendant", baseCommit: gate.baseCommit, mergeBase: gate.baseCommit, resultCommit: f.batch.resultCommit } };
  const nativeCompletion = { kind: "native-completion", actor: "trusted-parent", childId: "review-child", runId: "review-run", completedAt: "2026-09-22T10:00:00.000Z" };
  function replaceOutput(value: Record<string, unknown>) {
    const outputDigest = digest(value);
    const row = { kind: "envelope", namespace: store.namespace, ...handle, state: "consumed", input, output: value,
      promptProvenance: { roleId: "implement-reviewer", ...role, inputDigest: digest(input) }, outputDigest,
      expectedChild: { childId: nativeCompletion.childId, runId: nativeCompletion.runId }, nativeCompletion,
      consumedAt: nativeCompletion.completedAt, terminalAt: nativeCompletion.completedAt,
      terminalDigest: digest({ terminalKind: "consumed", outputDigest, childId: nativeCompletion.childId,
        runId: nativeCompletion.runId, completedAt: nativeCompletion.completedAt }) } as unknown as AttestationEnvelope;
    const prior = store.read(handle);
    if (prior === undefined) store.insert(row); else store.replace(prior, row);
  }
  replaceOutput(output);
  return { store, input: input as unknown as DispatchJSONValue, output, replaceOutput,
    authenticate: () => new CohortReviewAuthenticatorV1(store).authenticate({ reviewerDispatch: handle,
      envelope: f.batch.envelope, resultCommit: f.batch.resultCommit, role, gateEvidence: gate as ImplementWorkerSupervisedGateEvidence,
      recording: { operationId: "record-cohort-review", author: "review-contract", session: "T6562" } }) };
}
