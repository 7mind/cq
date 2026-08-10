/**
 * T1975 — fault / isolation / race cases for Postgres guarded generic mutations.
 *
 * Proves: failed/denied mutations leave the tenant unchanged; setRoots waits
 * behind an admitted generic mutation; cross-server replacement races serialize;
 * peer invalidation observes committed state only. Env-gated on CQ_TEST_PG_URL.
 */

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import {
  createPostgresWorksetGuardedLedger,
  ensureSchema,
  openPgPool,
  PostgresLedgerStore,
  TASKS_LEDGER,
  MILESTONES_LEDGER,
  WorksetGenericMutationError,
  WORKSET_OWNER_REF_FIELD,
  type WorksetGuardedLedger,
} from "../src/index.js";

const PG_URL = process.env.CQ_TEST_PG_URL;

function openNarrowPool(dsn: string): SQL {
  return new SQL({ url: dsn, max: 1 });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function disposeAll(ledgers: WorksetGuardedLedger[]): Promise<void> {
  while (ledgers.length > 0) {
    const ledger = ledgers.pop();
    if (ledger === undefined) break;
    try {
      await ledger.dispose();
    } catch {
      // Best-effort.
    }
  }
}

if (PG_URL === undefined || PG_URL.length === 0) {
  describe.skip("workset generic-mutation postgres faults [T1975]", () => {
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
    return `t1975-fault-${randomUUID()}`;
  }

  async function build(
    projectKey: string,
    opts: {
      afterGenericAdmit?: () => Promise<void> | void;
      hooks?: Parameters<typeof createPostgresWorksetGuardedLedger>[0]["hooks"];
    } = {},
  ): Promise<WorksetGuardedLedger> {
    const ledger = await createPostgresWorksetGuardedLedger({
      pool: openNarrowPool(dsn),
      projectKey,
      displayName: projectKey,
      ...(opts.afterGenericAdmit !== undefined
        ? { afterGenericAdmit: opts.afterGenericAdmit }
        : {}),
      ...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
    });
    openLedgers.push(ledger);
    return ledger;
  }

  describe("workset generic-mutation postgres faults [T1975]", () => {
    it("denied create under restrictive roots leaves counters and rows unchanged", async () => {
      const ledger = await build(await prepareTenant());
      const m = await ledger.mutations.createMilestone({ title: "deny-m" });
      const t = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "in" },
      });
      await ledger.setRoots([`${TASKS_LEDGER}:${t.id}`]);
      const beforeCount = ledger.fetch(TASKS_LEDGER).counters.item;
      const beforeItems = ledger.listMilestoneItems(m.id)[TASKS_LEDGER]?.length ?? 0;

      try {
        await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
          status: "planned",
          fields: { headline: "denied", [WORKSET_OWNER_REF_FIELD]: "goals:G1" },
        });
        throw new Error("expected creation-denied");
      } catch (error) {
        expect(error).toBeInstanceOf(WorksetGenericMutationError);
        expect((error as WorksetGenericMutationError).code).toBe("creation-denied");
      }

      expect(ledger.fetch(TASKS_LEDGER).counters.item).toBe(beforeCount);
      expect(ledger.listMilestoneItems(m.id)[TASKS_LEDGER]?.length ?? 0).toBe(beforeItems);
      expect(ledger.activeAdmissionCount()).toBe(0);
    });

    it("denied target-excluded update is zero-mutation (status unchanged)", async () => {
      const ledger = await build(await prepareTenant());
      const m = await ledger.mutations.createMilestone({ title: "ex-m" });
      const inside = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "in" },
      });
      const outside = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "out" },
      });
      await ledger.setRoots([`${TASKS_LEDGER}:${inside.id}`]);
      const before = ledger.fetchItem(TASKS_LEDGER, outside.id);

      try {
        await ledger.mutations.updateItem(TASKS_LEDGER, outside.id, { status: "wip" });
        throw new Error("expected target-excluded");
      } catch (error) {
        expect(error).toBeInstanceOf(WorksetGenericMutationError);
        expect((error as WorksetGenericMutationError).code).toBe("target-excluded");
      }
      expect(ledger.fetchItem(TASKS_LEDGER, outside.id)).toEqual(before);
    });

    it("setRoots waits behind an in-flight generic mutation admission", async () => {
      const admitted = deferred();
      const releaseHold = deferred();
      let holdEnabled = false;
      const ledger = await build(await prepareTenant(), {
        afterGenericAdmit: async () => {
          if (!holdEnabled) return;
          admitted.resolve();
          await releaseHold.promise;
        },
      });
      const m = await ledger.mutations.createMilestone({ title: "hold-m" });
      const t = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "hold-t" },
      });
      await ledger.setRoots([`${TASKS_LEDGER}:${t.id}`]);

      holdEnabled = true;
      const mutPromise = ledger.mutations.updateItem(TASKS_LEDGER, t.id, {
        fields: { headline: "held" },
      });
      await admitted.promise;
      expect(ledger.activeAdmissionCount()).toBeGreaterThan(0);

      let setDone = false;
      const setPromise = ledger.setRoots([]).then((snap) => {
        setDone = true;
        return snap;
      });
      await Bun.sleep(40);
      expect(setDone).toBe(false);

      releaseHold.resolve();
      await mutPromise;
      const snap = await setPromise;
      expect(setDone).toBe(true);
      expect(snap.roots).toEqual([]);
      expect(ledger.activeAdmissionCount()).toBe(0);
      expect(ledger.fetchItem(TASKS_LEDGER, t.id).fields.headline).toBe("held");
    });

    it("cross-server: peer setRoots waits for holder generic mutation then observes result", async () => {
      const projectKey = await prepareTenant();
      const admitted = deferred();
      const releaseHold = deferred();
      let holdEnabled = false;

      const holder = await build(projectKey, {
        afterGenericAdmit: async () => {
          if (!holdEnabled) return;
          admitted.resolve();
          await releaseHold.promise;
        },
      });
      const peer = await build(projectKey);

      const m = await holder.mutations.createMilestone({ title: "xsrv-m" });
      const t = await holder.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "planned",
        fields: { headline: "xsrv-t" },
      });
      // Peer must see the seed (reload via invalidate after holder writes).
      await peer.invalidate(TASKS_LEDGER);
      await peer.invalidate(MILESTONES_LEDGER);

      await holder.setRoots([`${TASKS_LEDGER}:${t.id}`]);
      // Peer observes roots via its own durable snapshot.
      expect(await peer.snapshotRoots()).toEqual({
        roots: [`${TASKS_LEDGER}:${t.id}`],
        epoch: 1,
      });

      holdEnabled = true;
      const mutPromise = holder.mutations.updateItem(TASKS_LEDGER, t.id, {
        status: "wip",
        fields: { headline: "xsrv-held" },
      });
      await admitted.promise;
      expect(holder.activeAdmissionCount()).toBeGreaterThan(0);

      let peerSetDone = false;
      const peerSetPromise = peer.setRoots([]).then((snap) => {
        peerSetDone = true;
        return snap;
      });
      await Bun.sleep(50);
      expect(peerSetDone).toBe(false);

      releaseHold.resolve();
      await mutPromise;
      const peerSnap = await peerSetPromise;
      expect(peerSetDone).toBe(true);
      expect(peerSnap.roots).toEqual([]);
      expect(peerSnap.epoch).toBe(2);

      await peer.invalidate(TASKS_LEDGER);
      expect(peer.fetchItem(TASKS_LEDGER, t.id).status).toBe("wip");
      expect(peer.fetchItem(TASKS_LEDGER, t.id).fields.headline).toBe("xsrv-held");
    });

    it("incomplete archive sweep denies without removing active members", async () => {
      const ledger = await build(await prepareTenant());
      const m = await ledger.mutations.createMilestone({ title: "sweep-deny" });
      const tIn = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "done",
        fields: { headline: "in" },
      });
      const tOut = await ledger.mutations.createItem(TASKS_LEDGER, m.id, {
        status: "done",
        fields: { headline: "out" },
      });
      await ledger.mutations.updateMilestone(m.id, { status: "done" });
      await ledger.setRoots([`${TASKS_LEDGER}:${tIn.id}`]);

      const beforeM = ledger.fetchItem(MILESTONES_LEDGER, m.id);
      const beforeOut = ledger.fetchItem(TASKS_LEDGER, tOut.id);

      try {
        await ledger.mutations.archiveMilestone(m.id, "should-fail");
        throw new Error("expected archive-sweep-incomplete");
      } catch (error) {
        expect(error).toBeInstanceOf(WorksetGenericMutationError);
        expect((error as WorksetGenericMutationError).code).toBe("archive-sweep-incomplete");
      }

      expect(ledger.fetchItem(MILESTONES_LEDGER, m.id)).toEqual(beforeM);
      expect(ledger.fetchItem(TASKS_LEDGER, tOut.id)).toEqual(beforeOut);
      expect(ledger.fetchItem(TASKS_LEDGER, tIn.id).id).toBe(tIn.id);
    });

    it("peer invalidate after denied write does not invent rows", async () => {
      const projectKey = await prepareTenant();
      const writer = await build(projectKey);
      const peer = new PostgresLedgerStore({
        pool: openNarrowPool(dsn),
        projectKey,
        displayName: projectKey,
      });
      await peer.init();
      try {
        const m = await writer.mutations.createMilestone({ title: "inv-m" });
        const t = await writer.mutations.createItem(TASKS_LEDGER, m.id, {
          status: "planned",
          fields: { headline: "inv-t" },
        });
        await writer.setRoots([`${TASKS_LEDGER}:${t.id}`]);
        const beforeCount = writer.fetch(TASKS_LEDGER).counters.item;

        try {
          await writer.mutations.createItem(TASKS_LEDGER, m.id, {
            status: "planned",
            fields: { headline: "ghost" },
          });
          throw new Error("expected denial");
        } catch (error) {
          expect(error).toBeInstanceOf(WorksetGenericMutationError);
        }
        expect(writer.fetch(TASKS_LEDGER).counters.item).toBe(beforeCount);

        await peer.invalidate(TASKS_LEDGER);
        expect(peer.fetch(TASKS_LEDGER).counters.item).toBe(beforeCount);
        const items = peer.listMilestoneItems(m.id)[TASKS_LEDGER] ?? [];
        expect(items.map((i) => i.id).sort()).toEqual([t.id]);
      } finally {
        await peer.dispose();
      }
    });
  });
}
