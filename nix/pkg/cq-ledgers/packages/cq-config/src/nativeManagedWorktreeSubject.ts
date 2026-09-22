import { assertCohortEffectEnvelopeV1, cohortValueDigestV1, cohortEffectTargetRefV1,
  type CohortEffectEnvelopeV1 } from "@cq/process-control";
import { isManagedWorktreeHandle, type ManagedWorktreeHandle } from "./managedWorktreeHandle.js";

export type NativeManagedWorktreeSubject =
  | { readonly taskId?: string; readonly cohort?: never }
  | { readonly cohort: CohortEffectEnvelopeV1; readonly taskId?: never };

export function resolveNativeManagedWorktreeSubject(input: {
  readonly handle?: ManagedWorktreeHandle;
  readonly taskId?: string;
  readonly cohort?: CohortEffectEnvelopeV1;
}): NativeManagedWorktreeSubject {
  if (input.handle !== undefined && !isManagedWorktreeHandle(input.handle)) throw new Error("native managed handle is invalid");
  if (input.cohort !== undefined) {
    if (Object.hasOwn(input, "taskId")) throw new Error("native cohort binding cannot carry an anchor task");
    assertCohortEffectEnvelopeV1(input.cohort);
    const identity = { kind: "cq-cohort-worktree-identity", version: 1,
      cohortId: input.cohort.definition.cohortId, definitionDigest: input.cohort.definition.definitionDigest,
      candidateIntentDigest: input.cohort.intent.intentDigest, memberSetDigest: input.cohort.memberSetDigest,
      memberAuthorities: input.cohort.memberAuthorities };
    if (input.handle !== undefined && (input.handle.version !== 3 ||
        cohortValueDigestV1(input.handle.cohort) !== cohortValueDigestV1(identity))) {
      throw new Error("native cohort envelope differs from the complete managed handle identity");
    }
    return { cohort: structuredClone(input.cohort) };
  }
  if (Object.hasOwn(input, "cohort") || input.handle?.version === 3) throw new Error("native V3 handle requires its exact full cohort envelope");
  const taskId = input.taskId ?? input.handle?.taskId;
  if (input.taskId !== undefined && input.handle !== undefined && input.taskId !== input.handle.taskId) throw new Error("native task identity differs from its managed handle");
  return taskId === undefined ? {} : { taskId };
}

export function nativeManagedWorktreeEffectTarget(input: {
  readonly handle: ManagedWorktreeHandle;
  readonly cohort?: CohortEffectEnvelopeV1;
}): string {
  const subject = resolveNativeManagedWorktreeSubject(input);
  if (subject.cohort !== undefined) return cohortEffectTargetRefV1(subject.cohort);
  if (subject.taskId === undefined) throw new Error("native task handle lacks its effect target");
  return `tasks:${subject.taskId}`;
}
