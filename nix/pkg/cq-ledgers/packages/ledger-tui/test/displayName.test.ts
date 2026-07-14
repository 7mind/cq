/**
 * displayName() accessor tests for LedgerClient (T66).
 *
 * 1. FakeClient: configurable display name, default 'cq1'.
 * 2. McpLedgerClient over HTTP (real server via subprocess): surfaces
 *    the basename from the REAL carrier T65 wrote — serverInfo.title
 *    via getServerVersion(), with instructions fallback.
 * 3. McpLedgerClient.embedded (in-process InMemoryTransport): same carrier.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { type Subprocess } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createLedgerStore } from "@cq/ledger";
import { McpLedgerClient } from "../src/mcpClient.js";
import { FakeClient } from "./fakeClient.js";
import { spawnWithFreePort } from "./portHelpers.js";

// ---------------------------------------------------------------------------
// FakeClient
// ---------------------------------------------------------------------------

describe("FakeClient.displayName()", () => {
  it("returns 'cq1' by default", () => {
    const fake = new FakeClient();
    expect(fake.displayName()).toBe("cq1");
  });

  it("returns the configured display name when constructed with one", () => {
    const fake = new FakeClient("my-project");
    expect(fake.displayName()).toBe("my-project");
  });
});

// ---------------------------------------------------------------------------
// McpLedgerClient — real carrier (HTTP subprocess)
// ---------------------------------------------------------------------------

const here = new URL(".", import.meta.url).pathname;
const serverMain = path.resolve(here, "..", "..", "ledger-mcp", "src", "main.ts");

let tmpRoot: string;
let xdgHome: string;
let prevXdgStateHome: string | undefined;
let proc: Subprocess;
let client: McpLedgerClient;
let port: number;

/** Pin a temp root to the xdg backend (T505) with an explicit projectId. */
async function writeXdgToml(root: string): Promise<void> {
  await fs.writeFile(
    path.join(root, "cq.toml"),
    `[ledger]\nbackend = "xdg"\nprojectId = "${path.basename(root)}"\n`,
    "utf8",
  );
}

beforeAll(async () => {
  // The runtime store is the out-of-tree xdg primary (T505); the override is
  // passed EXPLICITLY at spawn time (Bun's default child env is a
  // process-start snapshot that misses runtime mutations).
  prevXdgStateHome = process.env["XDG_STATE_HOME"];
  xdgHome = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-displayname-xdg-"));
  process.env["XDG_STATE_HOME"] = xdgHome;

  // Use a directory whose basename is a known token we can assert on.
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-displayname-"));
  await writeXdgToml(tmpRoot);
  const { store: seed } = await createLedgerStore(tmpRoot);
  await seed.dispose();

  ({ port, proc } = await spawnWithFreePort(
    (p) => [process.execPath, "run", serverMain, "--cwd", tmpRoot, "--http", String(p)],
    { stdout: "inherit", stderr: "inherit", env: { ...process.env } },
  ));
  client = await McpLedgerClient.connect(`http://127.0.0.1:${port}/mcp`);
});

afterAll(async () => {
  await client.close();
  proc.kill();
  await proc.exited;
  if (prevXdgStateHome === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = prevXdgStateHome;
  await fs.rm(xdgHome, { recursive: true, force: true });
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("McpLedgerClient.displayName() — HTTP", () => {
  it("returns the basename of --cwd via serverInfo.title (T65 carrier)", () => {
    // The server was started with --cwd set to tmpRoot whose basename is
    // 'ledger-displayname-XXXXXX'. T65 sets serverInfo.title = basename(cwd),
    // which the client reads via getServerVersion().title.
    const expected = path.basename(tmpRoot);
    expect(client.displayName()).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// McpLedgerClient.embedded — in-process InMemoryTransport
// ---------------------------------------------------------------------------

describe("McpLedgerClient.embedded displayName()", () => {
  it("returns the basename of cwd via the in-process server's serverInfo.title", async () => {
    const embeddedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-embedded-dn-"));
    try {
      await writeXdgToml(embeddedRoot);

      const embeddedClient = await McpLedgerClient.embedded(embeddedRoot);
      try {
        expect(embeddedClient.displayName()).toBe(path.basename(embeddedRoot));
      } finally {
        await embeddedClient.close();
      }
    } finally {
      await fs.rm(embeddedRoot, { recursive: true, force: true });
    }
  });
});
