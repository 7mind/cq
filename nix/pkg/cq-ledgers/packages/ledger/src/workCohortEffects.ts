import { cohortEffectTargetRefV1, type WorksetEffectAdmissionProvider } from "@cq/process-control";
import type { ManagedCohortWorktreeAuthority } from "./managedWorktree.js";
import type { WorksetStore } from "./worksetStore.js";

export function createCohortWorksetEffectAdmissionProvider(
  authority: ManagedCohortWorktreeAuthority,
  workset: WorksetStore,
): WorksetEffectAdmissionProvider {
  const envelope = structuredClone(authority.envelope);
  const lease = structuredClone(authority.lease);
  const targetRef = cohortEffectTargetRefV1(envelope);
  const cohortTargets = envelope.memberAuthorities.map((member) => member.taskRef);
  const assertLive = () => authority.store.assertLiveCohortAuthority(lease, envelope);
  return {
    acquire: async (input) => {
      if (input.targetRef !== targetRef) throw new Error("cohort process target substituted its complete effect envelope");
      await assertLive();
      const admission = await workset.admitExternalEffect({ kind: input.kind, targetRef, cohortTargets });
      try { await assertLive(); }
      catch (error) { await admission.abandonBeforeRegistration(); throw error; }
      return {
        id: admission.id, epoch: admission.epoch, kind: admission.kind, targetRef,
        registerProcessGroup: async (group) => {
          await assertLive();
          await admission.registerProcessGroup(group);
        },
        shareWithGuardian: async (group) => {
          await assertLive();
          await admission.shareWithGuardian(group);
        },
        markSettled: () => admission.markSettled(),
        releaseAfterSettlement: () => admission.releaseAfterSettlement(),
        abandonBeforeRegistration: () => admission.abandonBeforeRegistration(),
      };
    },
  };
}
