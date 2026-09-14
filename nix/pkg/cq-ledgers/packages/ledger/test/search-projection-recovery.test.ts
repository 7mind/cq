import { describe, expect, test } from "bun:test";
import type { Item } from "../src/types.js";
import { createDirectSearchProjection } from "../src/search/DirectSearchProjection.js";
import { createWorkerSearchProjection } from "../src/search/WorkerSearchProjection.js";
import type { SearchProjection } from "../src/search/SearchProjection.js";
import { SearchProjectionRecovery, PROJECTION_RETRY_MIN_MS } from "../src/search/SearchProjectionRecovery.js";
import type {
  ProjectionChangeFrame,
  ProjectionRecoverySource,
} from "../src/search/SearchProjectionRecovery.js";

const DEADLINE_MS = 1_000;

class MemoryRecoverySource implements ProjectionRecoverySource {
  private version = 0;
  private readonly documents = new Map<string, { item: Item; version: number }>();
  readonly notified: number[] = [];
  rejectNotification = false;
  notificationWait: Promise<void> | null = null;
  notificationStarted = Promise.withResolvers<void>();

  put(id: string, headline: string): void {
    this.version += 1;
    this.documents.set(id, {
      version: this.version,
      item: {
        id,
        milestoneId: "M1",
        status: "planned",
        fields: { headline },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
  }

  load(afterVersion: number, rebuild: boolean): ProjectionChangeFrame {
    if (afterVersion > this.version) throw new Error("Cursor exceeds durable version");
    const changed = [...this.documents.values()].filter((doc) => doc.version > afterVersion);
    return {
      version: this.version,
      foreignLedgers: changed.length === 0 ? [] : ["tasks"],
      snapshot: rebuild
        ? [
            {
              ledgerId: "tasks",
              archived: false,
              items: [...this.documents.values()].map((doc) => structuredClone(doc.item)),
            },
          ]
        : null,
      changes: changed.map((doc) => ({
        kind: "upsert",
        ledgerId: "tasks",
        archived: false,
        item: structuredClone(doc.item),
      })),
    };
  }

  async notify(frame: ProjectionChangeFrame, signal: AbortSignal): Promise<void> {
    if (frame.foreignLedgers.length === 0) return;
    this.notificationStarted.resolve();
    if (this.notificationWait !== null) await this.notificationWait;
    signal.throwIfAborted();
    if (this.rejectNotification) throw new Error("injected notification rejection");
    this.notified.push(frame.version);
  }
}

function recoveryContract(makeProjection: () => SearchProjection): void {
  test("a retry timer does not queue duplicate work behind an active reconciliation [Blackbox-Group]", async () => {
    const source = new MemoryRecoverySource();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const duplicate = Promise.withResolvers<void>();
    let held = false;
    let loads = 0;
    const recovery = new SearchProjectionRecovery(makeProjection(), {
      load: async (version, rebuild) => {
        if (held) {
          loads += 1;
          if (loads === 1) { entered.resolve(); await release.promise; }
          else await duplicate.promise;
        }
        return source.load(version, rebuild);
      }, notify: (frame, signal) => source.notify(frame, signal),
    }, DEADLINE_MS);
    try {
      await recovery.initialize();
      source.put("T1", "retry");
      source.rejectNotification = true;
      await expect(recovery.reconcile()).rejects.toThrow("injected notification rejection");
      source.rejectNotification = false;
      held = true;
      const manual = recovery.reconcile();
      await entered.promise;
      await Bun.sleep(PROJECTION_RETRY_MIN_MS * 2);
      release.resolve();
      await manual;
      expect(recovery.health().state).toBe("current");
      expect(loads).toBe(1);
    } finally { release.resolve(); duplicate.resolve(); await recovery.close(); }
  });

  test("close settles an asynchronous source read without allowing late acknowledgement [Blackbox-Group]", async () => {
    const source = new MemoryRecoverySource();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;
    const recovery = new SearchProjectionRecovery(makeProjection(), {
      load: async (version, rebuild) => { if (held) { entered.resolve(); await release.promise; } return source.load(version, rebuild); },
      notify: (frame, signal) => source.notify(frame, signal),
    }, DEADLINE_MS);
    let close: Promise<void> | null = null;
    try {
      await recovery.initialize();
      source.put("T1", "late");
      held = true;
      const pending = recovery.reconcile().catch(() => undefined);
      await entered.promise;
      let closed = false;
      close = recovery.close().then(() => { closed = true; });
      await Promise.race([close, Bun.sleep(100)]);
      expect(closed).toBe(true);
      release.resolve();
      await pending;
      expect(recovery.acknowledgedVersion()).toBe(0);
      expect(source.notified).toEqual([]);
    } finally { release.resolve(); if (close !== null) await close; await recovery.close(); }
  });

  test("explicit snapshot recovery is serialized and acknowledged before later deltas [Blackbox-Group]", async () => {
    const source = new MemoryRecoverySource();
    const requests: boolean[] = [];
    const recovery = new SearchProjectionRecovery(makeProjection(), {
      load: (version, rebuild) => { requests.push(rebuild); return source.load(version, rebuild); },
      notify: (frame, signal) => source.notify(frame, signal),
    }, DEADLINE_MS);
    try {
      await recovery.initialize();
      requests.length = 0;
      await recovery.rebuild();
      await recovery.reconcile();
      expect(requests).toEqual([true, false]);
    } finally { await recovery.close(); }
  });

  test("asynchronous durable reads finish before projection, notification and cursor acknowledgement [Blackbox-Group]", async () => {
    const source = new MemoryRecoverySource();
    const projection = makeProjection();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;
    const asynchronous: ProjectionRecoverySource = {
      load: async (version, rebuild) => {
        if (held) { entered.resolve(); await release.promise; }
        return source.load(version, rebuild);
      },
      notify: (frame, signal) => source.notify(frame, signal),
    };
    const recovery = new SearchProjectionRecovery(projection, asynchronous, DEADLINE_MS);
    try {
      await recovery.initialize();
      source.put("T1", "asynchronouslyloaded");
      held = true;
      const pending = recovery.reconcile();
      await entered.promise;
      expect(recovery.acknowledgedVersion()).toBe(0);
      expect(source.notified).toEqual([]);
      held = false;
      release.resolve();
      await pending;
      expect(recovery.acknowledgedVersion()).toBe(1);
      expect(source.notified).toEqual([1]);
      const ack = await projection.execute({ kind: "search", query: "asynchronouslyloaded", options: {} });
      if (ack.result.kind !== "search") throw new Error("expected search acknowledgement");
      expect(ack.result.hits.map(({ item }) => item.id)).toEqual(["T1"]);
    } finally { release.resolve(); await recovery.close(); }
  });

  test("notification failure retains the cursor and retry converges without overtaking [Blackbox-Group]", async () => {
    const source = new MemoryRecoverySource();
    const projection = makeProjection();
    const recovery = new SearchProjectionRecovery(projection, source, DEADLINE_MS);
    try {
      await recovery.initialize();
      source.put("T1", "first");
      source.rejectNotification = true;
      await expect(recovery.reconcile()).rejects.toThrow("injected notification rejection");
      expect(recovery.acknowledgedVersion()).toBe(0);
      expect(recovery.health().state).toBe("pending");
      expect(source.notified).toEqual([]);
      source.put("T1", "latest");
      source.rejectNotification = false;
      await recovery.reconcile();
      expect(recovery.acknowledgedVersion()).toBe(2);
      expect(source.notified).toEqual([2]);
      expect(recovery.health().state).toBe("current");
      const ack = await projection.execute({ kind: "search", query: "latest", options: {} });
      expect(ack.result.kind).toBe("search");
      if (ack.result.kind === "search")
        expect(ack.result.hits.map((hit) => hit.item.id)).toEqual(["T1"]);
    } finally {
      await recovery.close();
    }
  });

  test("close settles a reconciliation whose notification never acknowledges [Blackbox-Group]", async () => {
    const source = new MemoryRecoverySource();
    const recovery = new SearchProjectionRecovery(makeProjection(), source, DEADLINE_MS);
    const release = Promise.withResolvers<void>();
    try {
      await recovery.initialize();
      source.put("T1", "held");
      source.notificationWait = release.promise;
      const pending = recovery.reconcile().catch(() => undefined);
      await source.notificationStarted.promise;
      let closed = false;
      const close = recovery.close().then(() => {
        closed = true;
      });
      await Promise.race([close, Bun.sleep(DEADLINE_MS)]);
      expect(closed).toBe(true);
      expect(recovery.acknowledgedVersion()).toBe(0);
      release.resolve();
      await Promise.all([pending, close]);
      expect(source.notified).toEqual([]);
      await expect(recovery.reconcile()).rejects.toThrow("closed");
    } finally {
      release.resolve();
      await recovery.close();
    }
  });

  test("notification deadline retains the cursor and cancels late publication before retry [Blackbox-Group]", async () => {
    const source = new MemoryRecoverySource();
    const notificationDeadlineMs = 25;
    const recovery = new SearchProjectionRecovery(makeProjection(), source, notificationDeadlineMs);
    const release = Promise.withResolvers<void>();
    try {
      await recovery.initialize();
      source.put("T1", "held");
      source.notificationWait = release.promise;
      await expect(recovery.reconcile()).rejects.toThrow("notification exceeded 25ms deadline");
      expect(recovery.acknowledgedVersion()).toBe(0);
      expect(recovery.health().state).toBe("pending");
      expect(source.notified).toEqual([]);
      release.resolve();
      source.notificationWait = null;
      await recovery.reconcile();
      expect(recovery.acknowledgedVersion()).toBe(1);
      expect(source.notified).toEqual([1]);
      expect(recovery.health().state).toBe("current");
    } finally {
      release.resolve();
      await recovery.close();
    }
  });
}

describe("recovery with in-process projection and memory source", () =>
  recoveryContract(() => createDirectSearchProjection(DEADLINE_MS)));
describe("recovery with Bun worker and memory source", () =>
  recoveryContract(() => createWorkerSearchProjection(DEADLINE_MS)));
