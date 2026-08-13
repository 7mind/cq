import { afterAll } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  buildActiveStateFromLedgerStore,
  closeWorkset,
  createGitObjectWorksetStore,
  createTrustedWorksetManagementAuthority,
  createWorksetOwnedGuardedLedger,
  ensureSchema,
  FsLedgerStore,
  GitObjectLedgerBackend,
  openPgPool,
  PostgresLedgerStore,
  SqliteLedgerStore,
  worksetMemberRefSet,
  type CreateInMemoryWorksetOwnedGuardedLedgerOptions,
  type LedgerStore,
  type WorksetOwnedGuardedLedger,
} from "../src/index.js";
import type { WorksetOwnedWriteContractFactory } from "./worksetOwnedWriteContract.js";

const exec = promisify(execFile);
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

async function seedGitRepo(): Promise<string> {
  const root = await freshRoot("owned-write-git-");
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "test"], { cwd: root });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  return root;
}

export const fsOwnedWriteFactory: WorksetOwnedWriteContractFactory = {
  name: "FsLedgerStore",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  async build(options) {
    const root = await freshRoot("owned-write-fs-");
    const rawStore = new FsLedgerStore({
      root,
      ...(options?.now !== undefined ? { now: options.now } : {}),
    });
    const worksetStore = rawStore.createWorksetStore({
      ...(options?.hooks !== undefined ? { hooks: options.hooks } : {}),
      isTargetAdmitted: (target, roots) => targetInGraph(rawStore, target, roots),
    });
    return retain(
      createWorksetOwnedGuardedLedger({
        rawStore,
        worksetStore,
        invocationAuthority: createTrustedWorksetManagementAuthority(),
        ...(options?.afterOwnedAdmit !== undefined
          ? { afterOwnedAdmit: options.afterOwnedAdmit }
          : {}),
        runOwnedTransaction: (mutate) => rawStore.runAtomicOwnedMutation(mutate),
      }),
    );
  },
};

export const gitOwnedWriteFactory: WorksetOwnedWriteContractFactory = {
  name: "GitObjectLedgerBackend",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  async build(options) {
    const repoRoot = await seedGitRepo();
    const rawStore = new GitObjectLedgerBackend({
      repoRoot,
      ...(options?.now !== undefined ? { now: options.now } : {}),
    });
    const worksetStore = await createGitObjectWorksetStore({
      repoRoot,
      ...(options?.hooks !== undefined ? { hooks: options.hooks } : {}),
      isTargetAdmitted: (target, roots) => targetInGraph(rawStore, target, roots),
    });
    return retain(
      createWorksetOwnedGuardedLedger({
        rawStore,
        worksetStore,
        invocationAuthority: createTrustedWorksetManagementAuthority(),
        ...(options?.afterOwnedAdmit !== undefined
          ? { afterOwnedAdmit: options.afterOwnedAdmit }
          : {}),
        runOwnedTransaction: (mutate) => rawStore.runAtomicOwnedMutation(mutate),
      }),
    );
  },
};

export const sqliteOwnedWriteFactory: WorksetOwnedWriteContractFactory = {
  name: "SqliteLedgerStore",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  async build(options) {
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
    return retain(
      createWorksetOwnedGuardedLedger({
        rawStore,
        worksetStore: rawStore.worksetStore(),
        invocationAuthority: createTrustedWorksetManagementAuthority(),
        ...(options?.afterOwnedAdmit !== undefined
          ? { afterOwnedAdmit: options.afterOwnedAdmit }
          : {}),
        runOwnedTransaction: (mutate) => rawStore.runAtomicOwnedMutation(mutate),
      }),
    );
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
  return {
    name: "PostgresLedgerStore",
    classification: "Behavioral-Active Blackbox-GoodCommunication",
    async build(options?: CreateInMemoryWorksetOwnedGuardedLedgerOptions) {
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
      return retain(
        createWorksetOwnedGuardedLedger({
          rawStore,
          worksetStore: rawStore.worksetStore(),
          invocationAuthority: createTrustedWorksetManagementAuthority(),
          ...(options?.afterOwnedAdmit !== undefined
            ? { afterOwnedAdmit: options.afterOwnedAdmit }
            : {}),
          runOwnedTransaction: (mutate) => rawStore.runAtomicOwnedMutation(mutate),
        }),
      );
    },
  };
}
