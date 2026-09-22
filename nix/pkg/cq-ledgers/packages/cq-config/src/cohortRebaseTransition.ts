import { assertCohortEffectEnvelopeV1, cohortValueDigestV1, type CohortEffectEnvelopeV1 } from "@cq/process-control";
import type { DispatchHandle } from "./compactDispatchProtocol.js";
import type { DispatchGitEffectBinding, DispatchGuardedRebaseSourceBinding } from "./dispatchAttestation.js";
import { implementationQueueSubjectsMatch } from "./implementationQueueIdentity.js";

export type CohortRebaseManagerBinding = DispatchGuardedRebaseSourceBinding & { readonly cohort: CohortEffectEnvelopeV1 };
export interface DispatchCohortRebaseTransition {
  readonly kind: "cq-cohort-rebase-transition";
  readonly version: 1;
  readonly source: DispatchHandle;
  readonly sourceBinding: CohortRebaseManagerBinding;
  readonly successorBinding: CohortRebaseManagerBinding;
  readonly guardedRebaseBridgeDigest: string;
  readonly transitionDigest: string;
}
const COORDINATES = ["handleToken", "handleFingerprint", "repositoryRoot", "repositoryId", "commonDir", "worktreePath", "branch", "ref", "baseCommit"] as const;

export function cohortRebaseManagerBinding(binding: CohortRebaseManagerBinding): CohortRebaseManagerBinding {
  return { cohort: structuredClone(binding.cohort), handleToken: binding.handleToken, handleFingerprint: binding.handleFingerprint,
    repositoryRoot: binding.repositoryRoot, repositoryId: binding.repositoryId, commonDir: binding.commonDir,
    worktreePath: binding.worktreePath, branch: binding.branch, ref: binding.ref, baseCommit: binding.baseCommit };
}

export function assertDispatchCohortRebaseTransition(value: DispatchCohortRebaseTransition): void {
  if (value === null || typeof value !== "object" || Object.keys(value).sort().join(",") !==
      "guardedRebaseBridgeDigest,kind,source,sourceBinding,successorBinding,transitionDigest,version" ||
      value.kind !== "cq-cohort-rebase-transition" || value.version !== 1 ||
      !/^[0-9a-f]{64}$/u.test(value.guardedRebaseBridgeDigest) ||
      value.source === null || typeof value.source !== "object" || Object.keys(value.source).sort().join(",") !== "attestationId,generation" ||
      typeof value.source.attestationId !== "string" || !Number.isSafeInteger(value.source.generation) || value.source.generation < 1) {
    throw new Error("cohort rebase transition requires one exact source dispatch and closed proof");
  }
  for (const binding of [value.sourceBinding, value.successorBinding]) {
    if (binding === null || typeof binding !== "object" || Object.keys(binding).sort().join(",") !== [...COORDINATES, "cohort"].sort().join(",") ||
        COORDINATES.some((key) => typeof binding[key] !== "string" || binding[key] === "")) throw new Error("cohort rebase transition manager coordinates are malformed");
    assertCohortEffectEnvelopeV1(binding.cohort);
    if (binding.branch !== `implement/cohort-${binding.cohort.intent.intentDigest}` || binding.ref !== `refs/heads/${binding.branch}`) {
      throw new Error("cohort rebase transition substituted its intent branch");
    }
  }
  const { sourceBinding: source, successorBinding: next, transitionDigest, ...unsigned } = value;
  if (next.cohort.state !== "pre-seal" || source.cohort.intent.intentDigest === next.cohort.intent.intentDigest ||
      cohortValueDigestV1(source.cohort.definition) !== cohortValueDigestV1(next.cohort.definition) ||
      cohortValueDigestV1(source.cohort.memberAuthorities) !== cohortValueDigestV1(next.cohort.memberAuthorities) ||
      ["repositoryRoot", "repositoryId", "commonDir", "worktreePath"].some((key) => source[key as keyof typeof source] !== next[key as keyof typeof next]) ||
      transitionDigest !== cohortValueDigestV1({ ...unsigned, sourceBinding: source, successorBinding: next })) {
    throw new Error("cohort rebase transition does not bind a distinct exact successor");
  }
}

export function cohortRebaseTransitionMatches(source: DispatchGitEffectBinding, successor: DispatchGitEffectBinding,
  sourceHandle: DispatchHandle): boolean {
  const proof = successor.cohortRebaseTransition;
  const bridge = successor.guardedRebaseBridge;
  if (proof === undefined || bridge?.version !== 2 || source.cohort === undefined || successor.cohort === undefined) return false;
  try { assertDispatchCohortRebaseTransition(proof); } catch { return false; }
  return proof.source.attestationId === sourceHandle.attestationId && proof.source.generation === sourceHandle.generation &&
    cohortValueDigestV1(proof.sourceBinding) === cohortValueDigestV1(cohortRebaseManagerBinding(source)) &&
    implementationQueueSubjectsMatch(proof.successorBinding, successor, true) &&
    COORDINATES.every((key) => proof.successorBinding[key] === successor[key]) &&
    proof.guardedRebaseBridgeDigest === cohortValueDigestV1(bridge) &&
    implementationQueueSubjectsMatch(source, { cohort: bridge.cohort }, true) &&
    COORDINATES.every((key) => source[key] === bridge.sourceBinding[key]) && successor.baseCommit === bridge.ontoCommit;
}
