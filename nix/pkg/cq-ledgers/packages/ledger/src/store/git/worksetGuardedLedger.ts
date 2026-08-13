import type { WorksetAdmissionCoordinatorHooks } from "../../worksetEffectAdmission.js";
import {
  createTrustedWorksetManagementAuthority,
  type WorksetInvocationAuthority,
} from "../../worksetInvocationAuthority.js";
import {
  buildActiveStateFromLedgerStore,
  createWorksetGuardedLedger,
  worksetMemberRefSet,
  type WorksetGuardedLedger,
} from "../../worksetGenericMutation.js";
import { closeWorkset } from "../../worksetGraph.js";
import { readWorksetRootsEpoch } from "../../worksetStore.js";
import {
  createGitObjectWorksetStore,
  type CreateGitObjectWorksetStoreOptions,
} from "../../worksetStoreGit.js";
import type { OnMutation } from "../LedgerStore.js";
import type { LockfileOpts } from "../lockfile.js";
import type { GitPlumbing } from "./GitPlumbing.js";
import {
  GitObjectLedgerBackend,
  type GitObjectLedgerBackendOpts,
} from "./GitObjectLedgerBackend.js";

export interface CreateGitObjectWorksetGuardedLedgerOptions {
  readonly repoRoot: string;
  readonly ref?: string;
  readonly now?: () => string;
  readonly hooks?: WorksetAdmissionCoordinatorHooks;
  readonly afterGenericAdmit?: () => Promise<void> | void;
  readonly invocationAuthority?: WorksetInvocationAuthority;
  readonly lockfile?: LockfileOpts;
  readonly git?: GitPlumbing;
  readonly onMutation?: OnMutation;
  readonly onSchemaDivergence?: GitObjectLedgerBackendOpts["onSchemaDivergence"];
  readonly commitRoots?: CreateGitObjectWorksetStoreOptions["commitRoots"];
  readonly sleep?: CreateGitObjectWorksetStoreOptions["sleep"];
  readonly isPidAlive?: CreateGitObjectWorksetStoreOptions["isPidAlive"];
  readonly isProcessGroupAlive?: CreateGitObjectWorksetStoreOptions["isProcessGroupAlive"];
  readonly locksDir?: CreateGitObjectWorksetStoreOptions["locksDir"];
  readonly validateReplacement?: CreateGitObjectWorksetStoreOptions["validateReplacement"];
}

export async function createGitObjectWorksetGuardedLedger(
  options: CreateGitObjectWorksetGuardedLedgerOptions,
): Promise<WorksetGuardedLedger> {
  const rawStore = new GitObjectLedgerBackend({
    repoRoot: options.repoRoot,
    ...(options.ref !== undefined ? { ref: options.ref } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.lockfile !== undefined ? { lockfile: options.lockfile } : {}),
    ...(options.git !== undefined ? { git: options.git } : {}),
    ...(options.onMutation !== undefined ? { onMutation: options.onMutation } : {}),
    ...(options.onSchemaDivergence !== undefined
      ? { onSchemaDivergence: options.onSchemaDivergence }
      : {}),
  });
  const worksetStore = await createGitObjectWorksetStore({
    repoRoot: options.repoRoot,
    ...(options.ref !== undefined ? { ref: options.ref } : {}),
    ...(options.git !== undefined ? { git: options.git } : {}),
    ...(options.lockfile !== undefined ? { lockfile: options.lockfile } : {}),
    ...(options.locksDir !== undefined ? { locksDir: options.locksDir } : {}),
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
    ...(options.commitRoots !== undefined ? { commitRoots: options.commitRoots } : {}),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    ...(options.isPidAlive !== undefined ? { isPidAlive: options.isPidAlive } : {}),
    ...(options.isProcessGroupAlive !== undefined
      ? { isProcessGroupAlive: options.isProcessGroupAlive }
      : {}),
    ...(options.validateReplacement !== undefined
      ? { validateReplacement: options.validateReplacement }
      : {}),
    isTargetAdmitted: (target, roots) => {
      if (roots.length === 0) return true;
      try {
        const graph = closeWorkset(roots, buildActiveStateFromLedgerStore(rawStore));
        return worksetMemberRefSet(graph).has(target) || graph.inactiveRoots.includes(target);
      } catch {
        return false;
      }
    },
  });
  return createWorksetGuardedLedger({
    rawStore,
    worksetStore,
    runGenericTransaction: (mutate) =>
      rawStore.runAtomicGenericMutation(mutate, () => readWorksetRootsEpoch(worksetStore)),
    ...(options.invocationAuthority !== undefined
      ? { invocationAuthority: options.invocationAuthority }
      : {}),
    ...(options.afterGenericAdmit !== undefined
      ? { afterGenericAdmit: options.afterGenericAdmit }
      : {}),
  });
}

export async function createGitObjectWorksetManagementLedger(
  options: Omit<CreateGitObjectWorksetGuardedLedgerOptions, "invocationAuthority">,
): Promise<WorksetGuardedLedger> {
  return createGitObjectWorksetGuardedLedger({
    ...options,
    invocationAuthority: createTrustedWorksetManagementAuthority(),
  });
}
