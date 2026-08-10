import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  GitObjectLedgerBackend,
  InMemoryLedgerStore,
  MILESTONES_AMBIENT_ID,
  PostgresLedgerStore,
  SqliteLedgerStore,
  TASKS_LEDGER,
  type LedgerStore,
  type TaskAdoptionEligibilityFence,
} from "../src/index.js";
import { openPgPool } from "../src/store/postgres/connection.js";
import { ensureSchema } from "../src/store/postgres/schema.js";

const RESULT_A = "a".repeat(40);
const RESULT_B = "b".repeat(40);
const RESULT_C = "c".repeat(40);

interface HeldMutation {
  invoke(): void;
  readonly completed: Promise<void>;
}

interface AdoptionStoreFixture {
  readonly primary: LedgerStore;
  readonly peer: LedgerStore;
  prepareHeldMutation(taskId: string): Promise<HeldMutation>;
  dispose(): Promise<void>;
}

interface AdoptionStoreFactory {
  readonly name: string;
  readonly classification: string;
  readonly timeoutMs?: number;
  build(): Promise<AdoptionStoreFixture>;
}

function ordinaryHeldMutation(peer: LedgerStore, taskId: string): HeldMutation {
  let resolveCompleted!: () => void;
  let rejectCompleted!: (error: unknown) => void;
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  let invoked = false;
  return {
    invoke(): void {
      if (invoked) throw new Error("held mutation invoked twice");
      invoked = true;
      void peer
        .updateItem(TASKS_LEDGER, taskId, { fields: { resultCommit: RESULT_C } })
        .then(() => resolveCompleted(), rejectCompleted);
    },
    completed,
  };
}

async function sqliteHeldMutation(dbPath: string, taskId: string): Promise<HeldMutation> {
  const control = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(
    new URL("./taskAdoptionSqliteRaceWorker.ts", import.meta.url).href,
  );
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveCompleted!: () => void;
  let rejectCompleted!: (error: unknown) => void;
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  worker.onmessage = (event: MessageEvent<{ type: "ready" | "done" | "error"; message?: string }>) => {
    if (event.data.type === "ready") {
      resolveReady();
      return;
    }
    worker.terminate();
    if (event.data.type === "done") resolveCompleted();
    else rejectCompleted(new Error(event.data.message ?? "SQLite race worker failed"));
  };
  worker.onerror = (event): void => {
    const error = new Error(event.message);
    rejectReady(error);
    rejectCompleted(error);
  };
  worker.postMessage({ dbPath, taskId, control: control.buffer });
  await ready;
  let invoked = false;
  return {
    invoke(): void {
      if (invoked) throw new Error("held mutation invoked twice");
      invoked = true;
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0);
      const wait = Atomics.wait(control, 0, 1, 5_000);
      if (wait === "timed-out" || Atomics.load(control, 0) !== 2) {
        throw new Error("SQLite race worker did not reach its mutation boundary");
      }
    },
    completed,
  };
}

async function seedEligibleClosure(fixture: AdoptionStoreFixture): Promise<void> {
  await fixture.primary.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: "T1",
    status: "done",
    fields: { headline: "first dependency", resultCommit: RESULT_A },
  });
  await fixture.primary.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: "T2",
    status: "done",
    fields: {
      headline: "transitive dependency",
      dependsOn: ["tasks:T1"],
      resultCommit: RESULT_B,
    },
  });
  await fixture.primary.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: "T3",
    status: "wip",
    fields: { headline: "adopt existing worktree", dependsOn: ["tasks:T2"] },
  });
  await fixture.peer.invalidate(TASKS_LEDGER);
}

async function disposeDistinct(stores: readonly LedgerStore[]): Promise<void> {
  for (const store of new Set(stores)) await store.dispose();
}

function runTaskAdoptionEligibilityStoreContract(factory: AdoptionStoreFactory): void {
  const timeout = factory.timeoutMs ?? 10_000;
  describe(
    `Task adoption eligibility store contract — ${factory.name} (${factory.classification})`,
    () => {
      it("rejects absent, inactive, non-wip, and dependency-ineligible tasks", async () => {
        const fixture = await factory.build();
        try {
          await expect(fixture.primary.captureTaskAdoptionEligibility("T404")).resolves.toEqual({
            status: "ineligible",
            ineligibility: { reason: "task-not-found", taskId: "T404" },
          });
          await fixture.primary.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
            id: "T1",
            status: "planned",
            fields: { headline: "not started" },
          });
          await expect(fixture.primary.captureTaskAdoptionEligibility("T1")).resolves.toEqual({
            status: "ineligible",
            ineligibility: { reason: "task-not-wip", taskId: "T1", taskStatus: "planned" },
          });

          const milestone = await fixture.primary.createMilestone({ title: "archived root" });
          await fixture.primary.createItem(TASKS_LEDGER, milestone.id, {
            id: "T2",
            status: "done",
            fields: { headline: "archived", resultCommit: RESULT_A },
          });
          await fixture.primary.updateMilestone(milestone.id, { status: "done" });
          await fixture.primary.archiveMilestone(milestone.id, "archived root");
          await expect(fixture.primary.captureTaskAdoptionEligibility("T2")).resolves.toEqual({
            status: "ineligible",
            ineligibility: { reason: "task-not-active", taskId: "T2", taskStatus: "done" },
          });

          await fixture.primary.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
            id: "T3",
            status: "blocked",
            fields: { headline: "unsatisfied dependency" },
          });
          await fixture.primary.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
            id: "T4",
            status: "wip",
            fields: { headline: "blocked root", dependsOn: ["tasks:T3"] },
          });
          await expect(
            fixture.primary.captureTaskAdoptionEligibility("T4"),
          ).resolves.toMatchObject({
            status: "ineligible",
            ineligibility: {
              reason: "dependency-unresolvable",
              detail: { reason: "dependency-not-satisfied", dependencyRef: "tasks:T3" },
            },
          });
        } finally {
          await fixture.dispose();
        }
      }, timeout);

      it("loads an archived done dependency into the eligible closure", async () => {
        const fixture = await factory.build();
        try {
          const milestone = await fixture.primary.createMilestone({ title: "dependency" });
          await fixture.primary.createItem(TASKS_LEDGER, milestone.id, {
            id: "T1",
            status: "done",
            fields: { headline: "archived dependency", resultCommit: RESULT_A },
          });
          await fixture.primary.updateMilestone(milestone.id, { status: "done" });
          await fixture.primary.archiveMilestone(milestone.id, "dependency done");
          await fixture.primary.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
            id: "T2",
            status: "wip",
            fields: { headline: "root", dependsOn: ["tasks:T1"] },
          });
          await expect(fixture.primary.captureTaskAdoptionEligibility("T2")).resolves.toMatchObject({
            status: "eligible",
          });
        } finally {
          await fixture.dispose();
        }
      }, timeout);

      it("rejects a root-status mutation after capture without publishing", async () => {
        const fixture = await factory.build();
        try {
          await seedEligibleClosure(fixture);
          const captured = await fixture.primary.captureTaskAdoptionEligibility("T3");
          if (captured.status !== "eligible") throw new Error("eligible fixture was rejected");
          await fixture.peer.updateItem(TASKS_LEDGER, "T3", { status: "blocked" });
          let published = false;
          expect(
            await fixture.primary.publishTaskAdoption(captured.fence, () => {
              published = true;
            }),
          ).toEqual({ status: "stale" });
          expect(published).toBe(false);
        } finally {
          await fixture.dispose();
        }
      }, timeout);

      it("reloads authority and rejects a peer's transitive result-commit mutation", async () => {
        const fixture = await factory.build();
        try {
          await seedEligibleClosure(fixture);
          const captured = await fixture.primary.captureTaskAdoptionEligibility("T3");
          if (captured.status !== "eligible") throw new Error("eligible fixture was rejected");
          await fixture.peer.updateItem(TASKS_LEDGER, "T1", {
            fields: { resultCommit: RESULT_C },
          });
          let publications = 0;
          expect(
            await fixture.primary.publishTaskAdoption(captured.fence, () => {
              publications += 1;
            }),
          ).toEqual({ status: "stale" });
          expect(publications).toBe(0);
        } finally {
          await fixture.dispose();
        }
      }, timeout);

      it("serializes a mutation started while held after the pointer callback", async () => {
        const fixture = await factory.build();
        try {
          await seedEligibleClosure(fixture);
          const captured = await fixture.primary.captureTaskAdoptionEligibility("T3");
          if (captured.status !== "eligible") throw new Error("eligible fixture was rejected");
          const heldMutation = await fixture.prepareHeldMutation("T3");
          const events: string[] = [];
          const completed = heldMutation.completed.then(() => {
            events.push("mutation");
          });
          expect(
            await fixture.primary.publishTaskAdoption(captured.fence, () => {
              heldMutation.invoke();
              events.push("pointer");
            }),
          ).toEqual({ status: "published" });
          await completed;
          expect(events).toEqual(["pointer", "mutation"]);
          await fixture.primary.invalidate(TASKS_LEDGER);
          expect(fixture.primary.fetchItem(TASKS_LEDGER, "T3").fields["resultCommit"]).toBe(
            RESULT_C,
          );
        } finally {
          await fixture.dispose();
        }
      }, timeout);

      it("publishes an unchanged fence once and refuses forged or replayed fences", async () => {
        const fixture = await factory.build();
        try {
          await seedEligibleClosure(fixture);
          const captured = await fixture.primary.captureTaskAdoptionEligibility("T3");
          if (captured.status !== "eligible") throw new Error("eligible fixture was rejected");
          let publications = 0;
          const publish = (): undefined => {
            publications += 1;
          };
          expect(await fixture.primary.publishTaskAdoption(captured.fence, publish)).toEqual({
            status: "published",
          });
          expect(await fixture.primary.publishTaskAdoption(captured.fence, publish)).toEqual({
            status: "already-published",
          });
          const forged = {} as TaskAdoptionEligibilityFence;
          expect(await fixture.primary.publishTaskAdoption(forged, publish)).toEqual({
            status: "invalid-fence",
          });
          expect(publications).toBe(1);
        } finally {
          await fixture.dispose();
        }
      }, timeout);

      it("releases serialization and leaves the fence unpublished when the callback throws", async () => {
        const fixture = await factory.build();
        try {
          await seedEligibleClosure(fixture);
          const captured = await fixture.primary.captureTaskAdoptionEligibility("T3");
          if (captured.status !== "eligible") throw new Error("eligible fixture was rejected");
          let publications = 0;
          await expect(
            fixture.primary.publishTaskAdoption(captured.fence, () => {
              throw new Error("pointer commit failed");
            }),
          ).rejects.toThrow("pointer commit failed");
          expect(
            await fixture.primary.publishTaskAdoption(captured.fence, () => {
              publications += 1;
            }),
          ).toEqual({ status: "published" });
          await fixture.primary.updateItem(TASKS_LEDGER, "T3", {
            fields: { resultCommit: RESULT_C },
          });
          expect(publications).toBe(1);
        } finally {
          await fixture.dispose();
        }
      }, timeout);
    },
  );
}

const inMemoryFactory: AdoptionStoreFactory = {
  name: "InMemoryLedgerStore",
  classification: "Behavioral-Active Blackbox-Atomic",
  async build() {
    const store = new InMemoryLedgerStore();
    await store.init();
    return {
      primary: store,
      peer: store,
      prepareHeldMutation: async (taskId) => ordinaryHeldMutation(store, taskId),
      dispose: () => store.dispose(),
    };
  },
};

const fsFactory: AdoptionStoreFactory = {
  name: "FsLedgerStore",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  async build() {
    const root = await mkdtemp(path.join(tmpdir(), "task-adoption-fs-"));
    const primary = new FsLedgerStore({ root });
    const peer = new FsLedgerStore({ root });
    await primary.init();
    await peer.init();
    return {
      primary,
      peer,
      prepareHeldMutation: async (taskId) => ordinaryHeldMutation(peer, taskId),
      async dispose() {
        await disposeDistinct([primary, peer]);
        await rm(root, { recursive: true, force: true });
      },
    };
  },
};

const gitFactory: AdoptionStoreFactory = {
  name: "GitObjectLedgerBackend",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  timeoutMs: 60_000,
  async build() {
    const root = await mkdtemp(path.join(tmpdir(), "task-adoption-git-"));
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    const primary = new GitObjectLedgerBackend({ repoRoot: root });
    const peer = new GitObjectLedgerBackend({ repoRoot: root });
    await primary.init();
    await peer.init();
    return {
      primary,
      peer,
      prepareHeldMutation: async (taskId) => ordinaryHeldMutation(peer, taskId),
      async dispose() {
        await disposeDistinct([primary, peer]);
        await rm(root, { recursive: true, force: true });
      },
    };
  },
};

const sqliteFactory: AdoptionStoreFactory = {
  name: "SqliteLedgerStore",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  timeoutMs: 20_000,
  async build() {
    const root = await mkdtemp(path.join(tmpdir(), "task-adoption-sqlite-"));
    const dbPath = path.join(root, "ledger.db");
    const primary = new SqliteLedgerStore({ dbPath });
    const peer = new SqliteLedgerStore({ dbPath });
    await primary.init();
    await peer.init();
    return {
      primary,
      peer,
      prepareHeldMutation: (taskId) => sqliteHeldMutation(dbPath, taskId),
      async dispose() {
        await disposeDistinct([primary, peer]);
        await rm(root, { recursive: true, force: true });
      },
    };
  },
};

runTaskAdoptionEligibilityStoreContract(inMemoryFactory);
runTaskAdoptionEligibilityStoreContract(fsFactory);
runTaskAdoptionEligibilityStoreContract(gitFactory);
runTaskAdoptionEligibilityStoreContract(sqliteFactory);

const pgUrl = process.env["CQ_TEST_PG_URL"];
if (pgUrl === undefined || pgUrl.length === 0) {
  describe.skip("Task adoption eligibility store contract — PostgresLedgerStore", () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
} else {
  const postgresFactory: AdoptionStoreFactory = {
    name: "PostgresLedgerStore",
    classification: "Behavioral-Active Blackbox-GoodCommunication",
    timeoutMs: 30_000,
    async build() {
      const primaryPool = openPgPool(pgUrl);
      const peerPool = openPgPool(pgUrl);
      await ensureSchema(primaryPool);
      const projectKey = `task-adoption-${randomUUID()}`;
      const primary = new PostgresLedgerStore({
        pool: primaryPool,
        projectKey,
        displayName: projectKey,
      });
      const peer = new PostgresLedgerStore({
        pool: peerPool,
        projectKey,
        displayName: projectKey,
      });
      await primary.init();
      await peer.init();
      return {
        primary,
        peer,
        prepareHeldMutation: async (taskId) => ordinaryHeldMutation(peer, taskId),
        dispose: () => disposeDistinct([primary, peer]),
      };
    },
  };
  runTaskAdoptionEligibilityStoreContract(postgresFactory);
}
