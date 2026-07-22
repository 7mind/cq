/**
 * Embedded-TUI external-change coherence wiring (D51 / G43; xdg cutover T505).
 *
 * Regression lineage (D51): the embedded ledger-tui used to hard-wire the FS
 * .cq/*.md file-watcher directly in main.tsx rather than the backend-selecting
 * `startLedgerCoherenceWatcher(ctx.resolved, …)`. With the legacy fs /
 * git-object runtime primaries removed (T505) the embedded backend is the
 * out-of-tree xdg SqliteLedgerStore, and the same D51 contract now reads:
 *
 *  1. `McpLedgerClient.embedded` exposes the resolved backend descriptor
 *     (`embedded.resolved`) — backend 'xdg' with a concrete dbPath;
 *  2. the no-cq.toml default resolves to xdg (K117) — on a non-git root that
 *     surfaces as ProjectKeyResolutionError (no repo identity), never a
 *     silent in-tree legacy store; an explicit legacy 'git-object' takes the
 *     K117 warn-and-open path, which on a non-git root fails its git-env
 *     check;
 *  3. driving the SAME watcher wiring main.tsx uses —
 *     `startLedgerCoherenceWatcher(ctx.resolved, ctx.cwd, onChange)` — fires
 *     onChange on an EXTERNAL write (a second SqliteLedgerStore process-peer
 *     committing to the same ledger.db), via the data_version poll watcher.
 *
 * Throwaway dirs/repos via mkdtemp; cleaned up in afterAll.
 */

import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  GitEnvironmentError,
  ProjectKeyResolutionError,
  SqliteLedgerStore,
  type LedgerSchema,
} from "@cq/ledger";
import { startLedgerCoherenceWatcher } from "@cq/ledger-mcp";
import { McpLedgerClient } from "../src/mcpClient.js";

const dirs: string[] = [];

/** A throwaway non-git directory. */
async function plainDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "tui-coherence-plain-"));
  dirs.push(dir);
  return dir;
}

/** A throwaway root pinned to the xdg backend (explicit projectId — no git). */
async function xdgDir(): Promise<string> {
  const dir = await plainDir();
  await writeCqToml(
    dir,
    `[ledger]\nbackend = "xdg"\nprojectId = "${path.basename(dir)}"\n`,
  );
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

let prevXdgStateHome: string | undefined;
beforeAll(async () => {
  prevXdgStateHome = process.env["XDG_STATE_HOME"];
  const xdgHome = await fs.mkdtemp(path.join(tmpdir(), "tui-coherence-xdg-home-"));
  dirs.push(xdgHome);
  process.env["XDG_STATE_HOME"] = xdgHome;
});

afterAll(async () => {
  if (prevXdgStateHome === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = prevXdgStateHome;
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("embedded TUI exposes the resolved backend descriptor (D51 / T505)", () => {
  it("reports backend='xdg' with a concrete dbPath for an xdg cq.toml", async () => {
    const dir = await xdgDir();
    const client = await McpLedgerClient.embedded(dir);
    try {
      expect(client.embedded).not.toBeNull();
      expect(client.embedded?.resolved.backend).toBe("xdg");
      expect(typeof client.embedded?.resolved.dbPath).toBe("string");
      expect(client.embedded?.resolved.store).toBe(client.embedded?.store);
    } finally {
      await client.close();
    }
  });

  it("the no-cq.toml default resolves to xdg (K117): a non-git root fails with ProjectKeyResolutionError, never a silent legacy store", async () => {
    const dir = await plainDir();
    await expect(McpLedgerClient.embedded(dir)).rejects.toBeInstanceOf(ProjectKeyResolutionError);
  });

  it("[ledger] backend='git-object' takes the K117 warn-and-open path — on a non-git root the git-env check fails", async () => {
    const dir = await plainDir();
    await writeCqToml(dir, '[ledger]\nbackend = "git-object"\n');
    const err = await McpLedgerClient.embedded(dir).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GitEnvironmentError);
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

describe("embedded TUI wiring selects the data_version watcher under xdg (D51 / T505)", () => {
  it("fires onChange on an external peer commit to the same ledger.db", async () => {
    const dir = await xdgDir();

    // The embedded TUI client builds the xdg store + exposes `resolved`.
    const client = await McpLedgerClient.embedded(dir);
    const ctx = client.embedded;
    expect(ctx).not.toBeNull();
    if (ctx === null) throw new Error("expected embedded context");
    const dbPath = ctx.resolved.dbPath;
    if (dbPath === undefined) throw new Error("expected an xdg dbPath");

    // Seed a ledger + milestone through the client's store so an external write
    // has context to attach to.
    await ctx.store.createLedger("widgets", widgetsSchema);
    const ms = await ctx.store.createMilestone({ id: "M1", title: "m1" });

    // Wire the watcher exactly as main.tsx does for the embedded path.
    let fired = 0;
    const unsubscribe = wireOnSubscribe(ctx, () => {
      fired += 1;
    });

    // An EXTERNAL writer (a peer SqliteLedgerStore on the same ledger.db)
    // commits — bumping data_version — without going through ctx.store.
    const external = new SqliteLedgerStore({ dbPath });
    await external.init();
    await external.createItem("widgets", ms.id, { status: "open", fields: { note: "external" } });
    await external.dispose();

    // The data_version poll watcher (selected for xdg) detects the commit.
    expect(await waitUntil(() => fired > 0)).toBe(true);

    unsubscribe();
    await client.close();
  });
});
