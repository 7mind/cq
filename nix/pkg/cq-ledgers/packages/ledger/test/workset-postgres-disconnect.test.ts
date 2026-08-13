/**
 * T1958 — disconnect ordering across two Postgres server instances.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createPostgresWorksetStore,
  ensureSchema,
  createTrustedWorksetManagementAuthority,
  openPgPool,
  readWorksetRootsEpoch,
  WorksetAdmissionError,
  type PostgresWorksetStore,
} from "../src/index.js";

const PG_URL = process.env.CQ_TEST_PG_URL;

if (PG_URL === undefined || PG_URL.length === 0) {
  describe.skip("workset postgres disconnect [T1958]", () => {
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
    const projectKey = `t1958-dc-${randomUUID()}`;
    await sharedPool`
      INSERT INTO projects (project_key, display_name) VALUES (${projectKey}, ${projectKey})
    `;
    return projectKey;
  }

  describe("workset postgres disconnect [T1958]", () => {
    it("killed holder leaves admission row observable until release/settlement", async () => {
      const projectKey = await prepareTenant();
      // Separate pools simulate two server instances.
      const holderPool = openPgPool(PG_URL);
      const observerPool = openPgPool(PG_URL);
      const holder = createPostgresWorksetStore({ pool: holderPool, projectKey });
      const observer = createPostgresWorksetStore({ pool: observerPool, projectKey });
      openStores.push(holder, observer);

      try {
        const admission = await holder.admitExternalEffect({
          kind: "worktree-create",
          targetRef: "tasks:T-hold",
        });
        await Promise.resolve(admission.registerProcessGroup({ pgid: 7001, leaderPid: 7001 }));
        await Promise.resolve(admission.shareWithGuardian());
        // Flush durable register.
        await Bun.sleep(30);

        const before = await observer.listDurableAdmissions();
        expect(before).toHaveLength(1);
        expect(before[0]!.admissionId).toBe(admission.id);

        // Connection loss without release.
        holder.close();
        await holderPool.close();

        const afterDisconnect = await observer.listDurableAdmissions();
        expect(afterDisconnect).toHaveLength(1);
        expect(afterDisconnect[0]!.admissionId).toBe(admission.id);

        const setPromise = observer.setRoots(["goals:G-blocked"]);
        let finished = false;
        void setPromise.then(() => {
          finished = true;
        });
        await Bun.sleep(80);
        expect(finished).toBe(false);

        await observer.forceSettleAdmission({
          admissionId: admission.id,
          authority: createTrustedWorksetManagementAuthority(),
          reason: "holder connection lost; process group attested settled",
        });
        const snap = await setPromise;
        expect(snap).toEqual({ roots: ["goals:G-blocked"], epoch: 1 });
        expect(finished).toBe(true);
      } finally {
        observer.close();
        await observerPool.close().catch(() => undefined);
      }
    });

    it("stale recovery reclaims only after process-death proof", async () => {
      const projectKey = await prepareTenant();
      let holderAlive = true;
      const store = createPostgresWorksetStore({
        pool: sharedPool,
        projectKey,
        heartbeatTtlMs: 60_000,
        isHolderAlive: async () => holderAlive,
      });
      openStores.push(store);

      await store.admitLedgerMutation({
        kind: "finalize-plan",
        targets: [],
      });
      expect(await store.listDurableAdmissions()).toHaveLength(1);

      const waiting = store.setRoots(["goals:G1"]);
      let done = false;
      void waiting.then(() => {
        done = true;
      });
      await Bun.sleep(50);
      expect(done).toBe(false);

      holderAlive = false;
      const snap = await waiting;
      expect(snap.epoch).toBe(1);
      expect(await store.listDurableAdmissions()).toHaveLength(0);
    });

    it("indefinitely-blocked group yields stuck-admission with zero replacement", async () => {
      const projectKey = await prepareTenant();
      await sharedPool`
        INSERT INTO workset_roots (project_key, roots_json, epoch, admit_generation)
        VALUES (${projectKey}, ${"[]"}, ${0}, ${0})
      `;
      const stuckId = `ee-stuck-${randomUUID()}`;
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
          ${"tasks:T-block"},
          ${JSON.stringify(["tasks:T-block"])},
          ${0},
          ${"host-a"},
          ${1},
          ${"stale"},
          ${0},
          ${true},
          ${5555},
          ${5555},
          ${"start"},
          ${false},
          ${0}
        )
      `;

      const store = createPostgresWorksetStore({
        pool: sharedPool,
        projectKey,
        hostId: "host-a",
        heartbeatTtlMs: 1,
        now: () => 1_000_000,
        isHolderAlive: async () => false,
        settleRegisteredGroup: async () => ({ survivors: [5555] }),
      });
      openStores.push(store);

      try {
        await store.setRoots(["goals:G-should-not-land"]);
        throw new Error("expected stuck-admission");
      } catch (error) {
        expect(error).toBeInstanceOf(WorksetAdmissionError);
        const err = error as WorksetAdmissionError;
        expect(err.code).toBe("stuck-admission");
        expect(err.message).toContain(stuckId);
        expect(err.message).toContain("tasks:T-block");
      }
      expect(await readWorksetRootsEpoch(store)).toEqual({ roots: [], epoch: 0 });
      expect((await store.listDurableAdmissions()).map((r) => r.admissionId)).toEqual([
        stuckId,
      ]);
    });
  });
}
