import type { WorksetAdmissionCoordinatorHooks } from "../worksetEffectAdmission.js";
import {
  createTrustedWorksetManagementAuthority,
  type WorksetInvocationAuthority,
} from "../worksetInvocationAuthority.js";
import {
  closedGraphIsTargetAdmitted,
  createWorksetGuardedLedger,
  type WorksetGuardedLedger,
} from "../worksetGenericMutation.js";
import { readWorksetRootsEpoch } from "../worksetStore.js";
import { FsLedgerStore, type FsLedgerStoreOpts } from "./FsLedgerStore.js";
import {
  createFsWorksetStore,
  type CreateFsWorksetStoreOptions,
} from "./fsWorksetStore.js";

export interface CreateFsWorksetGuardedLedgerOptions {
  readonly root: string;
  readonly now?: () => string;
  readonly hooks?: WorksetAdmissionCoordinatorHooks;
  readonly afterGenericAdmit?: () => Promise<void> | void;
  readonly invocationAuthority?: WorksetInvocationAuthority;
  readonly lockfile?: FsLedgerStoreOpts["lockfile"];
  readonly onMutation?: FsLedgerStoreOpts["onMutation"];
  readonly ledgerAtomicWrite?: (filePath: string, text: string) => Promise<void>;
  readonly worksetAtomicWrite?: (filePath: string, text: string) => Promise<void>;
  readonly isPidAlive?: CreateFsWorksetStoreOptions["isPidAlive"];
  readonly isProcessGroupAlive?: CreateFsWorksetStoreOptions["isProcessGroupAlive"];
  readonly selfPid?: number;
  readonly selfHostname?: string;
  readonly pollIntervalMs?: number;
}

export function createFsWorksetGuardedLedger(
  options: CreateFsWorksetGuardedLedgerOptions,
): WorksetGuardedLedger {
  if (typeof options.root !== "string" || options.root.length === 0) {
    throw new Error("createFsWorksetGuardedLedger: root is required");
  }
  const rawStore = new FsLedgerStore({
    root: options.root,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.lockfile !== undefined ? { lockfile: options.lockfile } : {}),
    ...(options.onMutation !== undefined ? { onMutation: options.onMutation } : {}),
    ...(options.ledgerAtomicWrite !== undefined
      ? { atomicWrite: options.ledgerAtomicWrite }
      : {}),
  });
  const worksetStore = createFsWorksetStore({
    root: options.root,
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
    ...(options.lockfile !== undefined ? { lockfile: options.lockfile } : {}),
    ...(options.worksetAtomicWrite !== undefined
      ? { atomicWrite: options.worksetAtomicWrite }
      : {}),
    ...(options.isPidAlive !== undefined ? { isPidAlive: options.isPidAlive } : {}),
    ...(options.isProcessGroupAlive !== undefined
      ? { isProcessGroupAlive: options.isProcessGroupAlive }
      : {}),
    ...(options.selfPid !== undefined ? { selfPid: options.selfPid } : {}),
    ...(options.selfHostname !== undefined ? { selfHostname: options.selfHostname } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
    isTargetAdmitted: closedGraphIsTargetAdmitted(rawStore),
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

export function createFsWorksetManagementLedger(
  options: Omit<CreateFsWorksetGuardedLedgerOptions, "invocationAuthority">,
): WorksetGuardedLedger {
  return createFsWorksetGuardedLedger({
    ...options,
    invocationAuthority: createTrustedWorksetManagementAuthority(),
  });
}
