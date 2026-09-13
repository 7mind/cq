/**
 * Embedded TUI selects an isolated XDG store, rejects unsupported local
 * configuration, and publishes acknowledged peer changes through the same
 * watcher wiring as the production host.
 */

import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
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
let prevPromptRoot: string | undefined;
let prevPromptSurface: string | undefined;
let prevPromptSurfacesRoot: string | undefined;
beforeAll(async () => {
  prevXdgStateHome = process.env["XDG_STATE_HOME"];
  // These embedded/watcher tests are prompt-agnostic: an ambient prompt root
  // must not leak into the in-process server construction.
  prevPromptRoot = process.env["CQ_PROMPT_ROOT"];
  prevPromptSurface = process.env["CQ_PROMPT_SURFACE"];
  prevPromptSurfacesRoot = process.env["CQ_PROMPT_SURFACES_ROOT"];
  delete process.env["CQ_PROMPT_ROOT"];
  delete process.env["CQ_PROMPT_SURFACE"];
  delete process.env["CQ_PROMPT_SURFACES_ROOT"];
  const xdgHome = await fs.mkdtemp(path.join(tmpdir(), "tui-coherence-xdg-home-"));
  dirs.push(xdgHome);
  process.env["XDG_STATE_HOME"] = xdgHome;
});

afterAll(async () => {
  if (prevXdgStateHome === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = prevXdgStateHome;
  if (prevPromptRoot === undefined) delete process.env["CQ_PROMPT_ROOT"];
  else process.env["CQ_PROMPT_ROOT"] = prevPromptRoot;
  if (prevPromptSurface === undefined) delete process.env["CQ_PROMPT_SURFACE"];
  else process.env["CQ_PROMPT_SURFACE"] = prevPromptSurface;
  if (prevPromptSurfacesRoot === undefined) delete process.env["CQ_PROMPT_SURFACES_ROOT"];
  else process.env["CQ_PROMPT_SURFACES_ROOT"] = prevPromptSurfacesRoot;
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

describe("embedded TUI wiring selects the domain-state-version watcher under xdg (D51 / T505)", () => {
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
    // commits — bumping domain-state-version — without going through ctx.store.
    const external = new SqliteLedgerStore({ dbPath });
    await external.init();
    await external.createItem("widgets", ms.id, { status: "open", fields: { note: "external" } });
    await external.dispose();

    // The domain-state-version poll watcher (selected for xdg) detects the commit.
    expect(await waitUntil(() => fired > 0)).toBe(true);

    unsubscribe();
    await client.close();
  });
});
