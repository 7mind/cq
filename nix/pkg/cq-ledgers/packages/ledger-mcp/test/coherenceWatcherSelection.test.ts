/**
 * startLedgerCoherenceWatcher — per-backend SELECTION wiring (T500 / G67).
 *
 * The three coherence watchers (file-watch for fs, ref-sha-poll for
 * git-object, data_version-poll for xdg) are implemented and unit-tested
 * elsewhere (watch.test.ts, refWatcher.test.ts, store-sqlite.test.ts). THIS
 * file asserts the SELECTION itself: given a `ResolvedLedgerStore` with a
 * given `backend`, `startLedgerCoherenceWatcher` must dispatch to the
 * matching watcher — verified behaviourally (a peer process's write becomes
 * visible to the watched store within a bounded interval) rather than by
 * inspecting the returned handle's shape, since all three watchers expose the
 * same `{ close(): void }` surface.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  FsLedgerStore,
  GitObjectLedgerBackend,
  SqliteLedgerStore,
  type LedgerSchema,
  type ResolvedLedgerStore,
} from "@cq/ledger";
import { startLedgerCoherenceWatcher } from "../src/main.js";

const exec = promisify(execFile);
const dirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd, encoding: "utf8" });
}

async function seedGitRepo(): Promise<string> {
  const dir = await tmpDir("coherence-select-git-");
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "test");
  await git(dir, "config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(dir, "README.md"), "test\n");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

const widgetsSchema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: { note: { type: "string", required: true } },
};

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
  it("selects the fs file-watcher for backend 'fs': a peer FsLedgerStore write becomes visible", async () => {
    const root = await tmpDir("coherence-select-fs-");
    const a = new FsLedgerStore({ root });
    await a.init();
    await a.createLedger("widgets", widgetsSchema);
    const ms = await a.createMilestone({ id: "M1", title: "m1" });

    const resolved: ResolvedLedgerStore = {
      store: a,
      configRoot: root,
      backend: "fs",
      branch: "cq-ledger",
    };
    const watcher = startLedgerCoherenceWatcher(resolved, root);
    try {
      expect(a.fetch("widgets").milestones.flatMap((g) => g.items)).toHaveLength(0);

      const b = new FsLedgerStore({ root });
      await b.init();
      await b.createItem("widgets", ms.id, { status: "open", fields: { note: "from B" } });
      await b.dispose();

      const seen = await waitUntil(() =>
        a
          .fetch("widgets")
          .milestones.flatMap((g) => g.items)
          .some((i) => i.fields["note"] === "from B"),
      );
      expect(seen).toBe(true);
    } finally {
      watcher.close();
      await a.dispose();
    }
  });

  it("selects the git ref-sha watcher for backend 'git-object': a peer commit becomes visible", async () => {
    const dir = await seedGitRepo();
    const a = new GitObjectLedgerBackend({ repoRoot: dir });
    await a.init();
    await a.createLedger("widgets", widgetsSchema);
    const ms = await a.createMilestone({ id: "M1", title: "m1" });

    const resolved: ResolvedLedgerStore = {
      store: a,
      configRoot: dir,
      backend: "git-object",
      branch: "cq-ledger",
    };
    const watcher = startLedgerCoherenceWatcher(resolved, dir);
    try {
      expect(a.fetch("widgets").milestones.flatMap((g) => g.items)).toHaveLength(0);

      const b = new GitObjectLedgerBackend({ repoRoot: dir });
      await b.init();
      await b.createItem("widgets", ms.id, { status: "open", fields: { note: "from B" } });

      const seen = await waitUntil(() =>
        a
          .fetch("widgets")
          .milestones.flatMap((g) => g.items)
          .some((i) => i.fields["note"] === "from B"),
      );
      expect(seen).toBe(true);
    } finally {
      watcher.close();
      await a.dispose();
    }
  }, 10_000);

  it("selects the xdg data_version watcher for backend 'xdg': a peer commit becomes visible", async () => {
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
    // `root` is irrelevant to the xdg leg (it keys off dbPath, not the repo
    // root); pass a throwaway value to exercise the same call shape as fs/git.
    // D89: also assert onChange is FORWARDED to the xdg watcher (it used to be
    // accepted here but silently dropped), so a peer's write drives the WS
    // "changed" push for xdg the same way it already does for fs/git-object.
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

      const changed = await waitUntil(() => changes.length > 0);
      expect(changed).toBe(true);
      expect(changes[0]).toBe(null);
    } finally {
      watcher.close();
      await peer.dispose();
      await watched.dispose();
    }
  }, 10_000);

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
