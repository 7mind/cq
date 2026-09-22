import { isAbsolute, resolve } from "node:path";
import { WorksetAdmissionError, type WorksetExternalEffectKind } from "./worksetEffectAdmission.js";
import { cohortEffectTargetRefV1 } from "@cq/process-control";
import { readAuthorizedCohortTerminalReleaseV1, type AuthorizedCohortTerminalReleaseV1 } from "./workCohortCompletion.js";

const FULL_SHA256 = /^[0-9a-f]{64}$/u;
const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const TASK_ID = /^T[0-9]+$/u;
const RECOVERY_REF_PREFIX = "refs/cq-managed-recovery";
const MANAGED_RELEASE_BINDING_KIND = "cq-managed-terminal-release-binding" as const;
const managedReleaseBrand: unique symbol = Symbol("managed-terminal-release-binding");

export type ManagedTerminalReleaseEffectKind =
  "worktree-remove" | "branch-create" | "branch-remove";

export interface ManagedTerminalReleaseBinding {
  readonly kind: typeof MANAGED_RELEASE_BINDING_KIND;
  readonly taskId: string;
  readonly handleToken: string;
  readonly handleFingerprint: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly terminalDisposition: "done" | "abandoned";
  readonly [managedReleaseBrand]: true;
}

export interface ManagedCohortTerminalReleaseBinding {
  readonly kind: "cq-managed-cohort-terminal-release-binding";
  readonly targetRef: string;
  readonly cohortTargets: readonly string[];
  readonly resultCommit: string;
  readonly handleToken: string;
  readonly handleFingerprint: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
}
export type AnyManagedTerminalReleaseBinding = ManagedTerminalReleaseBinding | ManagedCohortTerminalReleaseBinding;

export type ManagedTerminalReleaseEffect =
  | {
      readonly kind: "worktree-remove";
      readonly targetRef: string;
      readonly repositoryRoot: string;
      readonly worktreePath: string;
      readonly branch: string;
    }
  | {
      readonly kind: "branch-create";
      readonly targetRef: string;
      readonly repositoryRoot: string;
      readonly reference: string;
      readonly expectedReferenceCommit: string;
      readonly commit: string;
    }
  | {
      readonly kind: "branch-remove";
      readonly targetRef: string;
      readonly repositoryRoot: string;
      readonly branch: string;
      readonly expectedCommit: string;
    };

export interface ManagedTerminalReleaseAdmissionRequest {
  readonly binding: AnyManagedTerminalReleaseBinding;
  readonly effect: ManagedTerminalReleaseEffect;
}

interface ManagedTerminalReleaseBindingState {
  readonly binding: AnyManagedTerminalReleaseBinding;
  worktreeRemoveAdmitted: boolean;
  recoveryReferenceAdmitted: boolean;
  branchRemoveAdmitted: boolean;
}

const bindingStates = new WeakMap<object, ManagedTerminalReleaseBindingState>();

function reject(detail: string): never {
  throw new WorksetAdmissionError(
    "management-authority-required",
    `managed terminal release admission denied: ${detail}`,
  );
}

function requireCanonicalAbsolutePath(value: string, label: string): void {
  if (!isAbsolute(value) || resolve(value) !== value) {
    reject(`${label} must be one canonical absolute path`);
  }
}

/**
 * Internal server mint. The returned object is runtime-authenticated by
 * identity in {@link bindingStates}; a structurally identical caller object is
 * not authority.
 */
export function mintManagedTerminalReleaseBinding(input: {
  readonly taskId: string;
  readonly handleToken: string;
  readonly handleFingerprint: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly terminalDisposition: "done" | "abandoned";
}): ManagedTerminalReleaseBinding {
  if (!TASK_ID.test(input.taskId)) reject("task id is not canonical");
  if (input.handleToken.length === 0) reject("handle token is empty");
  if (!FULL_SHA256.test(input.handleFingerprint)) reject("handle fingerprint is invalid");
  requireCanonicalAbsolutePath(input.repositoryRoot, "repository root");
  requireCanonicalAbsolutePath(input.worktreePath, "worktree path");
  if (input.branch !== `implement/${input.taskId}`) {
    reject("implement branch does not match the task id");
  }
  const binding: ManagedTerminalReleaseBinding = Object.freeze({
    kind: MANAGED_RELEASE_BINDING_KIND,
    taskId: input.taskId,
    handleToken: input.handleToken,
    handleFingerprint: input.handleFingerprint,
    repositoryRoot: input.repositoryRoot,
    worktreePath: input.worktreePath,
    branch: input.branch,
    terminalDisposition: input.terminalDisposition,
    [managedReleaseBrand]: true as const,
  });
  bindingStates.set(binding, {
    binding,
    worktreeRemoveAdmitted: false,
    recoveryReferenceAdmitted: false,
    branchRemoveAdmitted: false,
  });
  return binding;
}

export function assertManagedTerminalReleaseRunnerBinding(
  binding: ManagedTerminalReleaseBinding,
  expected: {
    readonly taskId: string;
    readonly repositoryRoot: string;
  },
): void {
  const state = bindingStates.get(binding);
  if (state === undefined || state.binding !== binding) reject("binding was not manager-minted");
  if (binding.taskId !== expected.taskId || binding.repositoryRoot !== expected.repositoryRoot) {
    reject("binding does not match the release runner");
  }
}

export function mintManagedCohortTerminalReleaseBinding(authority: AuthorizedCohortTerminalReleaseV1, input: {
  readonly handleToken: string; readonly handleFingerprint: string;
  readonly repositoryRoot: string; readonly worktreePath: string; readonly branch: string;
}): ManagedCohortTerminalReleaseBinding {
  const batch = readAuthorizedCohortTerminalReleaseV1(authority);
  requireCanonicalAbsolutePath(input.repositoryRoot, "repository root");
  requireCanonicalAbsolutePath(input.worktreePath, "worktree path");
  if (input.handleToken.length === 0 || !FULL_SHA256.test(input.handleFingerprint) ||
      input.branch !== `implement/cohort-${batch.envelope.intent.intentDigest}`) reject("cohort manager identity differs from terminal completion");
  const binding: ManagedCohortTerminalReleaseBinding = Object.freeze({ ...input,
    kind: "cq-managed-cohort-terminal-release-binding", targetRef: cohortEffectTargetRefV1(batch.envelope),
    cohortTargets: Object.freeze(batch.members.map(({ taskRef }) => taskRef)), resultCommit: batch.resultCommit });
  bindingStates.set(binding, { binding, worktreeRemoveAdmitted: false, recoveryReferenceAdmitted: false, branchRemoveAdmitted: false });
  return binding;
}

/**
 * Consume one exact release-sequence effect. Validation precedes every store
 * mutation; each accepted call still receives a normal one-effect admission.
 */
export function authorizeManagedTerminalReleaseEffect(
  input: ManagedTerminalReleaseAdmissionRequest,
): {
  readonly kind: WorksetExternalEffectKind;
  readonly targetRef: string;
  readonly cohortTargets?: readonly string[];
} {
  const state = bindingStates.get(input.binding);
  if (state === undefined || state.binding !== input.binding) {
    reject("binding was not manager-minted");
  }
  const binding = state.binding;
  const effect = input.effect;
  const cohort = binding.kind === "cq-managed-cohort-terminal-release-binding";
  const targetRef = cohort ? binding.targetRef : `tasks:${binding.taskId}`;
  if (effect.targetRef !== targetRef) reject("terminal release target was substituted");
  if (effect.repositoryRoot !== binding.repositoryRoot) reject("repository was substituted");
  if (state.branchRemoveAdmitted) reject("release sequence is already terminal");

  if (effect.kind === "worktree-remove") {
    if (state.worktreeRemoveAdmitted || state.recoveryReferenceAdmitted) {
      reject("worktree removal is out of sequence");
    }
    if (effect.worktreePath !== binding.worktreePath) reject("worktree path was substituted");
    if (effect.branch !== binding.branch) reject("worktree branch was substituted");
    state.worktreeRemoveAdmitted = true;
    return { kind: effect.kind, targetRef: effect.targetRef, ...(cohort ? { cohortTargets: binding.cohortTargets } : {}) };
  }

  if (effect.kind === "branch-create") {
    if (state.recoveryReferenceAdmitted) reject("recovery reference was already published");
    if (effect.reference !== `${RECOVERY_REF_PREFIX}/${binding.branch}`) {
      reject("recovery reference was substituted");
    }
    if (!FULL_COMMIT.test(effect.expectedReferenceCommit) || !FULL_COMMIT.test(effect.commit)) {
      reject("recovery reference commits are invalid");
    }
    if (cohort && effect.commit !== binding.resultCommit) reject("cohort recovery reference differs from completed commit");
    state.recoveryReferenceAdmitted = true;
    return { kind: effect.kind, targetRef: effect.targetRef, ...(cohort ? { cohortTargets: binding.cohortTargets } : {}) };
  }

  if (effect.kind !== "branch-remove") {
    reject("terminal release effect kind is not in the managed release inventory");
  }
  if (effect.branch !== binding.branch) reject("removed branch was substituted");
  if (!FULL_COMMIT.test(effect.expectedCommit)) reject("removed branch commit is invalid");
  if (cohort && effect.expectedCommit !== binding.resultCommit) reject("cohort branch differs from completed commit");
  state.branchRemoveAdmitted = true;
  return { kind: effect.kind, targetRef: effect.targetRef, ...(cohort ? { cohortTargets: binding.cohortTargets } : {}) };
}
