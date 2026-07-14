/**
 * ledger-tui PTY end-to-end test.
 *
 * Drives the REAL `ledger-tui` binary through a pseudo-terminal so ink runs
 * in genuine raw-mode against a live `ledger-mcp --http` server. Unlike the
 * ink-testing-library suite (simulated stdin, fake client), this exercises
 * the actual TTY input path, the real Streamable HTTP transport, and on-disk
 * persistence.
 *
 * The PTY driving runs in a node subprocess (test/ptyHarness.mjs): node-pty's
 * forkpty is reliable from node's single-threaded runtime, whereas spawning a
 * pty child directly from bun's multithreaded runtime drops the child output.
 * This test owns seeding, the server, invoking the harness, and the on-disk
 * assertion; the harness owns the keystroke scenario.
 *
 * Scenario (position-independent — reaches the item via full-text search):
 *   connect → `/` search "warp core breach" → open hit → `s` → ↓ → Enter
 *   (set "done") → quit, then re-open the store and assert O1.status==="done".
 *
 * SKIPS cleanly when node-pty's native binding or a `node` runtime is
 * unavailable, so the suite stays green on platforms without them.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn as bunSpawn, type Subprocess } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createLedgerStore } from "@cq/ledger";
import { spawnWithFreePort } from "./portHelpers.js";

// ---- availability guard ---------------------------------------------------
const nodePath = Bun.which("node");
let ptyLoadable = false;
try {
  await import("node-pty");
  ptyLoadable = true;
} catch {
  ptyLoadable = false;
}
const ptySuite = ptyLoadable && nodePath !== null ? describe : describe.skip;

// ---- paths ----------------------------------------------------------------
const here = new URL(".", import.meta.url).pathname;
const serverMain = path.resolve(here, "..", "..", "ledger-mcp", "src", "main.ts");
const tuiMain = path.resolve(here, "..", "src", "main.tsx");
const harness = path.resolve(here, "ptyHarness.mjs");


let tmpRoot: string;
let xdgHome: string;
let prevXdgStateHome: string | undefined;
let server: Subprocess;
let port: number;

beforeAll(async () => {
  // The runtime store is the out-of-tree xdg primary (T505); the override is
  // passed EXPLICITLY at spawn time (Bun's default child env is a
  // process-start snapshot that misses runtime mutations).
  prevXdgStateHome = process.env["XDG_STATE_HOME"];
  xdgHome = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-tui-pty-xdg-"));
  process.env["XDG_STATE_HOME"] = xdgHome;

  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-tui-pty-"));
  await fs.writeFile(
    path.join(tmpRoot, "cq.toml"),
    `[ledger]\nbackend = "xdg"\nprojectId = "${path.basename(tmpRoot)}"\n`,
    "utf8",
  );
  const { store: seed } = await createLedgerStore(tmpRoot);
  await seed.createLedger("ops", {
    statusValues: ["open", "done"],
    terminalStatuses: ["done"],
    fields: { headline: { type: "string", required: true } },
  });
  const ambient = seed.fetch("milestones").milestones[0]!.items[0]!;
  await seed.createItem("ops", ambient.id, {
    id: "O1",
    status: "open",
    fields: { headline: "warp core breach" },
  });
  await seed.dispose();

  ({ port, proc: server } = await spawnWithFreePort(
    (p) => [process.execPath, "run", serverMain, "--cwd", tmpRoot, "--http", String(p)],
    { stdout: "ignore", stderr: "ignore", env: { ...process.env } },
  ));
});

afterAll(async () => {
  server.kill();
  await server.exited;
  if (prevXdgStateHome === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = prevXdgStateHome;
  await fs.rm(xdgHome, { recursive: true, force: true });
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

ptySuite("ledger-tui over a real PTY", () => {
  it("connects, searches, edits an item's status, and persists to disk", async () => {
    const url = `http://127.0.0.1:${port}/mcp`;
    const proc = bunSpawn({
      cmd: [
        nodePath!,
        harness,
        "--bun",
        process.execPath,
        "--tui",
        tuiMain,
        "--url",
        url,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    if (exitCode !== 0 || !out.includes("RESULT:PASS")) {
      throw new Error(
        `PTY harness failed (exit ${exitCode}).\nstdout:\n${out}\nstderr:\n${err}`,
      );
    }

    // on-disk persistence: a fresh store sees the edit the TUI made over HTTP.
    const { store: verify } = await createLedgerStore(tmpRoot);
    expect(verify.fetchItem("ops", "O1").status).toBe("done");
    await verify.dispose();
  }, 40000);
});
