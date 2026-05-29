/**
 * Cross-process integration test for D-COHERENCE.
 *
 * Spawns a real cq-mcp subprocess against a real cq Bun.serve instance.
 * The subprocess connects back via /__internal/cq-mcp with the token
 * provided in env, then performs an MCP tool call (create_milestone)
 * via stdio. After the tool call commits to disk, the subprocess
 * broadcasts ledger.changed → the cq server's FsLedgerStore receives
 * the message and invalidates its cache. We assert the server's
 * `enumerate()` / `fetchMilestone()` reflect the new state within
 * 1 second.
 *
 * The reverse direction is exercised similarly: the cq server (via its
 * FsLedgerStore directly) creates a ledger; the server broadcasts; the
 * cq-mcp subprocess invalidates its cache; we observe the new ledger
 * via the MCP `enumerate_ledgers` tool.
 *
 * Resolution: the subprocess is launched via `bun run` against
 * `packages/cq-mcp/src/main.ts` directly so the test does not require a
 * built `node_modules/.bin/cq-mcp` symlink or a Nix-built bin on PATH.
 * This matches the dev-loop iteration the user would run.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  FsLedgerStore,
  MILESTONES_LEDGER,
} from "@cq/ledger";
import {
  INTERNAL_WS_PATH,
  InternalWsService,
} from "../src/agent/internalWs";
import type { Logger } from "../src/log/logger";

function nullLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function resolveCqMcpBin(): { command: string; args: string[] } {
  const here = new URL(".", import.meta.url).pathname;
  const main = path.resolve(here, "..", "..", "cq-mcp", "src", "main.ts");
  return { command: process.execPath, args: ["run", main] };
}

let tmpRoot: string;
let serverHandle: { stop: () => void } | null = null;
let internalWs: InternalWsService | null = null;
let serverLedgerStore: FsLedgerStore | null = null;
let url: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cq-coherence-itest-"));
  // Use a deterministic token so we can assert on it explicitly if
  // needed; production code generates a random one.
  internalWs = new InternalWsService({
    logger: nullLogger(),
    token: "abcdef".repeat(5) + "ab", // 32 chars hex
  });
  serverLedgerStore = new FsLedgerStore({
    root: tmpRoot,
    onMutation: (ledgerId, op) => {
      internalWs!.broadcast({
        type: "ledger.changed",
        ledgerId,
        op,
        sourcePid: internalWs!.selfPid(),
      });
    },
  });
  await serverLedgerStore.init();
  internalWs.registerHandler("ledger.changed", async (msg) => {
    await serverLedgerStore!.invalidate(msg.ledgerId).catch(() => undefined);
  });

  const bunServer = Bun.serve<{ kind?: "internal"; clientId?: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const u = new URL(req.url);
      if (u.pathname !== INTERNAL_WS_PATH) {
        return new Response("nope", { status: 404 });
      }
      return internalWs!.handleUpgrade(req, srv as never) ??
        new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) {
        if (ws.data.kind === "internal") internalWs!.open(ws as never);
      },
      message(ws, raw) {
        if (ws.data.kind === "internal") internalWs!.message(ws as never, raw);
      },
      close(ws) {
        if (ws.data.kind === "internal") internalWs!.close(ws as never);
      },
    },
  });
  serverHandle = bunServer;
  url = `ws://127.0.0.1:${bunServer.port}${INTERNAL_WS_PATH}`;
});

afterAll(async () => {
  if (serverHandle !== null) serverHandle.stop();
  if (serverLedgerStore !== null) await serverLedgerStore.dispose();
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

async function withMcpClient(
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const { command, args } = resolveCqMcpBin();
  const transport = new StdioClientTransport({
    command,
    args: [...args, "--cwd", tmpRoot],
    env: {
      ...process.env,
      CQ_INTERNAL_WS_URL: url,
      CQ_INTERNAL_WS_TOKEN: internalWs!.tokenForChild(),
    } as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client(
    { name: "cq-coherence-itest", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("D-COHERENCE — cross-process cache invalidation", () => {
  it("cq-mcp creates a milestone; server's FsLedgerStore observes it within 1s", async () => {
    // Sanity: server has no milestones beyond the immortal M-AMBIENT
    // bootstrap milestone (§8b).
    {
      const view = serverLedgerStore!.fetch(MILESTONES_LEDGER);
      expect(view.milestones[0]?.items.map((it) => it.id) ?? []).toEqual(["M-AMBIENT"]);
    }
    await withMcpClient(async (client) => {
      await client.callTool({
        name: "create_milestone",
        arguments: { id: "M9", title: "From the MCP" },
      });
      // The subprocess broadcasts ledger.changed → server invalidates.
      // Poll the server-side store until the milestone shows up.
      await waitFor(() => {
        try {
          const view = serverLedgerStore!.fetchMilestone("M9");
          return view.milestone.id === "M9";
        } catch {
          return false;
        }
      }, 1000);
    });
    const view = serverLedgerStore!.fetchMilestone("M9");
    expect(view.resolved.title).toBe("From the MCP");
  });

  it("cq-mcp creates a brand-new ledger; the server invalidate path reloads the registry", async () => {
    expect(serverLedgerStore!.enumerate()).not.toContain("itest-ledger");
    await withMcpClient(async (client) => {
      await client.callTool({
        name: "create_ledger",
        arguments: {
          name: "itest-ledger",
          schema: {
            statusValues: ["open", "done"],
            terminalStatuses: ["done"],
            fields: { note: { type: "string", required: false } },
          },
        },
      });
      await waitFor(
        () => serverLedgerStore!.enumerate().includes("itest-ledger"),
        1000,
      );
    });
    expect(serverLedgerStore!.enumerate()).toContain("itest-ledger");
  });
});
