/**
 * Embedded-TUI external-change coherence wiring (D51 / G43).
 *
 * Regression for D51: the embedded ledger-tui used to hard-wire the FS
 * .cq/*.md file-watcher (`startLedgerWatcher(ctx.store, ctx.cwd, …)`)
 * directly in main.tsx, rather than the backend-selecting
 * `startLedgerCoherenceWatcher(ctx.resolved, …)` that the web embedded path
 * uses. Under the git-object backend .cq/*.md never change on the working
 * branch, so the FS watcher never fired and EXTERNAL changes did not refresh
 * the embedded TUI.
 *
 * These tests prove:
 *  1. `McpLedgerClient.embedded` now exposes the resolved backend descriptor
 *     (`embedded.resolved`) — fs under no/explicit-fs cq.toml, git-object under
 *     `[ledger] backend = "git-object"`.
 *  2. Driving the SAME watcher wiring main.tsx uses — `startLedgerCoherenceWatcher(
 *     ctx.resolved, ctx.cwd, onChange)` — under the git-object backend fires
 *     onChange on an external write (orphan-ref advance) that leaves .cq/*.md
 *     untouched, which the old FS-only wiring would have MISSED.
 *  3. The fs path still selects the file-watcher (behaviour unchanged): an
 *     external write through a second FsLedgerStore fires onChange.
 *
 * Throwaway dirs/repos via mkdtemp; cleaned up in afterAll.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { GitObjectLedgerBackend, FsLedgerStore, type LedgerSchema } from "@cq/ledger";
import { startLedgerCoherenceWatcher } from "@cq/ledger-mcp";
import { McpLedgerClient } from "../src/mcpClient.js";

const exec = promisify(execFile);
const dirs: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

/** A throwaway non-git directory. */
async function plainDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "tui-coherence-plain-"));
  dirs.push(dir);
  return dir;
}

/** A throwaway initialised git repo with one commit. */
async function gitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "tui-coherence-git-"));
  dirs.push(dir);
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "test");
  await git(dir, "config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(dir, "README.md"), "test\n");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

async function writeCqToml(dir: string, body: string): Promise<void> {
  await fs.writeFile(path.join(dir, "cq.toml"), body, "utf8");
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
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("embedded TUI exposes the resolved backend descriptor (D51)", () => {
  it("reports backend='fs' for the default (no cq.toml)", async () => {
    const dir = await plainDir();
    const client = await McpLedgerClient.embedded(dir);
    try {
      expect(client.embedded).not.toBeNull();
      expect(client.embedded?.resolved.backend).toBe("fs");
      expect(client.embedded?.resolved.store).toBe(client.embedded?.store);
    } finally {
      await client.close();
    }
  });

  it("reports backend='git-object' for [ledger] backend='git-object'", async () => {
    const dir = await gitRepo();
    await writeCqToml(dir, '[ledger]\nbackend = "git-object"\n');
    const client = await McpLedgerClient.embedded(dir);
    try {
      expect(client.embedded?.resolved.backend).toBe("git-object");
      expect(client.embedded?.resolved.branch).toBe("cq-ledger");
    } finally {
      await client.close();
    }
  });
});

/**
 * Mirror the exact `onSubscribe` wiring `ledger-tui/src/main.tsx` builds for the
 * embedded path, so the test exercises the contract main.tsx depends on. Returns
 * the unsubscribe handle.
 */
function wireOnSubscribe(
  ctx: NonNullable<McpLedgerClient["embedded"]>,
  onChange: () => void,
): () => void {
  const watcher = startLedgerCoherenceWatcher(ctx.resolved, ctx.cwd, () => onChange());
  return () => watcher.close();
}

describe("embedded TUI wiring selects the ref-watcher under git-object (D51)", () => {
  it("fires onChange on an external orphan-ref advance (.cq/*.md untouched)", async () => {
    const dir = await gitRepo();
    await writeCqToml(dir, '[ledger]\nbackend = "git-object"\n');

    // The embedded TUI client builds the git-object store + exposes `resolved`.
    const client = await McpLedgerClient.embedded(dir);
    const ctx = client.embedded;
    expect(ctx).not.toBeNull();
    if (ctx === null) throw new Error("expected embedded context");

    // Seed a ledger + milestone through the client's store so an external write
    // has context to attach to.
    await ctx.store.createLedger("widgets", widgetsSchema);
    const ms = await ctx.store.createMilestone({ id: "M1", title: "m1" });

    // Wire the watcher exactly as main.tsx does for the embedded path.
    let fired = 0;
    const unsubscribe = wireOnSubscribe(ctx, () => {
      fired += 1;
    });

    // An EXTERNAL writer (a separate GitObjectLedgerBackend on the same repo)
    // advances the orphan ref WITHOUT changing .cq/*.md on the working branch —
    // the precise scenario the old FS-only wiring missed.
    const external = new GitObjectLedgerBackend({ repoRoot: dir });
    await external.init();
    await external.createItem("widgets", ms.id, { status: "open", fields: { note: "external" } });

    // The ref-watcher (selected by startLedgerCoherenceWatcher for git-object)
    // detects the advance and fires onChange.
    expect(await waitUntil(() => fired > 0)).toBe(true);

    unsubscribe();
    await external.dispose();
    await client.close();
  });
});

describe("embedded TUI wiring keeps the file-watcher under fs (D51 — no regression)", () => {
  it("fires onChange on an external .cq/*.md write", async () => {
    const dir = await plainDir();

    const client = await McpLedgerClient.embedded(dir);
    const ctx = client.embedded;
    expect(ctx?.resolved.backend).toBe("fs");
    if (ctx === null || ctx === undefined) throw new Error("expected embedded context");

    await ctx.store.createLedger("widgets", widgetsSchema);
    const ms = await ctx.store.createMilestone({ id: "M1", title: "m1" });

    let fired = 0;
    const unsubscribe = wireOnSubscribe(ctx, () => {
      fired += 1;
    });

    // External writer through a second FsLedgerStore on the same root mutates
    // .cq/*.md → the file-watcher fires.
    const external = new FsLedgerStore({ root: dir });
    await external.init();
    await external.createItem("widgets", ms.id, { status: "open", fields: { note: "external" } });
    await external.dispose();

    expect(await waitUntil(() => fired > 0)).toBe(true);

    unsubscribe();
    await client.close();
  });
});
