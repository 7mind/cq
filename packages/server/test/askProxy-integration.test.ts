/**
 * Cross-process integration test for the Codex ask_user_question
 * WS-back-proxy (askproxy / outer-14).
 *
 * Spawns a real cq-mcp subprocess with the internal-WS env (URL + token +
 * CQ_SESSION_ID) set, connected back to a real Bun.serve hosting an
 * InternalWsService. We then:
 *
 *   1. assert tools/list now includes `ask_user_question` (it must, since
 *      the channel is up and CQ_SESSION_ID is set);
 *   2. invoke the tool WITHOUT awaiting; on the server side, capture the
 *      inbound `ask.request`, assert its shape, then broadcast a synthetic
 *      `ask.reply` (standing in for the browser's answer the real proxy
 *      would relay);
 *   3. assert the tool call resolves with the proxied answers in the
 *      Claude-identical CallToolResult shape.
 *
 * A second case spawns the binary WITHOUT the env and asserts the
 * standalone surface stays at the 14 ledger tools (incl. fts_search; no ask_user_question).
 *
 * Mirrors `internalWs-integration.test.ts`; the subprocess is launched via
 * `bun run packages/cq-mcp/src/main.ts` so no built bin is required.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FsLedgerStore } from "@cq/ledger";
import {
  INTERNAL_WS_PATH,
  InternalWsService,
} from "../src/agent/internalWs";
import type { InternalWsMessage } from "@cq/shared";
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

const TEST_SESSION_ID = "11111111-2222-3333-4444-555555555555";

let tmpRoot: string;
let serverHandle: { stop: () => void } | null = null;
let internalWs: InternalWsService | null = null;
let serverLedgerStore: FsLedgerStore | null = null;
let url: string;

/** Captured ask.request envelopes the cq-mcp sent us. */
const askRequests: Array<Extract<InternalWsMessage, { type: "ask.request" }>> = [];
/** When set, the ask.request handler broadcasts this reply for the askId. */
let scriptedAnswers: Record<string, unknown> | null = null;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cq-askproxy-itest-"));
  internalWs = new InternalWsService({
    logger: nullLogger(),
    token: "abcdef".repeat(5) + "ab",
  });
  serverLedgerStore = new FsLedgerStore({ root: tmpRoot });
  await serverLedgerStore.init();

  // Stand in for the cq server's real proxy: on ask.request, capture it and
  // broadcast a synthetic ask.reply (the browser's answer the real AskProxy
  // would relay after driving the UI).
  internalWs.registerHandler("ask.request", async (msg) => {
    askRequests.push(msg);
    if (scriptedAnswers !== null) {
      internalWs!.broadcast({
        type: "ask.reply",
        askId: msg.askId,
        answers: scriptedAnswers,
        sourcePid: internalWs!.selfPid(),
      });
    }
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
  opts: { withChannel: boolean },
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const { command, args } = resolveCqMcpBin();
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (opts.withChannel) {
    env["CQ_INTERNAL_WS_URL"] = url;
    env["CQ_INTERNAL_WS_TOKEN"] = internalWs!.tokenForChild();
    env["CQ_SESSION_ID"] = TEST_SESSION_ID;
  } else {
    delete env["CQ_INTERNAL_WS_URL"];
    delete env["CQ_INTERNAL_WS_TOKEN"];
    delete env["CQ_SESSION_ID"];
  }
  const transport = new StdioClientTransport({
    command,
    args: [...args, "--cwd", tmpRoot],
    env,
    stderr: "ignore",
  });
  const client = new Client(
    { name: "cq-askproxy-itest", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

describe("askproxy — cq-mcp ask_user_question round-trip", () => {
  it("exposes ask_user_question in tools/list when the channel + CQ_SESSION_ID are up", async () => {
    await withMcpClient({ withChannel: true }, async (client) => {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      expect(names).toContain("ask_user_question");
      // The 14 ledger tools (incl. fts_search) are still present.
      expect(names).toContain("enumerate_ledgers");
      expect(names).toContain("fts_search");
      expect(names.length).toBe(15);
    });
  });

  it("does NOT expose ask_user_question in standalone mode (no channel)", async () => {
    await withMcpClient({ withChannel: false }, async (client) => {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      expect(names).not.toContain("ask_user_question");
      expect(names.length).toBe(14);
    });
  });

  it("round-trips a question: tool → ask.request → ask.reply → resolved result", async () => {
    askRequests.length = 0;
    scriptedAnswers = { "Pick one": ["a", "b"] };
    await withMcpClient({ withChannel: true }, async (client) => {
      const result = await client.callTool({
        name: "ask_user_question",
        arguments: {
          questions: [{ question: "Pick one", options: ["a", "b", "c"] }],
        },
      });

      // The server captured exactly one ask.request with the right shape.
      expect(askRequests).toHaveLength(1);
      const req = askRequests[0]!;
      expect(req.sessionId).toBe(TEST_SESSION_ID);
      expect(req.askId).toMatch(/^ask-\d+-\d+$/);
      expect(req.toolUseId).toBe(`${req.askId}-tu`);
      expect(req.questions).toEqual([
        { question: "Pick one", options: ["a", "b", "c"] },
      ]);

      // The tool resolved with the proxied answers, in the Claude-identical
      // CallToolResult shape ({content:[{type:"text",text:JSON(...)}]}).
      const block = (result.content as Array<{ type: string; text: string }>)[0]!;
      expect(block.type).toBe("text");
      const decoded = JSON.parse(block.text) as {
        questions: unknown[];
        answers: Record<string, string>;
      };
      // Answers normalised to the comma-joined string shape (string[] → "a, b").
      expect(decoded.answers).toEqual({ "Pick one": "a, b" });
      expect(decoded.questions).toEqual([
        { question: "Pick one", options: ["a", "b", "c"] },
      ]);
    });
    scriptedAnswers = null;
  });
});
