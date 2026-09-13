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
import type { WorksetStore } from "../../worksetStore.js";
import { SqliteLedgerStore } from "./SqliteLedgerStore.js";
import type {
  SqliteAccessObserver,
  SqliteMonotonicNow,
  SqliteOperationObserver,
} from "./operationObservability.js";

export interface CreateSqliteWorksetGuardedLedgerOptions {
  readonly dbPath: string;
  readonly now?: () => string;
  readonly monotonicNow?: SqliteMonotonicNow;
  readonly operationObserver?: SqliteOperationObserver;
  readonly accessObserver?: SqliteAccessObserver;
  readonly logsDir?: string;
  readonly hooks?: WorksetAdmissionCoordinatorHooks;
  readonly afterGenericAdmit?: () => Promise<void> | void;
  readonly invocationAuthority?: WorksetInvocationAuthority;
}

function lazySqliteWorksetStore(get: () => WorksetStore): WorksetStore {
  return {
    snapshot: () => get().snapshot(),
    setRoots: (roots) => get().setRoots(roots),
    admitLedgerMutation: (input) => get().admitLedgerMutation(input),
    admitExternalEffect: (input) => get().admitExternalEffect(input),
    admitManagedTerminalReleaseEffect: (input) => get().admitManagedTerminalReleaseEffect(input),
    runAdministrative: (input) => get().runAdministrative(input),
    activeAdmissionCount: () => get().activeAdmissionCount(),
    exclusiveHeld: () => get().exclusiveHeld(),
  };
}

export function createSqliteWorksetGuardedLedger(
  options: CreateSqliteWorksetGuardedLedgerOptions,
): WorksetGuardedLedger {
  const box: { raw: SqliteLedgerStore | null } = { raw: null };
  const rawStore = new SqliteLedgerStore({
    dbPath: options.dbPath,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.monotonicNow !== undefined ? { monotonicNow: options.monotonicNow } : {}),
    ...(options.operationObserver !== undefined
      ? { operationObserver: options.operationObserver }
      : {}),
    ...(options.accessObserver !== undefined ? { accessObserver: options.accessObserver } : {}),
    ...(options.logsDir !== undefined ? { logsDir: options.logsDir } : {}),
    workset: {
      ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
      isTargetAdmitted: (target, roots) => {
        if (roots.length === 0) return true;
        const live = box.raw;
        if (live === null) return false;
        try {
          const graph = closeWorkset(roots, buildActiveStateFromLedgerStore(live));
          return worksetMemberRefSet(graph).has(target) || graph.inactiveRoots.includes(target);
        } catch {
          return false;
        }
      },
    },
  });
  box.raw = rawStore;
  return createWorksetGuardedLedger({
    rawStore,
    worksetStore: lazySqliteWorksetStore(() => rawStore.worksetStore()),
    runGenericTransaction: (mutate, measurement, accessScope) =>
      rawStore.runAtomicGenericMutation(mutate, undefined, measurement, accessScope),
    ...(options.invocationAuthority !== undefined
      ? { invocationAuthority: options.invocationAuthority }
      : {}),
    ...(options.afterGenericAdmit !== undefined
      ? { afterGenericAdmit: options.afterGenericAdmit }
      : {}),
  });
}

export function createSqliteWorksetManagementLedger(
  options: Omit<CreateSqliteWorksetGuardedLedgerOptions, "invocationAuthority">,
): WorksetGuardedLedger {
  return createSqliteWorksetGuardedLedger({
    ...options,
    invocationAuthority: createTrustedWorksetManagementAuthority(),
  });
}
