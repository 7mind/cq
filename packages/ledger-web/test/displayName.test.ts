/**
 * displayName() accessor tests for the web LedgerClient (T66).
 *
 * 1. FakeClient: configurable display name, default 'cq1'.
 * 2. McpLedgerClient (serveHttp): surfaces serverInfo.title from the real server.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FsLedgerStore } from "@cq/ledger";
import { serveHttp, MCP_HTTP_PATH } from "@cq/ledger-mcp";
import { McpLedgerClient } from "../src/mcpClient.js";
import { FakeClient } from "./fakeClient.js";

// ---------------------------------------------------------------------------
// FakeClient
// ---------------------------------------------------------------------------

describe("web FakeClient.displayName()", () => {
  it("returns 'cq1' by default", () => {
    const fake = new FakeClient();
    expect(fake.displayName()).toBe("cq1");
  });

  it("returns the configured display name when constructed with one", () => {
    const fake = new FakeClient("web-project");
    expect(fake.displayName()).toBe("web-project");
  });
});

// ---------------------------------------------------------------------------
// McpLedgerClient (web) — real HTTP server via serveHttp
// ---------------------------------------------------------------------------

let tmpRoot: string;
let store: FsLedgerStore;
let server: ReturnType<typeof Bun.serve>;
let client: McpLedgerClient;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-web-dn-"));
  store = new FsLedgerStore({ root: tmpRoot });
  await store.init();
  const displayName = path.basename(tmpRoot);
  server = serveHttp(store, { host: "127.0.0.1", port: 0 }, displayName);
  const url = `http://127.0.0.1:${server.port}${MCP_HTTP_PATH}`;
  client = await McpLedgerClient.connect(url);
});

afterAll(async () => {
  await client.close();
  server.stop(true);
  await store.dispose();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("web McpLedgerClient.displayName()", () => {
  it("returns the display name the server was started with (serverInfo.title carrier)", () => {
    const expected = path.basename(tmpRoot);
    expect(client.displayName()).toBe(expected);
  });
});
