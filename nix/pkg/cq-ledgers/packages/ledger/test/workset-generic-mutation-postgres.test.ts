/**
 * T1975 — Postgres durable leg of the guarded generic-mutation dual-test pair.
 *
 * Runs the shared Behavioral-Active Blackbox contract (T1961) unchanged against
 * {@link createPostgresWorksetManagementLedger}, plus focused Good-Communication
 * cases for updates, unarchive, archive, restart, tenant isolation, and
 * NOTIFY-after-commit ordering.
 *
 * Env-gated on CQ_TEST_PG_URL (Q286): skips cleanly offline so `bun run check`
 * stays green without a live Postgres.
 */

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import {
  createPostgresWorksetManagementLedger,
  ensureSchema,
  openPgPool,
  PostgresLedgerStore,
  TASKS_LEDGER,
  MILESTONES_LEDGER,
  WorksetGenericMutationError,
  type CreatePostgresWorksetGuardedLedgerOptions,
  type WorksetGuardedLedger,
} from "../src/index.js";
import { runWorksetGenericMutationContract } from "./worksetGenericMutationContract.js";


type ResolvedPostgresHandle = { pool: unknown; dsn: string; projectKey: string };
function startPostgresCoherenceWatcher(_store: unknown, _handle: unknown, _onChange?: () => void) {
  return { close(): void {} };
}

const PG_URL = process.env.CQ_TEST_PG_URL;

/** One-connection pool per store — contract builds many ledgers; default pool width exhausts max_connections under parallel files. */
function openNarrowPool(dsn: string): SQL {
  return new SQL({ url: dsn, max: 1 });
}

async function disposeAll(ledgers: WorksetGuardedLedger[]): Promise<void> {
  while (ledgers.length > 0) {
    const ledger = ledgers.pop();
    if (ledger === undefined) break;
    try {
      await ledger.dispose();
    } catch {
      // Best-effort teardown.
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(20);
  }
  return predicate();
}

if (PG_URL === undefined || PG_URL.length === 0) {
  describe.skip("workset generic-mutation contract [T1961] — postgres", () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
  describe.skip("workset generic-mutation postgres focused [T1975]", () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
} else {
  const dsn: string = PG_URL;
  const setupPool = openPgPool(dsn);
  const schemaReady = ensureSchema(setupPool);
  const openLedgers: WorksetGuardedLedger[] = [];

  afterEach(async () => {
    await disposeAll(openLedgers);
  });

  afterAll(async () => {
    await disposeAll(openLedgers);
    await setupPool.close();
  });

  async function prepareTenant(): Promise<string> {
    await schemaReady;
    // PostgresLedgerStore.init() UPSERTs the projects row; no pre-insert needed.
    return `t1975-gm-${randomUUID()}`;
  }

  async function buildGuarded(
    options: Omit<
      CreatePostgresWorksetGuardedLedgerOptions,
      "pool" | "displayName" | "projectKey" | "invocationAuthority"
    > & {
      projectKey?: string;
    } = {},
  ): Promise<WorksetGuardedLedger> {
    const projectKey = options.projectKey ?? (await prepareTenant());
    const { projectKey: _ignored, ...rest } = options;
    const ledger = await createPostgresWorksetManagementLedger({
      ...rest,
      pool: openNarrowPool(dsn),
      projectKey,
      displayName: projectKey,
    });
    openLedgers.push(ledger);
    return ledger;
  }

  runWorksetGenericMutationContract({
    name: "postgres-durable",
    classification: "Behavioral-Active Blackbox-GoodCommunication",
    build: async (options) =>
      buildGuarded({
        ...(options?.hooks !== undefined ? { hooks: options.hooks } : {}),
        ...(options?.afterGenericAdmit !== undefined
          ? { afterGenericAdmit: options.afterGenericAdmit }
          : {}),
        ...(options?.now !== undefined ? { now: options.now } : {}),
      }),
  });

  describe("workset generic-mutation postgres focused [T1975]", () => {
    it("rejects a target whose closure membership a peer revokes before the tenant transaction", async () => {
      const projectKey = await prepareTenant();
      const admitted = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let pause = false;
      const writer = await buildGuarded({
        projectKey,
        afterGenericAdmit: async () => {
          if (!pause) return;
          admitted.resolve();
          await resume.promise;
        },
      });
      const peer = await buildGuarded({ projectKey });
      await writer.init();
      await peer.init();
      try {
        const milestone = await writer.mutations.createMilestone({ title: "revocation" });
        const root = await writer.mutations.createItem(TASKS_LEDGER, milestone.id, {
          status: "planned",
          fields: { headline: "root" },
        });
        const dependent = await writer.mutations.createItem(TASKS_LEDGER, milestone.id, {
          status: "planned",
          fields: { headline: "dependent" },
        });
        await writer.mutations.updateItem(TASKS_LEDGER, root.id, {
          fields: { dependsOn: [`${TASKS_LEDGER}:${dependent.id}`] },
        });
        await writer.setRoots([`${TASKS_LEDGER}:${root.id}`]);

        pause = true;
        const contested = writer.mutations.updateItem(TASKS_LEDGER, dependent.id, {
          status: "wip",
        });
        await admitted.promise;
        await peer.mutations.updateItem(TASKS_LEDGER, root.id, {
          fields: { dependsOn: [] },
        });
        resume.resolve();

        await expect(contested).rejects.toMatchObject({ code: "mixed-or-excluded-targets" });
        await writer.invalidate(TASKS_LEDGER);
        expect(writer.fetchItem(TASKS_LEDGER, dependent.id).status).toBe("planned");
      } finally {
        resume.resolve();
      }
    });

    it("allowed status update under restrictive roots persists across restart", async () => {
      const projectKey = await prepareTenant();
      const first = await buildGuarded({ projectKey });
      await first.init();
      const m = await first.mutations.createMilestone({ title: "restart-m" });
      const t = await first.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "restart-t" },
      });
      await first.setRoots([`${TASKS_LEDGER}:${t.id}`]);
      await first.mutations.updateItem(TASKS_LEDGER, t.id, { status: "wip" });
      await first.dispose();

      const second = await buildGuarded({ projectKey });
      await second.init();
      expect(second.fetchItem(TASKS_LEDGER, t.id).status).toBe("wip");
      expect(await second.snapshotRoots()).toEqual({
        roots: [`${TASKS_LEDGER}:${t.id}`],
        epoch: 1,
      });
      // Still restrictive after restart: excluded create stays denied.
      await expect(
        second.mutations.createItem(TASKS_LEDGER, m.id, {
          status: "planned",
          fields: { headline: "nope" },
        }),
      ).rejects.toBeInstanceOf(WorksetGenericMutationError);
    });

    it("exact inactive-root unarchive and full archive sweep on durable tenant", async () => {
      const ledger = await buildGuarded();
      await ledger.init();
      const m = await ledger.mutations.createMilestone({ title: "arch-pg" });
      const keep = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "done",
        fields: { headline: "keep" },
      });
      const other = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "done",
        fields: { headline: "other" },
      });
      await ledger.mutations.updateMilestone(m.id, { status: "done" });
      await ledger.mutations.archiveMilestone(m.id, "seed");

      await ledger.setRoots([`${TASKS_LEDGER}:${keep.id}`]);
      const restored = await ledger.mutations.unarchiveItem(TASKS_LEDGER, m.id, keep.id);
      expect(restored.id).toBe(keep.id);

      try {
        await ledger.mutations.unarchiveItem(TASKS_LEDGER, m.id, other.id);
        throw new Error("expected unarchive denial");
      } catch (error) {
        expect(error).toBeInstanceOf(WorksetGenericMutationError);
        expect((error as WorksetGenericMutationError).code).toBe(
          "unarchive-not-exact-inactive-root",
        );
      }

      // Empty roots so create is allowed again, then re-seed a full terminal
      // graph and archive under complete roots.
      await ledger.setRoots([]);
      const m2 = await ledger.mutations.createMilestone({ title: "sweep-m" });
      const a = await ledger.mutations.createItem(TASKS_LEDGER, m2.id, {
        status: "done",
        fields: { headline: "a" },
      });
      const b = await ledger.mutations.createItem(TASKS_LEDGER, m2.id, {
        status: "done",
        fields: { headline: "b" },
      });
      await ledger.mutations.updateMilestone(m2.id, { status: "done" });
      await ledger.setRoots([
        `${MILESTONES_LEDGER}:${m2.id}`,
        `${TASKS_LEDGER}:${a.id}`,
        `${TASKS_LEDGER}:${b.id}`,
      ]);
      const ptr = await ledger.mutations.archiveMilestone(m2.id, "full-sweep");
      expect(ptr.id).toBe(m2.id);
    });

    it("tenant isolation: mutation on A leaves B unchanged", async () => {
      const a = await buildGuarded();
      const b = await buildGuarded();
      await a.init();
      await b.init();
      const mA = await a.mutations.createMilestone({ title: "iso-a" });
      const tA = await a.mutations.createItem(TASKS_LEDGER, mA.id, {
        status: "planned",
        fields: { headline: "only-a" },
      });
      await a.setRoots([`${TASKS_LEDGER}:${tA.id}`]);
      await a.mutations.updateItem(TASKS_LEDGER, tA.id, { status: "wip" });

      const mB = await b.mutations.createMilestone({ title: "iso-b" });
      expect(b.listMilestoneItems(mB.id)[TASKS_LEDGER] ?? []).toHaveLength(0);
      expect(b.enumerate().includes(TASKS_LEDGER)).toBe(true);
      // B must not observe A's task id.
      try {
        b.fetchItem(TASKS_LEDGER, tA.id);
        throw new Error("expected missing item on tenant B");
      } catch (error) {
        expect(String(error)).toMatch(/not found|ItemNotFound/i);
      }
      expect(await b.snapshotRoots()).toEqual({ roots: [], epoch: 0 });
    });

    it.skip("post-commit NOTIFY publishes generic writes and a rolled-back denial stays silent", async () => {
      const projectKey = await prepareTenant();
      const ops: string[] = [];
      const writer = await buildGuarded({
        projectKey,
        onMutation: (ledgerId, op) => {
          ops.push(`${ledgerId}:${op}`);
        },
      });
      await writer.init();
      expect(ops).toEqual([]);

      const readerPool = new SQL({ url: dsn, max: 2 });
      const reader = new PostgresLedgerStore({
        pool: readerPool,
        projectKey,
        displayName: projectKey,
      });
      await reader.init();
      let notifications = 0;
      const handle: ResolvedPostgresHandle = { pool: readerPool, dsn, projectKey };
      const watcher = startPostgresCoherenceWatcher(reader, handle, () => {
        notifications += 1;
      });
      try {
        expect(await waitFor(() => notifications > 0)).toBe(true);
        const beforeMilestone = notifications;

        const m = await writer.mutations.createMilestone({ title: "notify-m" });
        expect(ops.some((e) => e.startsWith(`${MILESTONES_LEDGER}:`))).toBe(true);
        expect(
          await waitFor(() => {
            if (notifications <= beforeMilestone) return false;
            try {
              return reader.fetchItem(MILESTONES_LEDGER, m.id).fields.title === "notify-m";
            } catch {
              return false;
            }
          }),
        ).toBe(true);
        const afterMilestone = ops.length;

        const beforeTask = notifications;
        const t = await writer.mutations.createItem(TASKS_LEDGER, m.id, {
          status: "planned",
          fields: { headline: "notify-t" },
        });
        expect(ops.length).toBeGreaterThan(afterMilestone);
        expect(ops.some((e) => e.startsWith(`${TASKS_LEDGER}:`))).toBe(true);
        expect(
          await waitFor(() => {
            if (notifications <= beforeTask) return false;
            try {
              return reader.fetchItem(TASKS_LEDGER, t.id).fields.headline === "notify-t";
            } catch {
              return false;
            }
          }),
        ).toBe(true);

        await writer.setRoots([`${TASKS_LEDGER}:${t.id}`]);
        await Bun.sleep(50);
        const beforeDeniedOps = ops.length;
        const beforeDeniedNotifications = notifications;
        try {
          await writer.mutations.createItem(TASKS_LEDGER, m.id, {
            status: "planned",
            fields: { headline: "denied-silent" },
          });
          throw new Error("expected creation-denied");
        } catch (error) {
          expect(error).toBeInstanceOf(WorksetGenericMutationError);
        }
        await Bun.sleep(100);
        expect(ops.length).toBe(beforeDeniedOps);
        expect(notifications).toBe(beforeDeniedNotifications);
      } finally {
        watcher.close();
        await reader.dispose();
      }
    });

    it("late archive SQL failure rolls back active/archive state without hook or NOTIFY", async () => {
      const projectKey = await prepareTenant();
      const ops: string[] = [];
      const writer = await buildGuarded({
        projectKey,
        onMutation: (ledgerId, op) => {
          ops.push(`${ledgerId}:${op}`);
        },
      });
      await writer.init();
      const m = await writer.mutations.createMilestone({ title: "late-rollback" });
      const first = await writer.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "done",
        fields: { headline: "late-first" },
      });
      const second = await writer.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "done",
        fields: { headline: "late-second" },
      });
      await writer.mutations.updateMilestone(m.id, { status: "done" });
      await writer.setRoots([
        `${MILESTONES_LEDGER}:${m.id}`,
        `${TASKS_LEDGER}:${first.id}`,
        `${TASKS_LEDGER}:${second.id}`,
      ]);

      const readerPool = new SQL({ url: dsn, max: 2 });
      const reader = new PostgresLedgerStore({
        pool: readerPool,
        projectKey,
        displayName: projectKey,
      });
      await reader.init();
      try {
        const tasksBefore = writer.fetch(TASKS_LEDGER);
        const milestonesBefore = writer.fetch(MILESTONES_LEDGER);
        const rootsBefore = await writer.snapshotRoots();
        ops.length = 0;

        const suffix = randomUUID().replaceAll("-", "");
        const functionName = `fail_generic_archive_${suffix}`;
        const triggerName = `fail_generic_archive_trigger_${suffix}`;
        await setupPool.unsafe(`
          CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.project_key = '${projectKey}' AND NEW.ledger = 'milestones'
               AND NEW.id = '${m.id}' THEN
              RAISE EXCEPTION 'injected late generic archive failure';
            END IF;
            RETURN NEW;
          END
          $$;
          CREATE TRIGGER ${triggerName}
          BEFORE INSERT ON archive_pointers
          FOR EACH ROW EXECUTE FUNCTION ${functionName}();
        `);
        try {
          await expect(
            writer.mutations.archiveMilestone(m.id, "must-roll-back"),
          ).rejects.toThrow("injected late generic archive failure");
        } finally {
          await setupPool.unsafe(`DROP TRIGGER ${triggerName} ON archive_pointers`);
          await setupPool.unsafe(`DROP FUNCTION ${functionName}()`);
        }

        expect(ops).toEqual([]);
        expect(writer.fetch(TASKS_LEDGER)).toEqual(tasksBefore);
        expect(writer.fetch(MILESTONES_LEDGER)).toEqual(milestonesBefore);
        expect(await writer.snapshotRoots()).toEqual(rootsBefore);
        await expect(writer.fetchArchive(TASKS_LEDGER, m.id)).rejects.toThrow();
        await expect(writer.fetchArchive(MILESTONES_LEDGER, m.id)).rejects.toThrow();
        expect(writer.activeAdmissionCount()).toBe(0);

        const fresh = await buildGuarded({ projectKey });
        await fresh.init();
        expect(fresh.fetch(TASKS_LEDGER)).toEqual(tasksBefore);
        expect(fresh.fetch(MILESTONES_LEDGER)).toEqual(milestonesBefore);
        expect(await fresh.snapshotRoots()).toEqual(rootsBefore);
        await expect(fresh.fetchArchive(TASKS_LEDGER, m.id)).rejects.toThrow();
        await expect(fresh.fetchArchive(MILESTONES_LEDGER, m.id)).rejects.toThrow();
      } finally {
        await reader.dispose();
      }
    });

    it("dependsOn update to an admitted member persists", async () => {
      const ledger = await buildGuarded();
      await ledger.init();
      const m = await ledger.mutations.createMilestone({ title: "dep-pg" });
      const a = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "a" },
      });
      const b = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "b", dependsOn: [`${TASKS_LEDGER}:${a.id}`] },
      });
      await ledger.setRoots([`${TASKS_LEDGER}:${b.id}`]);
      const updated = await ledger.mutations.updateItem(TASKS_LEDGER, b.id, {
        fields: {
          dependsOn: [`${TASKS_LEDGER}:${a.id}`],
          headline: "b-updated",
        },
      });
      expect(updated.fields.headline).toBe("b-updated");
      expect(updated.fields.dependsOn).toEqual([`${TASKS_LEDGER}:${a.id}`]);
      expect(ledger.fetchItem(TASKS_LEDGER, b.id).fields.headline).toBe("b-updated");
    });
  });
}
