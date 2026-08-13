/**
 * T1958 — WorksetStore Postgres leg: shared Blackbox contract + focused
 * durable/tenant behaviors. Env-gated on CQ_TEST_PG_URL (Q286).
 */

import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createPostgresWorksetStore,
  ensureSchema,
  createTrustedWorksetManagementAuthority,
  openPgPool,
  PostgresLedgerStore,
  readWorksetRootsEpoch,
  WorksetAdmissionError,
  type PostgresWorksetStore,
} from "../src/index.js";
import {
  runWorksetStoreContract,
  type WorksetStoreContractFactory,
} from "./worksetStoreContract.js";

const PG_URL = process.env.CQ_TEST_PG_URL;

if (PG_URL === undefined || PG_URL.length === 0) {
  describe.skip("workset store contract [T1958] — Postgres", () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
  describe.skip("workset store postgres focused [T1958]", () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
} else {
  // One shared pool for the whole file — the contract race fixture builds
  // hundreds of stores; a pool-per-build exhausts max_connections.
  const sharedPool = openPgPool(PG_URL);
  const schemaReady = ensureSchema(sharedPool);
  const openStores: PostgresWorksetStore[] = [];

  afterAll(async () => {
    for (const s of openStores) s.close();
    await sharedPool.close();
  });

  async function prepareTenant(): Promise<string> {
    await schemaReady;
    const projectKey = `t1958-ws-${randomUUID()}`;
    await sharedPool`
      INSERT INTO projects (project_key, display_name) VALUES (${projectKey}, ${projectKey})
    `;
    return projectKey;
  }

  const postgresFactory: WorksetStoreContractFactory = {
    name: "Postgres durable WorksetStore",
    classification: "Behavioral-Active Blackbox-GoodCommunication",
    async build(options) {
      const projectKey = await prepareTenant();
      const store = createPostgresWorksetStore({
        pool: sharedPool,
        projectKey,
        ...(options?.hooks !== undefined ? { hooks: options.hooks } : {}),
        ...(options?.validateReplacement !== undefined
          ? { validateReplacement: options.validateReplacement }
          : {}),
        ...(options?.isTargetAdmitted !== undefined
          ? { isTargetAdmitted: options.isTargetAdmitted }
          : {}),
      });
      openStores.push(store);
      return store;
    },
  };

  runWorksetStoreContract(postgresFactory);

  describe("workset store postgres focused [T1958]", () => {
    it("holds administrative exclusion through atomic tenant deletion", async () => {
      const projectKey = await prepareTenant();
      const store = createPostgresWorksetStore({ pool: sharedPool, projectKey });
      openStores.push(store);

      await store.runAdministrative({
        kind: "erase",
        authority: createTrustedWorksetManagementAuthority(),
        destructivePhase: async () => {
          await sharedPool.begin(async (tx) => {
            await tx`DELETE FROM workset_admissions WHERE project_key = ${projectKey}`;
            await tx`DELETE FROM workset_roots WHERE project_key = ${projectKey}`;
            await tx`DELETE FROM projects WHERE project_key = ${projectKey}`;
          });
        },
      });

      const [projects, roots, admissions] = await Promise.all([
        sharedPool`SELECT project_key FROM projects WHERE project_key = ${projectKey}`,
        sharedPool`SELECT project_key FROM workset_roots WHERE project_key = ${projectKey}`,
        sharedPool`SELECT project_key FROM workset_admissions WHERE project_key = ${projectKey}`,
      ]);
      expect(projects).toHaveLength(0);
      expect(roots).toHaveLength(0);
      expect(admissions).toHaveLength(0);
    });

    it("isolates roots across tenants", async () => {
      const aKey = await prepareTenant();
      const bKey = await prepareTenant();
      const a = createPostgresWorksetStore({ pool: sharedPool, projectKey: aKey });
      const b = createPostgresWorksetStore({ pool: sharedPool, projectKey: bKey });
      openStores.push(a, b);
      await a.setRoots(["goals:G-a"]);
      await b.setRoots(["goals:G-b", "tasks:T-b"]);
      expect(await readWorksetRootsEpoch(a)).toEqual({ roots: ["goals:G-a"], epoch: 1 });
      expect(await readWorksetRootsEpoch(b)).toEqual({
        roots: ["goals:G-b", "tasks:T-b"],
        epoch: 1,
      });
    });

    it("restart (new store instance) observes committed roots/epoch", async () => {
      const projectKey = await prepareTenant();
      const first = createPostgresWorksetStore({ pool: sharedPool, projectKey });
      openStores.push(first);
      await first.setRoots(["tasks:T-persist", "goals:G-persist"]);
      first.close();

      const second = createPostgresWorksetStore({ pool: sharedPool, projectKey });
      openStores.push(second);
      expect(await readWorksetRootsEpoch(second)).toEqual({
        roots: ["tasks:T-persist", "goals:G-persist"],
        epoch: 1,
      });
    });

    it("cross-server set waits for peer durable admission then commits", async () => {
      const projectKey = await prepareTenant();
      const holder = createPostgresWorksetStore({ pool: sharedPool, projectKey });
      const peer = createPostgresWorksetStore({ pool: sharedPool, projectKey });
      openStores.push(holder, peer);

      const admission = await holder.admitExternalEffect({
        kind: "merge",
        targetRef: "tasks:T-peer",
      });
      expect((await holder.listDurableAdmissions()).length).toBe(1);

      const setPromise = peer.setRoots(["goals:G1"]);
      let done = false;
      void setPromise.then(() => {
        done = true;
      });
      await Promise.resolve();
      await Bun.sleep(30);
      expect(done).toBe(false);

      await Promise.resolve(admission.registerProcessGroup({ pgid: 9001, leaderPid: 9001 }));
      await Promise.resolve(admission.markSettled());
      await admission.releaseAfterSettlement();
      const snap = await setPromise;
      expect(snap).toEqual({ roots: ["goals:G1"], epoch: 1 });
      expect(await peer.listDurableAdmissions()).toEqual([]);
    });

    it("forceSettleAdmission under management authority clears a stuck row", async () => {
      const projectKey = await prepareTenant();
      const stuckId = `ee-stuck-${randomUUID()}`;
      await sharedPool`
        INSERT INTO workset_roots (project_key, roots_json, epoch, admit_generation)
        VALUES (${projectKey}, ${"[]"}, ${0}, ${0})
        ON CONFLICT DO NOTHING
      `;
      await sharedPool`
        INSERT INTO workset_admissions (
          project_key, admission_id, form, kind, target_key, targets_json, epoch,
          host_id, holder_pid, holder_start_time, heartbeat_at_ms,
          process_group_registered, pgid, leader_pid, leader_start_time,
          settled, created_at_ms
        ) VALUES (
          ${projectKey},
          ${stuckId},
          ${"external-effect"},
          ${"rebase"},
          ${"tasks:T-stuck"},
          ${JSON.stringify(["tasks:T-stuck"])},
          ${0},
          ${"host-x"},
          ${1},
          ${"dead"},
          ${0},
          ${true},
          ${4242},
          ${4242},
          ${"start"},
          ${false},
          ${0}
        )
      `;

      const peer = createPostgresWorksetStore({
        pool: sharedPool,
        projectKey,
        heartbeatTtlMs: 1,
        isHolderAlive: async () => false,
        settleRegisteredGroup: async () => ({ survivors: [42] }),
        now: () => Date.now() + 10_000,
      });
      openStores.push(peer);

      try {
        await peer.setRoots(["goals:G-new"]);
        throw new Error("expected stuck-admission");
      } catch (error) {
        expect(error).toBeInstanceOf(WorksetAdmissionError);
        expect((error as WorksetAdmissionError).code).toBe("stuck-admission");
        expect((error as WorksetAdmissionError).message).toContain(stuckId);
      }

      await peer.forceSettleAdmission({
        admissionId: stuckId,
        authority: createTrustedWorksetManagementAuthority(),
        reason: "operator attested process group terminated out-of-band",
      });
      const snap = await peer.setRoots(["goals:G-new"]);
      expect(snap).toEqual({ roots: ["goals:G-new"], epoch: 1 });
    });

    it("PostgresLedgerStore.worksetStore() exposes the same capability", async () => {
      const projectKey = await prepareTenant();
      // Dedicated pool: PostgresLedgerStore.dispose() closes its pool.
      const ledgerPool = openPgPool(PG_URL);
      const ledger = new PostgresLedgerStore({
        pool: ledgerPool,
        projectKey,
        displayName: projectKey,
      });
      await ledger.init();
      try {
        const ws = ledger.worksetStore();
        await ws.setRoots(["goals:G-via-ledger"]);
        expect(await readWorksetRootsEpoch(ws)).toEqual({
          roots: ["goals:G-via-ledger"],
          epoch: 1,
        });
      } finally {
        await ledger.dispose();
      }
    });
  });
}
