/**
 * T1958 — disconnect ordering across two Postgres server instances.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPostgresWorksetStore,
  ensureSchema,
  openPgPool,
  readWorksetRootsEpoch,
  WorksetAdmissionError,
  type PostgresWorksetStore,
} from "../src/index.js";

const PG_URL = process.env.CQ_TEST_PG_URL;
const BROKER_FIXTURE = fileURLToPath(
  new URL("./worksetEffectBrokerPostgresChild.ts", import.meta.url),
);

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await Bun.file(path).exists())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(5);
  }
}

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
    it("broker disconnect retains the row until its guardian settles descendants", async () => {
      const projectKey = await prepareTenant();
      const root = await mkdtemp(join(tmpdir(), "cq-postgres-broker-disconnect-"));
      const statePath = join(root, "broker-state.json");
      const descendantPidPath = join(root, "descendant-pid");
      const broker = Bun.spawn(
        [process.execPath, "run", BROKER_FIXTURE, projectKey, statePath, descendantPidPath],
        { stdout: "pipe", stderr: "pipe", env: process.env },
      );
      const observerPool = openPgPool(PG_URL);
      const observer = createPostgresWorksetStore({
        pool: observerPool,
        projectKey,
        now: () => Date.now() + 60_000,
      });
      openStores.push(observer);

      try {
        await waitForFile(statePath);
        await waitForFile(descendantPidPath);
        const state = JSON.parse(await readFile(statePath, "utf8")) as {
          readonly leaderPid: number;
        };

        const before = await observer.listDurableAdmissions();
        expect(before).toHaveLength(1);
        expect(before[0]!.holderPid).toBe(state.leaderPid);

        const setPromise = observer.setRoots(["goals:G-after-disconnect"]);
        let finished = false;
        void setPromise.then(() => {
          finished = true;
        });
        await Bun.sleep(80);
        expect(finished).toBe(false);

        broker.kill("SIGKILL");
        expect(await broker.exited).not.toBe(0);
        const snap = await setPromise;
        expect(snap).toEqual({ roots: ["goals:G-after-disconnect"], epoch: 1 });
        expect(finished).toBe(true);
        expect(await observer.listDurableAdmissions()).toEqual([]);
      } finally {
        broker.kill("SIGKILL");
        await broker.exited;
        observer.close();
        await observerPool.close().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
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
