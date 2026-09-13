/**
 * Local XDG watcher selection, acknowledged peer visibility, and rejection
 * of remote or unsupported backend fallthrough.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  InMemoryLedgerStore,
  SqliteLedgerStore,
  type ResolvedLedgerStore,
} from "@cq/ledger";
import { startLedgerCoherenceWatcher } from "../src/main.js";

const dirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function waitUntil(pred: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

describe("startLedgerCoherenceWatcher — backend selection", () => {
  it("rejects an unsupported backend instead of selecting a local watcher", async () => {
    const root = await tmpDir("coherence-select-unsupported-");
    const store = new InMemoryLedgerStore({});
    await store.init();
    try {
      const resolved: ResolvedLedgerStore = {
        store,
        configRoot: root,
        backend: "unsupported" as ResolvedLedgerStore["backend"],
        branch: "cq-ledger",
      };
      expect(() => startLedgerCoherenceWatcher(resolved, root)).toThrow(
        /unsupported.*backend/i,
      );
    } finally {
      await store.dispose();
    }
  });

  it("refuses backend 'remote' instead of falling through to a local watcher", async () => {
    const root = await tmpDir("coherence-select-remote-");
    const store = new InMemoryLedgerStore();
    await store.init();
    try {
      const resolved = {
        store,
        configRoot: root,
        backend: "remote",
        branch: "cq-ledger",
      } as ResolvedLedgerStore;
      expect(() => startLedgerCoherenceWatcher(resolved, root)).toThrow(
        /backend = 'remote'.*remote ledger client.*not wired.*local persistence/is,
      );
    } finally {
      await store.dispose();
    }
  });

  it("selects the xdg coherence watcher for backend 'xdg': a peer commit becomes visible", async () => {
    const dbDir = await tmpDir("coherence-select-xdg-");
    const dbPath = path.join(dbDir, "ledger.db");
    const peer = new SqliteLedgerStore({ dbPath });
    const watched = new SqliteLedgerStore({ dbPath });
    await peer.init();
    await watched.init();

    const resolved: ResolvedLedgerStore = {
      store: watched,
      configRoot: dbDir,
      backend: "xdg",
      branch: "cq-ledger",
      dbPath,
    };
    // D89: peer commits must reach the same scoped live-notification callback.
    const changes: Array<string | null> = [];
    const watcher = startLedgerCoherenceWatcher(resolved, dbDir, (ledgerId) => {
      changes.push(ledgerId);
    });
    try {
      const m = await peer.createMilestone({ title: "xdg select" });
      await peer.createItem("defects", m.id, {
        status: "open",
        fields: { headline: "selection sees this", severity: "minor", description: "d" },
      });

      const deadline = Date.now() + 2_000;
      let hits: Awaited<ReturnType<typeof watched.ftsSearch>> = [];
      while (Date.now() < deadline) {
        hits = await watched.ftsSearch("selection");
        if (hits.length > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(hits.length).toBe(1);
      expect(hits[0]?.item.fields["headline"]).toBe("selection sees this");

      const changed = await waitUntil(() => changes.includes("defects"));
      expect(changed).toBe(true);
      expect(changes.sort()).toEqual(["defects", "milestones"]);
    } finally {
      watcher.close();
      await peer.dispose();
      await watched.dispose();
    }
  }, 10_000);

  it("publishes a local XDG mutation after searchable convergence without replaying it [Blackbox-GoodCommunication]", async () => {
    const root = await tmpDir("coherence-select-local-");
    const dbPath = path.join(root, "ledger.db");
    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    const milestone = await store.createMilestone({ title: "local publication" });
    const task = await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: { headline: "before" },
    });
    const changes: Array<string | null> = [];
    const searchable: Array<Promise<string[]>> = [];
    const watcher = startLedgerCoherenceWatcher(
      { store, configRoot: root, backend: "xdg", branch: "cq-ledger", dbPath },
      root,
      (ledgerId) => {
        changes.push(ledgerId);
        searchable.push(
          store.ftsSearch("localvisible").then((hits) => hits.map((hit) => hit.item.id)),
        );
      },
    );
    try {
      await store.updateItem("tasks", task.id, { fields: { headline: "localvisible" } });
      expect(changes).toEqual(["tasks"]);
      expect(await Promise.all(searchable)).toEqual([[task.id]]);
      await store.reconcileProjection();
      expect(changes).toEqual(["tasks"]);
    } finally {
      watcher.close();
      await store.dispose();
    }
  });

  it("throws if backend 'xdg' resolves without a dbPath (defensive fail-fast)", async () => {
    const root = await tmpDir("coherence-select-xdg-missing-dbpath-");
    const dbPath = path.join(root, "ledger.db");
    const store = new SqliteLedgerStore({ dbPath });
    await store.init();
    try {
      const resolved = {
        store,
        configRoot: root,
        backend: "xdg",
        branch: "cq-ledger",
      } as ResolvedLedgerStore;
      expect(() => startLedgerCoherenceWatcher(resolved, root)).toThrow(/without a dbPath/);
    } finally {
      await store.dispose();
    }
  });
});
