import { afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  buildActiveStateFromLedgerStore,
  closeWorkset,
  createGitObjectWorksetStore,
  createTrustedWorksetManagementAuthority,
  createWorksetGuardedPlanLifecycleStore,
  ensureSchema,
  FsLedgerStore,
  GitObjectLedgerBackend,
  openPgPool,
  PostgresLedgerStore,
  SqliteLedgerStore,
  worksetMemberRefSet,
  type LedgerStore,
  type WorksetGuardedPlanLifecycleStore,
  type WorksetOwnedWriteTx,
  type WorksetPlanLifecycleTx,
  type WorksetStore,
} from "../src/index.js";
import type { WorksetPlanLifecycleContractFactory } from "./worksetPlanLifecycleContract.js";

const exec = promisify(execFile);
const tempRoots: string[] = [];
const openLedgers: WorksetGuardedPlanLifecycleStore[] = [];

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

function retain(
  ledger: WorksetGuardedPlanLifecycleStore,
): WorksetGuardedPlanLifecycleStore {
  openLedgers.push(ledger);
  return ledger;
}

async function freshRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function seedGitRepo(): Promise<string> {
  const root = await freshRoot("workset-plan-git-");
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "test"], { cwd: root });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  return root;
}

type DurablePlanStore = LedgerStore & {
  runAtomicOwnedMutation<T>(mutate: (tx: WorksetOwnedWriteTx) => T): Promise<T>;
  runAtomicWorksetPlanLifecycleMutation<T>(
    mutate: (tx: WorksetPlanLifecycleTx) => T,
  ): Promise<T>;
};

function surface(
  rawStore: DurablePlanStore,
  worksetStore: WorksetStore,
  options: Parameters<WorksetPlanLifecycleContractFactory["build"]>[0],
): WorksetGuardedPlanLifecycleStore {
  return retain(
    createWorksetGuardedPlanLifecycleStore({
      rawStore,
      worksetStore,
      invocationAuthority: createTrustedWorksetManagementAuthority(),
      ...(options?.afterPlanAdmit !== undefined
        ? { afterPlanAdmit: options.afterPlanAdmit }
        : {}),
      runOwnedTransaction: (mutate) => rawStore.runAtomicOwnedMutation(mutate),
      runPlanLifecycleTransaction: (mutate) =>
        rawStore.runAtomicWorksetPlanLifecycleMutation(mutate),
    }),
  );
}

export const fsPlanLifecycleFactory: WorksetPlanLifecycleContractFactory = {
  name: "FsLedgerStore",
  async build(options) {
    const root = await freshRoot("workset-plan-fs-");
    const rawStore = new FsLedgerStore({
      root,
      ...(options?.now !== undefined ? { now: options.now } : {}),
    });
    const worksetStore = rawStore.createWorksetStore({
      ...(options?.hooks !== undefined ? { hooks: options.hooks } : {}),
      isTargetAdmitted: (target, roots) => targetInGraph(rawStore, target, roots),
    });
    return surface(rawStore, worksetStore, options);
  },
};

export const gitPlanLifecycleFactory: WorksetPlanLifecycleContractFactory = {
  name: "GitObjectLedgerBackend",
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
    return surface(rawStore, worksetStore, options);
  },
};

export const sqlitePlanLifecycleFactory: WorksetPlanLifecycleContractFactory = {
  name: "SqliteLedgerStore",
  async build(options) {
    const dbPath = path.join(await freshRoot("workset-plan-sqlite-"), "ledger.db");
    const rawStore: SqliteLedgerStore = new SqliteLedgerStore({
      dbPath,
      ...(options?.now !== undefined ? { now: options.now } : {}),
      workset: {
        ...(options?.hooks !== undefined ? { hooks: options.hooks } : {}),
        isTargetAdmitted: (target, roots) => targetInGraph(rawStore, target, roots),
      },
    });
    await rawStore.init();
    return surface(rawStore, rawStore.worksetStore(), options);
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

export function postgresPlanLifecycleFactory(
  dsn: string,
): WorksetPlanLifecycleContractFactory {
  const ownedPool = openPgPool(dsn);
  const sharedPool = withoutPoolOwnership(ownedPool);
  const schemaReady = ensureSchema(ownedPool);
  afterAll(async () => {
    await ownedPool.close();
  });
  return {
    name: "PostgresLedgerStore",
    async build(options) {
      await schemaReady;
      const projectKey = `t1971-plan-${randomUUID()}`;
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
      return surface(rawStore, rawStore.worksetStore(), options);
    },
  };
}
