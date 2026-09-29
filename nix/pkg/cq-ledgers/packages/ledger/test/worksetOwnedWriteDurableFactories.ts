import { afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildActiveStateFromLedgerStore,
  closeWorkset,
  createTrustedWorksetManagementAuthority,
  createWorksetOwnedGuardedLedger,
  ensureSchema,
  openPgPool,
  PostgresLedgerStore,
  SqliteLedgerStore,
  worksetMemberRefSet,
  type CreateInMemoryWorksetOwnedGuardedLedgerOptions,
  type LedgerStore,
  type WorksetOwnedGuardedLedger,
  type WorksetOwnedWriteHost,
} from "../src/index.js";
import type {
  OwnedTransactionProbe,
  WorksetOwnedMemoryAuthorityPair,
  WorksetOwnedWriteContractFactory,
} from "./worksetOwnedWriteContract.js";

const tempRoots: string[] = [];
const openLedgers: WorksetOwnedGuardedLedger[] = [];

afterAll(async () => {
  for (const ledger of openLedgers.splice(0)) {
    await ledger.dispose().catch(() => undefined);
  }
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

function targetInGraph(
  rawStore: LedgerStore,
  target: string,
  roots: readonly string[],
): boolean {
  if (roots.length === 0) return true;
  try {
    const graph = closeWorkset(roots, buildActiveStateFromLedgerStore(rawStore));
    return worksetMemberRefSet(graph).has(target) || graph.inactiveRoots.includes(target);
  } catch {
    return false;
  }
}

function retain(ledger: WorksetOwnedGuardedLedger): WorksetOwnedGuardedLedger {
  openLedgers.push(ledger);
  return ledger;
}

async function freshRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/** G192/T6629 — ordinary (constructor default) and management surfaces over one raw store. */
function memoryAuthorityPair(
  rawStore: SqliteLedgerStore | PostgresLedgerStore,
  probe: OwnedTransactionProbe,
): WorksetOwnedMemoryAuthorityPair {
  const host: WorksetOwnedWriteHost = {
    rawStore,
    worksetStore: rawStore.worksetStore(),
    runOwnedTransaction: (mutate, context) =>
      rawStore.runAtomicOwnedMutation(probe.observe(mutate), context),
  };
  return {
    ordinary: createWorksetOwnedGuardedLedger(host),
    management: retain(
      createWorksetOwnedGuardedLedger({
        ...host,
        invocationAuthority: createTrustedWorksetManagementAuthority(),
      }),
    ),
  };
}


async function openSqliteRawStore(
  options: CreateInMemoryWorksetOwnedGuardedLedgerOptions | undefined,
): Promise<SqliteLedgerStore> {
  const dbPath = path.join(await freshRoot("owned-write-sqlite-"), "ledger.db");
  const rawStore: SqliteLedgerStore = new SqliteLedgerStore({
    dbPath,
    ...(options?.now !== undefined ? { now: options.now } : {}),
    workset: {
      ...(options?.hooks !== undefined ? { hooks: options.hooks } : {}),
      isTargetAdmitted: (target, roots) => targetInGraph(rawStore, target, roots),
    },
  });
  await rawStore.init();
  return rawStore;
}

export const sqliteOwnedWriteFactory: WorksetOwnedWriteContractFactory = {
  name: "SqliteLedgerStore",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  async build(options) {
    const rawStore = await openSqliteRawStore(options);
    return retain(
      createWorksetOwnedGuardedLedger({
        rawStore,
        worksetStore: rawStore.worksetStore(),
        invocationAuthority: createTrustedWorksetManagementAuthority(),
        ...(options?.afterOwnedAdmit !== undefined
          ? { afterOwnedAdmit: options.afterOwnedAdmit }
          : {}),
        runOwnedTransaction: (mutate, context) => rawStore.runAtomicOwnedMutation(mutate, context),
      }),
    );
  },
  async buildMemoryAuthorityPair(probe) {
    return memoryAuthorityPair(await openSqliteRawStore(undefined), probe);
  },
};

function withoutPoolOwnership(
  pool: ReturnType<typeof openPgPool>,
): ReturnType<typeof openPgPool> {
  return new Proxy(pool, {
    apply: (target, _thisArgument, argumentsList) =>
      Reflect.apply(
        target as unknown as (...args: unknown[]) => unknown,
        target,
        argumentsList,
      ),
    get: (target, property) => {
      if (property === "close") return async () => undefined;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function postgresOwnedWriteFactory(
  dsn: string,
): WorksetOwnedWriteContractFactory {
  const ownedPool = openPgPool(dsn);
  const sharedPool = withoutPoolOwnership(ownedPool);
  const schemaReady = ensureSchema(ownedPool);
  afterAll(async () => {
    await ownedPool.close();
  });
  async function openRawStore(
    options: CreateInMemoryWorksetOwnedGuardedLedgerOptions | undefined,
  ): Promise<PostgresLedgerStore> {
    await schemaReady;
    const projectKey = `t1966-owned-${randomUUID()}`;
    const rawStore: PostgresLedgerStore = new PostgresLedgerStore({
      pool: sharedPool,
      projectKey,
      displayName: projectKey,
      ...(options?.now !== undefined ? { now: options.now } : {}),
      workset: {
        ...(options?.hooks !== undefined ? { hooks: options.hooks } : {}),
        isTargetAdmitted: (target, roots) => targetInGraph(rawStore, target, roots),
      },
    });
    await rawStore.init();
    return rawStore;
  }
  return {
    name: "PostgresLedgerStore",
    classification: "Behavioral-Active Blackbox-GoodCommunication",
    async build(options?: CreateInMemoryWorksetOwnedGuardedLedgerOptions) {
      const rawStore = await openRawStore(options);
      return retain(
        createWorksetOwnedGuardedLedger({
          rawStore,
          worksetStore: rawStore.worksetStore(),
          invocationAuthority: createTrustedWorksetManagementAuthority(),
          ...(options?.afterOwnedAdmit !== undefined
            ? { afterOwnedAdmit: options.afterOwnedAdmit }
            : {}),
          runOwnedTransaction: (mutate, context) => rawStore.runAtomicOwnedMutation(mutate, context),
        }),
      );
    },
    async buildMemoryAuthorityPair(probe) {
      return memoryAuthorityPair(await openRawStore(undefined), probe);
    },
  };
}
