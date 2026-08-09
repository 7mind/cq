/**
 * T1958 — focused durable admission behaviors on Postgres (skip-if-no-PG).
 */

import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createPostgresWorksetStore,
  ensureSchema,
  openPgPool,
  WorksetAdmissionError,
  type CreatePostgresWorksetStoreOptions,
  type PostgresWorksetStore,
} from "../src/index.js";

const PG_URL = process.env.CQ_TEST_PG_URL;

if (PG_URL === undefined || PG_URL.length === 0) {
  describe.skip("workset effect admission postgres [T1958]", () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
} else {
  const sharedPool = openPgPool(PG_URL);
  const schemaReady = ensureSchema(sharedPool);
  const openStores: PostgresWorksetStore[] = [];

  afterAll(async () => {
    for (const s of openStores) s.close();
    await sharedPool.close();
  });

  async function prepareTenant(): Promise<string> {
    await schemaReady;
    const projectKey = `t1958-adm-${randomUUID()}`;
    await sharedPool`
      INSERT INTO projects (project_key, display_name) VALUES (${projectKey}, ${projectKey})
    `;
    return projectKey;
  }

  function build(
    projectKey: string,
    opts: Partial<CreatePostgresWorksetStoreOptions> = {},
  ): PostgresWorksetStore {
    const store = createPostgresWorksetStore({
      ...opts,
      pool: sharedPool,
      projectKey,
    });
    openStores.push(store);
    return store;
  }

  describe("workset effect admission postgres [T1958]", () => {
    it("durable admission row remains after grant until acknowledge", async () => {
      const store = build(await prepareTenant());
      const lm = await store.admitLedgerMutation({
        kind: "generic-write",
        targets: ["tasks:T1"],
      });
      const rows = await store.listDurableAdmissions();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.admissionId).toBe(lm.id);
      expect(rows[0]!.form).toBe("ledger-mutation");
      await lm.acknowledge();
      expect(await store.listDurableAdmissions()).toHaveLength(0);
    });

    it("stale recovery reclaims a dead-holder ledger mutation before set", async () => {
      const projectKey = await prepareTenant();
      const holder = build(projectKey);
      await holder.admitLedgerMutation({
        kind: "owned-write",
        targets: [],
      });
      expect(await holder.listDurableAdmissions()).toHaveLength(1);
      holder.close();

      const peer = build(projectKey, {
        isHolderAlive: async () => false,
        heartbeatTtlMs: 1,
        now: () => Date.now() + 60_000,
      });
      const snap = await peer.setRoots(["goals:G-after-reclaim"]);
      expect(snap.epoch).toBe(1);
      expect(await peer.listDurableAdmissions()).toHaveLength(0);
    });

    it("set-first ordering revokes a not-yet-granted admit (generation fence)", async () => {
      function deferred(): { promise: Promise<void>; resolve: () => void } {
        let resolve!: () => void;
        const promise = new Promise<void>((res) => {
          resolve = res;
        });
        return { promise, resolve };
      }
      const beforeGrant = deferred();
      const releaseGrant = deferred();
      const projectKey = await prepareTenant();
      const hooked = build(projectKey, {
        hooks: {
          beforeAdmissionGrant: async () => {
            beforeGrant.resolve();
            await releaseGrant.promise;
          },
        },
      });

      const effectPromise = hooked.admitExternalEffect({
        kind: "merge",
        targetRef: "tasks:T-old",
      });
      await beforeGrant.promise;
      const setPromise = hooked.setRoots(["goals:G-only"]);
      releaseGrant.resolve();
      try {
        await effectPromise;
        throw new Error("expected revoked");
      } catch (error) {
        expect(error).toBeInstanceOf(WorksetAdmissionError);
        expect((error as WorksetAdmissionError).code).toBe("revoked");
      }
      expect(await setPromise).toEqual({ roots: ["goals:G-only"], epoch: 1 });
    });

    it("heartbeat expiry alone marks a foreign-host row stale for reclaim", async () => {
      const projectKey = await prepareTenant();
      await sharedPool`
        INSERT INTO workset_roots (project_key, roots_json, epoch, admit_generation)
        VALUES (${projectKey}, ${"[]"}, ${0}, ${0})
        ON CONFLICT DO NOTHING
      `;
      await sharedPool`
        INSERT INTO workset_admissions (
          project_key, admission_id, form, kind, target_key, targets_json, epoch,
          host_id, holder_pid, holder_start_time, heartbeat_at_ms,
          process_group_registered, settled, created_at_ms
        ) VALUES (
          ${projectKey},
          ${"ee-foreign-1"},
          ${"external-effect"},
          ${"merge"},
          ${"tasks:T-x"},
          ${JSON.stringify(["tasks:T-x"])},
          ${0},
          ${"other-host.example"},
          ${999999},
          ${"1"},
          ${0},
          ${false},
          ${false},
          ${0}
        )
      `;

      const store = build(projectKey, {
        hostId: "this-host",
        heartbeatTtlMs: 1,
        now: () => 100_000,
      });
      const snap = await store.setRoots(["goals:G1"]);
      expect(snap).toEqual({ roots: ["goals:G1"], epoch: 1 });
      expect(await store.listDurableAdmissions()).toHaveLength(0);
    });
  });
}
