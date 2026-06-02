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
import { spawn, type Subprocess } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FsLedgerStore } from "@cq/ledger";
import { McpLedgerClient } from "../src/mcpClient.js";
import { FakeClient } from "./fakeClient.js";
import { freePort, waitForPort } from "./portHelpers.js";

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
let proc: Subprocess;
let client: McpLedgerClient;
let port: number;

beforeAll(async () => {
  // Use a directory whose basename is a known token we can assert on.
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-displayname-"));
  const seed = new FsLedgerStore({ root: tmpRoot });
  await seed.init();
  await seed.dispose();

  port = await freePort();
  proc = spawn({
    cmd: [process.execPath, "run", serverMain, "--cwd", tmpRoot, "--http", String(port)],
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitForPort(port);
  client = await McpLedgerClient.connect(`http://127.0.0.1:${port}/mcp`);
});

afterAll(async () => {
  await client.close();
  proc.kill();
  await proc.exited;
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
      const seed = new FsLedgerStore({ root: embeddedRoot });
      await seed.init();
      await seed.dispose();

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
